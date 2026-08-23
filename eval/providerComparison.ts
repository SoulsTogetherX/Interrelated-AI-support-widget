//#region Why this file
// The scoring half of the provider comparison (M8.3) — the table the plan
// calls "the strongest evidence the author evaluated rather than guessed",
// and the last of its named metrics that had no producer at all.
//
// The plan asks for "the same eval run across every provider — recall@5,
// citation-verification rate, schema-violation rate, p50 TTFT, cost per 1k
// answers". Those five columns are NOT one measurement: recall@5 is a
// property of the EMBEDDING provider and is produced by runEval's
// --embedder flag (§3.14), while the other four are properties of the
// GENERATION provider and are produced here. Keeping them apart is what
// makes either honest — a table that mixed them would let a better embedder
// flatter a worse model, and the entire point of the comparison is that a
// reader can attribute a number to a decision.
//
// Pure and database-free, the same split as eval/metrics.ts and
// eval/tenantScan.ts and for the same reason: the harness
// (realtime/scripts/runProviderComparison.ts) owns the Postgres and the
// network, and everything published is computed here where a hand-written
// fixture can pin it. The numbers reach a README, so they get a test a
// reader can redo by hand.
//
// The load-bearing decision is that a CONTRACT FAILURE is counted and is
// not an answer. When a model breaks the JSON contract twice the pipeline
// throws and writes NO assistant row (§3.15.3), so a summary built only
// from message rows would score a systematically failing provider as
// PERFECT — its worst outcome recorded as no outcome. That is the exact
// trap migration 010 was written around (§3.3.12), and this file reproduces
// the product's own split rather than inventing a second one: violations
// that landed on an answer come from `messages.schema_violations`, and the
// ones that produced nothing are counted separately, the way
// `usage_daily.schema_failures` counts them in production.
//#endregion

//#region Imports
/** Nearest-rank percentile, never interpolated — loadtest/histogram.ts's
 *  argument, that interpolation invents a latency nobody measured and that
 *  is the wrong thing to print beside "p95". Imported from
 *  eval/tenantScan.ts rather than copied a third time: that file states why
 *  the loadtest copy is not shared (separate alias roots, nothing else
 *  joins them), and inside eval/ there is no such excuse. Relative, not
 *  through the @eval alias: that alias is how CONSUMERS reach this folder,
 *  and it does not resolve from inside it. */
import { percentile } from "./tenantScan"
//#endregion

//#region Type Defs
/** What one provider did with one question.
 *
 *  The four outcomes are mutually exclusive and together exhaust the
 *  pipeline's endings (§3.15.3): the gate refused before any model call;
 *  the model answered (whether or not every claim survived verification);
 *  the model broke the contract twice; or the call failed outright — a 401,
 *  an exhausted rate-limit budget, a transport error. The last two are kept
 *  apart because they say different things about a provider: one held the
 *  wire and failed the schema, the other never produced a document at all. */
interface AnswerOutcome {
  questionId: string
  outcome: "answered" | "refused" | "contract_failure" | "error"
  /** Claims the model emitted, and the subset whose quoted span was found
   *  verbatim in the chunk it cited (§2.4.4b). Both 0 for every outcome
   *  other than "answered". */
  claimsTotal: number
  claimsVerified: number
  /** `messages.schema_violations` read back from the row the pipeline
   *  wrote — the column M7.10 added, so the harness measures the product's
   *  own record rather than a private counter kept beside it. NULL exactly
   *  when no model ran, which the column's CHECK already guarantees. */
  schemaViolations: number | null
  /** Null on every outcome where no first token ever arrived. Kept null
   *  rather than 0 because a gate refusal is fast for a reason that has
   *  nothing to do with the model, and averaging it in would report a
   *  provider as quicker the more often the corpus failed to answer —
   *  §9.13 found exactly that bug live, where a full answer read as faster
   *  than its own first token. */
  ttftMs: number | null
  totalMs: number
  inputTokens: number | null
  outputTokens: number | null
  /** List-price cost of this answer (§2.4.8), or null when the model is
   *  unpriced or the provider reported no usage. Never 0 for "unknown" —
   *  the price table's central rule. */
  costUsd: number | null
}

/** One row of the published table. */
interface ProviderSummary {
  /** How the provider was selected, and what it called itself. Both, because
   *  `--llm gemini` says which decision was made while `gemini-3.6-flash`
   *  says what was actually measured, and a default that moves would
   *  otherwise silently re-label a published row. */
  provider: string
  model: string
  questions: number
  answered: number
  refused: number
  contractFailures: number
  errors: number
  /** Verified claims / claims emitted, over answers that emitted any.
   *  NULL when no claim was ever emitted — a provider that refused
   *  everything has no verification rate, and 0% would read as "it cited
   *  and every citation was fake" while 100% would read as flawless. The
   *  null-not-zero stance §9.13 takes for every rate it publishes. */
  citationVerificationRate: number | null
  /** Its complement, published beside it rather than left to be inferred,
   *  because the strip rate is the number this whole project exists to be
   *  able to state. */
  claimStripRate: number | null
  /** Violations per GENERATED answer. Contract failures are excluded from
   *  this denominator because they wrote no row to carry a count, and get
   *  their own column instead — reading the two together is the only honest
   *  summary of a provider's structured-output discipline. */
  schemaViolationRate: number | null
  /** Contract failures over every question asked. The column that stops a
   *  systematically failing provider from reading as perfect. */
  contractFailureRate: number
  ttftP50Ms: number
  ttftP95Ms: number
  totalP50Ms: number
  totalP95Ms: number
  inputTokens: number
  outputTokens: number
  /** Over answers that could be priced. NULL when none could — an unpriced
   *  model reports "—", never "$0.00", which would be a specific falsehood
   *  about a tenant who is really paying (§2.4.8). */
  costPer1kAnswersUsd: number | null
  /** How many generated answers the cost figure covers, and how many it
   *  could not. A cost silently computed over 60% of the traffic is worse
   *  than no cost, so the denominator travels with the number (§9.13). */
  pricedAnswers: number
  unpricedAnswers: number
}
//#endregion

//#region Scoring
/** Sorts before delegating, so callers cannot pass an unsorted array and get
 *  a plausible wrong number. NaN comes back for an empty set and renders as
 *  "—" rather than "0 ms", for histogram.ts's reason: zero reads as
 *  impossibly fast where an em dash reads as never measured. */
function percentileOf(values: readonly number[], p: number): number {
  return percentile([...values].sort((a, b) => a - b), p)
}

/**
 * Summarizes one provider's run over the question set.
 *
 * Throws on an empty run rather than reporting zeros — eval/metrics.ts's and
 * eval/tenantScan.ts's stance: "this provider made no mistakes" and "this
 * provider was never asked" are opposite findings, and a table that produced
 * the first from the second would be a published lie.
 */
function summarizeProvider(
  provider: string,
  model: string,
  outcomes: readonly AnswerOutcome[],
): ProviderSummary {
  if (outcomes.length === 0) throw new Error(`summarizeProvider(${provider}): no questions measured`)

  const answered = outcomes.filter((o) => o.outcome === "answered")
  const contractFailures = outcomes.filter((o) => o.outcome === "contract_failure").length
  const claimsTotal = answered.reduce((sum, o) => sum + o.claimsTotal, 0)
  const claimsVerified = answered.reduce((sum, o) => sum + o.claimsVerified, 0)

  // Only answers that actually ran a model carry a violation count — the
  // pipeline writes NULL otherwise and the schema enforces the pairing by
  // CHECK. Filtering on the null rather than on the outcome keeps this true
  // even if a future ending writes a row this file does not know about.
  const withViolations = answered.filter((o) => o.schemaViolations !== null)
  const violations = withViolations.reduce((sum, o) => sum + (o.schemaViolations ?? 0), 0)

  // TTFT over answers that produced a first token; see AnswerOutcome.ttftMs.
  const ttfts = answered.map((o) => o.ttftMs).filter((t): t is number => t !== null)

  const priced = answered.filter((o) => o.costUsd !== null)
  const totalCost = priced.reduce((sum, o) => sum + (o.costUsd ?? 0), 0)

  return {
    provider,
    model,
    questions: outcomes.length,
    answered: answered.length,
    refused: outcomes.filter((o) => o.outcome === "refused").length,
    contractFailures,
    errors: outcomes.filter((o) => o.outcome === "error").length,
    citationVerificationRate: claimsTotal === 0 ? null : claimsVerified / claimsTotal,
    claimStripRate: claimsTotal === 0 ? null : (claimsTotal - claimsVerified) / claimsTotal,
    schemaViolationRate: withViolations.length === 0 ? null : violations / withViolations.length,
    contractFailureRate: contractFailures / outcomes.length,
    ttftP50Ms: percentileOf(ttfts, 50),
    ttftP95Ms: percentileOf(ttfts, 95),
    totalP50Ms: percentileOf(answered.map((o) => o.totalMs), 50),
    totalP95Ms: percentileOf(answered.map((o) => o.totalMs), 95),
    inputTokens: answered.reduce((sum, o) => sum + (o.inputTokens ?? 0), 0),
    outputTokens: answered.reduce((sum, o) => sum + (o.outputTokens ?? 0), 0),
    // Per 1k answers, scaled from the answers that COULD be priced rather
    // than from every answer: dividing a partial cost by a full count would
    // under-report in exactly the direction that gets believed.
    costPer1kAnswersUsd: priced.length === 0 ? null : (totalCost / priced.length) * 1000,
    pricedAnswers: priced.length,
    unpricedAnswers: answered.length - priced.length,
  }
}
//#endregion

//#region Exports
export { summarizeProvider, percentileOf }
export type { AnswerOutcome, ProviderSummary }
//#endregion
