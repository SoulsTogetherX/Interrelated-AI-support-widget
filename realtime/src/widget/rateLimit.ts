//#region Type Defs
/**
 * Token buckets — trust-model layer 3, the layer that actually bounds
 * scripted abuse (the Origin check defeats browsers; curl forges Origin
 * trivially, and the plan says so out loud). In-memory BY DESIGN: this
 * deployment is exactly one always-on instance (the free-tier constraint
 * that shaped the whole architecture), so a shared store would be a
 * second stateful service protecting against a topology that cannot
 * occur. If a second instance ever appears, buckets shard per-instance —
 * caps loosen by the instance count, and the DB-backed per-org daily
 * ceiling (checked in the chat route) remains exact regardless.
 *
 * Classic refill math: capacity is the burst budget, refillPerSecond the
 * sustained rate. The clock is injectable because rate math verified with
 * sleeps is rate math unverified.
 */
interface RateLimiterOptions {
  capacity: number
  refillPerSecond: number
  now?: () => number
}

interface BucketState {
  tokens: number
  updatedAt: number
}
//#endregion

//#region Limiter
class RateLimiter {
  readonly #capacity: number
  readonly #refillPerSecond: number
  readonly #now: () => number
  readonly #buckets = new Map<string, BucketState>()

  constructor(options: RateLimiterOptions) {
    if (options.capacity < 1 || options.refillPerSecond <= 0) {
      throw new Error("RateLimiter needs capacity >= 1 and refillPerSecond > 0")
    }
    this.#capacity = options.capacity
    this.#refillPerSecond = options.refillPerSecond
    this.#now = options.now ?? Date.now
  }

  /** Spends one token from `key`'s bucket. False = rate limited. */
  take(key: string): boolean {
    const now = this.#now()
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now }
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerSecond)
    bucket.updatedAt = now
    if (bucket.tokens < 1) {
      // Store the refill progress even on denial — otherwise a hammering
      // client resets its own refill and never recovers.
      this.#buckets.set(key, bucket)
      this.#sweep(now)
      return false
    }
    bucket.tokens -= 1
    this.#buckets.set(key, bucket)
    this.#sweep(now)
    return true
  }

  /**
   * Drops buckets that have fully refilled — they are indistinguishable
   * from absent ones, so keeping them is pure leak. Runs opportunistically
   * on take() past a size threshold rather than on a timer: no interval
   * handle to leak in tests, and a map only grows when traffic touches it.
   */
  #sweep(now: number): void {
    if (this.#buckets.size < 10_000) return
    const fullAfterMs = (this.#capacity / this.#refillPerSecond) * 1000
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) this.#buckets.delete(key)
    }
  }

  /** Test/observability hook. */
  get size(): number {
    return this.#buckets.size
  }
}
//#endregion

//#region Exports
export { RateLimiter }
export type { RateLimiterOptions }
//#endregion
