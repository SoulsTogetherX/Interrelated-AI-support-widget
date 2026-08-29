//#region Why this file
// Ingest throughput, measured — `npm run ingest-bench` (M8.7). The plan's
// metrics list names it beside retrieval-only latency and TTFT, and both of
// those have had committed producers for milestones while ingest speed
// existed only as anecdotes ("9 pages in 4 seconds", §9.9). This is the
// producer: the REAL worker (IngestWorker.tick), the REAL crawler under a
// permissive hostGuard, and the committed eval corpus (31 Fastify pages,
// ~584 KB) served over loopback HTTP from a sitemap — the production
// pipeline verbatim, fetch → parse → chunk → embed → store, with only the
// network made free.
//
// What the number MEANS is bounded by three deliberate exclusions, each
// stated in the output because a throughput figure that hides its
// exclusions reads as a promise:
//
//   1. The network. Loopback fetches cost microseconds; a real site adds
//      RTT and transfer per page. What is measured is the pipeline's own
//      capacity, which is the half we control.
//   2. Politeness. fetchDelayMs is 0 here where production paces every
//      fetch (plus any robots.txt Crawl-delay, §3.10.4) — a deliberate
//      per-page floor that would otherwise BE the measurement.
//   3. Model load. The local embedder initializes ONNX once per process
//      (seconds), so it is warmed outside the timed window: a boot cost,
//      not a per-crawl cost.
//
// And one stated ceiling: §3.3.1 says the queue's real throughput limit is
// embedding-API rate limits, not CPU — a remote free tier meters
// per-request (batchEmbedContents even per ITEM, §7.9), so the local-model
// row is the honest upper bound for a keyless stack, not a claim about
// hosted providers.
//
// Three rows, because they answer different questions:
//   - cold, mock embedder: everything EXCEPT embedding (parse/chunk/store).
//   - cold, local bge-small-en-v1.5: the real end-to-end number on the
//     model CI and the eval harness use.
//   - unchanged re-crawl: the content_hash short-circuit (§3.10.5) as a
//     NUMBER — what a tenant's Re-crawl costs when nothing changed, which
//     is the case the short-circuit exists for.
//
// Wrongness guards, in the tenant-scan tradition (§3.29): the runner
// REFUSES to start if the queue already holds live jobs (tick() claims the
// oldest queued job, so suite residue would hijack the bench — the §3.8
// run-book gotcha), and a run with ANY skipped page fails loudly rather
// than publishing a number over a silently shrunken denominator.
//
// Everything it creates is deleted at the end, including on Ctrl-C. Like
// the load harness (§10.4) this is deliberately NOT a CI gate: throughput
// on a shared runner measures the runner.
//
// Usage:
//   npm run ingest-bench                 all three rows
//   npm run ingest-bench -- --mock-only  skip the local-model rows (no
//                                        fastembed download on a cold box)
//#endregion

//#region Imports
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
//#endregion

//#region Env fallback
// The block every sibling CLI carries (§3.11): already-set env always wins,
// and it must run BEFORE @/db/pool loads, since the pool reads env at module
// load — which is why main() defers every import that touches it.
if (!process.env.POSTGRES_PASSWORD) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../../.env"), "utf8")
    for (const line of envFile.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]
      }
    }
  } catch {
    // No .env — the check below says exactly what is missing.
  }
}

if (!process.env.POSTGRES_PASSWORD) {
  console.error(
    "ingest-bench needs a database: set POSTGRES_PASSWORD (or fill .env) and start the compose database.",
  )
  process.exit(1)
}
//#endregion

//#region Arguments
const MOCK_ONLY = process.argv.includes("--mock-only")
//#endregion

//#region Corpus discovery
/** Every committed corpus page, as url-path → absolute file path. The map
 *  is also the server's routing table, so nothing outside it is servable
 *  and the page count in the report is the count on disk. */
function corpusFiles(): Map<string, string> {
  const root = resolve(__dirname, "../../eval/corpus")
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(".md") && name !== "PROVENANCE.md") {
        files.set(`/corpus/${relative(root, full).replaceAll("\\", "/")}`, full)
      }
    }
  }
  walk(root)
  if (files.size === 0) throw new Error(`no corpus pages found under ${root}`)
  return files
}
//#endregion

//#region Runner
async function main(): Promise<void> {
  // Deferred so the env fallback above lands before the pool constructs.
  const { createServer } = await import("node:http")
  const { db } = await import("@/db/pool")
  const { migrateToLatest } = await import("@/db/migrate")
  const { newId } = await import("@shared/utils/ids")
  const { IngestWorker } = await import("@/ingest/worker")
  const { crawl } = await import("@/ingest/crawler")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")

  type CrawlSource = import("@/ingest/crawler").CrawlSource
  type CrawlEvent = import("@/ingest/crawler").CrawlEvent
  type EmbeddingProvider = import("@providers/embedding/types").EmbeddingProvider

  await migrateToLatest(db)

  // Refuse a queue that is not ours. tick() claims the OLDEST queued job,
  // so a leftover row from a test suite would be what gets timed — and its
  // crawl of an unreachable fixture host would burn real attempts on state
  // this bench does not own.
  const leftovers = await db
    .selectFrom("ingest_jobs")
    .select(["id", "state"])
    .where("state", "in", ["queued", "running"])
    .execute()
  if (leftovers.length > 0) {
    console.error(
      `the queue already holds ${leftovers.length} live job(s) (${leftovers
        .map((j) => `${j.id}:${j.state}`)
        .join(", ")}) — a bench tick would claim the oldest of them instead of its own. ` +
        "Delete the residue (usually a test suite's) or run against a clean database.",
    )
    process.exit(1)
  }

  //#region Loopback corpus server
  const files = corpusFiles()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (path === "/sitemap.xml") {
      const locs = [...files.keys()]
        .map((p) => `  <url><loc>http://127.0.0.1:${port}${p}</loc></url>`)
        .join("\n")
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${locs}\n</urlset>\n`)
      return
    }
    const file = files.get(path)
    if (file === undefined) {
      // robots.txt lands here too: 404 is "no file, everything allowed"
      // (§3.10.6), the common case for a small docs site.
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" })
    res.end(readFileSync(file))
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  //#endregion

  const createdOrgs: string[] = []
  const cleanup = async (): Promise<void> => {
    if (createdOrgs.length === 0) return
    await db.deleteFrom("organizations").where("id", "in", createdOrgs).execute()
    createdOrgs.length = 0
  }
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130))
  })

  /** Counts embedded texts so the short-circuit row can PROVE it embedded
   *  nothing — the worker suite's counting-embedder idiom. */
  const counting = (
    inner: EmbeddingProvider,
  ): { provider: EmbeddingProvider; embedded: () => number } => {
    let texts = 0
    return {
      provider: {
        model: inner.model,
        dim: inner.dim,
        embed: (input, options) => {
          texts += input.length
          return inner.embed(input, options)
        },
      },
      embedded: () => texts,
    }
  }

  interface BenchRow {
    label: string
    pages: number
    chunks: number
    embeddedTexts: number
    wallMs: number
  }
  const rows: BenchRow[] = []

  /** One timed tick of the real worker over one freshly queued job. The org
   *  and source persist across calls so the re-crawl row can reuse them. */
  const runJob = async (
    label: string,
    orgId: string,
    sourceId: string,
    embedder: EmbeddingProvider,
    embedded: () => number,
  ): Promise<void> => {
    const jobId = newId("job")
    await db
      .insertInto("ingest_jobs")
      .values({ id: jobId, org_id: orgId, source_id: sourceId })
      .execute()
    const worker = new IngestWorker({
      db,
      embedder,
      crawler: (source: CrawlSource): AsyncGenerator<CrawlEvent> =>
        crawl(source, { fetchDelayMs: 0, fetchOptions: { hostGuard: () => {} } }),
    })

    const embeddedBefore = embedded()
    const startedAt = Date.now()
    await worker.tick()
    const wallMs = Date.now() - startedAt

    const job = await db
      .selectFrom("ingest_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()
    if (job.state !== "done") {
      throw new Error(
        `${label}: job finished '${job.state}' (${job.error ?? "no error recorded"}) — nothing to publish`,
      )
    }
    // A skipped page is a shrunken denominator wearing a healthy state:
    // 25 of 31 pages would produce a rate that looks fine and means nothing.
    if (job.skipped_count > 0) {
      throw new Error(
        `${label}: ${job.skipped_count} page(s) skipped — ` +
          JSON.stringify(job.skipped_pages) +
          " — a throughput number over a partial crawl is not published",
      )
    }

    const count = async (table: "documents" | "chunks" | "chunk_embeddings"): Promise<number> => {
      const row = await db
        .selectFrom(table)
        .select(db.fn.countAll().as("n"))
        .where("org_id", "=", orgId)
        .executeTakeFirstOrThrow()
      return Number(row.n)
    }
    const pages = job.docs_done ?? 0
    rows.push({
      label,
      pages,
      chunks: await count("chunks"),
      embeddedTexts: embedded() - embeddedBefore,
      wallMs,
    })
    console.log(
      `  ${label}: ${pages} pages in ${wallMs} ms (chunks in org: ${await count("chunks")}, embeddings: ${await count("chunk_embeddings")})`,
    )
  }

  /** Org + sitemap source pointing at the loopback server. */
  const makeSource = async (name: string): Promise<{ orgId: string; sourceId: string }> => {
    const orgId = newId("org")
    createdOrgs.push(orgId)
    await db.insertInto("organizations").values({ id: orgId, name }).execute()
    const sourceId = newId("src")
    await db
      .insertInto("sources")
      .values({
        id: sourceId,
        org_id: orgId,
        kind: "sitemap",
        location: `http://127.0.0.1:${port}/sitemap.xml`,
        crawl_depth: 1,
      })
      .execute()
    return { orgId, sourceId }
  }

  try {
    console.log(
      `ingest-bench — ${files.size} corpus pages over loopback :${port}, real worker, real crawler\n`,
    )

    const mock = counting(new MockEmbeddingProvider())
    const mockSite = await makeSource("Ingest Bench (mock)")
    await runJob(
      "cold, mock embedder",
      mockSite.orgId,
      mockSite.sourceId,
      mock.provider,
      mock.embedded,
    )

    if (!MOCK_ONLY) {
      const { LocalEmbeddingProvider } = await import("@providers/embedding/local")
      const local = counting(new LocalEmbeddingProvider())
      // Model load is a boot cost, not a per-crawl cost: one warmup call
      // initializes ONNX outside every timed window.
      await local.provider.embed(["warmup"])

      const localSite = await makeSource("Ingest Bench (local)")
      await runJob(
        "cold, local bge-small-en-v1.5",
        localSite.orgId,
        localSite.sourceId,
        local.provider,
        local.embedded,
      )
      await runJob(
        "unchanged re-crawl (short-circuit)",
        localSite.orgId,
        localSite.sourceId,
        local.provider,
        local.embedded,
      )
    }

    // The table, in the shape eval/RESULTS.md publishes it.
    console.log(
      "\n| configuration | pages | chunks in org | texts embedded | wall | pages/s | chunks/s |",
    )
    console.log("|---|---|---|---|---|---|---|")
    for (const row of rows) {
      const seconds = row.wallMs / 1000
      console.log(
        `| ${row.label} | ${row.pages} | ${row.chunks} | ${row.embeddedTexts} | ` +
          `${seconds.toFixed(2)} s | ${(row.pages / seconds).toFixed(1)} | ${(row.chunks / seconds).toFixed(0)} |`,
      )
    }
    console.log(
      "\nWhat these numbers exclude, on purpose: network (loopback fetches), politeness " +
        "(fetchDelayMs 0 here; production paces every fetch, plus any robots.txt Crawl-delay), " +
        "and model load (warmed outside the window — a boot cost). The production ceiling is the " +
        "embedding provider's rate limit, not this pipeline (§3.3.1): the local-model row is the " +
        "keyless stack's honest upper bound, and the re-crawl row is what an unchanged site costs " +
        "thanks to the content_hash short-circuit.",
    )
  } finally {
    server.close()
    await cleanup()
    await db.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
//#endregion
