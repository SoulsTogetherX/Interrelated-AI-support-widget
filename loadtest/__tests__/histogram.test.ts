//#region Imports
import { describe, expect, it } from "vitest"

import { Histogram, formatSummary } from "../histogram"
//#endregion

//#region Tests
// The numbers this file computes are the numbers the README quotes, so they
// are checked against hand-computed fixtures rather than trusted — the same
// stance eval/metrics.ts takes toward the retrieval scores.
describe("Histogram", () => {
  it("computes NEAREST-RANK percentiles, never an interpolation", () => {
    const histogram = new Histogram()
    // 1..10: rank for p95 is ceil(0.95 × 10) = 10 → the 10th sample.
    for (let i = 1; i <= 10; i++) histogram.record(i)

    expect(histogram.percentile(50)).toBe(5)
    expect(histogram.percentile(95)).toBe(10)
    expect(histogram.percentile(100)).toBe(10)
    // p10 is the FIRST sample, not something between 0 and 1: printing a
    // latency nobody measured is the one thing a report must not do.
    expect(histogram.percentile(10)).toBe(1)
  })

  it("is order-independent — samples arrive as the network delivers them", () => {
    const ordered = new Histogram()
    const shuffled = new Histogram()
    for (const value of [1, 2, 3, 4, 5]) ordered.record(value)
    for (const value of [4, 1, 5, 3, 2]) shuffled.record(value)
    expect(shuffled.summary()).toEqual(ordered.summary())
  })

  it("summarizes count, bounds, and mean together", () => {
    const histogram = new Histogram()
    for (const value of [10, 20, 30, 40]) histogram.record(value)
    expect(histogram.summary()).toEqual({
      count: 4, min: 10, p50: 20, p95: 40, p99: 40, max: 40, mean: 25,
    })
  })

  it("reports an empty run as empty rather than as zero latency", () => {
    // A run where nothing was measured must not print "p95 0.0 ms", which
    // reads as "impossibly fast" instead of "never happened".
    const summary = new Histogram().summary()
    expect(summary.count).toBe(0)
    expect(Number.isNaN(summary.p95)).toBe(true)
    expect(formatSummary("delivery", summary)).toContain("—")
  })

  it("refuses samples that would silently corrupt every percentile after them", () => {
    const histogram = new Histogram()
    expect(() => histogram.record(-1)).toThrow(/invalid latency/)
    expect(() => histogram.record(Number.NaN)).toThrow(/invalid latency/)
    expect(() => histogram.percentile(0)).toThrow(/out of range/)
    expect(() => histogram.percentile(101)).toThrow(/out of range/)
  })

  it("formats one aligned row per measurement", () => {
    const histogram = new Histogram()
    histogram.record(12.34)
    const row = formatSummary("connect", histogram.summary())
    expect(row).toContain("connect")
    expect(row).toContain("n=1")
    expect(row).toContain("p50    12.3")
  })
})
//#endregion
