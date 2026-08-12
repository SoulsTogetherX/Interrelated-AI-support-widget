//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 001 — the whole schema, in one reviewable file.
//
// FLATTENED at the end of M3 from the five migrations that built it up
// (001 tenancy/auth/keys, 002 content pipeline, 003 chat, 004 provider
// credentials, 005 embedding credentials). Their history is in git; what
// they were for is in CLAUDE.md §3.3. The trade: a migration series exists
// to carry EXISTING databases forward, and this product has none worth
// carrying — it is pre-launch, the only deployed data is a demo corpus that
// `npm run seed-demo` recreates in seconds, and every test suite already
// drops and re-migrates the schema from scratch. Against that, five files
// whose deltas nobody will ever replay cost real legibility: the shape of
// `chunk_embeddings` was spread across three of them, and reading the
// current schema meant replaying its own history in your head.
//
// THE OPERATIONAL CONSEQUENCE, stated plainly because it bites exactly
// once: Kysely's migrator refuses to run against a bookkeeping table
// containing migration names the registry no longer has ("corrupted
// migrations"). Any database that already applied the old 001–005 —
// a dev box, the Neon instance behind the deployed demo — must be reset
// before it will boot again:
//
//     DROP SCHEMA public CASCADE; CREATE SCHEMA public;
//
// then start the service, which migrates on boot (§3.7), and re-seed. That
// is a deliberate, one-time cost taken while it is still free to take. From
// here on the rule is the ordinary one: additive migrations only, 002
// onward, never a rewrite of this file.
//
// Raw SQL via the sql tag, not the Kysely schema builder: DDL should be
// explicit and reviewable as the SQL it actually is. The query builder is
// for application queries, where the type system earns its keep.
//
// Typed as Kysely<unknown>: migrations must not import the application's
// Database types, because a migration is frozen at the moment it ships while
// schema.ts keeps evolving. Coupling them would make old migrations fail to
// compile against future types.

async function up(db: Kysely<unknown>): Promise<void> {
  // The extension is created FIRST, before any table needs it. Rationale:
  // boot fails immediately on any Postgres that lacks pgvector (wrong Docker
  // image, misconfigured Neon project), at deploy time, instead of failing
  // at first ingest three weeks from now. Fail-fast beats fail-later, and
  // the statement is idempotent.
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db)

  // ── Tenancy ──────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE organizations (
      id             TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      plan           TEXT NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'starter', 'pro')),
      system_persona TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // ── Auth ─────────────────────────────────────────────────────────────────
  // email_ciphertext + email_index (AES-GCM at rest, slow-KDF blind index
  // for lookups) were columns before there was code to fill them, because
  // encryption at rest cannot be retrofitted without a data migration. The
  // code that fills them is web/src/lib/auth (§9.5).
  await sql`
    CREATE TABLE users (
      id               TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      email_index      TEXT NOT NULL UNIQUE,
      email_ciphertext TEXT NOT NULL,
      password_hash    TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE TABLE org_members (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    )
  `.execute(db)

  // Exactly one owner per organization. A partial unique index states the
  // business rule in the schema, where it cannot be forgotten by a code
  // path; application code that tries to add a second owner gets a loud
  // constraint violation instead of silently corrupting ownership.
  await sql`
    CREATE UNIQUE INDEX org_members_one_owner
      ON org_members (org_id) WHERE role = 'owner'
  `.execute(db)

  // Session id IS sha256(cookie token): a leaked database cannot be replayed
  // as logins, because the raw token never touches the server's storage.
  await sql`
    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY CHECK (char_length(id) = 64),
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX sessions_user ON sessions (user_id)`.execute(db)

  // ── Widget credentials ───────────────────────────────────────────────────
  // The kind/column pairing is enforced with one CHECK: public keys carry a
  // public_id and no secret_hash; secret keys the reverse. A row violating
  // that is not "unusual data", it is a bug — so it is unrepresentable.
  await sql`
    CREATE TABLE api_keys (
      id           TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK (kind IN ('public', 'secret')),
      public_id    TEXT,
      secret_hash  TEXT CHECK (secret_hash IS NULL OR char_length(secret_hash) = 64),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (kind = 'public' AND public_id IS NOT NULL AND secret_hash IS NULL) OR
        (kind = 'secret' AND public_id IS NULL     AND secret_hash IS NOT NULL)
      )
    )
  `.execute(db)

  // Uniqueness among LIVE public keys only: rotation revokes rather than
  // deletes (audit trail + grace window), and a revoked row must not block
  // the namespace forever.
  await sql`
    CREATE UNIQUE INDEX api_keys_public_id_live
      ON api_keys (public_id) WHERE revoked_at IS NULL
  `.execute(db)

  await sql`CREATE INDEX api_keys_org ON api_keys (org_id)`.execute(db)

  // ── Origin allowlist ─────────────────────────────────────────────────────
  // Exact origins only. The CHECK rejects trailing slashes and paths at the
  // boundary, because "https://a.com/" !== "https://a.com" in a string
  // comparison and that mismatch would read as "allowlist mysteriously
  // doesn't work" in production.
  await sql`
    CREATE TABLE allowed_origins (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      origin     TEXT NOT NULL CHECK (origin ~ '^https?://[^/]+$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, origin)
    )
  `.execute(db)

  // ── BYO provider credentials ─────────────────────────────────────────────
  // One row per (org, role), the tenant's API key AES-256-GCM encrypted
  // under a server-held master key (credentials/vault.ts, AAD = this row's
  // id). The dashboard writes these through realtime's internal API — the
  // ONLY surface that ever sees the plaintext, and only in transit.
  //
  // Two deliberate choices:
  //   * UNIQUE(org_id, role) with HARD DELETE on replace/remove, not the
  //     revoked_at soft-state api_keys uses. A widget pk is OUR credential —
  //     an audit trail of rotations is an asset. A provider key is SOMEONE
  //     ELSE'S — retaining superseded ciphertexts of a tenant's Groq key is
  //     pure liability (one more thing a master-key compromise unlocks), so
  //     replacement destroys the old row. The plan sketched a partial unique
  //     over active rows; this is that intent with less retained secret
  //     material.
  //   * CHECKs make invalid provider shapes unrepresentable (the api_keys
  //     pattern): ollama is unauthenticated so it must NOT carry a key;
  //     hosted providers must. Self-hosted shapes (ollama, openai_compatible)
  //     must carry a base_url; hosted ones must not — their endpoints are
  //     pinned in code, and a writable base_url on a hosted provider would be
  //     a request-forgery lever, not a feature.
  //
  // dim is the embedding model's true dimension, measured by the live Test
  // round-trip and stored so an adapter built from this row DECLARES its
  // dimension instead of discovering it mid-ingest — which is what makes a
  // provider that silently changes dimension a loud failure rather than a
  // second vector space inside one org's index. Generation models have no
  // dimension, so the CHECK ties the pairing exactly.
  await sql`
    CREATE TABLE org_provider_credentials (
      id             TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role           TEXT NOT NULL CHECK (role IN ('generation', 'embedding')),
      provider       TEXT NOT NULL CHECK (provider IN
                       ('groq', 'gemini', 'ollama', 'openai_compatible', 'anthropic')),
      -- NULL means "the provider's default model" where one exists; the
      -- validate layer requires an explicit model where no sane default
      -- does (openai_compatible, ollama).
      model          TEXT,
      base_url       TEXT,
      -- Bounded by chunk_embeddings.dim and PADDED_DIM: a model that cannot
      -- fit the storage column is refused at the Test button with a
      -- sentence, and unrepresentable here.
      dim            INT CHECK (dim IS NULL OR dim BETWEEN 1 AND 1024),
      -- v1.<iv>.<tag>.<ciphertext> base64, AAD = this row's id (a ciphertext
      -- moved to another row fails to decrypt — same binding as email-at-rest).
      key_ciphertext TEXT,
      -- Last 4 characters of the plaintext key, for "…a3f9" display. The
      -- ONLY fragment of the key that exists outside the ciphertext.
      key_suffix     TEXT,
      last_validated_at TIMESTAMPTZ,
      -- Human-readable summary of the last successful validation round-trip
      -- ("llama-3.3-70b-versatile, 412ms") — dashboard display, never parsed.
      last_validation   TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (org_id, role),
      -- Key presence by provider: ollama is unauthenticated (a key would be
      -- a lie); hosted providers require one; openai_compatible goes either
      -- way (hosted compat APIs use keys, self-hosted vLLM/LM Studio often
      -- run keyless).
      CHECK (
        CASE provider
          WHEN 'ollama' THEN key_ciphertext IS NULL
          WHEN 'openai_compatible' THEN TRUE
          ELSE key_ciphertext IS NOT NULL
        END
      ),
      CHECK ((key_ciphertext IS NULL) = (key_suffix IS NULL)),
      -- Self-hosted shapes need an endpoint; hosted endpoints are pinned in
      -- code and must not be overridable per-row.
      CHECK ((provider IN ('ollama', 'openai_compatible')) = (base_url IS NOT NULL)),
      -- A dimension belongs to an embedding model and nothing else.
      CHECK ((role = 'embedding') = (dim IS NOT NULL))
    )
  `.execute(db)

  await sql`
    CREATE INDEX org_provider_credentials_org
      ON org_provider_credentials (org_id)
  `.execute(db)

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
  // filter must be on the indexed relation, paired with pgvector's iterative
  // scans at query time (retrieval/search.ts).
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
  // Registered models: the local eval/CI model, the deterministic test mock,
  // and the hosted embedding default — the three whose names this file can
  // know. A tenant's self-hosted or OpenAI-compatible model carries a name
  // no migration can enumerate; those still WORK (Postgres falls back to an
  // exact sequential scan), they are just slower, which the eval harness
  // would surface. A future migration registers one when a model earns it.
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

  await sql`
    CREATE INDEX chunk_emb_gemini_hnsw
      ON chunk_embeddings USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE model = 'gemini-embedding-001'
  `.execute(db)

  // ── Ingest job queue ─────────────────────────────────────────────────────
  // A Postgres-backed queue consumed with FOR UPDATE SKIP LOCKED
  // (ingest/worker.ts). Rejected alternative: Redis/BullMQ — a second
  // stateful service to run, secure, and pay for, when the queue's
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

  // ── Conversations: one widget chat thread ────────────────────────────────
  // visitor_id is the widget-generated anonymous id (no FK — visitors are
  // not users and never will be; authenticated-visitor mode in the plan's
  // trust-model layer 6 still identifies THEIR user, not ours).
  //
  // status carries 'escalated' from day one even though handoff is M4:
  // adding an enum value later is a migration, and the widget already
  // needs to RENDER the state ("you are being connected...") when it sees
  // it, so the pipeline is provisioned now.
  await sql`
    CREATE TABLE conversations (
      id              TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      visitor_id      TEXT NOT NULL CHECK (char_length(visitor_id) BETWEEN 1 AND 100),
      status          TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'escalated', 'closed')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // The dashboard's conversation list is exactly this ordering.
  await sql`
    CREATE INDEX conversations_org_recent
      ON conversations (org_id, last_message_at DESC)
  `.execute(db)

  // ── Messages ─────────────────────────────────────────────────────────────
  // org_id is denormalized (same reasoning as chunk_embeddings): the M5
  // usage caps count an org's answers per day and must be checked BEFORE a
  // model call — that hot-path count cannot afford a join through
  // conversations, and the (org_id, created_at) index serves it directly.
  //
  // content is what the visitor actually SAW. For assistant messages that is
  // the verified-claims text after stripping (or the refusal fallback) —
  // never the raw model output; the full claim-level story, including what
  // was stripped, lives in message_citations.
  //
  // The three role CHECKs make column/role mismatches unrepresentable
  // (house pattern from api_keys): only assistant messages carry a model,
  // a refusal flag, a retrieval score, or latency numbers.
  await sql`
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('visitor', 'assistant', 'agent')),
      content         TEXT NOT NULL CHECK (char_length(content) > 0),
      model           TEXT CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 100),
      refused         BOOLEAN NOT NULL DEFAULT FALSE,
      retrieval_score REAL,
      ttft_ms         INT CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
      total_ms        INT CHECK (total_ms IS NULL OR total_ms >= 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (role = 'assistant' OR model IS NULL),
      CHECK (role = 'assistant' OR NOT refused),
      CHECK (role = 'assistant' OR (retrieval_score IS NULL AND ttft_ms IS NULL AND total_ms IS NULL))
    )
  `.execute(db)

  // Replay order within a thread. created_at alone can collide inside one
  // transaction; id as the tie-break keeps replay deterministic.
  await sql`
    CREATE INDEX messages_conversation ON messages (conversation_id, created_at, id)
  `.execute(db)

  // The M5 usage-cap count: answers per org per day, checked pre-flight.
  await sql`
    CREATE INDEX messages_org_created ON messages (org_id, created_at)
  `.execute(db)

  // ── Citations: one verdict per claim ─────────────────────────────────────
  // EVERY claim is stored — verified and stripped alike. The strip rate is
  // a published metric and the dashboard shows what the visitor did NOT
  // see; storing only survivors would make both impossible.
  //
  // Natural composite key (message_id, ord), like chunk_embeddings: nothing
  // ever references a citation row individually.
  //
  // chunk_id has deliberately NO foreign key. Chunks are MUTABLE pipeline
  // state — every re-chunk deletes and recreates them — while a support
  // transcript is IMMUTABLE history. An FK would force a choice between
  // cascade-deleting citations (history rots on every recrawl) and blocking
  // re-chunks (ingest hostage to chat history); snapshotting url,
  // heading_path and quote at answer time breaks the coupling entirely.
  // span_start/span_end are offsets into the cited chunk's text AS IT WAS;
  // the (verdict = 'verified') = (span_start IS NOT NULL) CHECK ties offsets
  // to verified rows exactly — a verdict without offsets and offsets without
  // a verdict are both unrepresentable.
  await sql`
    CREATE TABLE message_citations (
      message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      ord          SMALLINT NOT NULL CHECK (ord >= 0),
      chunk_id     TEXT NOT NULL CHECK (char_length(chunk_id) BETWEEN 1 AND 100),
      claim_text   TEXT NOT NULL CHECK (char_length(claim_text) > 0),
      quote        TEXT NOT NULL CHECK (char_length(quote) > 0),
      verdict      TEXT NOT NULL
                   CHECK (verdict IN ('verified', 'unknown_chunk', 'quote_not_found')),
      span_start   INT CHECK (span_start IS NULL OR span_start >= 0),
      span_end     INT,
      url          TEXT,
      heading_path TEXT,
      PRIMARY KEY (message_id, ord),
      CHECK ((verdict = 'verified') = (span_start IS NOT NULL)),
      CHECK ((span_end IS NULL) = (span_start IS NULL)),
      CHECK (span_end IS NULL OR span_start < span_end)
    )
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse dependency order. The extension is left installed: other
  // databases on the same server may use it, and DROP EXTENSION is the kind
  // of collateral damage a down() should never risk.
  await sql`DROP TABLE IF EXISTS message_citations`.execute(db)
  await sql`DROP TABLE IF EXISTS messages`.execute(db)
  await sql`DROP TABLE IF EXISTS conversations`.execute(db)
  await sql`DROP TABLE IF EXISTS ingest_jobs`.execute(db)
  await sql`DROP TABLE IF EXISTS chunk_embeddings`.execute(db)
  await sql`DROP TABLE IF EXISTS chunks`.execute(db)
  await sql`DROP TABLE IF EXISTS documents`.execute(db)
  await sql`DROP TABLE IF EXISTS sources`.execute(db)
  await sql`DROP TABLE IF EXISTS org_provider_credentials`.execute(db)
  await sql`DROP TABLE IF EXISTS allowed_origins`.execute(db)
  await sql`DROP TABLE IF EXISTS api_keys`.execute(db)
  await sql`DROP TABLE IF EXISTS sessions`.execute(db)
  await sql`DROP TABLE IF EXISTS org_members`.execute(db)
  await sql`DROP TABLE IF EXISTS users`.execute(db)
  await sql`DROP TABLE IF EXISTS organizations`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
