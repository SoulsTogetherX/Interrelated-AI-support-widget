// The retry policy (M7.7) — keyless and instant: the sleep and the random
// are injected, because rate math verified with real sleeps is rate math
// unverified (§3.17.2's stance, and the reason this file runs in
// milliseconds instead of tens of seconds).
import { describe, expect, it, vi } from "vitest"

import { LLMHttpError } from "@providers/llm/http"

import { withRetry, isRetryable, delayFor, DEFAULT_POLICY } from "@/answer/retry"

/** Records what was waited for instead of waiting. */
function fakeSleep() {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
  }
}

const http = (status: number, retryAfterMs: number | null = null) =>
  new LLMHttpError({ provider: "test", status, detail: "nope", retryAfterMs })

describe("isRetryable — would a second attempt plausibly do better?", () => {
  it("retries the failures a wait can clear", () => {
    expect(isRetryable(http(429))).toBe(true) // the free tier's window
    expect(isRetryable(http(408))).toBe(true) // the provider timed us out
    expect(isRetryable(http(500))).toBe(true)
    expect(isRetryable(http(503))).toBe(true) // mid-deploy on their side
    // A dropped socket or a DNS blip: the class retries were invented for,
    // and the budget bounds the cost of being wrong about it.
    expect(isRetryable(new Error("fetch failed"))).toBe(true)
  })

  it("refuses the failures that are configuration facts, not weather", () => {
    // Each of these will be just as true in two seconds, so retrying only
    // spends the visitor's patience to reach the same failure.
    expect(isRetryable(http(401))).toBe(false) // wrong key
    expect(isRetryable(http(400))).toBe(false) // malformed request
    expect(isRetryable(http(404))).toBe(false) // no such model
    expect(isRetryable(http(422))).toBe(false)
  })

  it("never retries an abort — the visitor left, and stopping is the point", () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(isRetryable(abort)).toBe(false)
    const timeout = new Error("timed out")
    timeout.name = "TimeoutError"
    expect(isRetryable(timeout)).toBe(false)
  })
})

describe("delayFor — how long to wait", () => {
  it("honors Retry-After, because only the provider knows when its window resets", () => {
    expect(delayFor(1, http(429, 2_000), DEFAULT_POLICY, () => 0.5)).toBe(2_000)
    // Even a long one is REPORTED faithfully here; whether it is affordable
    // is the budget's decision, not this function's.
    expect(delayFor(1, http(429, 60_000), DEFAULT_POLICY, () => 0.5)).toBe(60_000)
  })

  it("backs off exponentially with FULL jitter when the provider said nothing", () => {
    // full jitter = random() × exponential, so random()=1 is the ceiling and
    // random()=0 is an immediate retry — the spread is the whole point.
    expect(delayFor(1, http(500), DEFAULT_POLICY, () => 1)).toBe(250)
    expect(delayFor(2, http(500), DEFAULT_POLICY, () => 1)).toBe(500)
    expect(delayFor(3, http(500), DEFAULT_POLICY, () => 1)).toBe(1_000)
    expect(delayFor(1, http(500), DEFAULT_POLICY, () => 0)).toBe(0)
    // …and it is capped, so attempt 40 does not propose a four-hour wait.
    expect(delayFor(40, http(500), DEFAULT_POLICY, () => 1)).toBe(DEFAULT_POLICY.maxDelayMs)
  })

  it("spreads concurrent clients rather than re-colliding them", () => {
    // The property full jitter exists for: two widgets rate-limited by the
    // same burst must not wake together and re-limit each other.
    const a = delayFor(2, http(429), DEFAULT_POLICY, () => 0.1)
    const b = delayFor(2, http(429), DEFAULT_POLICY, () => 0.9)
    expect(a).not.toBe(b)
  })
})

describe("withRetry", () => {
  it("returns the first success without waiting at all", async () => {
    const { waits, sleep } = fakeSleep()
    const fn = vi.fn(async () => "answer")
    expect(await withRetry(fn, { sleep })).toBe("answer")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it("clears a 429 that a short wait fixes — the case this exists for", async () => {
    const { waits, sleep } = fakeSleep()
    let calls = 0
    const fn = async () => {
      calls++
      if (calls === 1) throw http(429, 300)
      return "answer"
    }
    expect(await withRetry(fn, { sleep, random: () => 0.5 })).toBe("answer")
    expect(calls).toBe(2)
    expect(waits).toEqual([300]) // the provider's own Retry-After
  })

  it("gives up after maxAttempts and rethrows the PROVIDER's error, not a wrapper", async () => {
    const { waits, sleep } = fakeSleep()
    let calls = 0
    const fn = async () => {
      calls++
      throw http(429, 10)
    }
    // The original error survives, so status and retryAfterMs are still
    // there for whoever reads the log line above the failure.
    await expect(withRetry(fn, { sleep, random: () => 0.5 })).rejects.toMatchObject({
      name: "LLMHttpError",
      status: 429,
    })
    expect(calls).toBe(DEFAULT_POLICY.maxAttempts)
    expect(waits).toHaveLength(DEFAULT_POLICY.maxAttempts - 1)
  })

  it("fails IMMEDIATELY when the wait would not fit the budget", async () => {
    // A provider answering `Retry-After: 60s` is the case: honoring it would
    // hold a visitor on a spinner for a minute to then maybe fail anyway.
    // Failing now delivers strictly better information strictly sooner.
    const { waits, sleep } = fakeSleep()
    let calls = 0
    const fn = async () => {
      calls++
      throw http(429, 60_000)
    }
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 429 })
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it("spends its budget across several waits and then stops", async () => {
    const { waits, sleep } = fakeSleep()
    const fn = async () => {
      throw http(429, 3_000)
    }
    // 3 s + 3 s = 6 s fits inside 8 s; a third would not — but maxAttempts
    // ends it first, and the test pins the arithmetic either way.
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 429 })
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(DEFAULT_POLICY.budgetMs)
  })

  it("does not retry what a retry cannot fix", async () => {
    const { waits, sleep } = fakeSleep()
    let calls = 0
    const fn = async () => {
      calls++
      throw http(401)
    }
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 401 })
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it("stops the moment the visitor closes the tab, mid-backoff included", async () => {
    const controller = new AbortController()
    let calls = 0
    const fn = async () => {
      calls++
      throw http(429, 100)
    }
    // Aborted DURING the wait: the next attempt must not happen, because the
    // whole point of the abort is to stop spending the tenant's tokens.
    const sleep = async () => {
      controller.abort()
    }
    await expect(withRetry(fn, { sleep, signal: controller.signal })).rejects.toMatchObject({
      status: 429,
    })
    expect(calls).toBe(1)
  })

  it("reports each retry to its caller, so a wait is never silent", async () => {
    const { sleep } = fakeSleep()
    const seen: Array<{ attempt: number; delayMs: number }> = []
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw http(503, 50)
      return "answer"
    }
    await withRetry(fn, {
      sleep,
      onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
    })
    expect(seen).toEqual([
      { attempt: 1, delayMs: 50 },
      { attempt: 2, delayMs: 50 },
    ])
  })

  it("passes the attempt number through, so a caller can tell attempts apart", async () => {
    const { sleep } = fakeSleep()
    const attempts: number[] = []
    await withRetry(
      async (attempt) => {
        attempts.push(attempt)
        if (attempt < 3) throw http(500, 1)
        return "answer"
      },
      { sleep },
    )
    expect(attempts).toEqual([1, 2, 3])
  })
})
