//#region Imports
import { describe, expect, it } from "vitest"

import { approxTokens, chunkBlocks } from "../chunker"
import type { Block } from "../chunker"
//#endregion

//#region Helpers
/** Builds a coherent source document + block list from parts, honoring the
 *  parser contract text === source.slice(charStart, charEnd) that the
 *  chunker's offset math assumes. */
function buildDoc(parts: Array<{ kind: Block["kind"]; level?: number; text: string }>): {
  source: string
  blocks: Block[]
} {
  let source = ""
  const blocks: Block[] = []
  for (const part of parts) {
    const charStart = source.length
    source += part.text
    blocks.push({ ...part, charStart, charEnd: source.length })
    source += "\n" // inter-block byte the parser consumed (not part of any block)
  }
  return { source, blocks }
}

/** A paragraph of exactly n approx-tokens (n*4 chars of 'xxx x…'). */
function paraOfTokens(n: number): string {
  return "x".repeat(n * 4)
}
//#endregion

describe("chunkBlocks", () => {
  it("returns nothing for an empty document", () => {
    expect(chunkBlocks([])).toEqual([])
  })

  it("emits one chunk for a small paragraph, with faithful offsets", () => {
    const { source, blocks } = buildDoc([{ kind: "paragraph", text: "Hello support world." }])
    const [chunk] = chunkBlocks(blocks)
    expect(chunkBlocks(blocks)).toHaveLength(1)
    expect(chunk?.ord).toBe(0)
    expect(chunk?.headingPath).toBeNull()
    // The offset contract: slicing the source at the chunk's span must
    // reproduce the chunk's text (single-piece case — exact identity).
    expect(source.slice(chunk!.charStart, chunk!.charEnd)).toBe(chunk!.text)
  })

  it("tracks the heading trail, replacing siblings and their children", () => {
    const { blocks } = buildDoc([
      { kind: "heading", level: 1, text: "Billing" },
      { kind: "heading", level: 2, text: "Refunds" },
      { kind: "paragraph", text: "Refunds take five days." },
      { kind: "heading", level: 3, text: "Partial refunds" },
      { kind: "paragraph", text: "Partial refunds are prorated." },
      { kind: "heading", level: 2, text: "Invoices" }, // must evict Refunds AND its h3 child
      { kind: "paragraph", text: "Invoices are monthly." },
    ])
    const paths = chunkBlocks(blocks).map((c) => c.headingPath)
    expect(paths).toEqual([
      "Billing > Refunds",
      "Billing > Refunds > Partial refunds",
      "Billing > Invoices",
    ])
  })

  it("packs to the target and flushes at the boundary (at cap, cap+1)", () => {
    // Two 200-token paragraphs fit a 400-token target exactly — one chunk.
    const fit = buildDoc([
      { kind: "paragraph", text: paraOfTokens(200) },
      { kind: "paragraph", text: paraOfTokens(200) },
    ])
    expect(chunkBlocks(fit.blocks, { targetTokens: 400 })).toHaveLength(1)

    // 200 + 201 exceeds it by one token — must split into two chunks.
    const over = buildDoc([
      { kind: "paragraph", text: paraOfTokens(200) },
      { kind: "paragraph", text: paraOfTokens(201) },
    ])
    const chunks = chunkBlocks(over.blocks, { targetTokens: 400 })
    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.ord)).toEqual([0, 1]) // dense, sequential
  })

  it("a heading closes the running chunk even when under target", () => {
    const { blocks } = buildDoc([
      { kind: "paragraph", text: "Intro text." },
      { kind: "heading", level: 1, text: "Details" },
      { kind: "paragraph", text: "Detail text." },
    ])
    const chunks = chunkBlocks(blocks)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.headingPath).toBeNull()
    expect(chunks[1]?.headingPath).toBe("Details")
  })

  it("splits an oversized paragraph at sentence bounds with exact offsets", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something useful here.`)
    const big = sentences.join(" ")
    const { source, blocks } = buildDoc([{ kind: "paragraph", text: big }])
    const chunks = chunkBlocks(blocks, { targetTokens: 100, maxTokens: 100 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      // Every chunk must stay under the ceiling…
      expect(chunk.tokenCount).toBeLessThanOrEqual(100)
      // …and its span must reproduce its text from the source (single-piece
      // chunks here, so identity holds exactly).
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text)
    }
    // Nothing lost: concatenating all chunk texts reproduces the paragraph.
    expect(chunks.map((c) => c.text).join("")).toBe(big)
  })

  it("hard-cuts an indivisible run rather than exceeding maxTokens", () => {
    // No sentence bounds, no spaces: a 1000-token wall of chars.
    const { blocks } = buildDoc([{ kind: "paragraph", text: "x".repeat(4000) }])
    const chunks = chunkBlocks(blocks, { targetTokens: 100, maxTokens: 100 })
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(100)
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBe(4000)
  })

  it("splits code blocks at newlines, never mid-statement by sentence regex", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i})`)
    const code = lines.join("\n")
    const { blocks } = buildDoc([{ kind: "code", text: code }])
    const chunks = chunkBlocks(blocks, { targetTokens: 120, maxTokens: 120 })
    for (const chunk of chunks) {
      // Every piece boundary must fall on a line boundary: each chunk's text
      // must be a run of complete lines from the original.
      expect(code.includes(chunk.text)).toBe(true)
      expect(chunk.text.startsWith("const ")).toBe(true)
    }
  })

  it("rejects nonsensical option combinations", () => {
    expect(() => chunkBlocks([], { targetTokens: 0 })).toThrow()
    expect(() => chunkBlocks([], { targetTokens: 400, maxTokens: 200 })).toThrow()
  })
})

describe("approxTokens", () => {
  it("is ceil(chars/4) with a floor of one", () => {
    expect(approxTokens("")).toBe(1)
    expect(approxTokens("abcd")).toBe(1)
    expect(approxTokens("abcde")).toBe(2)
  })
})
