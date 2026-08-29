//#region Imports
import { Kysely, PostgresDialect, sql } from "kysely"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import type { Database } from "@/db/schema"
import { denseSearch, hybridSearch, lexicalSearch } from "@/retrieval/search"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"
//#endregion

//#region Test Setup
// Integration tests for hybrid retrieval — same gating and schema-reset
// convention as the db suites (see migrate.test.ts). fileParallelism is off,
// so this file owns the database while it runs.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

// The same deterministic embedder the ingest worker uses under
// EMBEDDING_PROVIDER=mock: same text → same vector, so a query embedded
// with a chunk's exact text lands at cosine distance ~0 from it. All
// SEMANTIC-quality claims belong to the eval harness (next increment, local
// model); these tests prove the machinery — filters, fusion, tenancy —
// which is exactly what the mock exists for.
const embedder = new MockEmbeddingProvider()

async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedder.embed([text])
  return vector
}

/** Inserts a chunk row + its mock embedding for each text, batched to stay
 *  far from pg's parameter cap. Returns chunk ids in text order. */
async function insertChunks(
  rows: ReadonlyArray<{
    orgId: string
    documentId: string
    ord: number
    text: string
    headingPath?: string | null
    charStart?: number | null
    charEnd?: number | null
  }>,
): Promise<string[]> {
  const vectors = await embedder.embed(rows.map((r) => r.text))
  const ids = rows.map(() => newId("chk"))
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    await db
      .insertInto("chunks")
      .values(
        rows.slice(i, i + BATCH).map((r, j) => ({
          id: ids[i + j],
          org_id: r.orgId,
          document_id: r.documentId,
          ord: r.ord,
          heading_path: r.headingPath ?? null,
          text: r.text,
          token_count: Math.max(1, Math.ceil(r.text.length / 4)),
          char_start: r.charStart ?? null,
          char_end: r.charEnd ?? null,
        })),
      )
      .execute()
    await db
      .insertInto("chunk_embeddings")
      .values(
        rows.slice(i, i + BATCH).map((r, j) => ({
          chunk_id: ids[i + j],
          org_id: r.orgId,
          model: embedder.model,
          dim: embedder.dim,
          embedding: toPgvector(padVector(vectors[i + j])),
        })),
      )
      .execute()
  }
  return ids
}

async function seedOrg(name: string): Promise<{ orgId: string; sourceId: string }> {
  const orgId = newId("org")
  await db.insertInto("organizations").values({ id: orgId, name }).execute()
  const sourceId = newId("src")
  await db
    .insertInto("sources")
    .values({
      id: sourceId,
      org_id: orgId,
      kind: "url",
      location: `https://${name.toLowerCase().replace(/\s+/g, "-")}.example.com`,
    })
    .execute()
  return { orgId, sourceId }
}

async function seedDocument(
  orgId: string,
  sourceId: string,
  url: string,
  opts: { title?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = newId("doc")
  await db
    .insertInto("documents")
    .values({
      id,
      org_id: orgId,
      source_id: sourceId,
      url,
      title: opts.title ?? null,
      content_hash: "c".repeat(64),
      ...(opts.deleted ? { deleted_at: new Date() } : {}),
    })
    .execute()
  return id
}
//#endregion

//#region Fixture texts
const REFUND_TEXT = "Refunds are processed within five business days."
const SHIPPING_TEXT = "Shipping typically takes two weeks for international orders."
const RATE_LIMIT_TEXT = "Our API rate limit is sixty requests per minute."
const PASSWORD_TEXT = "Reset your password from the account settings page."
const DELETED_TEXT = "The legacy exporter tool was retired in early 2024."
const SHARED_TEXT = "Invoices can be downloaded as PDF from the billing tab."
const TIE_TEXT = "Contact support via the help desk portal."
//#endregion

describe.skipIf(!DB_CONFIGURED)("hybrid retrieval", () => {
  //#region Fixture state
  let orgA: string
  let orgB: string
  let tinyOrg: string
  let emptyOrg: string
  let refundChunkId: string
  let deletedChunkId: string
  let sharedChunkA: string
  let sharedChunkB: string
  let tieChunkIds: string[] = []
  let orgAChunkIds: string[] = []
  //#endregion

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    await migrateToLatest(db)

    // ── Org A: the main corpus — live doc, deleted doc, a lexical tie pair ─
    const a = await seedOrg("Retrieval Co")
    orgA = a.orgId
    const liveDoc = await seedDocument(
      orgA,
      a.sourceId,
      "https://docs.retrieval.example.com/billing",
      { title: "Billing FAQ" },
    )
    const goneDoc = await seedDocument(
      orgA,
      a.sourceId,
      "https://docs.retrieval.example.com/legacy",
      { deleted: true },
    )

    const liveIds = await insertChunks([
      // The refund chunk carries full metadata so the hydration test can
      // assert every field round-trips, not just ids.
      {
        orgId: orgA,
        documentId: liveDoc,
        ord: 0,
        text: REFUND_TEXT,
        headingPath: "Billing > Refunds",
        charStart: 0,
        charEnd: REFUND_TEXT.length,
      },
      { orgId: orgA, documentId: liveDoc, ord: 1, text: SHIPPING_TEXT },
      { orgId: orgA, documentId: liveDoc, ord: 2, text: RATE_LIMIT_TEXT },
      { orgId: orgA, documentId: liveDoc, ord: 3, text: PASSWORD_TEXT },
      { orgId: orgA, documentId: liveDoc, ord: 4, text: SHARED_TEXT },
      // Identical texts → identical tsv → identical ts_rank_cd scores: the
      // deterministic-tie-break fixture.
      { orgId: orgA, documentId: liveDoc, ord: 5, text: TIE_TEXT },
      { orgId: orgA, documentId: liveDoc, ord: 6, text: TIE_TEXT },
    ])
    refundChunkId = liveIds[0]
    sharedChunkA = liveIds[4]
    tieChunkIds = [liveIds[5], liveIds[6]]
    orgAChunkIds = liveIds

    // A chunk whose document is soft-deleted: embedded and indexed like any
    // other — only the documents.deleted_at filter keeps it out of results.
    const deletedIds = await insertChunks([
      { orgId: orgA, documentId: goneDoc, ord: 0, text: DELETED_TEXT },
    ])
    deletedChunkId = deletedIds[0]

    // ── Org B: one chunk with text IDENTICAL to org A's — same mock vector,
    // same tsv. Only the org filter separates them, in both arms. ──────────
    const b = await seedOrg("Tenant B")
    orgB = b.orgId
    const bDoc = await seedDocument(orgB, b.sourceId, "https://docs.tenant-b.example.com/billing")
    const bIds = await insertChunks([{ orgId: orgB, documentId: bDoc, ord: 0, text: SHARED_TEXT }])
    sharedChunkB = bIds[0]

    // ── Tiny org: fewer chunks than k, for the k-overrun boundary. ─────────
    const tiny = await seedOrg("Tiny Org")
    tinyOrg = tiny.orgId
    const tinyDoc = await seedDocument(tinyOrg, tiny.sourceId, "https://docs.tiny.example.com/")
    await insertChunks([
      { orgId: tinyOrg, documentId: tinyDoc, ord: 0, text: "Alpha setup guide for the widget." },
      { orgId: tinyOrg, documentId: tinyDoc, ord: 1, text: "Beta configuration reference manual." },
      { orgId: tinyOrg, documentId: tinyDoc, ord: 2, text: "Gamma troubleshooting checklist." },
    ])

    // ── Empty org: exists, owns nothing. ───────────────────────────────────
    emptyOrg = (await seedOrg("Empty Org")).orgId
  })

  afterAll(async () => {
    await db.destroy()
  })

  //#region Dense arm
  describe("dense arm", () => {
    it("returns the exact-text chunk first, at ~zero distance", async () => {
      const hits = await denseSearch(db, {
        orgId: orgA,
        model: embedder.model,
        queryVector: await embedOne(SHIPPING_TEXT),
        k: 3,
      })
      expect(hits[0]?.chunkId).toBe(orgAChunkIds[1])
      // fp16 storage rounds the stored vector, so ~0 rather than exactly 0.
      expect(hits[0]?.distance).toBeLessThan(0.01)
      // Distances come back sorted — the contract fusion's ranks rely on.
      const distances = hits.map((h) => h.distance)
      expect([...distances].sort((x, y) => x - y)).toEqual(distances)
    })

    it("never returns chunks of soft-deleted documents", async () => {
      // Hardest case: the query IS the deleted chunk's text, so its vector
      // is the true nearest neighbor by a wide margin. Only the
      // documents.deleted_at filter keeps it out.
      const hits = await denseSearch(db, {
        orgId: orgA,
        model: embedder.model,
        queryVector: await embedOne(DELETED_TEXT),
        k: 10,
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.map((h) => h.chunkId)).not.toContain(deletedChunkId)
    })

    it("never returns another org's chunks, even with identical vectors", async () => {
      // SHARED_TEXT exists in both orgs with the SAME mock vector (distance
      // 0 for both rows) — the org filter is the only thing separating them.
      const queryVector = await embedOne(SHARED_TEXT)
      const hitsA = await denseSearch(db, {
        orgId: orgA,
        model: embedder.model,
        queryVector,
        k: 10,
      })
      const hitsB = await denseSearch(db, {
        orgId: orgB,
        model: embedder.model,
        queryVector,
        k: 10,
      })
      expect(hitsA.map((h) => h.chunkId)).toContain(sharedChunkA)
      expect(hitsA.map((h) => h.chunkId)).not.toContain(sharedChunkB)
      expect(hitsB.map((h) => h.chunkId)).toEqual([sharedChunkB])
    })

    it("returns the whole corpus when k exceeds it", async () => {
      const hits = await denseSearch(db, {
        orgId: tinyOrg,
        model: embedder.model,
        queryVector: await embedOne("anything at all"),
        k: 5,
      })
      expect(hits).toHaveLength(3)
    })

    it("returns [] for an org with no content", async () => {
      const hits = await denseSearch(db, {
        orgId: emptyOrg,
        model: embedder.model,
        queryVector: await embedOne("anything"),
        k: 5,
      })
      expect(hits).toEqual([])
    })

    it("returns [] for an unknown model rather than cross-model garbage", async () => {
      // A model with no embeddings must yield nothing — silently comparing
      // vectors across model spaces is the bug the model column exists to
      // prevent.
      const hits = await denseSearch(db, {
        orgId: orgA,
        model: "no-such-model",
        queryVector: await embedOne(REFUND_TEXT),
        k: 5,
      })
      expect(hits).toEqual([])
    })
  })
  //#endregion

  //#region Lexical arm
  describe("lexical arm", () => {
    it("finds chunks by full-text match with a positive score", async () => {
      const hits = await lexicalSearch(db, { orgId: orgA, query: "refund processing", k: 5 })
      expect(hits.map((h) => h.chunkId)).toContain(refundChunkId)
      expect(hits[0]?.score).toBeGreaterThan(0)
    })

    it("returns [] when nothing matches", async () => {
      const hits = await lexicalSearch(db, { orgId: orgA, query: "quantum blockchain zebra", k: 5 })
      expect(hits).toEqual([])
    })

    it("returns [] for a stop-word-only query", async () => {
      // "the of and" parses to an EMPTY tsquery; matching nothing is the
      // correct answer, not an error.
      const hits = await lexicalSearch(db, { orgId: orgA, query: "the of and", k: 5 })
      expect(hits).toEqual([])
    })

    it("does not throw on hostile query syntax", async () => {
      // websearch_to_tsquery's contract: end-user text can never produce a
      // parse error. These would all crash to_tsquery.
      for (const hostile of ['refund" AND (', "a | b & c!", '""""', "-—–"]) {
        await expect(
          lexicalSearch(db, { orgId: orgA, query: hostile, k: 5 }),
        ).resolves.toBeDefined()
      }
    })

    it("never returns another org's chunks for identical text", async () => {
      const hits = await lexicalSearch(db, { orgId: orgB, query: "download invoice PDF", k: 5 })
      expect(hits.map((h) => h.chunkId)).toEqual([sharedChunkB])
    })

    it("excludes soft-deleted documents", async () => {
      const hits = await lexicalSearch(db, { orgId: orgA, query: "legacy exporter retired", k: 5 })
      expect(hits.map((h) => h.chunkId)).not.toContain(deletedChunkId)
    })

    it("breaks equal-score ties deterministically by chunk id", async () => {
      // The tie pair has byte-identical text → identical ts_rank_cd. Order
      // must be reproducible or eval runs diff against themselves.
      const first = await lexicalSearch(db, { orgId: orgA, query: "help desk portal", k: 5 })
      const second = await lexicalSearch(db, { orgId: orgA, query: "help desk portal", k: 5 })
      const tiePair = first.filter((h) => tieChunkIds.includes(h.chunkId)).map((h) => h.chunkId)
      expect(tiePair).toEqual([...tieChunkIds].sort())
      expect(second).toEqual(first)
    })
  })
  //#endregion

  //#region Hybrid fusion
  describe("hybrid", () => {
    it("ranks the both-arms consensus chunk first and reports both ranks", async () => {
      const results = await hybridSearch(db, {
        orgId: orgA,
        queryText: REFUND_TEXT,
        queryVector: await embedOne(REFUND_TEXT),
        model: embedder.model,
        k: 5,
      })
      // Dense rank 1 (exact vector) + lexical rank 1 (exact wording) → RRF
      // score of exactly 1/61 + 1/61.
      expect(results[0]?.chunkId).toBe(refundChunkId)
      expect(results[0]?.denseRank).toBe(1)
      expect(results[0]?.lexicalRank).toBe(1)
      expect(results[0]?.score).toBeCloseTo(2 / 61, 10)
    })

    it("reports null lexical fields for dense-only results", async () => {
      const results = await hybridSearch(db, {
        orgId: orgA,
        queryText: REFUND_TEXT,
        queryVector: await embedOne(REFUND_TEXT),
        model: embedder.model,
        k: 5,
      })
      // Dense returns the whole small corpus as neighbors; lexical matches
      // only the refund wording — so the tail is dense-only by construction.
      const denseOnly = results.filter((r) => r.chunkId !== refundChunkId)
      expect(denseOnly.length).toBeGreaterThan(0)
      for (const r of denseOnly) {
        expect(r.denseRank).not.toBeNull()
        expect(r.lexicalRank).toBeNull()
        expect(r.lexicalScore).toBeNull()
      }
    })

    it("hydrates full citation metadata", async () => {
      const results = await hybridSearch(db, {
        orgId: orgA,
        queryText: REFUND_TEXT,
        queryVector: await embedOne(REFUND_TEXT),
        model: embedder.model,
        k: 1,
      })
      expect(results[0]).toMatchObject({
        chunkId: refundChunkId,
        url: "https://docs.retrieval.example.com/billing",
        title: "Billing FAQ",
        headingPath: "Billing > Refunds",
        text: REFUND_TEXT,
        charStart: 0,
        charEnd: REFUND_TEXT.length,
      })
    })

    it("cuts to k after fusion", async () => {
      const results = await hybridSearch(db, {
        orgId: orgA,
        queryText: REFUND_TEXT,
        queryVector: await embedOne(REFUND_TEXT),
        model: embedder.model,
        k: 2,
      })
      expect(results).toHaveLength(2)
    })

    it("returns [] for an org with no content", async () => {
      const results = await hybridSearch(db, {
        orgId: emptyOrg,
        queryText: "anything",
        queryVector: await embedOne("anything"),
        model: embedder.model,
      })
      expect(results).toEqual([])
    })
  })
  //#endregion

  //#region Multi-tenant iterative-scan regression
  describe("multi-tenant retrieval under HNSW filtering", () => {
    // THE regression test from the plan: 20 orgs share one index; every one
    // must retrieve exactly k for a generic query. Without iterative scans
    // this fails in production only — HNSW yields ~ef_search candidates,
    // the org filter discards the other tenants' rows, and a small tenant
    // quietly gets fewer than k. Having a test for it is the whole story.
    const TENANTS = 20
    const CHUNKS_PER_TENANT = 30
    const K = 5
    const tenantChunks = new Map<string, Set<string>>()

    // A dedicated single-connection Kysely: the planner SETs below are
    // session-scoped, and on the shared 5-connection pool a SET and the
    // search could land on different connections. One connection makes the
    // planner constraint airtight — these searches MUST go through HNSW,
    // because an exact plan (unstarvable) would pass the regression test
    // without exercising the thing it guards.
    //
    // Two knobs, and the second is the one that matters. `enable_seqscan =
    // off` was the original and is not sufficient: a sequential scan is not
    // the only exact route. Every plan that is NOT the HNSW index scan has
    // to SORT by distance to satisfy the ORDER BY, and at this fixture's
    // size those plans cost about the same as HNSW-with-LIMIT — measured in
    // M7.1's ladder, where the starvation check below went red for the
    // first time: a documents → chunks → chunk_embeddings-by-primary-key
    // plan under stale statistics, then a scan of the whole primary-key
    // index for model='mock-384' (612 rows) plus a Sort under fresh ones,
    // costed at 215 against the HNSW plan's ~209. A coin flip that
    // statistics freshness tipped either way, which is why it passed alone
    // and failed inside a full run (0/20 tenants starved under the exact
    // plan; 19/20 under HNSW). `enable_sort = off` closes every exact route
    // at once — the HNSW scan is the only path that needs no Sort — so the
    // choice no longer depends on autoanalyze timing, and the pigeonhole in
    // the sanity check holds by construction rather than by luck.
    let singleConn: Kysely<Database>
    let singlePool: Pool

    beforeAll(async () => {
      for (let t = 0; t < TENANTS; t++) {
        const { orgId, sourceId } = await seedOrg(`Fleet Tenant ${t}`)
        const docId = await seedDocument(orgId, sourceId, `https://docs.tenant-${t}.example.com/`)
        const ids = await insertChunks(
          Array.from({ length: CHUNKS_PER_TENANT }, (_, j) => ({
            orgId,
            documentId: docId,
            ord: j,
            text: `Tenant ${t} article ${j}: assorted product documentation prose.`,
          })),
        )
        tenantChunks.set(orgId, new Set(ids))
      }

      singlePool = new Pool({
        host: process.env.POSTGRES_HOST ?? "localhost",
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        user: process.env.POSTGRES_USER ?? "interrelated",
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DB ?? "interrelated",
        max: 1,
      })
      singleConn = new Kysely<Database>({ dialect: new PostgresDialect({ pool: singlePool }) })
      await sql`SET enable_seqscan = off`.execute(singleConn)
      await sql`SET enable_sort = off`.execute(singleConn)
    }, 60_000)

    afterAll(async () => {
      await singleConn.destroy()
    })

    it("every tenant retrieves exactly k results, all its own", async () => {
      const queryVector = await embedOne("how do I configure the product?")
      for (const [orgId, ownIds] of tenantChunks) {
        const hits = await denseSearch(singleConn, {
          orgId,
          model: embedder.model,
          queryVector,
          k: K,
        })
        expect(hits, `tenant ${orgId} starved`).toHaveLength(K)
        for (const hit of hits) {
          expect(ownIds.has(hit.chunkId), `tenant ${orgId} got foreign chunk ${hit.chunkId}`).toBe(
            true,
          )
        }
      }
    }, 60_000)

    it("without iterative scans, tenants starve — the fixture actually bites", async () => {
      // Sanity check that keeps the test above non-vacuous. With
      // iterative_scan off (pgvector's default), the index yields at most
      // ~ef_search=40 candidates; 20 tenants × k=5 = 100 > 40, so by
      // pigeonhole SOME tenant must come up short. If this ever fails, the
      // regression test has stopped exercising HNSW — the planner found an
      // exact plan despite the SETs above (see the connection's comment for
      // the two it found before `enable_sort = off`) — and needs
      // re-fixturing.
      const queryVector = await embedOne("how do I configure the product?")
      let starved = 0
      for (const orgId of tenantChunks.keys()) {
        const hits = await denseSearch(singleConn, {
          orgId,
          model: embedder.model,
          queryVector,
          k: K,
          iterativeScan: "off",
        })
        if (hits.length < K) starved++
      }
      expect(starved).toBeGreaterThan(0)
    }, 60_000)
  })
  //#endregion
})

//#region Input validation (no database needed)
// assertLimit fires before any query is issued, so these run in the no-DB
// lane too — the pool dials only on first use.
describe("retrieval input validation", () => {
  const base = { orgId: "org_x", model: "mock-384", queryVector: [1, 0, 0] }
  it("rejects non-positive, fractional, and oversized k", async () => {
    await expect(denseSearch(db, { ...base, k: 0 })).rejects.toThrow(/k must be/)
    await expect(denseSearch(db, { ...base, k: 2.5 })).rejects.toThrow(/k must be/)
    await expect(denseSearch(db, { ...base, k: 1_001 })).rejects.toThrow(/k must be/)
    await expect(lexicalSearch(db, { orgId: "org_x", query: "q", k: -1 })).rejects.toThrow(
      /k must be/,
    )
  })
  it("rejects an out-of-range efSearch", async () => {
    await expect(denseSearch(db, { ...base, k: 5, efSearch: 0 })).rejects.toThrow(
      /efSearch must be/,
    )
  })
})
//#endregion

// Placeholder so the file is never empty when the DB is absent — same
// convention as the other DB-gated suites.
describe.skipIf(DB_CONFIGURED)("hybrid retrieval (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
