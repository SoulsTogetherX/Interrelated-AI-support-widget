//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 004 — usage_daily (M5.3): one row per org per UTC day, the
// counters the pre-flight quota check reads and billing rolls up.
//
// The obvious objection first: messages already holds every one of these
// facts, and M2.5's cap counted them with a range scan over the
// (org_id, created_at) index. That works, and it is what shipped. What it
// is not is CONSTANT — the cost of the check grows with the tenant's
// traffic, and it runs before every question, including the ones that get
// refused or rate-limited. A counter turns the most frequent query on the
// hot path into a single primary-key lookup whose cost does not depend on
// how successful the customer is. The same row is also what a billing
// period sums, where re-deriving a month from messages on every page load
// is the same scan repeated.
//
// The counters are written in the SAME transaction as the rows they count
// (the answer pipeline's persist step, the escalation's insert), so they
// cannot drift from the underlying history without someone deleting rows by
// hand. That is the whole reason not to run this as a nightly rollup job:
// a cap enforced against a number that is up to a day stale is not a cap.
//
// UTC days, not org-local. A per-org timezone would make the primary key
// depend on a setting a tenant can change, which would silently re-bucket
// history the moment they moved offices; the boundary being arbitrary but
// FIXED is what makes yesterday's number still true tomorrow. The widget
// route's utcDayStart already drew the line here.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE usage_daily (
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      day           DATE NOT NULL,
      -- Every assistant message, refusals INCLUDED. A refusal spends no
      -- generation tokens, but it spends an embedding call and a retrieval
      -- query, and a quota that exempted the cheapest questions to ask
      -- would be a quota an off-topic flood runs straight through.
      answers       INT NOT NULL DEFAULT 0,
      -- The sub-count, so a tenant can see the split rather than inferring
      -- it. Never greater than answers.
      refusals      INT NOT NULL DEFAULT 0,
      -- Conversations handed to a person. Only genuinely-created handoffs
      -- count: an idempotent re-request (§3.23) returns the first one and
      -- increments nothing, or one visitor's impatience would inflate the
      -- escalation rate.
      escalations   INT NOT NULL DEFAULT 0,
      -- BIGINT, unlike messages' INT columns: one row here sums a whole
      -- day's answers, and a busy pro tenant at 20k answers × ~4k context
      -- tokens is 8e7 per day — comfortably inside INT today, but a counter
      -- that overflows silently corrupts a bill, and the two extra bytes
      -- per org per day are nothing.
      input_tokens  BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Natural composite key, like chunk_embeddings and message_citations:
      -- nothing references a counter row individually, and (org, day) IS
      -- its identity. It is also the index the pre-flight check reads.
      PRIMARY KEY (org_id, day),

      -- Counters only ever go up, and each is bounded by the one it
      -- decomposes. A negative answer count would mean an increment ran
      -- backwards; a refusal count above the answer count would mean two
      -- writers disagreed about what an answer is.
      CHECK (answers >= 0 AND refusals >= 0 AND escalations >= 0),
      CHECK (refusals <= answers),
      CHECK (input_tokens >= 0 AND output_tokens >= 0)
    )
  `.execute(db)

  // The dashboard's usage chart: this org's recent days, newest first. The
  // primary key already serves the single-day lookup the hot path makes, so
  // this exists for the range read alone.
  await sql`
    CREATE INDEX usage_daily_recent ON usage_daily (org_id, day DESC)
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS usage_daily`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
