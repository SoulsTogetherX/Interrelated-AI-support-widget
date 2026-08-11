//#region Imports
import { describe, expect, it } from "vitest"

import { RateLimiter } from "@/widget/rateLimit"
//#endregion

//#region Test Setup
/** Injectable clock — rate math verified with sleeps is rate math
 *  unverified. */
function clockAt(start: number) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}
//#endregion

describe("RateLimiter", () => {
  it("allows exactly `capacity` immediate takes, denies the next — the boundary", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: clock.now })
    expect([limiter.take("k"), limiter.take("k"), limiter.take("k")]).toEqual([true, true, true])
    expect(limiter.take("k")).toBe(false)
  })

  it("refills at the configured rate — one token after exactly one second", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now })
    limiter.take("k")
    limiter.take("k")
    clock.advance(999)
    expect(limiter.take("k")).toBe(false)
    clock.advance(1)
    expect(limiter.take("k")).toBe(true)
    // And the refill it just spent is gone again.
    expect(limiter.take("k")).toBe(false)
  })

  it("caps refill at capacity — a long absence is not a bigger burst", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now })
    limiter.take("k")
    limiter.take("k")
    clock.advance(3_600_000)
    expect([limiter.take("k"), limiter.take("k"), limiter.take("k")]).toEqual([true, true, false])
  })

  it("keys are independent — one client's flood is not another's limit", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.001, now: clock.now })
    expect(limiter.take("flooder")).toBe(true)
    expect(limiter.take("flooder")).toBe(false)
    expect(limiter.take("bystander")).toBe(true)
  })

  it("a hammering client still recovers on schedule — denials don't reset refill", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.take("k")
    // Hammer every 100 ms; the fractional refill must accumulate across
    // denials rather than being discarded with each rejected call. (The
    // final step advances 101 ms, not 100: ten sequential +0.1s sum to
    // 0.999… under IEEE 754, and the boundary itself is not the property
    // under test — accumulation is. If denials RESET refill, tokens here
    // would be ~0.1, nowhere near enough, and this still fails loudly.)
    for (let i = 0; i < 9; i++) {
      clock.advance(100)
      expect(limiter.take("k")).toBe(false)
    }
    clock.advance(101)
    expect(limiter.take("k")).toBe(true)
  })

  it("rejects nonsensical configuration loudly", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow()
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow()
  })

  it("sweeps fully-refilled buckets once past the size threshold", () => {
    const clock = clockAt(0)
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    for (let i = 0; i < 10_000; i++) limiter.take(`k${i}`)
    expect(limiter.size).toBe(10_000)
    // Everything refills within a second; the next take triggers the sweep.
    clock.advance(5_000)
    limiter.take("fresh")
    expect(limiter.size).toBe(1)
  })
})
