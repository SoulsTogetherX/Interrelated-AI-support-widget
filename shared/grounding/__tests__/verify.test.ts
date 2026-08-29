import { describe, expect, it } from "vitest"

import { findQuote, verifyClaims, displayableClaims } from "../verify"
import type { VerifiableChunk } from "../verify"

//#region Fixtures
const chunkA: VerifiableChunk = {
  id: "chk_a",
  text: "Fastify offers experimental support for HTTP/2.\nTo enable it, pass the http2 option\n  to the factory. Plaintext or encrypted modes are available.",
}
const chunkB: VerifiableChunk = {
  id: "chk_b",
  text: "The onRequest hook runs first in the lifecycle. Decorators added there are visible to every later hook.",
}
const chunks = [chunkA, chunkB]

function claim(chunkId: string, quote: string, text = "Some rendered sentence.") {
  return { text, chunkId, quote }
}
//#endregion

describe("findQuote", () => {
  it("finds an exact quote and returns raw offsets that slice back to it", () => {
    const span = findQuote(chunkA.text, "experimental support for HTTP/2")
    expect(span).not.toBeNull()
    expect(chunkA.text.slice(span!.start, span!.end)).toBe("experimental support for HTTP/2")
  })

  it("tolerates rewrapped whitespace — quote single-spaced, chunk hard-wrapped", () => {
    // The quote crosses the "\n" and the "\n  " in the chunk. Raw offsets
    // must still bound the ORIGINAL spacing, not the normalized form.
    const span = findQuote(chunkA.text, "pass the http2 option to the factory")
    expect(span).not.toBeNull()
    const sliced = chunkA.text.slice(span!.start, span!.end)
    expect(sliced.replace(/\s+/g, " ")).toBe("pass the http2 option to the factory")
  })

  it("matches at the very start (start = 0)", () => {
    const span = findQuote(chunkA.text, "Fastify offers")
    expect(span).toEqual({ start: 0, end: "Fastify offers".length })
  })

  it("matches at the very end (end = text.length)", () => {
    const quote = "modes are available."
    const span = findQuote(chunkA.text, quote)
    expect(span).not.toBeNull()
    expect(span!.end).toBe(chunkA.text.length)
  })

  it("matches the entire chunk as one quote", () => {
    const span = findQuote(chunkB.text, chunkB.text)
    expect(span).toEqual({ start: 0, end: chunkB.text.length })
  })

  it("matches a single-character quote", () => {
    expect(findQuote("abc", "b")).toEqual({ start: 1, end: 2 })
  })

  it("is case-sensitive — a quote is a quotation", () => {
    expect(findQuote(chunkA.text, "fastify offers experimental")).toBeNull()
  })

  it("treats regex metacharacters as literals", () => {
    const haystack =
      "Use route.setNotFoundHandler({ preValidation: [fn] }) to override (per prefix)."
    const quote = "setNotFoundHandler({ preValidation: [fn] })"
    const span = findQuote(haystack, quote)
    expect(span).not.toBeNull()
    expect(haystack.slice(span!.start, span!.end)).toBe(quote)
  })

  it("returns the FIRST occurrence of a repeated quote", () => {
    const span = findQuote("echo echo echo", "echo")
    expect(span).toEqual({ start: 0, end: 4 })
  })

  it("returns null for blank quotes", () => {
    expect(findQuote(chunkA.text, "")).toBeNull()
    expect(findQuote(chunkA.text, "   \n ")).toBeNull()
  })

  it("returns null when the quote is absent", () => {
    expect(findQuote(chunkA.text, "refunds are always approved")).toBeNull()
  })
})

describe("verifyClaims", () => {
  it("verifies a claim whose quote occurs in its named chunk", () => {
    const [result] = verifyClaims([claim("chk_b", "runs first in the lifecycle")], chunks)
    expect(result.verdict.status).toBe("verified")
  })

  it("rejects a citation to a chunk the model was never shown", () => {
    const [result] = verifyClaims([claim("chk_fabricated", "runs first in the lifecycle")], chunks)
    expect(result.verdict).toEqual({ status: "unknown_chunk" })
  })

  it("rejects a quote that exists — but in a different chunk than the one named", () => {
    // The cross-chunk cheat: real text, wrong attribution. This is exactly
    // the mislabeling the per-chunk check exists to catch; a corpus-wide
    // search would wave it through.
    const [result] = verifyClaims([claim("chk_a", "runs first in the lifecycle")], chunks)
    expect(result.verdict).toEqual({ status: "quote_not_found" })
  })

  it("rejects an invented quote against a real chunk", () => {
    const [result] = verifyClaims(
      [claim("chk_a", "HTTP/2 is fully stable and enabled by default")],
      chunks,
    )
    expect(result.verdict).toEqual({ status: "quote_not_found" })
  })

  it("returns empty for no claims and unknown_chunk for every claim when no chunks were retrieved", () => {
    expect(verifyClaims([], chunks)).toEqual([])
    const [result] = verifyClaims([claim("chk_a", "anything")], [])
    expect(result.verdict).toEqual({ status: "unknown_chunk" })
  })

  it("preserves claim order and mixes verdicts independently", () => {
    const results = verifyClaims(
      [
        claim("chk_a", "experimental support for HTTP/2", "First."),
        claim("chk_missing", "whatever", "Second."),
        claim("chk_b", "visible to every later hook", "Third."),
        claim("chk_b", "not in this chunk at all", "Fourth."),
      ],
      chunks,
    )
    expect(results.map((r) => r.verdict.status)).toEqual([
      "verified",
      "unknown_chunk",
      "verified",
      "quote_not_found",
    ])
    expect(results.map((r) => r.claim.text)).toEqual(["First.", "Second.", "Third.", "Fourth."])
  })

  it("verified offsets point into the NAMED chunk's text", () => {
    const [result] = verifyClaims([claim("chk_b", "Decorators added there")], chunks)
    expect(result.verdict.status).toBe("verified")
    if (result.verdict.status === "verified") {
      expect(chunkB.text.slice(result.verdict.start, result.verdict.end)).toBe(
        "Decorators added there",
      )
    }
  })
})

describe("displayableClaims", () => {
  it("strips everything unverified and preserves order — the product's core promise", () => {
    const verified = verifyClaims(
      [
        claim("chk_a", "experimental support for HTTP/2", "Keep me."),
        claim("chk_ghost", "anything", "Strip me — fabricated chunk."),
        claim("chk_b", "The onRequest hook runs first", "Keep me too."),
        claim("chk_b", "totally invented sentence", "Strip me — bad quote."),
      ],
      chunks,
    )
    expect(displayableClaims(verified).map((c) => c.text)).toEqual(["Keep me.", "Keep me too."])
  })

  it("returns empty when nothing verified — the widget's fallback state, never unverified text", () => {
    const verified = verifyClaims([claim("chk_a", "invented")], chunks)
    expect(displayableClaims(verified)).toEqual([])
  })
})
