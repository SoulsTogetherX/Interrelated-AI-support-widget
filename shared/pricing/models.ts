//#region Why this file
// The per-provider price list — the one thing M5's "cost per 1k answers"
// metric was blocked on. Token COUNTS are a measurement (the provider
// reports them, the pipeline stores them); token PRICES are published
// third-party facts with a date on them, and the difference is why they
// live in a separate file with an as-of stamp rather than inline in a
// query.
//
// In shared/ rather than providers/ even though pricing is a provider fact:
// web/ renders the number and realtime/ could record it, and web resolves
// only @/* and @shared/* by design — giving the dashboard an alias into
// providers/ would let a Server Component import an adapter that opens
// sockets, to read a constant. This file is pure data with no imports at
// all, which is the shape shared/ exists for.
//
// Two honesty rules the rest of the file implements:
//
//   1. An unknown model is priced NULL, never 0. A tenant on self-hosted
//      Ollama pays for electricity and a GPU; a tenant on a model released
//      after this table was written pays list price. Both are unknown to
//      us, and "$0.00" is a specific wrong answer where "—" is a correct
//      one. The only 0 in the table is the mock, which really is free.
//
//   2. Matching is EXACT on the stored model id — no prefix or fuzzy
//      matching. "gemini-2.5-pro" starts with "gemini-2.5" and costs an
//      order of magnitude more than Flash; a helpful prefix match would
//      report a tenant's bill as a tenth of what it is, and be believed
//      because it looked like a real number.
//
// What the resulting figure IS: what this usage would cost at the
// provider's published list price. What it is NOT: what the tenant was
// actually billed. Every provider in the plan's table has a free tier, so
// a demo org's real spend is $0 while this number is positive — that is
// the intended reading (it answers "what would this cost at scale?"), and
// the dashboard says so beside it. It also covers GENERATION only:
// embedding tokens are not metered by the pipeline, so folding a guess at
// them in would trade a known-partial number for an unknown-wrong one.
//#endregion

//#region Type Defs
/** Published list price for one model, USD per MILLION tokens. Per million
 *  because that is the unit every provider publishes — converting to
 *  per-token here would bake rounding into the table itself. */
interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
}
//#endregion

//#region Constants
/**
 * When these prices were last checked against the providers' own pricing
 * pages. Displayed next to the cost figure, because a price list without a
 * date is a rumor: Google cut Gemini's free quotas 50–80% in December 2025
 * and list prices move with them.
 */
const PRICES_AS_OF = "2026-08"

/**
 * The table. Keys are the exact `messages.model` values this product can
 * produce — the provider adapters' defaults (providers/llm/) plus the
 * cheaper siblings a tenant is most likely to override to. Anything else
 * resolves to null and is reported as unpriced rather than guessed.
 */
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Groq (providers/llm/groq.ts). Its default model, and the small one.
  "llama-3.3-70b-versatile": { inputPerMTok: 0.59, outputPerMTok: 0.79 },
  "llama-3.1-8b-instant": { inputPerMTok: 0.05, outputPerMTok: 0.08 },

  // Google Gemini (providers/llm/gemini.ts). Note the input/output ratio:
  // Flash charges ~8× more for output than input, which is exactly why the
  // pipeline caps generated tokens (MAX_ANSWER_TOKENS) rather than trusting
  // a model to be brief.
  "gemini-2.5-flash": { inputPerMTok: 0.30, outputPerMTok: 2.50 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.10, outputPerMTok: 0.40 },

  // The mock (providers/llm/mock.ts) — the one row that is legitimately
  // zero, since it never leaves the process. Without it every keyless
  // stack (dev compose, CI, the demo org) would report its cost as
  // unknown, when the true answer is exactly $0.00.
  "mock-llm": { inputPerMTok: 0, outputPerMTok: 0 },
}
//#endregion

//#region Exports
/** The published price for a model, or null when we do not know it —
 *  self-hosted models, and anything released after PRICES_AS_OF. */
function priceFor(model: string | null | undefined): ModelPrice | null {
  if (typeof model !== "string") return null
  return MODEL_PRICES[model] ?? null
}

/**
 * List-price cost in USD for one model's measured token usage, or null
 * when the model is unpriced.
 *
 * Null propagates rather than defaulting, all the way to the page: a
 * caller that wants a total over several models must decide out loud what
 * to do with the unpriced ones (the metrics layer reports how many answers
 * it could not price, next to the figure it did compute).
 */
function costUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceFor(model)
  if (price === null) return null
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000
}

export { MODEL_PRICES, PRICES_AS_OF, priceFor, costUsd }
export type { ModelPrice }
//#endregion
