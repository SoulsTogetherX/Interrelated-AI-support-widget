//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 003 — chat persistence: conversations, their messages, and the
// per-claim citation verdicts. What M2's answer pipeline writes and the M3
// dashboard reads.
//
// The one deliberate schema decision here: message_citations SNAPSHOTS what
// it cites (chunk id without FK, plus url/heading/quote copies) instead of
// referencing live pipeline rows. Chunks are MUTABLE state — every re-chunk
// deletes and recreates them — while a support transcript is IMMUTABLE
// history. An FK would force a choice between cascade-deleting citations
// (history rots on every recrawl) and blocking re-chunks (ingest hostage to
// chat history). Snapshotting breaks the coupling entirely.

async function up(db: Kysely<unknown>): Promise<void> {
  // ── Conversations: one widget chat thread ────────────────────────────────
  // visitor_id is the widget-generated anonymous id (no FK — visitors are
  // not users and never will be; authenticated-visitor mode in the plan's
  // trust-model layer 6 still identifies THEIR user, not ours).
  //
  // status carries 'escalated' from day one even though handoff is M4:
  // adding an enum value later is a migration, and the M2 widget already
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
  // chunk_id has deliberately NO foreign key (see the header comment) —
  // url/heading_path/quote are snapshots taken at answer time so the
  // citation still renders after the chunk is re-chunked away. span_start/
  // span_end are offsets into the cited chunk's text AS IT WAS; the
  // (verdict = 'verified') = (span_start IS NOT NULL) CHECK ties offsets to
  // verified rows exactly — a verdict without offsets and offsets without a
  // verdict are both unrepresentable.
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
  await sql`DROP TABLE IF EXISTS message_citations`.execute(db)
  await sql`DROP TABLE IF EXISTS messages`.execute(db)
  await sql`DROP TABLE IF EXISTS conversations`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
