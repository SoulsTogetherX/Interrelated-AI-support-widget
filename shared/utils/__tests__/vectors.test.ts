//#region Imports
import { describe, expect, it } from "vitest"

import { PADDED_DIM, fromPgvector, padVector, toPgvector } from "../vectors"
//#endregion

//#region Helpers
// Deterministic pseudo-random vectors: tests must not flake, so no
// Math.random — a linear congruential generator with a fixed seed gives
// "random-looking" data with reproducible failures.
function lcgVector(seed: number, dim: number): number[] {
  let s = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out.push((s / 0xffffffff) * 2 - 1)
  }
  return out
}

const dot = (a: number[], b: number[]): number => a.reduce((acc, v, i) => acc + v * b[i], 0)
const norm = (a: number[]): number => Math.sqrt(dot(a, a))
//#endregion

describe("padVector", () => {
  it("preserves dot products and norms exactly (the two-line proof, executed)", () => {
    // This is the property the whole shared-column design rests on: if
    // padding changed either quantity, cosine rankings would shift and
    // retrieval quality would silently degrade for padded models.
    for (const seed of [1, 42, 31337]) {
      const u = lcgVector(seed, 384)
      const v = lcgVector(seed + 1, 384)
      const pu = padVector(u)
      const pv = padVector(v)
      expect(pu).toHaveLength(PADDED_DIM)
      expect(dot(pu, pv)).toBeCloseTo(dot(u, v), 10)
      expect(norm(pu)).toBeCloseTo(norm(u), 10)
    }
  })

  it("handles the boundaries: exact fit passes, oversize and empty throw", () => {
    const exact = lcgVector(7, PADDED_DIM)
    expect(padVector(exact)).toEqual(exact) // 1024 → unchanged
    expect(() => padVector(lcgVector(7, PADDED_DIM + 1))).toThrow(/exceeding/) // 1025
    expect(() => padVector([])).toThrow(/empty/)
  })
})

describe("pgvector serialization", () => {
  it("round-trips through the text format", () => {
    const v = [1, -0.5, 0.25, 3.14159]
    expect(fromPgvector(toPgvector(v))).toEqual(v)
  })

  it("matches the literal shape Postgres accepts", () => {
    // Pinned as a string because migration tests and repositories rely on
    // this exact shape being castable with ::halfvec(1024).
    expect(toPgvector([1, 2, 3])).toBe("[1,2,3]")
  })

  it("rejects malformed literals instead of yielding NaNs", () => {
    expect(() => fromPgvector("1,2,3")).toThrow(/literal/)
    expect(() => fromPgvector("[]")).toThrow(/empty/)
    expect(() => fromPgvector("[1,banana,3]")).toThrow(/malformed/)
  })
})
