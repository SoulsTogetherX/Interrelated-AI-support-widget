//#region Imports
import { LLMHttpError } from "@providers/llm/http"
//#endregion

//#region Why this file
/**
 * Surviving a provider's rate limit (M7.7) — the caller's half of a division
 * of labor the provider interface stated from the start: implementations
 * throw on transport failure, and "retry/backoff belongs to the caller"
 * (providers/llm/types.ts, §2.4.5d). This is that caller.
 *
 * It exists because of arithmetic, not taste. The free tiers this product is
 * designed around are 30 requests/minute (Groq) and 10–15 (Gemini), and a
 * visitor's question costs one model call — sometimes two, when the schema
 * retry fires. A burst of demo traffic, or one org's widget on a busy page,
 * meets that ceiling routinely, and until now a 429 threw straight out of
 * the pipeline and reached the visitor as the same opaque error a real
 * outage produces. The plan lists that under its top risks twice: "handle
 * 429s with jittered retry before failing", and the demo dying mid-visit.
 *
 * WHY A RETRY IS SAFE HERE, which is not true of every streaming pipeline:
 * nothing generated reaches the visitor until it has been parsed, verified
 * and stripped (§2.4.4c — the protocol is claim-granular precisely because a
 * claim is the smallest unit that may be shown). So a call that dies
 * half-streamed has shown nobody anything, and discarding its partial text
 * costs only tokens. A pipeline that forwarded raw deltas could not do this
 * without double-rendering.
 *
 * WHAT IS DELIBERATELY NOT RETRIED. Only failures a second attempt could
 * plausibly fix: 429, 5xx, 408, and transport errors (a socket that died, a
 * DNS blip). A 401 is a wrong key, a 400 a malformed request, a 404 a model
 * that does not exist — each is a configuration fact that will be just as
 * true in two seconds, and retrying it spends the visitor's patience to
 * reach the same failure. An abort is never retried at all: the visitor
 * closed the tab, and the whole point of the abort is to STOP spending.
 *
 * THE BUDGET IS WALL-CLOCK, not just attempts, and it is the rule that
 * matters most. A provider may answer 429 with `Retry-After: 60`, and
 * honoring that literally would hold a visitor on a spinner for a minute to
 * then maybe fail anyway. So a wait that would not fit inside the remaining
 * budget is not taken: the call fails NOW, with the provider's own error,
 * which is strictly better information delivered strictly sooner. The
 * ceiling is a product decision about how long a person will sit and watch —
 * not a technical one — which is why it is a named constant here rather than
 * a number inside the loop.
 */
//#endregion

//#region Types
interface RetryPolicy {
  /** Total attempts INCLUDING the first, so 1 disables retrying. */
  maxAttempts: number
  /** Ceiling on the total time spent WAITING between attempts (the calls
   *  themselves are bounded by the provider's own timeouts). */
  budgetMs: number
  baseDelayMs: number
  maxDelayMs: number
}

interface RetryHooks {
  /** Cancels the wait and the retry — the visitor's AbortController. */
  signal?: AbortSignal
  /** Injected for tests: rate math verified with real sleeps is rate math
   *  unverified (§3.17.2's stance, applied here). */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests, so full jitter can be pinned rather than sampled. */
  random?: () => number
  /** Called before each wait — the seam an operator-visible "retrying"
   *  log or metric hangs off, without this file knowing about either. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}
//#endregion

//#region Constants
/**
 * The default policy, and every number in it is a product judgment.
 *
 * Three attempts, because the failure this exists for is a rate limit whose
 * window is seconds: if two waits have not cleared it, the tenant is over
 * their quota rather than briefly unlucky, and more waiting is a worse
 * answer than an honest one. 8 seconds of total waiting is the outer edge of
 * what someone watching a chat bubble will sit through — it rides on top of
 * retrieval and generation, so the visitor's real wait is longer.
 *
 * A 250 ms base with full jitter and a 4 s cap: the base is short because
 * the common 429 clears almost at once, and the jitter is what keeps a
 * widget on a busy page from turning one rate limit into a synchronized
 * herd that re-limits itself on every retry.
 */
const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  budgetMs: 8_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
}

/** Not an error condition — a visitor closing the tab is the abort working. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}
//#endregion

//#region Policy
/**
 * Would a second attempt plausibly do better? An HTTP status answers this
 * precisely; anything else that is not an abort is treated as transport (a
 * dropped socket, a DNS hiccup, a TLS reset), which is exactly the class a
 * retry was invented for. Erring toward retrying a non-HTTP error is safe
 * because the budget bounds the cost, and erring the other way would mean a
 * single dropped connection loses a visitor's question.
 */
function isRetryable(err: unknown): boolean {
  if (isAbort(err)) return false
  if (err instanceof LLMHttpError) {
    return err.status === 429 || err.status === 408 || err.status >= 500
  }
  return err instanceof Error
}

/**
 * How long to wait before attempt N+1.
 *
 * `Retry-After` wins when the provider sent one: it is the only party that
 * knows when its window resets, and guessing shorter just earns another 429.
 * Otherwise exponential with FULL jitter — `random() * exponential` rather
 * than `exponential ± a bit`, because full jitter is what actually spreads a
 * synchronized herd; the tighter variants still leave every client waiting
 * roughly the same time and re-colliding.
 */
function delayFor(
  attempt: number,
  err: unknown,
  policy: RetryPolicy,
  random: () => number,
): number {
  if (err instanceof LLMHttpError && err.retryAfterMs !== null && err.retryAfterMs >= 0) {
    return err.retryAfterMs
  }
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  return Math.floor(random() * exponential)
}
//#endregion

//#region Runner
/**
 * Runs `fn`, retrying the failures above until the policy runs out of
 * attempts or of budget, then rethrowing the LAST error — the provider's
 * own, never a wrapper, so the log line above the failure says what actually
 * happened and `status`/`retryAfterMs` survive for whoever reads it.
 *
 * `fn` takes the attempt number so a caller can tell attempts apart in its
 * own instrumentation without counting them a second time.
 */
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  hooks: RetryHooks = {},
  policy: RetryPolicy = DEFAULT_POLICY,
): Promise<T> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = hooks.random ?? Math.random
  let spentMs = 0

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      // The visitor left between attempts: stop, and let the abort surface
      // as itself rather than as whatever the provider said on the way down.
      if (hooks.signal?.aborted) throw err
      if (attempt >= policy.maxAttempts || !isRetryable(err)) throw err

      const delayMs = delayFor(attempt, err, policy, random)
      // The budget rule: a wait that does not fit is not taken. Failing now
      // with the provider's error beats failing in a minute with the same
      // one, and a visitor watching a spinner cannot tell the difference
      // between "waiting" and "broken".
      if (spentMs + delayMs > policy.budgetMs) throw err

      hooks.onRetry?.({ attempt, delayMs, error: err })
      spentMs += delayMs
      await sleep(delayMs)
      if (hooks.signal?.aborted) throw err
    }
  }
}
//#endregion

//#region Exports
export { withRetry, isRetryable, delayFor, DEFAULT_POLICY }
export type { RetryHooks }
//#endregion
