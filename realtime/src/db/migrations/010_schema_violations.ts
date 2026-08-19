//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 010 — the schema-violation metric (M7.10).
//
// The plan's anti-tutorial rules name this one directly: structured output
// differs per provider, "weaker paths need validate-and-one-retry rather
// than trusting the first response", and **schema violations are a counted
// metric, not a swallowed exception**. The pipeline has done the first half
// since M2.3 — it validates, retries exactly once, and gives up loudly —
// but nothing recorded WHETHER a given answer needed that retry, so the
// rate was an exception being handled rather than a number anyone could
// read. This migration is the counting half.
//
// It matters most as a COMPARISON. Four providers now enforce a schema four
// different ways (§2.4.5n): Gemini validates it server-side, Ollama
// constrains generation with `format`, Anthropic forces a tool call whose
// arguments are the document, and JSON mode on the OpenAI-compatible path
// is a polite request. Those should NOT produce the same violation rate,
// and the difference is exactly what the plan's provider-comparison table
// is supposed to show. A number that can only be zero would be decoration.
//
// ── messages.schema_violations ──────────────────────────────────────────
//
// How many times the model broke the answer contract while producing THIS
// message: 0 when it held on the first attempt, 1 when the retry rescued
// it. The cap is a product decision (exactly one retry — prompt.ts) rather
// than a schema one, so this is an INT and not a BOOLEAN: a boolean would
// bake today's cap into the table, and a count is what the metric sums
// anyway.
//
// NULLABLE, and the null is load-bearing — 003's argument for the token
// columns, applied to the same distinction. NULL means NO MODEL RAN: a
// groundedness-gate refusal (which never calls one), a visitor's turn, an
// agent's reply. Zero would mean "a model ran and held the contract", which
// is a specific falsehood about a refusal, and it would drag the violation
// rate toward zero by padding the denominator with answers no model wrote.
// A CHECK ties the pairing exactly, in the 001 style where a mismatch is
// unrepresentable rather than merely unlikely: a row has a model if and
// only if it has a violation count.
//
// The one-time imprecision, stated rather than smoothed over: rows written
// BEFORE this migration are backfilled to 0, which claims those answers
// held the contract when the truth is that nobody recorded it. That is
// acceptable here for the same reason the schema was flattened at M3 —
// this product is pre-launch, and the only deployed rows are a demo corpus
// a seed script recreates in seconds. On a database with real traffic the
// honest choice would be the opposite one (leave history NULL and drop the
// pairing CHECK), and it is written down here so that a future migration
// making that trade knows this one made it deliberately.
//
// ── usage_daily.schema_failures ─────────────────────────────────────────
//
// The case the message column CANNOT hold, and the one that matters most:
// when the retry ALSO fails, the pipeline throws and NO assistant row is
// written at all. Counting violations only on messages would therefore make
// a provider that fails systematically look perfect — the worst outcome
// recorded as no outcome, which is precisely the "swallowed exception" the
// plan is warning about. So the org's daily counters get the total, beside
// the answers and refusals they already carry.
//
// Per (org, day) rather than per model, because there is no message row to
// hang a model on — that is the whole problem. What this number answers is
// "how many questions did we fail to answer today because a model could not
// hold the contract?", which is an alerting question rather than a
// comparison one. The comparison lives on the messages column.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE messages
      ADD COLUMN schema_violations INT
  `.execute(db)

  // History first, so the CHECK below can be added without a violation.
  await sql`
    UPDATE messages SET schema_violations = 0 WHERE model IS NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE messages
      ADD CONSTRAINT messages_schema_violations_nonneg
        CHECK (schema_violations IS NULL OR schema_violations >= 0),
      ADD CONSTRAINT messages_schema_violations_pairs_with_model
        CHECK ((model IS NULL) = (schema_violations IS NULL))
  `.execute(db)

  await sql`
    ALTER TABLE usage_daily
      ADD COLUMN schema_failures INT NOT NULL DEFAULT 0,
      ADD CONSTRAINT usage_daily_schema_failures_nonneg
        CHECK (schema_failures >= 0)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE usage_daily DROP COLUMN schema_failures`.execute(db)
  await sql`ALTER TABLE messages DROP COLUMN schema_violations`.execute(db)
}
//#endregion
