//#region Imports
import { describe, expect, it } from "vitest"

import { summarizeScan, percentile } from "../tenantScan"
import type { TenantOutcome } from "../tenantScan"
//#endregion

//#region Fixtures
/** Hand-built outcomes, so every expectation below is arithmetic a reader
 *  can redo — the same standard eval/metrics.ts holds itself to, and the
 *  reason it matters is that these numbers get published. */
function outcome(orgId: string, returned: number, latencyMs = 10): TenantOutcome {
  return { orgId, returned, latencyMs }
}
//#endregion

describe("summarizeScan", () => {
  it("reports a healthy run as zero starved and full recall", () => {
    // What `iterative_scan = relaxed_order` is supposed to produce: every
    // tenant gets the k rows it asked for.
    const summary = summarizeScan([outcome("a", 5), outcome("b", 5), outcome("c", 5)], 5)
    expect(summary.tenants).toBe(3)
    expect(summary.starved).toBe(0)
    expect(summary.starvedFraction).toBe(0)
    expect(summary.meanReturned).toBe(5)
    expect(summary.recall).toBe(1)
  })

  it("counts a tenant short of k as starved, however slightly", () => {
    // 4 of 5 is a widget answering from 80% of its own documentation with
    // no error anywhere — the failure mode this measurement exists to size,
    // so "nearly enough" is still starved.
    const summary = summarizeScan([outcome("a", 5), outcome("b", 4), outcome("c", 0)], 5)
    expect(summary.starved).toBe(2)
    expect(summary.starvedFraction).toBeCloseTo(2 / 3, 10)
    expect(summary.meanReturned).toBeCloseTo(3, 10)
    // 9 rows delivered against 15 asked for.
    expect(summary.recall).toBeCloseTo(0.6, 10)
  })

  it("reports latency percentiles by nearest rank, never interpolated", () => {
    const summary = summarizeScan(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms, i) => outcome(`t${i}`, 1, ms)),
      1,
    )
    // p50 of ten samples is the 5th by nearest rank — a real measurement,
    // not the 5.5 an interpolating percentile would invent.
    expect(summary.latencyP50Ms).toBe(5)
    expect(summary.latencyP95Ms).toBe(10)
  })

  it("refuses an empty run rather than reporting a flattering zero", () => {
    // "No tenant starved" and "no tenant was measured" are opposite
    // findings; a summary that produced the first from the second would be
    // a published lie.
    expect(() => summarizeScan([], 5)).toThrow(/no tenants measured/)
  })

  it("refuses a nonsense k", () => {
    expect(() => summarizeScan([outcome("a", 1)], 0)).toThrow(/positive integer/)
    expect(() => summarizeScan([outcome("a", 1)], 1.5)).toThrow(/positive integer/)
  })
})

describe("percentile", () => {
  it("is nearest-rank and clamps at both ends", () => {
    const sorted = [10, 20, 30, 40]
    expect(percentile(sorted, 0)).toBe(10)
    expect(percentile(sorted, 50)).toBe(20)
    expect(percentile(sorted, 100)).toBe(40)
  })

  it("is NaN for an empty sample, not zero", () => {
    // "0 ms" reads as impossibly fast where NaN renders as "—" and reads as
    // never happened.
    expect(percentile([], 50)).toBeNaN()
  })
})
