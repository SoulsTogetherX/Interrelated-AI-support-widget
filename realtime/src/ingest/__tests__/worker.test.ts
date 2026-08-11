//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"

import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { crawl, CrawlError } from "@/ingest/crawler"
import type { CrawlEvent, CrawlSource } from "@/ingest/crawler"
import { parseMarkdown } from "@/ingest/parsers/markdown"
import { IngestWorker } from "@/ingest/worker"
import { newId } from "@shared/utils/ids"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import type { EmbeddingProvider } from "@providers/embedding/types"
//#endregion

//#region Test Setup
// Integration tests for the ingest worker — the first place the whole
// pipeline (queue → crawl → parse → chunk → embed → store) runs against a
// real Postgres AND a real (loopback) website. Same DB gating and schema
// reset as the other integration suites.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

//#region Fixture site
// A two-version site: version 2 changes a page's content and removes
// another — the exact situations the recrawl logic (hash short-circuit,
// chunk replacement, soft delete) exists for.
let server: Server
let base: string
let siteVersion = 1

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`

function serveSite(path: string): { status: number; body: string } {
  switch (path) {
    case "/docs/index.html":
      return {
        status: 200,
        body: page("Docs Home", `
          <h1>Docs Home</h1>
          <p>Welcome to the fixture documentation.</p>
          <a href="/docs/a.html">a</a>
          ${siteVersion === 1 ? '<a href="/docs/gone.html">gone</a>' : ""}`),
      }
    case "/docs/a.html":
      return {
        status: 200,
        body: page("A Guide", `
          <h1>A Guide</h1>
          <p>${siteVersion === 1 ? "Refunds take five business days." : "Refunds take ten business days now."}</p>`),
      }
    case "/docs/gone.html":
      if (siteVersion === 1) return { status: 200, body: page("Gone", "<h1>Gone</h1><p>Soon removed.</p>") }
      return { status: 404, body: "removed" }
    default:
      return { status: 404, body: "not found" }
  }
}
//#endregion

//#region Helpers
/** The mock embedder wrapped to record every embed() call — the recrawl
 *  short-circuit assertions are about calls NOT happening. */
const embedCalls: string[][] = []
const mockEmbedder = new MockEmbeddingProvider()
const countingEmbedder: EmbeddingProvider = {
  model: mockEmbedder.model,
  dim: mockEmbedder.dim,
  embed: (texts) => {
    embedCalls.push([...texts])
    return mockEmbedder.embed(texts)
  },
}

/** Worker under test: real crawler pointed at the loopback fixture. */
function makeWorker(overrides: Partial<ConstructorParameters<typeof IngestWorker>[0]> = {}): IngestWorker {
  return new IngestWorker({
    db,
    embedder: countingEmbedder,
    crawler: (source: CrawlSource) => crawl(source, { fetchDelayMs: 0, fetchOptions: { hostGuard: () => {} } }),
    ...overrides,
  })
}

async function makeOrg(name: string): Promise<string> {
  const id = newId("org")
  await db.insertInto("organizations").values({ id, name }).execute()
  return id
}

async function enqueue(orgId: string, source: { kind?: "url" | "sitemap" | "upload"; location: string; crawl_depth?: number; sourceId?: string }): Promise<{ sourceId: string; jobId: string }> {
  const sourceId = source.sourceId ?? newId("src")
  if (!source.sourceId) {
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: source.kind ?? "url",
      location: source.location, crawl_depth: source.crawl_depth ?? 1,
    }).execute()
  }
  const jobId = newId("job")
  await db.insertInto("ingest_jobs").values({ id: jobId, org_id: orgId, source_id: sourceId }).execute()
  return { sourceId, jobId }
}

const job = (id: string) => db.selectFrom("ingest_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const source = (id: string) => db.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const liveDocs = (sourceId: string) =>
  db.selectFrom("documents").selectAll().where("source_id", "=", sourceId).where("deleted_at", "is", null).execute()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A crawler factory that blocks on a gate before yielding each doc —
 *  the deterministic way to hold a job in the 'running' state. */
function gatedCrawler(pages: Array<{ url: string; markdown: string }>): {
  factory: () => AsyncGenerator<CrawlEvent>
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const factory = async function* (): AsyncGenerator<CrawlEvent> {
    for (const p of pages) {
      await gate
      yield { kind: "page", url: p.url, doc: parseMarkdown(p.markdown) }
    }
  }
  return { factory, release }
}
//#endregion

describe.skipIf(!DB_CONFIGURED)("ingest worker", () => {
  let orgId: string
  let mainSourceId: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const { status, body } = serveSite(new URL(req.url ?? "/", "http://x").pathname)
      res.writeHead(status, { "content-type": "text/html" }).end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    base = `http://127.0.0.1:${address.port}`

    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    await migrateToLatest(db)
    orgId = await makeOrg("Ingest Co")
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await db.destroy()
  })

  it("returns false from tick() on an empty queue", async () => {
    expect(await makeWorker().tick()).toBe(false)
  })

  //#region The full pipeline, three crawls of a changing site
  it("ingests a site end to end: documents, chunks, embeddings, statuses", async () => {
    const { sourceId, jobId } = await enqueue(orgId, { location: `${base}/docs/index.html` })
    mainSourceId = sourceId
    embedCalls.length = 0

    expect(await makeWorker().tick()).toBe(true)

    const j = await job(jobId)
    expect(j.state).toBe("done")
    expect(j.locked_by).toBeNull()
    expect(j.docs_done).toBe(3) // index + a + gone
    expect(j.docs_total).toBe(3)

    const s = await source(sourceId)
    expect(s.status).toBe("ready")
    expect(s.last_crawled_at).not.toBeNull()

    const docs = await liveDocs(sourceId)
    expect(docs.map((d) => d.title).sort()).toEqual(["A Guide", "Docs Home", "Gone"])
    const aDoc = docs.find((d) => d.title === "A Guide") as (typeof docs)[number]

    const chunks = await db.selectFrom("chunks").selectAll().where("document_id", "=", aDoc.id).execute()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.heading_path).toBe("A Guide")
    expect(chunks[0]?.text).toContain("five business days")

    // Every chunk carries an embedding under the worker's model, and the
    // embedded text was the chunk PREFIXED with its heading trail.
    const embeddings = await db.selectFrom("chunk_embeddings").selectAll().where("org_id", "=", orgId).execute()
    const allChunks = await db.selectFrom("chunks").selectAll().where("org_id", "=", orgId).execute()
    expect(embeddings).toHaveLength(allChunks.length)
    expect(embeddings.every((e) => e.model === "mock-384" && e.dim === 384)).toBe(true)
    expect(embedCalls.flat().some((t) => t.startsWith("A Guide\n"))).toBe(true)
  })

  it("skips re-embedding when a recrawl finds identical content", async () => {
    const { jobId } = await enqueue(orgId, { sourceId: mainSourceId, location: "" })
    const chunksBefore = await db.selectFrom("chunks").selectAll().where("org_id", "=", orgId).execute()
    embedCalls.length = 0

    expect(await makeWorker().tick()).toBe(true)

    expect((await job(jobId)).state).toBe("done")
    expect(embedCalls).toHaveLength(0) // the whole point of content_hash
    const chunksAfter = await db.selectFrom("chunks").selectAll().where("org_id", "=", orgId).execute()
    expect(chunksAfter.map((c) => c.id).sort()).toEqual(chunksBefore.map((c) => c.id).sort())
  })

  it("re-chunks changed pages and soft-deletes vanished ones", async () => {
    siteVersion = 2 // a.html rewritten; gone.html removed
    const { jobId } = await enqueue(orgId, { sourceId: mainSourceId, location: "" })
    embedCalls.length = 0

    expect(await makeWorker().tick()).toBe(true)
    expect((await job(jobId)).state).toBe("done")

    const docs = await liveDocs(mainSourceId)
    expect(docs.map((d) => d.title).sort()).toEqual(["A Guide", "Docs Home"])
    const aDoc = docs.find((d) => d.title === "A Guide") as (typeof docs)[number]
    const aChunks = await db.selectFrom("chunks").selectAll().where("document_id", "=", aDoc.id).execute()
    expect(aChunks.some((c) => c.text.includes("ten business days"))).toBe(true)
    expect(aChunks.some((c) => c.text.includes("five business days"))).toBe(false)
    expect(embedCalls.length).toBeGreaterThan(0)

    // The removed page survives as a tombstone, not as retrievable content.
    const tombstone = await db
      .selectFrom("documents").selectAll()
      .where("source_id", "=", mainSourceId).where("deleted_at", "is not", null)
      .executeTakeFirst()
    expect(tombstone?.title).toBe("Gone")
  })
  //#endregion

  //#region Queue semantics
  it("lets two workers claim distinct jobs concurrently", async () => {
    const org2 = await makeOrg("Contention Co")
    const gateA = gatedCrawler([{ url: "https://a.test/page", markdown: "# A\n\nalpha" }])
    const gateB = gatedCrawler([{ url: "https://b.test/page", markdown: "# B\n\nbeta" }])
    const a = await enqueue(org2, { location: "https://a.test" })
    const b = await enqueue(org2, { location: "https://b.test" })

    const workerA = makeWorker({ workerId: "worker-A", crawler: gateA.factory })
    const workerB = makeWorker({ workerId: "worker-B", crawler: gateB.factory })
    const ticks = Promise.all([workerA.tick(), workerB.tick()])

    // Both jobs must reach 'running' under DIFFERENT owners — SKIP LOCKED
    // working as designed. Poll rather than sleep-and-hope.
    let owners: Array<string | null> = []
    for (let i = 0; i < 100; i++) {
      const rows = await db.selectFrom("ingest_jobs").select(["locked_by", "state"])
        .where("id", "in", [a.jobId, b.jobId]).execute()
      if (rows.every((r) => r.state === "running")) { owners = rows.map((r) => r.locked_by); break }
      await sleep(20)
    }
    expect(owners.sort()).toEqual(["worker-A", "worker-B"])

    gateA.release()
    gateB.release()
    expect(await ticks).toEqual([true, true])
    expect((await job(a.jobId)).state).toBe("done")
    expect((await job(b.jobId)).state).toBe("done")
  })

  it("requeues a stale lease with attempts remaining, fails one without", async () => {
    const org3 = await makeOrg("Stale Co")
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000)

    const fresh = await enqueue(org3, { location: "https://stale.test" })
    await db.updateTable("ingest_jobs")
      .set({ state: "running", locked_by: "worker-dead", locked_at: twentyMinAgo, attempts: 1 })
      .where("id", "=", fresh.jobId).execute()

    const spent = await enqueue(org3, { location: "https://spent.test" })
    await db.updateTable("ingest_jobs")
      .set({ state: "running", locked_by: "worker-dead", locked_at: twentyMinAgo, attempts: 3 })
      .where("id", "=", spent.jobId).execute()

    // Empty crawl: this test is about lease bookkeeping, not ingestion.
    const emptyCrawler = async function* (): AsyncGenerator<CrawlEvent> {}
    await makeWorker({ crawler: emptyCrawler }).tick()

    // The reclaimed job was requeued and (being oldest) claimed and run.
    expect((await job(fresh.jobId)).state).toBe("done")
    const dead = await job(spent.jobId)
    expect(dead.state).toBe("failed")
    expect(dead.error).toContain("lease expired")
    expect(dead.locked_by).toBeNull()
  })

  it("stop() requeues the in-flight job between pages", async () => {
    const org4 = await makeOrg("Stop Co")
    // Page one flows immediately; page two waits on a gate. The test stops
    // the worker while it sits between the two — the only ordering in which
    // "requeue between pages" is observable deterministically.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const factory = async function* (): AsyncGenerator<CrawlEvent> {
      yield { kind: "page", url: "https://stop.test/one", doc: parseMarkdown("# One\n\nfirst page") }
      await gate
      yield { kind: "page", url: "https://stop.test/two", doc: parseMarkdown("# Two\n\nsecond page") }
    }
    const { sourceId, jobId } = await enqueue(org4, { location: "https://stop.test" })
    const worker = makeWorker({ crawler: factory })

    const tick = worker.tick()
    for (let i = 0; i < 100 && (await job(jobId)).docs_done !== 1; i++) await sleep(20)
    expect((await job(jobId)).docs_done).toBe(1) // page one landed; worker is at the gate

    await worker.stop() // sets the flag; the in-flight tick is the `tick` promise we hold
    release()
    expect(await tick).toBe(true)

    const j = await job(jobId)
    expect(j.state).toBe("queued")
    expect(j.locked_by).toBeNull()
    expect((await source(sourceId)).status).toBe("pending")

    const docs = await liveDocs(sourceId)
    expect(docs.map((d) => d.url)).toEqual(["https://stop.test/one"])

    // Park the requeued job so later tests' ticks don't adopt it.
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", jobId).execute()
  })
  //#endregion

  //#region Failure paths
  it("fails the job and the source when the crawl is unrunnable", async () => {
    const org5 = await makeOrg("Broken Co")
    const boom = async function* (): AsyncGenerator<CrawlEvent> {
      throw new CrawlError("root fetch failed: HTTP 500")
    }
    const { sourceId, jobId } = await enqueue(org5, { location: "https://broken.test" })
    expect(await makeWorker({ crawler: boom }).tick()).toBe(true)

    const j = await job(jobId)
    expect(j.state).toBe("failed")
    expect(j.error).toContain("root fetch failed")
    expect(j.locked_by).toBeNull()
    expect((await source(sourceId)).status).toBe("failed")
  })

  it("fails a queue job for an upload source instead of crawling it", async () => {
    const org6 = await makeOrg("Upload Co")
    const { sourceId, jobId } = await enqueue(org6, { kind: "upload", location: "manual.pdf" })
    expect(await makeWorker().tick()).toBe(true)
    expect((await job(jobId)).error).toContain("not crawlable")
    expect((await source(sourceId)).status).toBe("failed")
  })
  //#endregion
})

// Placeholder so the file is never empty when the DB is absent — same
// convention as the other integration suites.
describe.skipIf(DB_CONFIGURED)("ingest worker (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
//#endregion
