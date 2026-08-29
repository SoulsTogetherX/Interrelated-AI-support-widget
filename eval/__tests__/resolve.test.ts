//#region Imports
import { describe, expect, it } from "vitest"

import { resolveAnchor, squash } from "../resolve"
//#endregion

//#region Tests
describe("squash", () => {
  it("collapses runs of whitespace, including newlines, to single spaces", () => {
    expect(squash("a  b\nc\t d")).toBe("a b c d")
  })

  it("trims the edges", () => {
    expect(squash("  a b  ")).toBe("a b")
  })
})

describe("resolveAnchor", () => {
  it("matches an anchor across a rewrapped line break", () => {
    // The reason squash exists: the golden anchor quotes prose as one line,
    // the corpus wraps it. Upstream rewrapping must not break resolution.
    const chunks = [
      { id: "c1", text: "Fastify starts loading the plugin\n__after__ `.listen()` is called." },
    ]
    expect(resolveAnchor(chunks, "loading the plugin __after__ `.listen()` is called")).toEqual([
      "c1",
    ])
  })

  it("is case-sensitive — an anchor is a quotation, not a search", () => {
    const chunks = [{ id: "c1", text: "The Done callback." }]
    expect(resolveAnchor(chunks, "the done callback")).toEqual([])
  })

  it("returns ALL chunks containing the anchor", () => {
    // A sentence legally repeated across chunks makes both correct
    // retrieval targets; resolving to just one would punish retrieval for
    // finding the other.
    const chunks = [
      { id: "c1", text: "Contact the help desk portal." },
      { id: "c2", text: "unrelated" },
      { id: "c3", text: "Contact the   help desk portal." },
    ]
    expect(resolveAnchor(chunks, "help desk portal")).toEqual(["c1", "c3"])
  })

  it("returns empty for no match and for an empty anchor", () => {
    // Empty result is the caller's loud-failure signal; an empty NEEDLE
    // must not silently match everything (''.includes('') is true).
    const chunks = [{ id: "c1", text: "some text" }]
    expect(resolveAnchor(chunks, "absent phrase")).toEqual([])
    expect(resolveAnchor(chunks, "   ")).toEqual([])
    expect(resolveAnchor([], "anything")).toEqual([])
  })
})
//#endregion
