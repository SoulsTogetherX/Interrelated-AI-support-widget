//#region Imports
import { describe, expect, it } from "vitest"

import { SYSTEM_PROMPT, buildAnswerMessages, buildRetryMessages, formatChunk } from "@/answer/prompt"
import type { RetrievedChunk } from "@/retrieval/search"
//#endregion

//#region Helpers
function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chk_00000000000000000000000000000abc",
    documentId: "doc_x", url: "https://docs.example.com/http2",
    title: "HTTP2", headingPath: "HTTP2 > Secure",
    text: "Fastify offers experimental support for HTTP/2.",
    charStart: 0, charEnd: 47, score: 0.03,
    denseRank: 1, denseDistance: 0.2, lexicalRank: 1, lexicalScore: 0.4,
    ...overrides,
  }
}
//#endregion

describe("formatChunk", () => {
  it("emits the id line with url and heading trail, then the text", () => {
    expect(formatChunk(chunk())).toBe(
      "[chunk chk_00000000000000000000000000000abc | https://docs.example.com/http2 | HTTP2 > Secure]\n" +
      "Fastify offers experimental support for HTTP/2.",
    )
  })

  it("omits the heading segment when the chunk has no trail", () => {
    const formatted = formatChunk(chunk({ headingPath: null }))
    expect(formatted).toContain("| https://docs.example.com/http2]")
    expect(formatted).not.toContain("| HTTP2 > Secure")
  })
})

describe("buildAnswerMessages", () => {
  const retrieved = [chunk(), chunk({ chunkId: "chk_00000000000000000000000000000def", text: "Second excerpt." })]

  it("keeps the system prompt free of retrieved content — the injection boundary", () => {
    const [system] = buildAnswerMessages({ question: "q", retrieved })
    expect(system!.role).toBe("system")
    expect(system!.content).toBe(SYSTEM_PROMPT)
    expect(system!.content).not.toContain("Fastify offers")
  })

  it("appends the org persona to the SYSTEM prompt, never the user turn", () => {
    const [system, user] = buildAnswerMessages({
      question: "q", retrieved, persona: "Answer like a pirate.",
    })
    expect(system!.content).toContain("Answer like a pirate.")
    expect(user!.content).not.toContain("pirate")
  })

  it("delimits the context and puts the question last in the user turn", () => {
    const [, user] = buildAnswerMessages({ question: "Does it do HTTP/2?", retrieved })
    expect(user!.role).toBe("user")
    expect(user!.content).toMatch(/^<context>\n/)
    expect(user!.content).toContain("[chunk chk_00000000000000000000000000000abc |")
    expect(user!.content).toContain("[chunk chk_00000000000000000000000000000def |")
    expect(user!.content.indexOf("</context>")).toBeLessThan(user!.content.indexOf("Visitor question:"))
    expect(user!.content.trimEnd().endsWith("Does it do HTTP/2?")).toBe(true)
  })

  it("produces exactly two messages — the cacheable prefix depends on it", () => {
    expect(buildAnswerMessages({ question: "q", retrieved })).toHaveLength(2)
  })
})

describe("buildRetryMessages", () => {
  it("replays the exchange and lists every validator error", () => {
    const original = buildAnswerMessages({ question: "q", retrieved: [chunk()] })
    const retry = buildRetryMessages(original, "not json at all", [
      "claims[0].quote: expected a non-blank string",
      "claims[1].text: expected a non-blank string",
    ])
    expect(retry).toHaveLength(4)
    expect(retry[0]).toEqual(original[0])
    expect(retry[1]).toEqual(original[1])
    expect(retry[2]).toEqual({ role: "assistant", content: "not json at all" })
    expect(retry[3]!.role).toBe("user")
    expect(retry[3]!.content).toContain("claims[0].quote")
    expect(retry[3]!.content).toContain("claims[1].text")
    expect(retry[3]!.content).toContain("ONLY the corrected JSON")
  })
})
