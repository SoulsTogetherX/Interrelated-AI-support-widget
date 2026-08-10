//#region Imports
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// Integration tests for migration 002 — same gating and same schema-reset
// convention as migrate.test.ts (see that file's comments). fileParallelism
// is off in vitest.config.ts, so the two files never race the shared DB.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

/** Serializes a number[] into pgvector's text format, zero-padded to 1024.
 *  This is a test-local helper today; the real one ships with the provider
 *  layer in the next increment and this test switches to importing it. */
function vec(values: number[], pad = 1024): string {
  const padded = [...values, ...Array.from({ length: pad - values.length }, () => 0)]
  return `[${padded.join(",")}]`
}

describe.skipIf(!DB_CONFIGURED)("migration 002 — content pipeline", () => {
  let orgId: string
  let sourceId: string
  let documentId: string

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    await migrateToLatest(db)

    // One org → source → document spine for every test below.
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Pipeline Co" }).execute()
    sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "url", location: "https://docs.example.com",
    }).execute()
    documentId = newId("doc")
    await db.insertInto("documents").values({
      id: documentId, org_id: orgId, source_id: sourceId,
      url: "https://docs.example.com/billing", title: "Billing",
      content_hash: "a".repeat(64),
    }).execute()
  })

  afterAll(async () => {
    await db.destroy()
  })

  //#region Chunks + lexical column
  it("computes the tsv column and finds chunks lexically", async () => {
    const chunkId = newId("chk")
    await db.insertInto("chunks").values({
      id: chunkId, org_id: orgId, document_id: documentId, ord: 0,
      heading_path: "Billing > Refunds",
      text: "Refunds are processed within five business days.",
      token_count: 9, char_start: 0, char_end: 48,
    }).execute()

    // The generated tsv must make this row findable via full-text search —
    // this is the lexical half of hybrid retrieval working end to end.
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM chunks
      WHERE org_id = ${orgId} AND tsv @@ plainto_tsquery('english', 'refund processing')
    `.execute(db)
    expect(rows.map((r) => r.id)).toContain(chunkId)
  })

  it("rejects a duplicate (document_id, ord)", async () => {
    // ord collisions would silently interleave two chunkings of the same
    // document — the unique index makes a buggy re-chunk loud instead.
    await expect(
      db.insertInto("chunks").values({
        id: newId("chk"), org_id: orgId, document_id: documentId, ord: 0,
        text: "Duplicate position.", token_count: 3,
      }).execute(),
    ).rejects.toThrow(/chunks_document_ord/)
  })

  it("rejects an inverted char span", async () => {
    await expect(
      db.insertInto("chunks").values({
        id: newId("chk"), org_id: orgId, document_id: documentId, ord: 99,
        text: "Bad span.", token_count: 2, char_start: 10, char_end: 5,
      }).execute(),
    ).rejects.toThrow(/check/i)
  })
  //#endregion

  //#region Embeddings
  it("stores a padded vector and retrieves by cosine distance", async () => {
    // Three chunks with hand-picked 3-d vectors (padded to 1024): two near
    // the query direction, one orthogonal. Nearest-neighbor order must be
    // exact — this is the smallest possible end-to-end proof that the
    // halfvec column, the distance operator, and the padding scheme agree.
    const near = newId("chk")
    const mid = newId("chk")
    const far = newId("chk")
    const vectors: Array<[string, number[]]> = [
      [near, [1, 0, 0]],
      [mid, [0.7, 0.7, 0]],
      [far, [0, 0, 1]],
    ]
    let ord = 100
    for (const [id, v] of vectors) {
      await db.insertInto("chunks").values({
        id, org_id: orgId, document_id: documentId, ord: ord++,
        text: `Vector fixture ${id}`, token_count: 3,
      }).execute()
      await db.insertInto("chunk_embeddings").values({
        chunk_id: id, org_id: orgId, model: "mock-384", dim: 3, embedding: vec([...v]),
      }).execute()
    }

    const { rows } = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings
      WHERE org_id = ${orgId} AND model = 'mock-384'
      ORDER BY embedding <=> ${vec([1, 0.1, 0])}::halfvec(1024)
      LIMIT 3
    `.execute(db)
    expect(rows.map((r) => r.chunk_id)).toEqual([near, mid, far])
  })

  it("rejects a vector of the wrong dimension", async () => {
    // halfvec(1024) enforces dimensionality in the type itself. A 384-d
    // vector that skipped padding must fail HERE, not silently compare
    // against padded neighbors in a different space.
    await expect(
      db.insertInto("chunk_embeddings").values({
        chunk_id: newId("chk"), org_id: orgId, model: "mock-384", dim: 384,
        embedding: `[${Array.from({ length: 384 }, () => 0).join(",")}]`,
      }).execute(),
    ).rejects.toThrow(/dimensions|foreign key/i)
  })

  it("rejects a second embedding for the same (chunk_id, model)", async () => {
    const chunkId = newId("chk")
    await db.insertInto("chunks").values({
      id: chunkId, org_id: orgId, document_id: documentId, ord: 200,
      text: "PK fixture.", token_count: 2,
    }).execute()
    const row = {
      chunk_id: chunkId, org_id: orgId, model: "mock-384", dim: 3,
      embedding: vec([1, 2, 3]),
    }
    await db.insertInto("chunk_embeddings").values(row).execute()
    await expect(
      db.insertInto("chunk_embeddings").values(row).execute(),
    ).rejects.toThrow(/chunk_embeddings_pkey/)
    // …while the SAME chunk under a DIFFERENT model is legal (BYO-provider:
    // two orgs on two models can share a corpus in principle).
    await db.insertInto("chunk_embeddings")
      .values({ ...row, model: "bge-small-en-v1.5", dim: 384 }).execute()
  })

  it("uses the partial HNSW index for same-model queries", async () => {
    // Pins the load-bearing performance property: the planner actually
    // chooses the partial index when the WHERE clause matches its predicate.
    // enable_seqscan=off forces the planner to reveal whether an index path
    // EXISTS at all (with 3 rows it would otherwise always seqscan).
    await sql`SET enable_seqscan = off`.execute(db)
    const explain = await sql<{ "QUERY PLAN": string }>`
      EXPLAIN SELECT chunk_id FROM chunk_embeddings
      WHERE model = 'mock-384'
      ORDER BY embedding <=> ${vec([1, 0, 0])}::halfvec(1024)
      LIMIT 3
    `.execute(db)
    await sql`SET enable_seqscan = on`.execute(db)
    const planText = explain.rows.map((r) => r["QUERY PLAN"]).join("\n")
    expect(planText).toContain("chunk_emb_mock_hnsw")
  })
  //#endregion

  //#region Documents + jobs
  it("enforces URL uniqueness among live documents only", async () => {
    const dup = {
      org_id: orgId, source_id: sourceId,
      url: "https://docs.example.com/billing", content_hash: "b".repeat(64),
    }
    // Same live URL as the spine document → rejected.
    await expect(
      db.insertInto("documents").values({ id: newId("doc"), ...dup }).execute(),
    ).rejects.toThrow(/documents_source_url_live/)
    // Soft-delete the original → the URL becomes reusable (recrawl of a
    // page that was removed and re-added must not collide with tombstones).
    await db.updateTable("documents")
      .set({ deleted_at: new Date() }).where("id", "=", documentId).execute()
    await db.insertInto("documents").values({ id: newId("doc"), ...dup }).execute()
    // NOTE: the spine document stays soft-deleted from here on — un-deleting
    // it would create a second live row at this URL, violating the very
    // index under test. (Chunks reference documents by id, not liveness, so
    // earlier fixtures are unaffected; no test after this one needs a live
    // spine.) This ordering constraint is why the document tests run last.
  })

  it("makes an unowned running job unrepresentable", async () => {
    // state='running' with no locked_by is how work silently vanishes after
    // a worker crash — the CHECK turns that state into an insert error.
    await expect(
      db.insertInto("ingest_jobs").values({
        id: newId("job"), org_id: orgId, source_id: sourceId, state: "running",
      }).execute(),
    ).rejects.toThrow(/check/i)
    // The legal form of the same transition:
    await db.insertInto("ingest_jobs").values({
      id: newId("job"), org_id: orgId, source_id: sourceId,
      state: "running", locked_by: "worker-test", locked_at: new Date(),
    }).execute()
  })
  //#endregion
})

// Placeholder so the file is never empty when the DB is absent (vitest
// treats a zero-test file as an error) — same convention as migrate.test.ts.
describe.skipIf(DB_CONFIGURED)("migration 002 (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
//#endregion
