//#region Type Defs
/**
 * The measurement half of the handoff load harness (M4.7): latency samples
 * in, percentiles out. Pure and dependency-free, which is what lets the
 * numbers the README quotes be pinned by unit tests instead of trusted —
 * the same instinct as eval/metrics.ts, where hand-computed fixtures check
 * the scorer that grades retrieval.
 *
 * Samples are kept, not bucketed. A load run against a free-tier stack
 * produces thousands of samples, not millions, so exact percentiles cost a
 * sort and remove the "which bucket did p95 land in" question entirely.
 * If a run ever needs millions, that is the moment to switch — and the
 * tests here would keep the switch honest.
 */
interface Summary {
  count: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}
//#endregion

//#region Histogram
class Histogram {
  readonly #samples: number[] = []

  record(ms: number): void {
    // A negative or non-finite sample means the clock or the caller is
    // broken; recording it would quietly corrupt every percentile after it.
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid latency sample: ${ms}`)
    this.#samples.push(ms)
  }

  get count(): number {
    return this.#samples.length
  }

  /**
   * The NEAREST-RANK percentile: the smallest sample at or above the given
   * rank, never an interpolation between two neighbours. Interpolation
   * invents a latency nobody measured, which is exactly the wrong thing to
   * print in a README next to "p95".
   */
  percentile(p: number): number {
    if (p <= 0 || p > 100) throw new Error(`percentile out of range: ${p}`)
    if (this.#samples.length === 0) return Number.NaN
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[rank - 1] as number
  }

  summary(): Summary {
    const count = this.#samples.length
    if (count === 0) {
      return { count: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN }
    }
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    return {
      count,
      min: sorted[0] as number,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: sorted[count - 1] as number,
      mean: total / count,
    }
  }
}

/** One row of the report — "connect  n=200  p50 12.4  p95 31.0 ms". Formatted
 *  here rather than at the call site so every number in the output has the
 *  same precision, and a missing measurement reads as "—" rather than NaN. */
function formatSummary(label: string, summary: Summary): string {
  const cell = (value: number): string => (Number.isFinite(value) ? value.toFixed(1) : "—")
  return [
    label.padEnd(22),
    `n=${String(summary.count).padEnd(7)}`,
    `min ${cell(summary.min).padStart(7)}`,
    `p50 ${cell(summary.p50).padStart(7)}`,
    `p95 ${cell(summary.p95).padStart(7)}`,
    `p99 ${cell(summary.p99).padStart(7)}`,
    `max ${cell(summary.max).padStart(7)}`,
  ].join("  ")
}
//#endregion

//#region Exports
export { Histogram, formatSummary }
export type { Summary }
//#endregion
