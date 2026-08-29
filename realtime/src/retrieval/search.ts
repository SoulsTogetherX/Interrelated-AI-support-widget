//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"

import type { Database } from "@/db/schema"
import { rrfFuse } from "@shared/retrieval/rrf"
import { padVector, toPgvector } from "@shared/utils/vectors"
//#endregion

//#region Type Defs
/**
 * Hybrid retrieval — the query side of the content pipeline (DATAFLOW.md §4).
 *
 * Two arms over the same chunks, fused by rank:
 *   - DENSE: cosine nearest-neighbor over chunk_embeddings via the partial
 *     HNSW index for the query's model (§3.3.1).
 *   - LEXICAL: full-text match over chunks.tsv (a GENERATED column — it
 *     cannot drift from the text) ranked by ts_rank_cd.
 *
 * Fusion is Reciprocal Rank Fusion (shared/retrieval/rrf.ts): the arms'
 * scores live on incomparable scales, so only ranks are combined. The eval
 * harness (next increment) measures each arm alone against the fusion —
 * the delta IS the case for hybrid, so all three entry points are public.
 *
 * Both arms exclude chunks of soft-deleted documents. The ingest worker
 * soft-deletes a vanished page but leaves its chunks for history; "deleted"
 * therefore lives on documents alone, and retrieval must look through the
 * join or it would keep answering from pages a site removed.
 */
interface DenseSearchOptions {
  orgId: string
  /** Embedding model id. Must match the model that embedded the chunks —
   *  vectors from different models are not comparable, and each model has
   *  its own partial HNSW index keyed on exactly this value. */
  model: string
  /** The embedded query at the model's NATIVE dimension; padded to the
   *  stored 1024 in here so callers never think about padding. */
  queryVector: readonly number[]
  k: number
  /** HNSW candidate-list width. pgvector's default is 40; raising it trades
   *  latency for recall. The eval harness sweeps this to draw the
   *  recall-vs-ef_search curve the README promises. */
  efSearch?: number
  /**
   * pgvector iterative scans (≥0.8). "relaxed_order" (the default) makes
   * the index KEEP scanning until the post-filter LIMIT is satisfied —
   * without it, HNSW yields ~ef_search candidates, the org filter then
   * discards foreign-tenant rows, and a small tenant inside a big index
   * silently gets fewer than k results (or zero) while appearing to work.
   * "off" exists because the eval harness measures recall with and without
   * iterative scans under tenant filtering — the delta justifies the
   * setting, and the multi-tenant regression test proves it bites.
   */
  iterativeScan?: "relaxed_order" | "off"
}

interface DenseHit {
  chunkId: string
  /** Cosine distance in [0, 2]; smaller is nearer. */
  distance: number
}

interface LexicalSearchOptions {
  orgId: string
  /** Raw user text. Parsed by websearch_to_tsquery, which never throws on
   *  hostile syntax — quotes, dashes, parens, "or" all degrade gracefully. */
  query: string
  k: number
}

interface LexicalHit {
  chunkId: string
  /** ts_rank_cd cover-density score; larger is better. Unbounded scale —
   *  comparable within one query's results, never across queries (which is
   *  exactly why fusion uses ranks, not these values). */
  score: number
}

interface HybridSearchOptions {
  orgId: string
  queryText: string
  queryVector: readonly number[]
  model: string
  /** Results returned after fusion. Default 10 — M2's prompt budget, and
   *  the deepest cut the eval scores (recall@10). */
  k?: number
  /** Per-arm candidate depth BEFORE fusion. Deeper arms let RRF surface
   *  consensus that neither arm ranked highly; 50 costs little at either
   *  arm and is comfortably deeper than any k we cut to. */
  poolSize?: number
  efSearch?: number
}

/** One fused result with everything M2's grounding prompt and citations
 *  need: the quotable text, where it lives (url + heading trail + char
 *  span), and the full scoring picture for observability. */
interface RetrievedChunk {
  chunkId: string
  documentId: string
  url: string
  title: string | null
  headingPath: string | null
  text: string
  charStart: number | null
  charEnd: number | null
  /** The fused RRF score — the number the M2 refusal threshold cuts on. */
  score: number
  /** 1-based rank in the dense arm, null if this arm didn't surface it. */
  denseRank: number | null
  denseDistance: number | null
  /** 1-based rank in the lexical arm, null if this arm didn't surface it. */
  lexicalRank: number | null
  lexicalScore: number | null
}
//#endregion

//#region Constants
const DEFAULT_K = 10
const DEFAULT_POOL_SIZE = 50
/** pgvector's own default; kept explicit so the value is visible here and
 *  in EXPLAIN output rather than inherited invisibly from the extension. */
const DEFAULT_EF_SEARCH = 40
//#endregion

//#region Guards
/** Retrieval limits arrive from application code today but from request
 *  handlers in M2 — validate like it is already user input. */
function assertLimit(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer in [1, ${max}], got ${value}`)
  }
}
//#endregion

//#region Dense arm
/**
 * Nearest-neighbor search over one org's chunks under one model.
 *
 * Runs inside a transaction because the pgvector knobs are set with
 * set_config(..., is_local => true) — transaction-scoped, so no setting can
 * leak onto a pooled connection and change another query's behavior.
 * (set_config rather than SET LOCAL because SET cannot take bind
 * parameters; set_config is an ordinary function call, so the values travel
 * as parameters instead of being spliced into SQL text.)
 *
 * The WHERE clause matches the partial index predicate (model = …) and
 * filters org_id ON the indexed relation — org_id is denormalized onto
 * chunk_embeddings for exactly this query (§3.3.1). The documents
 * join only EXCLUDES soft-deleted pages; under iterative scans the index
 * keeps yielding until k post-join rows survive.
 */
async function denseSearch(db: Kysely<Database>, options: DenseSearchOptions): Promise<DenseHit[]> {
  assertLimit("k", options.k, 1_000)
  const efSearch = options.efSearch ?? DEFAULT_EF_SEARCH
  assertLimit("efSearch", efSearch, 1_000)
  const iterativeScan = options.iterativeScan ?? "relaxed_order"
  const queryVec = toPgvector(padVector(options.queryVector))

  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`.execute(trx)
    await sql`SELECT set_config('hnsw.iterative_scan', ${iterativeScan}, true)`.execute(trx)

    const { rows } = await sql<{ chunk_id: string; distance: number }>`
      SELECT ce.chunk_id, ce.embedding <=> ${queryVec}::halfvec(1024) AS distance
      FROM chunk_embeddings ce
      JOIN chunks c ON c.id = ce.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE ce.org_id = ${options.orgId}
        AND ce.model = ${options.model}
        AND d.deleted_at IS NULL
      ORDER BY ce.embedding <=> ${queryVec}::halfvec(1024)
      LIMIT ${options.k}
    `.execute(trx)
    // No secondary sort key: ORDER BY must be exactly the index's distance
    // expression or the planner abandons HNSW for a full sort. Distance ties
    // are possible under fp16 quantization but harmless — fusion re-ranks.
    return rows.map((row) => ({ chunkId: row.chunk_id, distance: Number(row.distance) }))
  })
}
//#endregion

//#region Lexical arm
/**
 * Full-text search over one org's chunks, ranked by ts_rank_cd — the
 * cover-density variant, which rewards query terms appearing NEAR each
 * other. That favors chunks about "refund processing" over chunks that
 * mention refunds in one section and processing in another, and it is the
 * reason tsv is STORED with positions rather than stripped.
 *
 * websearch_to_tsquery, not plainto_tsquery: identical for plain prose, but
 * it accepts quoted phrases and never raises on unbalanced syntax — this
 * string is typed by end users (M2 widget), so "cannot throw on hostile
 * input" is a requirement, not a nicety. A query of pure stop words parses
 * to an empty tsquery, matches nothing, and returns [] — the correct answer.
 *
 * ORDER BY ties break on chunk id: ts_rank_cd yields identical scores for
 * identically-worded chunks, and a nondeterministic order there would make
 * eval runs non-reproducible.
 */
async function lexicalSearch(
  db: Kysely<Database>,
  options: LexicalSearchOptions,
): Promise<LexicalHit[]> {
  assertLimit("k", options.k, 1_000)

  const { rows } = await sql<{ chunk_id: string; score: number }>`
    SELECT c.id AS chunk_id, ts_rank_cd(c.tsv, query) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id,
         websearch_to_tsquery('english', ${options.query}) AS query
    WHERE c.org_id = ${options.orgId}
      AND d.deleted_at IS NULL
      AND c.tsv @@ query
    ORDER BY score DESC, c.id
    LIMIT ${options.k}
  `.execute(db)
  return rows.map((row) => ({ chunkId: row.chunk_id, score: Number(row.score) }))
}
//#endregion

//#region Hybrid
/**
 * The production entry point: both arms at poolSize depth, RRF-fused, cut
 * to k, hydrated with the metadata M2's prompt assembly and citations need.
 *
 * The arms run concurrently — they touch disjoint indexes and the pool has
 * headroom (max 5). Metadata is fetched once AFTER fusion for only the
 * surviving k ids, so the arm queries stay lean enough to be pure
 * index-shaped work.
 */
async function hybridSearch(
  db: Kysely<Database>,
  options: HybridSearchOptions,
): Promise<RetrievedChunk[]> {
  const k = options.k ?? DEFAULT_K
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE
  assertLimit("k", k, 1_000)
  assertLimit("poolSize", poolSize, 1_000)

  const [dense, lexical] = await Promise.all([
    denseSearch(db, {
      orgId: options.orgId,
      model: options.model,
      queryVector: options.queryVector,
      k: poolSize,
      ...(options.efSearch !== undefined ? { efSearch: options.efSearch } : {}),
    }),
    lexicalSearch(db, { orgId: options.orgId, query: options.queryText, k: poolSize }),
  ])

  const fused = rrfFuse([dense.map((h) => h.chunkId), lexical.map((h) => h.chunkId)]).slice(0, k)
  if (fused.length === 0) return []

  const meta = await db
    .selectFrom("chunks")
    .innerJoin("documents", "documents.id", "chunks.document_id")
    .select([
      "chunks.id",
      "chunks.document_id",
      "chunks.heading_path",
      "chunks.text",
      "chunks.char_start",
      "chunks.char_end",
      "documents.url",
      "documents.title",
    ])
    .where(
      "chunks.id",
      "in",
      fused.map((f) => f.id),
    )
    .execute()
  const metaById = new Map(meta.map((m) => [m.id, m]))

  const denseByChunk = new Map(
    dense.map((h, i) => [h.chunkId, { rank: i + 1, distance: h.distance }]),
  )
  const lexicalByChunk = new Map(
    lexical.map((h, i) => [h.chunkId, { rank: i + 1, score: h.score }]),
  )

  return fused.map((f) => {
    // Every fused id came from an arm query, which joined these same tables
    // — a miss here means a row vanished mid-flight, which is worth a loud
    // failure, not a silent hole in the result list.
    const m = metaById.get(f.id)
    if (!m) throw new Error(`retrieval hydration lost chunk ${f.id}`)
    const d = denseByChunk.get(f.id)
    const l = lexicalByChunk.get(f.id)
    return {
      chunkId: f.id,
      documentId: m.document_id,
      url: m.url,
      title: m.title,
      headingPath: m.heading_path,
      text: m.text,
      charStart: m.char_start,
      charEnd: m.char_end,
      score: f.score,
      denseRank: d?.rank ?? null,
      denseDistance: d?.distance ?? null,
      lexicalRank: l?.rank ?? null,
      lexicalScore: l?.score ?? null,
    }
  })
}
//#endregion

//#region Exports
export { denseSearch, lexicalSearch, hybridSearch, DEFAULT_EF_SEARCH }
export type {
  DenseSearchOptions,
  DenseHit,
  LexicalSearchOptions,
  LexicalHit,
  HybridSearchOptions,
  RetrievedChunk,
}
//#endregion
