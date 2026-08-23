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
    // Pro, not the default free: since M8.5 the plan's source ceiling is
    // enforced at both create routes, this suite creates sources freely
    // because that is not what it is about, and free's ceiling is ONE. The
    // ceiling has its own block below, with its own orgs at their own tiers.
    await db.insertInto("organizations").values({ id: orgId, name: "Sources Test Org", plan: "pro" }).execute()

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

  //#region The source ceiling, and delete (M8.5)
  // The plan catalog had advertised a per-tier source limit on the billing
  // page since M5.3 with nothing checking it — the state its own comment
  // called "worse than none". These cases pin the enforcement at both
  // create routes, the concurrency guarantee (org row locked), and the
  // delete route that makes a cap on a formerly add-only resource honest.
  //
  // Every case makes its OWN org and deletes it in a `finally` — the
  // migrate suite's convention (§3.8) — because a leftover QUEUED job would
  // be claimed by the worker test below, whose woken tick runs exactly one
  // job (it bit that suite once already).

  /** DELETE with the secret, the upload()/post() sibling. */
  function del(path: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "DELETE",
      headers: { "x-internal-secret": SECRET },
    })
  }

  async function makeOrg(plan: "free" | "starter" | "pro"): Promise<string> {
    const id = newId("org")
    await db.insertInto("organizations").values({ id, name: `Cap ${id.slice(-6)}`, plan }).execute()
    return id
  }

  it("enforces the free plan's single slot at the second source, naming both ways out", async () => {
    const org = await makeOrg("free")
    try {
      const first = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-one.example/" })
      expect(first.status).toBe(200)

      const wakesBefore = enqueueCalls
      const second = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-two.example/" })
      expect(second.status).toBe(409)
      const body = (await second.json()) as { error: string }
      expect(body.error).toContain("Free plan allows 1 source")
      expect(body.error).toContain("Delete a source or upgrade")
      // Nothing landed and nothing woke: the refusal is a rollback, not a
      // half-created source.
      expect(enqueueCalls).toBe(wakesBefore)
      const rows = await db.selectFrom("sources").select("id").where("org_id", "=", org).execute()
      expect(rows).toHaveLength(1)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("holds an upload to the same ceiling, before the parse and with nothing stored", async () => {
    const org = await makeOrg("free")
    try {
      // The slot spent directly (a seeded source counts like any other —
      // the cap is a count of rows, not of route calls).
      await db.insertInto("sources").values({
        id: newId("src"), org_id: org, kind: "url", location: "https://cap-full.example/",
      }).execute()

      const wakesBefore = enqueueCalls
      const res = await fetch(`${base}/internal/orgs/${org}/sources/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-upload-filename": "notes.md",
          "x-upload-content-type": "text/markdown",
          "x-internal-secret": SECRET,
        },
        body: new Uint8Array(Buffer.from("# Notes\n\nA paragraph of real text.\n")),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain("Free plan allows 1 source")
      expect(enqueueCalls).toBe(wakesBefore)
      const uploads = await db.selectFrom("source_uploads")
        .innerJoin("sources", "sources.id", "source_uploads.source_id")
        .select("source_uploads.source_id")
        .where("sources.org_id", "=", org)
        .execute()
      expect(uploads).toHaveLength(0)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("opens the next slot on an upgrade — the limit is the PLAN's, read live", async () => {
    const org = await makeOrg("free")
    try {
      await db.insertInto("sources").values({
        id: newId("src"), org_id: org, kind: "url", location: "https://cap-full.example/",
      }).execute()
      const refused = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-more.example/" })
      expect(refused.status).toBe(409)

      await db.updateTable("organizations").set({ plan: "starter" }).where("id", "=", org).execute()
      const allowed = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-more.example/" })
      expect(allowed.status).toBe(200)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("admits exactly ONE of five concurrent creates on a free plan — the lock, not luck", async () => {
    // The reason the check runs with the org row locked: count-then-insert
    // races, and five concurrent requests would otherwise all count zero
    // and all land. This is the org-level sibling of the recrawl route's
    // click-storm case.
    const org = await makeOrg("free")
    try {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          post(`/internal/orgs/${org}/sources`, { kind: "url", location: `https://race-${i}.example/` }),
        ),
      )
      const statuses = results.map((r) => r.status).sort()
      expect(statuses).toEqual([200, 409, 409, 409, 409])
      const rows = await db.selectFrom("sources").select("id").where("org_id", "=", org).execute()
      expect(rows).toHaveLength(1)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("deleting a source frees its slot, without waking the worker", async () => {
    const org = await makeOrg("free")
    try {
      const first = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-cycle.example/" })
      const { sourceId } = (await first.json()) as { sourceId: string }

      const wakesBefore = enqueueCalls
      const removed = await del(`/internal/orgs/${org}/sources/${sourceId}`)
      expect(removed.status).toBe(200)
      expect((await removed.json()) as object).toEqual({ ok: true })
      expect(enqueueCalls).toBe(wakesBefore) // nothing was enqueued

      const again = await post(`/internal/orgs/${org}/sources`, { kind: "url", location: "https://cap-cycle-2.example/" })
      expect(again.status).toBe(200)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("delete takes the whole subtree and spares the transcript", async () => {
    // The §3.3.2 property — citations snapshot what they cite, no chunk FK —
    // exercised through a route for the first time: pipeline state dies,
    // history survives.
    const org = await makeOrg("pro")
    try {
      const sourceId = newId("src")
      await db.insertInto("sources").values({
        id: sourceId, org_id: org, kind: "upload", location: "manual.md",
      }).execute()
      await db.insertInto("source_uploads").values({
        source_id: sourceId, filename: "manual.md", format: "markdown",
        byte_size: 24, title: "Manual", text: "# Manual\n\nSome text.",
        blocks: JSON.stringify([{ kind: "paragraph", charStart: 10, charEnd: 20 }]),
      }).execute()
      const documentId = newId("doc")
      await db.insertInto("documents").values({
        id: documentId, org_id: org, source_id: sourceId,
        url: "manual.md", title: "Manual", content_hash: "a".repeat(64),
      }).execute()
      const chunkId = newId("chk")
      await db.insertInto("chunks").values({
        id: chunkId, org_id: org, document_id: documentId, ord: 0,
        heading_path: null, text: "Some text.", token_count: 3, char_start: null, char_end: null,
      }).execute()
      await db.insertInto("chunk_embeddings").values({
        chunk_id: chunkId, org_id: org, model: "mock-384", dim: 384,
        embedding: `[${Array.from({ length: 1024 }, () => 0).join(",")}]`,
      }).execute()
      const jobId = newId("job")
      await db.insertInto("ingest_jobs").values({
        id: jobId, org_id: org, source_id: sourceId, state: "done",
      }).execute()
      // A transcript that cited the chunk.
      const conversationId = newId("con")
      await db.insertInto("conversations").values({
        id: conversationId, org_id: org, visitor_id: "vis-cap",
      }).execute()
      const messageId = newId("msg")
      await db.insertInto("messages").values({
        id: messageId, conversation_id: conversationId, org_id: org,
        role: "assistant", content: "Some text.", model: "mock-llm",
        refused: false, schema_violations: 0,
      }).execute()
      await db.insertInto("message_citations").values({
        message_id: messageId, ord: 0, chunk_id: chunkId,
        claim_text: "Some text.", quote: "Some text.", verdict: "verified",
        span_start: 0, span_end: 10, url: "manual.md", heading_path: null,
      }).execute()

      const removed = await del(`/internal/orgs/${org}/sources/${sourceId}`)
      expect(removed.status).toBe(200)

      // The pipeline subtree is gone…
      expect(await db.selectFrom("sources").select("id").where("id", "=", sourceId).executeTakeFirst()).toBeUndefined()
      expect(await db.selectFrom("documents").select("id").where("id", "=", documentId).executeTakeFirst()).toBeUndefined()
      expect(await db.selectFrom("chunks").select("id").where("id", "=", chunkId).executeTakeFirst()).toBeUndefined()
      expect(await db.selectFrom("chunk_embeddings").select("chunk_id").where("chunk_id", "=", chunkId).executeTakeFirst()).toBeUndefined()
      expect(await db.selectFrom("source_uploads").select("source_id").where("source_id", "=", sourceId).executeTakeFirst()).toBeUndefined()
      expect(await db.selectFrom("ingest_jobs").select("id").where("id", "=", jobId).executeTakeFirst()).toBeUndefined()
      // …and the transcript's verdict is not: the citation still names the
      // chunk that no longer exists, which is exactly what the missing FK
      // was for.
      const citation = await db.selectFrom("message_citations")
        .select(["chunk_id", "verdict"]).where("message_id", "=", messageId).executeTakeFirstOrThrow()
      expect(citation).toMatchObject({ chunk_id: chunkId, verdict: "verified" })
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("refuses to delete under a RUNNING crawl, and takes a QUEUED one with it", async () => {
    const org = await makeOrg("pro")
    try {
      // Running: the worker holds this job, and cascading it away would
      // yank the row out from under a live crawl.
      const busyId = newId("src")
      await db.insertInto("sources").values({
        id: busyId, org_id: org, kind: "url", location: "https://busy.example/",
      }).execute()
      await db.insertInto("ingest_jobs").values({
        id: newId("job"), org_id: org, source_id: busyId,
        state: "running", locked_by: "worker-under-test", locked_at: new Date(), attempts: 1,
      }).execute()
      const refused = await del(`/internal/orgs/${org}/sources/${busyId}`)
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as { error: string }).error).toContain("running")
      expect(await db.selectFrom("sources").select("id").where("id", "=", busyId).executeTakeFirst()).toBeDefined()

      // Queued: nobody holds it — the delete takes the row lock, and the
      // worker's SKIP LOCKED claim cannot take a locked row, so the job
      // dies with its source instead of being claimed mid-delete.
      const idleId = newId("src")
      await db.insertInto("sources").values({
        id: idleId, org_id: org, kind: "url", location: "https://idle.example/",
      }).execute()
      const queuedJob = newId("job")
      await db.insertInto("ingest_jobs").values({
        id: queuedJob, org_id: org, source_id: idleId,
      }).execute()
      const removed = await del(`/internal/orgs/${org}/sources/${idleId}`)
      expect(removed.status).toBe(200)
      expect(await db.selectFrom("ingest_jobs").select("id").where("id", "=", queuedJob).executeTakeFirst()).toBeUndefined()
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("delete answers 404 for a foreign source, a fabricated id, and a non-id alike", async () => {
    const stranger = await makeOrg("free")
    try {
      const theirs = newId("src")
      await db.insertInto("sources").values({
        id: theirs, org_id: stranger, kind: "url", location: "https://theirs.example/",
      }).execute()

      // Another org's source under MY org's path: indistinguishable from
      // not existing — the recrawl route's stance.
      expect((await del(`/internal/orgs/${orgId}/sources/${theirs}`)).status).toBe(404)
      expect(await db.selectFrom("sources").select("id").where("id", "=", theirs).executeTakeFirst()).toBeDefined()
      expect((await del(`/internal/orgs/${orgId}/sources/${newId("src")}`)).status).toBe(404)
      expect((await del(`/internal/orgs/${orgId}/sources/not-an-id`)).status).toBe(404)
      // And without the secret: the uniform empty 401.
      const bare = await fetch(`${base}/internal/orgs/${orgId}/sources/${theirs}`, { method: "DELETE" })
      expect(bare.status).toBe(401)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", stranger).execute()
    }
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
    // 10 s ceiling, not the 2 s this used to allow: the loop exits the
    // moment the job fails, so the cap only ever binds when something is
    // WRONG, and a tight one converts an ordinary machine stall into a red
    // run — observed once (M8.5): state still "queued" at 2 s on an
    // otherwise idle box, green on every re-run. A wake is remembered
    // mid-tick by design, so the generous ceiling costs nothing but honesty
    // about how slow a loaded runner can be.
    for (let i = 0; i < 200 && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const row = await db
        .selectFrom("ingest_jobs").select("state").where("id", "=", jobId).executeTakeFirstOrThrow()
      state = row.state
    }
    expect(state).toBe("failed")
    await worker.stop()
  })
})
