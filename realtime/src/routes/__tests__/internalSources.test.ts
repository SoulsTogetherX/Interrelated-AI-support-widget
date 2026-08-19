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
import { buildPdf } from "@/ingest/__tests__/pdfFixtures"

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

  it("re-crawls a source: one queued job per click-storm, the wake fired once (M7.5)", async () => {
    const created = await post(`/internal/orgs/${orgId}/sources`, { kind: "url", location: "https://recrawl.example/" })
    const { sourceId, jobId: firstJob } = (await created.json()) as { sourceId: string; jobId: string }
    // Finish the connect-time job so the source is idle, as it would be
    // after its first crawl.
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", firstJob).execute()
    const before = enqueueCalls

    // Five concurrent clicks: exactly one job, one wake, four honest
    // `queued: false` — the partial unique index deciding, not a read.
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => post(`/internal/orgs/${orgId}/sources/${sourceId}/recrawl`, {})),
    )
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    const bodies = (await Promise.all(answers.map((r) => r.json()))) as Array<{ queued: boolean; jobId?: string }>
    expect(bodies.filter((b) => b.queued)).toHaveLength(1)
    expect(bodies.filter((b) => !b.queued)).toHaveLength(4)
    expect(enqueueCalls).toBe(before + 1)
    const live = await db
      .selectFrom("ingest_jobs").select("id")
      .where("source_id", "=", sourceId).where("state", "in", ["queued", "running"]).execute()
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(bodies.find((b) => b.queued)?.jobId)

    // Once that job is done, the source can be re-crawled again.
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", live[0]?.id as string).execute()
    const again = await post(`/internal/orgs/${orgId}/sources/${sourceId}/recrawl`, {})
    const againBody = (await again.json()) as { queued: boolean; jobId: string }
    expect(againBody.queued).toBe(true)
    expect(enqueueCalls).toBe(before + 2)
    // Park it: a queued job here would be the oldest in the queue, and the
    // wake-driven worker test below runs one job per tick.
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", againBody.jobId).execute()
  })

  it("re-crawl refuses what is not this org's, not a source, or not an id", async () => {
    const before = enqueueCalls
    // Another org's source: the same 404 a fabricated or malformed id gets.
    const otherOrg = newId("org")
    await db.insertInto("organizations").values({ id: otherOrg, name: "Other Sources Org" }).execute()
    const foreign = newId("src")
    await db.insertInto("sources").values({ id: foreign, org_id: otherOrg, kind: "url", location: "https://theirs.example/" }).execute()
    expect((await post(`/internal/orgs/${orgId}/sources/${foreign}/recrawl`, {})).status).toBe(404)
    expect((await post(`/internal/orgs/${orgId}/sources/${newId("src")}/recrawl`, {})).status).toBe(404)
    expect((await post(`/internal/orgs/${orgId}/sources/not-an-id/recrawl`, {})).status).toBe(404)
    // Without the secret, nothing at all.
    const bare = await fetch(`${base}/internal/orgs/${orgId}/sources/${foreign}/recrawl`, { method: "POST" })
    expect(bare.status).toBe(401)
    expect(enqueueCalls).toBe(before)
    await db.deleteFrom("organizations").where("id", "=", otherOrg).execute()
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

  //#region Uploads (M7.6b)
  /** Raw bytes plus the two metadata headers, as the dashboard sends them. */
  function upload(bytes: Buffer, filename: string, declaredType = "application/octet-stream"): Promise<Response> {
    return fetch(`${base}/internal/orgs/${orgId}/sources/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-upload-filename": encodeURIComponent(filename),
        "x-upload-content-type": declaredType,
        "x-internal-secret": SECRET,
      },
      body: new Uint8Array(bytes),
    })
  }

  it("uploads a PDF: parsed in the request, text stored, job queued, wake fired", async () => {
    const before = enqueueCalls
    const pdf = buildPdf(
      [{ lines: ["Refunds are issued within 14 days of purchase.", "Contact support to start one."] }],
      { info: { Title: "Refund Policy" } },
    )
    const res = await upload(pdf, "refund policy.pdf", "application/pdf")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sourceId: string; jobId: string; filename: string; format: string; title: string | null; charCount: number
    }
    expect(body.sourceId.startsWith("src_")).toBe(true)
    // Title from the Info dictionary, format detected from the MAGIC BYTES —
    // and a character count, which is the only honest answer to "did that
    // work?" about a file the service no longer holds.
    expect(body).toMatchObject({ filename: "refund policy.pdf", format: "pdf", title: "Refund Policy" })
    expect(body.charCount).toBeGreaterThan(40)
    expect(enqueueCalls).toBe(before + 1)

    const source = await db.selectFrom("sources").selectAll()
      .where("id", "=", body.sourceId).executeTakeFirstOrThrow()
    expect(source).toMatchObject({ org_id: orgId, kind: "upload", location: "refund policy.pdf", crawl_depth: 0 })

    const stored = await db.selectFrom("source_uploads").selectAll()
      .where("source_id", "=", body.sourceId).executeTakeFirstOrThrow()
    expect(stored.format).toBe("pdf")
    expect(stored.byte_size).toBe(pdf.byteLength)
    expect(stored.text).toContain("Refunds are issued within 14 days")
    // The blocks are SPANS, and every one slices back out of the stored text
    // — the parser contract surviving a round trip through Postgres, which
    // is the whole basis for not storing the text a second time.
    expect(stored.blocks.length).toBeGreaterThan(0)
    for (const b of stored.blocks) {
      expect(typeof b.charStart).toBe("number")
      expect(stored.text.slice(b.charStart, b.charEnd).length).toBeGreaterThan(0)
      expect(b).not.toHaveProperty("text")
    }

    const job = await db.selectFrom("ingest_jobs").selectAll()
      .where("id", "=", body.jobId).executeTakeFirstOrThrow()
    expect(job).toMatchObject({ source_id: body.sourceId, state: "queued" })
    // Park it — one job per tick, and the wake-driven worker case is below.
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", body.jobId).execute()
  })

  it("detects the format from the bytes, not from the browser's claim", async () => {
    // A PDF the browser called text/plain: misconfigured clients do this
    // daily, and the magic bytes are what decide (parsers/index.ts).
    const pdf = buildPdf([{ lines: ["A sentence that is unmistakably prose."] }])
    const res = await upload(pdf, "mislabelled.txt", "text/plain")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sourceId: string; jobId: string; format: string }
    expect(body.format).toBe("pdf")
    const stored = await db.selectFrom("source_uploads").select("text")
      .where("source_id", "=", body.sourceId).executeTakeFirstOrThrow()
    // Parsed as a PDF rather than decoded as text: the binary header is gone.
    expect(stored.text).not.toContain("%PDF")
    expect(stored.text).toContain("unmistakably prose")
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", body.jobId).execute()
  })

  it("keeps a markdown upload's heading structure, which a PDF cannot have", async () => {
    const md = Buffer.from("# Billing\n\n## Refunds\n\nRefunds take 14 days.\n", "utf8")
    const res = await upload(md, "billing.md", "text/markdown")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sourceId: string; jobId: string; format: string; title: string | null }
    expect(body).toMatchObject({ format: "markdown", title: "Billing" })
    const stored = await db.selectFrom("source_uploads").select(["text", "blocks"])
      .where("source_id", "=", body.sourceId).executeTakeFirstOrThrow()
    const headings = stored.blocks.filter((b) => b.kind === "heading")
    expect(headings).toHaveLength(2)
    expect(stored.text.slice(headings[1]!.charStart, headings[1]!.charEnd)).toContain("Refunds")
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", body.jobId).execute()
  })

  it("refuses what cannot be read, with a sentence and nothing stored", async () => {
    const before = enqueueCalls
    const sourcesBefore = await db.selectFrom("sources").select("id").where("org_id", "=", orgId).execute()

    // A scan — a PDF with no text layer. The refusal names OCR, because that
    // is the thing the tenant can actually do about it.
    const scanRes = await upload(buildPdf([{ lines: [] }]), "scanned.pdf", "application/pdf")
    expect(scanRes.status).toBe(422)
    expect(((await scanRes.json()) as { error: string }).error).toMatch(/OCR/i)

    // Bytes that claim to be a PDF and are not.
    expect((await upload(Buffer.from("%PDF-1.7\nnot really", "utf8"), "broken.pdf", "application/pdf")).status).toBe(422)

    // An empty file and a nameless one.
    expect((await upload(Buffer.alloc(0), "empty.md")).status).toBe(422)
    expect((await upload(Buffer.from("text", "utf8"), "")).status).toBe(422)

    // A file whose text is only whitespace parses, but is refused rather
    // than stored as a source that reads "ready" and answers nothing.
    const blankRes = await upload(Buffer.from("   \n\n  \n", "utf8"), "blank.md")
    expect(blankRes.status).toBe(422)
    expect(((await blankRes.json()) as { error: string }).error).toMatch(/no text/i)

    // A name that is a path is a legal upload once the path is stripped: a
    // filename here is a LABEL, never a location, so there is nothing to
    // traverse — but the segments must not survive into the row either.
    const traversalRes = await upload(Buffer.from("Readable text.\n", "utf8"), "../../etc/passwd")
    expect(traversalRes.status).toBe(200)
    const traversal = (await traversalRes.json()) as { sourceId: string; jobId: string; filename: string }
    expect(traversal.filename).toBe("passwd")

    // Exactly that one source was created — every refusal stored nothing.
    const sourcesAfter = await db.selectFrom("sources").select("id").where("org_id", "=", orgId).execute()
    expect(sourcesAfter.length).toBe(sourcesBefore.length + 1)
    expect(enqueueCalls).toBe(before + 1)
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", traversal.jobId).execute()
  })

  it("refuses an oversized file with 413, before the parser sees a byte", async () => {
    const before = enqueueCalls
    // 11 MB behind a valid PDF header: only the size cap can be what rejects
    // this, and it must do so without the parser ever running.
    const oversized = Buffer.concat([Buffer.from("%PDF-1.7\n", "utf8"), Buffer.alloc(11 * 1024 * 1024, 0x20)])
    const res = await upload(oversized, "huge.pdf", "application/pdf")
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toMatch(/larger than 10 MB/)
    expect(enqueueCalls).toBe(before)
  })

  it("refuses an upload without the secret, and for an org that is not one", async () => {
    const before = enqueueCalls
    const bytes = new Uint8Array(Buffer.from("# Doc\n\nText.\n", "utf8"))
    const headers = {
      "content-type": "application/octet-stream",
      "x-upload-filename": "doc.md",
      "x-upload-content-type": "text/markdown",
    }
    const bare = await fetch(`${base}/internal/orgs/${orgId}/sources/upload`, { method: "POST", headers, body: bytes })
    expect(bare.status).toBe(401)
    const foreign = await fetch(`${base}/internal/orgs/${newId("org")}/sources/upload`, {
      method: "POST", headers: { ...headers, "x-internal-secret": SECRET }, body: bytes,
    })
    expect(foreign.status).toBe(404)
    expect(enqueueCalls).toBe(before)
  })

  it("re-indexes an upload from its stored text — the 422 that used to live here", async () => {
    const md = Buffer.from("# Handbook\n\nPolicies live here.\n", "utf8")
    const { sourceId, jobId } = (await (await upload(md, "handbook.md", "text/markdown")).json()) as
      { sourceId: string; jobId: string }
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", jobId).execute()
    const before = enqueueCalls

    // An upload whose FIRST ingest failed — a wrong embedding credential, a
    // provider outage — used to leave the tenant nothing to click but "upload
    // it again". The stored text is exactly what a retry needs, so re-index
    // is now an ordinary enqueue.
    const res = await post(`/internal/orgs/${orgId}/sources/${sourceId}/recrawl`, {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { queued: boolean; jobId: string }
    expect(body.queued).toBe(true)
    expect(enqueueCalls).toBe(before + 1)
    await db.updateTable("ingest_jobs").set({ state: "done" }).where("id", "=", body.jobId).execute()
  })
  //#endregion

  it("a WOKEN wake-driven worker runs the job with no poll timer", async () => {
    // pollMs 0: after the start tick the worker is fully idle — no timer
    // exists to find this job. Only wake() can, which is the production
    // contract the enqueue route's onEnqueue fulfills.
    const worker = new IngestWorker({ db, embedder: new MockEmbeddingProvider(), pollMs: 0 })
    worker.start()
    await new Promise((r) => setTimeout(r, 50)) // let the start tick drain (no jobs yet)

    // An upload-kind source with NO source_uploads row: the worker fails it
    // FAST and loudly — an upload is ingested from its stored extraction
    // (M7.6b), and one written without it is a broken invariant the worker
    // refuses rather than treating as an empty crawl. Which makes it the
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
