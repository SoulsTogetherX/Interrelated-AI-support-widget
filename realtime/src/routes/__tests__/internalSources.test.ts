// The M3.6 enqueue surface: source + job in one transaction, the wake
// callback that IS production's scheduler, the SSRF vet on tenant crawl
// URLs, and a wake-driven worker (pollMs 0) proving a woken tick runs work
// with no poll timer anywhere.
import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { createApp } from "@/app"
import { IngestWorker } from "@/ingest/worker"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { newId } from "@shared/utils/ids"

import type { Server } from "node:http"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const SECRET = "internal-sources-test-secret-0123456789"

let appServer: Server
let base: string
let orgId: string
let enqueueCalls: number

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": SECRET },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasDb)("internal sources API + wake-driven worker", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Sources Test Org" }).execute()

    enqueueCalls = 0
    const app = createApp({
      internal: {
        secret: SECRET,
        ticketSecret: SECRET,
        vetBaseUrl: async () => {},
        onEnqueue: () => { enqueueCalls += 1 },
      },
    })
    appServer = createServer(app)
    await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r))
    const ap = appServer.address() as { port: number }
    base = `http://127.0.0.1:${ap.port}`
  })

  afterAll(async () => {
    appServer?.close()
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await pool.end()
  })

  it("connects a source, queues its job, and fires the wake callback", async () => {
    const res = await post(`/internal/orgs/${orgId}/sources`, {
      kind: "url",
      location: "https://docs.example.com/start",
      crawlDepth: 2,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sourceId: string; jobId: string }
    expect(body.sourceId.startsWith("src_")).toBe(true)
    expect(body.jobId.startsWith("job_")).toBe(true)
    expect(enqueueCalls).toBe(1)

    const source = await db
      .selectFrom("sources").selectAll().where("id", "=", body.sourceId).executeTakeFirstOrThrow()
    expect(source).toMatchObject({
      org_id: orgId, kind: "url", location: "https://docs.example.com/start",
      crawl_depth: 2, status: "pending",
    })
    const job = await db
      .selectFrom("ingest_jobs").selectAll().where("id", "=", body.jobId).executeTakeFirstOrThrow()
    expect(job).toMatchObject({ org_id: orgId, source_id: body.sourceId, state: "queued" })
  })

  it("rejects malformed inputs with zero enqueues", async () => {
    const before = enqueueCalls
    const cases: Array<Record<string, unknown>> = [
      { kind: "upload", location: "https://x.example/" }, // uploads are not crawl sources
      { kind: "url", location: "not a url" },
      { kind: "url", location: "ftp://x.example/" },
      { kind: "url", location: "https://user:pw@x.example/" },
      { kind: "url", location: "https://x.example/", crawlDepth: 4 },
      { kind: "url", location: "https://x.example/", crawlDepth: 1.5 },
      { kind: "url", location: "https://x.example/", crawlDepth: -1 },
    ]
    for (const body of cases) {
      const res = await post(`/internal/orgs/${orgId}/sources`, body)
      expect(res.status).toBe(422)
    }
    expect(enqueueCalls).toBe(before)
  })

  it("the PRODUCTION vet rejects private crawl targets", async () => {
    const prodApp = createApp({ internal: { secret: SECRET, ticketSecret: SECRET } })
    const prodServer = createServer(prodApp)
    await new Promise<void>((r) => prodServer.listen(0, "127.0.0.1", r))
    const pp = prodServer.address() as { port: number }
    try {
      const res = await fetch(`http://127.0.0.1:${pp.port}/internal/orgs/${orgId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": SECRET },
        body: JSON.stringify({ kind: "url", location: "http://169.254.169.254/latest/meta-data" }),
      })
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: string }).error).toContain("public address")
    } finally {
      prodServer.close()
    }
  })

  it("a WOKEN wake-driven worker runs the job with no poll timer", async () => {
    // pollMs 0: after the start tick the worker is fully idle — no timer
    // exists to find this job. Only wake() can, which is the production
    // contract the enqueue route's onEnqueue fulfills.
    const worker = new IngestWorker({ db, embedder: new MockEmbeddingProvider(), pollMs: 0 })
    worker.start()
    await new Promise((r) => setTimeout(r, 50)) // let the start tick drain (no jobs yet)

    // An upload-kind source: the worker fails it FAST and loudly (uploads
    // are parsed at upload time, never crawled) — which makes it the
    // perfect no-network probe that a tick actually ran.
    const sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "upload", location: "manual.pdf",
    }).execute()
    const jobId = newId("job")
    await db.insertInto("ingest_jobs").values({
      id: jobId, org_id: orgId, source_id: sourceId,
    }).execute()

    worker.wake()
    let state = "queued"
    for (let i = 0; i < 40 && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const row = await db
        .selectFrom("ingest_jobs").select("state").where("id", "=", jobId).executeTakeFirstOrThrow()
      state = row.state
    }
    expect(state).toBe("failed")
    await worker.stop()
  })
})
