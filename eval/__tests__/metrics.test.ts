//#region Imports
import { describe, expect, it } from "vitest"

import { mrrAtK, ndcgAtK, recallAtK, scoreRun } from "../metrics"
import type { QueryJudgment } from "../metrics"
//#endregion

//#region Helpers
const j = (relevant: string[], ranked: string[]): QueryJudgment => ({
  relevant: new Set(relevant),
  ranked,
})
//#endregion

//#region Tests
describe("recallAtK", () => {
  it("is 1 when the single gold is retrieved anywhere in the top k", () => {
    expect(recallAtK(j(["g"], ["a", "b", "g"]), 5)).toBe(1)
  })

  it("is 0 when the gold sits just below the cutoff", () => {
    // The boundary that matters: rank k+1 counts for nothing at k.
    expect(recallAtK(j(["g"], ["a", "b", "g"]), 2)).toBe(0)
    expect(recallAtK(j(["g"], ["a", "b", "g"]), 3)).toBe(1)
  })

  it("credits partial coverage with multiple golds", () => {
    expect(recallAtK(j(["g1", "g2"], ["g1", "x", "y"]), 3)).toBe(0.5)
  })

  it("handles k beyond the ranked list and an empty ranked list", () => {
    expect(recallAtK(j(["g"], ["g"]), 10)).toBe(1)
    expect(recallAtK(j(["g"], []), 10)).toBe(0)
  })
})

describe("mrrAtK", () => {
  it("is the reciprocal rank of the FIRST relevant result", () => {
    expect(mrrAtK(j(["g"], ["a", "b", "g"]), 10)).toBeCloseTo(1 / 3, 12)
    // A second gold further down must not change it.
    expect(mrrAtK(j(["g", "h"], ["a", "g", "h"]), 10)).toBeCloseTo(1 / 2, 12)
  })

  it("is 0 when no relevant result is inside the cutoff", () => {
    expect(mrrAtK(j(["g"], ["a", "b"]), 10)).toBe(0)
    expect(mrrAtK(j(["g"], ["a", "b", "g"]), 2)).toBe(0)
  })
})

describe("ndcgAtK", () => {
  it("is 1 for the ideal ranking", () => {
    expect(ndcgAtK(j(["g1", "g2"], ["g1", "g2", "x"]), 10)).toBeCloseTo(1, 12)
  })

  it("matches the hand-computed value for a buried gold", () => {
    // Single gold at rank 3: DCG = 1/log2(4) = 0.5, IDCG = 1/log2(2) = 1.
    expect(ndcgAtK(j(["g"], ["a", "b", "g"]), 10)).toBeCloseTo(0.5, 12)
  })

  it("prefers golds packed early over golds spread late", () => {
    // The whole-ordering property recall and MRR both miss: same set
    // retrieved, different positions.
    const early = ndcgAtK(j(["g1", "g2"], ["x", "g1", "g2", "y"]), 10)
    const late = ndcgAtK(j(["g1", "g2"], ["x", "g1", "y", "z", "a", "b", "c", "d", "g2"]), 10)
    expect(early).toBeGreaterThan(late)
  })

  it("is 0 when nothing relevant is retrieved", () => {
    expect(ndcgAtK(j(["g"], ["a", "b"]), 10)).toBe(0)
  })
})

describe("scoreRun", () => {
  it("macro-averages across queries", () => {
    const run = scoreRun([
      j(["g"], ["g"]), // recall@1 = 1, mrr = 1, ndcg = 1
      j(["h"], ["x", "h"]), // recall@1 = 0, mrr = 1/2, ndcg = 1/log2(3)
    ])
    expect(run.queries).toBe(2)
    expect(run.recall[1]).toBeCloseTo(0.5, 12)
    expect(run.recall[5]).toBeCloseTo(1, 12)
    expect(run.mrr10).toBeCloseTo(0.75, 12)
    expect(run.ndcg10).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 12)
  })

  //#region Boundaries
  it("rejects an empty run", () => {
    expect(() => scoreRun([])).toThrow(/empty run/)
  })

  it("rejects an empty relevant set — an unresolved golden anchor", () => {
    expect(() => scoreRun([j([], ["a"])])).toThrow(/empty relevant set/)
  })

  it("rejects duplicate ids in the ranked list", () => {
    expect(() => scoreRun([j(["g"], ["a", "a"])])).toThrow(/duplicates/)
  })

  it("rejects a non-positive or fractional k", () => {
    expect(() => recallAtK(j(["g"], ["g"]), 0)).toThrow(/positive integer/)
    expect(() => recallAtK(j(["g"], ["g"]), 2.5)).toThrow(/positive integer/)
  })
  //#endregion
})
//#endregion
