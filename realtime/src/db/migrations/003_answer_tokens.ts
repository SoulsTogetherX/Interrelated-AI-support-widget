//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 003 — token usage per answer (M5.2), the input to cost per 1k
// answers.
//
// Why columns on `messages` rather than a usage table: an answer's token
// counts are facts ABOUT that answer, at exactly its grain, written in the
// same transaction that writes it. A side table would need its own key, its
// own join for every cost query, and would make "an answer whose tokens went
// missing" representable. usage_daily (M5.3) is a different thing — a
// rolled-up counter read pre-flight on the hot path — and it is derived from
// these, not a replacement for them.
//
// Nullable, deliberately. Some OpenAI-compatible servers omit usage on
// streamed responses (providers/llm/types.ts says so, and the adapters
// return null there), a gate refusal never calls a model at all, and a
// tenant's self-hosted endpoint may report nothing. NULL means "not
// reported"; 0 would mean "a model ran and consumed nothing", which is
// false. The cost metric treats them differently — unpriced answers are
// counted and shown, never averaged in as free.
//
// input_/output_ rather than prompt_/completion_: these columns are the
// persisted form of LLMUsage (providers/llm/types.ts), and matching the
// interface's names means a reader can follow one word from the provider's
// wire response to the column. OpenAI's prompt_tokens/completion_tokens
// naming is one vendor's dialect, already translated at the adapter.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE messages
      ADD COLUMN input_tokens  INT,
      ADD COLUMN output_tokens INT
  `.execute(db)

  // Non-negative, and assistant-only — the same stance 001 takes on model,
  // refused, retrieval_score and the latencies. A visitor turn carrying
  // token counts would be a pipeline bug that silently doubled every cost
  // figure; the CHECK makes it unrepresentable instead.
  await sql`
    ALTER TABLE messages
      ADD CONSTRAINT messages_tokens_non_negative
        CHECK ((input_tokens IS NULL OR input_tokens >= 0)
           AND (output_tokens IS NULL OR output_tokens >= 0)),
      ADD CONSTRAINT messages_tokens_assistant_only
        CHECK (role = 'assistant' OR (input_tokens IS NULL AND output_tokens IS NULL)),
      -- Paired, like message_citations' span_start/span_end: a provider
      -- reports usage as one object or not at all, so half a usage record
      -- is a parsing bug rather than a partial measurement. Storing it
      -- would make output-token cost — the expensive half on every model in
      -- the price list — quietly under-report.
      ADD CONSTRAINT messages_tokens_paired
        CHECK ((input_tokens IS NULL) = (output_tokens IS NULL))
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE messages
      DROP COLUMN IF EXISTS input_tokens,
      DROP COLUMN IF EXISTS output_tokens
  `.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
