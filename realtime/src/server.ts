//#region Imports
import { createServer } from "node:http"
import { resolve as resolvePath } from "node:path"

import { createApp } from "@/app"
import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { IngestWorker } from "@/ingest/worker"
import { buildLLMProvider } from "@/answer/buildLLM"
import { resolveTokenSecret } from "@/widget/sessionToken"
import { hasMasterKey } from "@/credentials/vault"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { InternalRouteOptions } from "@/routes/internal"
//#endregion

//#region Internal API opt-in
// The dashboard's server-to-server surface (routes/internal.ts) mounts only
// when INTERNAL_API_SECRET is configured — pre-M3 deployments keep booting
// with the routes absent. Configuration is all-or-nothing: a secret WITHOUT
// the vault's master key would accept a tenant's credential and then throw
// at encryption time (after the plaintext crossed the wire), so the
// half-configured state refuses to boot instead. A short secret refuses
// too — same stance as the widget token secret.
function resolveInternalOptions(): InternalRouteOptions | undefined {
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret) return undefined
  if (secret.length < 32) {
    throw new Error("INTERNAL_API_SECRET must be at least 32 characters.")
  }
  if (!hasMasterKey()) {
    throw new Error(
      "INTERNAL_API_SECRET is set but CREDENTIAL_MASTER_KEY is not — the " +
        "internal API would accept tenant keys it cannot encrypt. Set both " +
        "or neither.",
    )
  }
  return { secret }
}
//#endregion

//#region Embedder selection
// Which embedding provider the ingest worker uses, from EMBEDDING_PROVIDER:
//   - "local": fastembed/ONNX (bge-small-en-v1.5) — dev machines and the
//     eval harness. Dynamic import so onnxruntime is only loaded when
//     actually selected (it wants ~250–400 MB of RAM — see
//     providers/embedding/local.ts; it must never run on Render).
//   - anything else: the deterministic mock. An honest placeholder until
//     per-org BYO providers land in M3 — mock vectors carry no semantics,
//     which is fine while nothing retrieves (M2), and it is what lets CI
//     drive the full ingest pipeline with zero API keys.
async function buildEmbedder(): Promise<EmbeddingProvider> {
  if (process.env.EMBEDDING_PROVIDER === "local") {
    const { LocalEmbeddingProvider } = await import("@providers/embedding/local")
    return new LocalEmbeddingProvider()
  }
  return new MockEmbeddingProvider()
}
//#endregion

//#region Boot
// Boot order is a contract (traced in DATAFLOW.md §2):
//   1. migrate — the process must not accept traffic against a schema it
//      wasn't built for. A failure here throws, and the catch below exits
//      loudly. Kysely's migrator takes a session-level advisory lock via its
//      bookkeeping table semantics; even so, this deployment runs exactly
//      one instance (Render free tier), so concurrent-migrator races are
//      out of scope by design and documented rather than half-handled.
//   2. listen — only after the schema is current.
//
// The http server is created explicitly (rather than app.listen) because M4
// attaches the WebSocket upgrade handler to this same server object; doing
// it now costs nothing and avoids reshaping boot later.
// BACKEND_PORT first (this repo's own convention, set by compose and
// render.yaml), then PORT (the convention Render and most PaaS routers
// inject), then 3000. Honoring PORT means the service still binds correctly
// on a platform that only speaks the generic convention.
const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 3000)

async function start(): Promise<void> {
  const applied = await migrateToLatest(db)
  const names = applied.results?.map((r) => r.migrationName).join(", ") || "none"
  console.log(`[boot] migrations applied: ${names}`)

  // The widget surface. One embedder serves both the worker and retrieval —
  // they MUST agree on the model or queries search an empty vector space.
  // LLM_PROVIDER defaults to the context-quoting mock so every stack (dev
  // compose, prod compose, CI e2e) serves real grounded answers keylessly;
  // env-configured real providers are a dev convenience that M3 replaces
  // with per-org encrypted credentials.
  const embedder = await buildEmbedder()
  const llm = buildLLMProvider(process.env.LLM_PROVIDER ?? "mock")
  const maxDistance = Number(process.env.ANSWER_MAX_DISTANCE)
  const dailyCap = Number(process.env.WIDGET_DAILY_ANSWER_CAP)
  console.log(`[boot] widget: llm=${llm.model} embeddings=${embedder.model}`)

  const internal = resolveInternalOptions()
  console.log(`[boot] internal api: ${internal ? "mounted" : "not configured"}`)

  const app = createApp({
    widget: {
      db, embedder, llm,
      tokenSecret: resolveTokenSecret(),
      ...(Number.isFinite(maxDistance) ? { maxDistance } : {}),
      ...(Number.isFinite(dailyCap) ? { dailyAnswerCap: dailyCap } : {}),
    },
    ...(internal ? { internal } : {}),
    demo: {
      // Null until DEMO_PUBLISHABLE_KEY is set — /demo then serves setup
      // instructions instead of a broken widget (routes/demo.ts).
      publishableKey: process.env.DEMO_PUBLISHABLE_KEY || null,
      // ../widget/dist resolves identically from the prod image's
      // /app/realtime workdir and a host-side `npm run dev` in realtime/.
      widgetBundlePath: resolvePath(process.cwd(), "../widget/dist/widget.js"),
    },
  })
  const server = createServer(app)

  server.listen(port, () => {
    console.log(`[boot] realtime listening on :${port}`)
  })

  // The ingest worker is OPT-IN (INGEST_WORKER=1): its poll loop queries
  // Postgres every few seconds, which on Neon would hold compute awake
  // around the clock — the same ~100 CU-hour budget the DB-free health
  // route exists to protect. Both compose stacks turn it on (local Postgres
  // has no such budget); render.yaml leaves it OFF until M3 gives the
  // worker something that can enqueue in production plus an in-process wake
  // instead of a poll.
  let worker: IngestWorker | null = null
  if (process.env.INGEST_WORKER === "1") {
    const pollMs = Number(process.env.INGEST_POLL_MS) || undefined
    // Same embedder instance as the widget surface — the agreement that
    // ingest-time and query-time vectors share a model is enforced by
    // construction here, not by two env reads happening to match.
    worker = new IngestWorker({ db, embedder, ...(pollMs ? { pollMs } : {}) })
    worker.start()
    console.log(`[boot] ingest worker polling${pollMs ? ` every ${pollMs}ms` : ""}`)
  }

  //#region Shutdown
  // SIGTERM is what Render (and docker stop) sends. Drain in order: stop
  // accepting connections AND stop the worker (it requeues an in-flight job
  // between pages), then release the pool. A second signal while draining
  // forces exit — an operator mashing Ctrl+C outranks graceful.
  let draining = false
  const shutdown = (signal: string): void => {
    if (draining) process.exit(1)
    draining = true
    console.log(`[shutdown] ${signal} received, draining`)
    const workerStopped = worker ? worker.stop() : Promise.resolve()
    server.close(() => {
      workerStopped
        .then(() => pool.end())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        )
    })
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
  //#endregion
}

start().catch((err) => {
  // A failed boot must be loud and terminal. Exiting nonzero makes Render /
  // compose restart us with backoff, which is the correct behavior for a
  // transient DB outage and the visible behavior for a real defect.
  console.error("[boot] fatal:", err)
  process.exit(1)
})
//#endregion
