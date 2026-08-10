//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 002 — the content pipeline: crawl targets, fetched documents,
// retrieval chunks, their vector embeddings, and the ingest job queue.
//
// The three deliberate schema decisions here (each explained at its site,
// summarized in CLAUDE.md §3.3):
//   1. halfvec(1024), not vector(1024) — halves storage AND index size.
//   2. Partial HNSW index per embedding model — never IVFFlat.
//   3. org_id denormalized onto chunk_embeddings — the tenant filter must
//      live on the same relation as the vector index.

async function up(db: Kysely<unknown>): Promise<void> {
  // ── Sources: things an org has asked us to ingest ────────────────────────
  await sql`
    CREATE TABLE sources (
      id              TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('url', 'sitemap', 'upload')),
      location        TEXT NOT NULL,
      crawl_depth     INT  NOT NULL DEFAULT 1 CHECK (crawl_depth BETWEEN 0 AND 3),
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'crawling', 'ready', 'failed')),
      last_crawled_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX sources_org ON sources (org_id)`.execute(db)

  // ── Documents: one fetched page or uploaded file ─────────────────────────
  // content_hash is sha256 of the NORMALIZED text: a recrawl that fetches
  // byte-identical content skips re-chunking and re-embedding entirely —
  // embedding quota is the scarcest resource in the whole pipeline, and this
  // one column is what keeps recrawls nearly free.
  await sql`
    CREATE TABLE documents (
      id           TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      url          TEXT NOT NULL,
      title        TEXT,
      content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
      token_count  INT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at   TIMESTAMPTZ
    )
  `.execute(db)

  // A URL is unique among LIVE documents of a source. Soft delete
  // (deleted_at) rather than hard delete so a recrawl that drops a page
  // keeps its history until a cleanup pass — and the partial index means a
  // re-added page doesn't collide with its own tombstone.
  await sql`
    CREATE UNIQUE INDEX documents_source_url_live
      ON documents (source_id, url) WHERE deleted_at IS NULL
  `.execute(db)

  await sql`CREATE INDEX documents_org ON documents (org_id)`.execute(db)

  // ── Chunks: the retrieval unit ───────────────────────────────────────────
  // heading_path ("Billing > Refunds > Partial refunds") travels with every
  // chunk because a chunk quoted out of context is how RAG answers cite the
  // right page for the wrong reason; the path is prepended at embedding time
  // and shown with citations.
  //
  // char_start/char_end span back into the source document so citations can
  // deep-link to the exact passage, not just the page.
  //
  // tsv is a GENERATED column: the lexical half of hybrid retrieval can
  // never drift out of sync with the text, because Postgres owns it.
  await sql`
    CREATE TABLE chunks (
      id           TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ord          INT  NOT NULL CHECK (ord >= 0),
      heading_path TEXT,
      text         TEXT NOT NULL CHECK (char_length(text) > 0),
      token_count  INT  NOT NULL CHECK (token_count > 0),
      char_start   INT,
      char_end     INT,
      tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      CHECK (char_start IS NULL OR char_end IS NULL OR char_start < char_end)
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX chunks_document_ord ON chunks (document_id, ord)
  `.execute(db)

  await sql`CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv)`.execute(db)

  await sql`CREATE INDEX chunks_org ON chunks (org_id)`.execute(db)

  // ── Chunk embeddings ─────────────────────────────────────────────────────
  // halfvec(1024): 2 bytes/dimension instead of 4 halves both row and index
  // size — on Neon's 0.5 GB free tier that is the difference between ~39k
  // and ~78k chunks. Recall cost of fp16 quantization is negligible at this
  // scale (and measured by the eval harness rather than asserted).
  //
  // All models share the 1024-d column; shorter models (bge-small: 384) are
  // ZERO-PADDED up. Zero-padding preserves dot products and L2 norms
  // exactly — for padded u,v: <pad(u),pad(v)> = <u,v> and |pad(u)| = |u|,
  // since the extra coordinates contribute only zeros — so cosine and L2
  // rankings among same-model vectors are unchanged.
  //
  // org_id is DENORMALIZED here on purpose. Retrieval filters by tenant,
  // and with HNSW Postgres searches the index THEN filters: if the filter
  // column lived only on chunks, the planner would have to join first and
  // lose the index, or scan the index and post-filter — the latter can
  // return fewer than k rows for a small tenant inside a big index. The
  // filter must be on the indexed relation (paired with iterative scans at
  // query time — that arrives with the retrieval code).
  //
  // dim records the model's TRUE dimension before padding, so code can
  // detect a model whose dimension changed out from under stored vectors.
  await sql`
    CREATE TABLE chunk_embeddings (
      chunk_id  TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      model     TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
      dim       INT  NOT NULL CHECK (dim BETWEEN 1 AND 1024),
      embedding HALFVEC(1024) NOT NULL,
      PRIMARY KEY (chunk_id, model)
    )
  `.execute(db)

  // One partial HNSW index per embedding model. Why partial-per-model: rows
  // for different models are NOT comparable (different spaces), so one big
  // index would waste every traversal step that lands on a foreign-model
  // row. Why HNSW and not IVFFlat: IVFFlat needs representative data before
  // build and silently degrades as rows are inserted without a rebuild —
  // fatal for a continuous-ingest product. HNSW builds incrementally and
  // holds recall; m=16 / ef_construction=64 are the right defaults below
  // ~100k vectors.
  //
  // Registered models today: the local eval/CI model and the deterministic
  // test mock. A future migration adds an index when a new provider model
  // goes live (a new model without its index still WORKS — sequential scan —
  // it is just slow, which the eval harness would surface).
  await sql`
    CREATE INDEX chunk_emb_bge_small_hnsw
      ON chunk_embeddings USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE model = 'bge-small-en-v1.5'
  `.execute(db)

  await sql`
    CREATE INDEX chunk_emb_mock_hnsw
      ON chunk_embeddings USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE model = 'mock-384'
  `.execute(db)

  // ── Ingest job queue ─────────────────────────────────────────────────────
  // A Postgres-backed queue consumed with FOR UPDATE SKIP LOCKED (worker
  // arrives in a later increment). Rejected alternative: Redis/BullMQ — a
  // second stateful service to run, secure, and pay for, when the queue's
  // throughput ceiling is embedding-API rate limits, not Postgres.
  // locked_by/locked_at make a crashed worker's lease visibly stale instead
  // of silently lost.
  await sql`
    CREATE TABLE ingest_jobs (
      id         TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      state      TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'done', 'failed')),
      attempts   INT  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      locked_by  TEXT,
      locked_at  TIMESTAMPTZ,
      docs_total INT,
      docs_done  INT,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((state = 'running') = (locked_by IS NOT NULL))
    )
  `.execute(db)

  // Partial index over only the queued rows: the worker's claim query scans
  // exactly the runnable work, and the index stays tiny no matter how much
  // done/failed history accumulates.
  await sql`
    CREATE INDEX ingest_jobs_queued ON ingest_jobs (created_at)
      WHERE state = 'queued'
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ingest_jobs`.execute(db)
  await sql`DROP TABLE IF EXISTS chunk_embeddings`.execute(db)
  await sql`DROP TABLE IF EXISTS chunks`.execute(db)
  await sql`DROP TABLE IF EXISTS documents`.execute(db)
  await sql`DROP TABLE IF EXISTS sources`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
