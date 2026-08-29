import { describe, expect, it } from "vitest"

import { MAX_CLAIMS, ANSWER_JSON_SCHEMA, parseAnswerPayload, parseAnswerText } from "../claims"

//#region Fixtures
const goodClaim = {
  text: "Fastify supports HTTP/2.",
  chunkId: "chk_a",
  quote: "Fastify offers experimental support for HTTP/2",
}

function payloadWith(claims: unknown): unknown {
  return { claims }
}
//#endregion

describe("parseAnswerPayload", () => {
  it("accepts a well-formed payload and round-trips the values", () => {
    const result = parseAnswerPayload(payloadWith([goodClaim]))
    expect(result).toEqual({ ok: true, payload: { claims: [goodClaim] } })
  })

  it("accepts an empty claims array — the model's refusal shape", () => {
    const result = parseAnswerPayload(payloadWith([]))
    expect(result).toEqual({ ok: true, payload: { claims: [] } })
  })

  it("rejects non-object roots", () => {
    for (const root of [null, "text", 42, [goodClaim], undefined]) {
      const result = parseAnswerPayload(root)
      expect(result.ok).toBe(false)
    }
  })

  it("rejects a missing or non-array claims field", () => {
    for (const claims of [undefined, null, "chunk", { 0: goodClaim }]) {
      const result = parseAnswerPayload(payloadWith(claims))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors[0]).toContain("claims")
    }
  })

  it("rejects blank and missing claim fields with path-prefixed errors", () => {
    const result = parseAnswerPayload(
      payloadWith([
        { text: "   ", chunkId: "chk_a", quote: "q" },
        { text: "ok", quote: "q" },
        { text: "ok", chunkId: "chk_a", quote: 7 },
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain("claims[0].text: expected a non-blank string")
      expect(result.errors).toContain("claims[1].chunkId: expected a non-blank string")
      expect(result.errors).toContain("claims[2].quote: expected a non-blank string")
    }
  })

  it("collects every error in one pass — the single retry prompt needs the full list", () => {
    const result = parseAnswerPayload(
      payloadWith([{ text: "", chunkId: "", quote: "" }, "not an object"]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBe(4)
  })

  it("accepts exactly MAX_CLAIMS and rejects MAX_CLAIMS + 1", () => {
    const atCap = Array.from({ length: MAX_CLAIMS }, () => goodClaim)
    expect(parseAnswerPayload(payloadWith(atCap)).ok).toBe(true)
    const overCap = [...atCap, goodClaim]
    const result = parseAnswerPayload(payloadWith(overCap))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain(String(MAX_CLAIMS))
  })
})

describe("parseAnswerText", () => {
  const json = JSON.stringify({ claims: [goodClaim] })

  it("parses bare JSON", () => {
    expect(parseAnswerText(json)).toEqual({ ok: true, payload: { claims: [goodClaim] } })
  })

  it("parses JSON inside a ```json fence", () => {
    expect(parseAnswerText("```json\n" + json + "\n```")).toEqual({
      ok: true,
      payload: { claims: [goodClaim] },
    })
  })

  it("parses JSON inside a bare ``` fence", () => {
    expect(parseAnswerText("```\n" + json + "\n```")).toEqual({
      ok: true,
      payload: { claims: [goodClaim] },
    })
  })

  it("parses JSON wrapped in prose preamble and postamble", () => {
    const wrapped = "Here is the answer you asked for:\n" + json + "\nHope that helps!"
    expect(parseAnswerText(wrapped)).toEqual({ ok: true, payload: { claims: [goodClaim] } })
  })

  it("fails on text with no JSON at all, naming the parse failure", () => {
    const result = parseAnswerText("I cannot answer that question.")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("not valid JSON")
  })

  it("fails on the empty string", () => {
    expect(parseAnswerText("").ok).toBe(false)
  })

  it("valid JSON of the wrong shape returns structural errors, not a JSON error", () => {
    const result = parseAnswerText(JSON.stringify({ answer: "free text" }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("claims")
  })

  it("rescues an UNTERMINATED fence via the brace slice — a stream cut off before ```", () => {
    // The fence regex needs a closing ```, so candidate 2 never matches; the
    // first-{-to-last-} slice still recovers the object. This is a real
    // failure shape: the closing fence is the last thing a model emits.
    const text = "```json\n" + json
    expect(parseAnswerText(text)).toEqual({ ok: true, payload: { claims: [goodClaim] } })
  })

  it("gives up on a fence of broken JSON followed by junk — that is what the retry is for", () => {
    // Nothing recoverable here: the brace slice starts at the broken "{",
    // so every candidate fails. Heuristics deliberately stop at formatting
    // noise; a genuinely malformed payload must surface as ok: false.
    const result = parseAnswerText("```json\n{broken\n```")
    expect(result.ok).toBe(false)
  })
})

describe("ANSWER_JSON_SCHEMA", () => {
  it("mirrors the validator's contract — required fields and the claims cap", () => {
    // The schema is handed to providers; the validator is the source of
    // truth. This pins the two facts that would silently diverge first.
    const claims = (ANSWER_JSON_SCHEMA["properties"] as Record<string, Record<string, unknown>>)[
      "claims"
    ]
    expect(claims).toBeDefined()
    expect(claims["maxItems"]).toBe(MAX_CLAIMS)
    expect((claims["items"] as Record<string, unknown>)["required"]).toEqual([
      "text",
      "chunkId",
      "quote",
    ])
  })
})
