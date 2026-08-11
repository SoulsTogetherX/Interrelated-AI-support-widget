//#region Imports
import { describe, expect, it } from "vitest"

import { evaluateGroundedness, DEFAULT_MAX_DISTANCE } from "@/answer/gate"
import type { RetrievedChunk } from "@/retrieval/search"
//#endregion

//#region Helpers
/** A RetrievedChunk with only the fields the gate reads set meaningfully. */
function hit(denseDistance: number | null): RetrievedChunk {
  return {
    chunkId: "chk_test", documentId: "doc_test", url: "https://example.com",
    title: null, headingPath: null, text: "text", charStart: null, charEnd: null,
    score: 0.03, denseRank: denseDistance === null ? null : 1, denseDistance,
    lexicalRank: denseDistance === null ? 1 : null, lexicalScore: denseDistance === null ? 0.5 : null,
  }
}
//#endregion

describe("evaluateGroundedness", () => {
  it("refuses on empty retrieval with no signal", () => {
    expect(evaluateGroundedness([])).toEqual({ refuse: true, signal: null, reason: "no_results" })
  })

  it("refuses when every hit is lexical-only — unknown similarity fails closed", () => {
    expect(evaluateGroundedness([hit(null), hit(null)]))
      .toEqual({ refuse: true, signal: null, reason: "no_dense_evidence" })
  })

  it("refuses when the closest dense evidence is beyond the threshold", () => {
    const decision = evaluateGroundedness([hit(0.9), hit(0.95)])
    expect(decision).toEqual({ refuse: true, signal: 0.9, reason: "distance_above_threshold" })
  })

  it("answers when close dense evidence exists", () => {
    const decision = evaluateGroundedness([hit(0.4), hit(0.9)])
    expect(decision).toEqual({ refuse: false, signal: 0.4, reason: null })
  })

  it("answers at EXACTLY the threshold — the boundary belongs to the answer side", () => {
    const decision = evaluateGroundedness([hit(DEFAULT_MAX_DISTANCE)])
    expect(decision.refuse).toBe(false)
  })

  it("refuses just past the threshold", () => {
    const decision = evaluateGroundedness([hit(DEFAULT_MAX_DISTANCE + 0.0001)])
    expect(decision.refuse).toBe(true)
  })

  it("takes the MINIMUM distance across hits, ignoring lexical-only rows", () => {
    // Fusion may rank a lexical-only hit first; the gate must look past it
    // to the best dense evidence anywhere in the set.
    const decision = evaluateGroundedness([hit(null), hit(0.8), hit(0.3)])
    expect(decision).toEqual({ refuse: false, signal: 0.3, reason: null })
  })

  it("honors a custom threshold", () => {
    expect(evaluateGroundedness([hit(0.4)], 0.3).refuse).toBe(true)
    expect(evaluateGroundedness([hit(0.4)], 0.5).refuse).toBe(false)
  })
})
