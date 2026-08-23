//#region Imports
import { describe, expect, it } from "vitest"

import { rrfFuse, DEFAULT_RRF_K } from "../rrf"
//#endregion

//#region Tests
describe("rrfFuse", () => {
  it("scores an item found by both rankings above items found by one", () => {
    // The property hybrid retrieval exists for: consensus beats any single
    // arm's head pick. "both" is rank 2 in each list; "denseTop" and
    // "lexTop" are rank 1 in exactly one. 2/(k+2) > 1/(k+1) for k=60.
    const fused = rrfFuse([
      ["denseTop", "both", "denseThird"],
      ["lexTop", "both", "lexThird"],
    ])
    expect(fused[0]?.id).toBe("both")
    expect(fused[0]?.score).toBeCloseTo(2 / (DEFAULT_RRF_K + 2), 12)
  })

  it("preserves the order of a single ranking", () => {
    const fused = rrfFuse([["a", "b", "c"]])
    expect(fused.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("computes the textbook score for each rank", () => {
    const fused = rrfFuse([["a", "b"]], 60)
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12)
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 12)
  })

  it("breaks score ties by first appearance, deterministically", () => {
    // "x" at rank 1 of the first list and "y" at rank 1 of the second have
    // identical scores; x appeared first, so x wins — every run, everywhere.
    // The eval harness diffs ranked lists across runs; nondeterministic tie
    // order would read as a retrieval regression.
    const fused = rrfFuse([["x"], ["y"]])
    expect(fused.map((r) => r.id)).toEqual(["x", "y"])
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? NaN, 12)
  })

  //#region Boundaries
  it("returns empty for no rankings and for empty rankings", () => {
    expect(rrfFuse([])).toEqual([])
    expect(rrfFuse([[], []])).toEqual([])
  })

  it("handles one empty and one populated ranking", () => {
    // A no-match lexical arm alongside a populated dense arm is the routine
    // case for out-of-vocabulary queries, not an edge case.
    const fused = rrfFuse([[], ["a", "b"]])
    expect(fused.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("smaller k amplifies head-rank differences", () => {
    // At k=0 rank 1 scores 1.0 vs rank 2's 0.5; at k=1000 they are nearly
    // equal. Pinning the direction guards against someone "fixing" the
    // formula to k * rank or similar.
    const sharp = rrfFuse([["a", "b"]], 0)
    const flat = rrfFuse([["a", "b"]], 1000)
    const gap = (r: typeof sharp) => (r[0]?.score ?? 0) - (r[1]?.score ?? 0)
    expect(gap(sharp)).toBeGreaterThan(gap(flat))
  })

  it("rejects a duplicate id within one ranking", () => {
    expect(() => rrfFuse([["a", "a"]])).toThrow(/duplicate id/)
    // …while the same id across DIFFERENT rankings is the whole point.
    expect(() => rrfFuse([["a"], ["a"]])).not.toThrow()
  })

  it("rejects a negative or non-finite k", () => {
    expect(() => rrfFuse([["a"]], -1)).toThrow(/non-negative/)
    expect(() => rrfFuse([["a"]], Number.NaN)).toThrow(/non-negative/)
  })
  //#endregion
})
//#endregion
