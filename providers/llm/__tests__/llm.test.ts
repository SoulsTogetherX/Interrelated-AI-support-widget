import { describe, expect, it } from "vitest"

import { MockLLMProvider } from "../mock"
import type { LLMRequest, LLMStreamEvent } from "../types"

//#region Helpers
const request: LLMRequest = { messages: [{ role: "user", content: "hi" }] }

async function collect(events: AsyncIterable<LLMStreamEvent>) {
  const deltas: string[] = []
  const done: LLMStreamEvent[] = []
  for await (const event of events) {
    if (event.type === "delta") deltas.push(event.text)
    else done.push(event)
  }
  return { deltas, done }
}
//#endregion

describe("MockLLMProvider", () => {
  it("streams deltas that concatenate to the scripted text, then exactly one done", async () => {
    const text = "Hello, this is a scripted completion."
    const provider = new MockLLMProvider([{ text }])
    const { deltas, done } = await collect(provider.stream(request))
    expect(deltas.join("")).toBe(text)
    // Default delta size (7) is smaller than the text, so streaming must
    // actually be exercised — a single-delta implementation would hide
    // every reassembly bug in consumers.
    expect(deltas.length).toBeGreaterThan(1)
    expect(done).toEqual([{ type: "done", finishReason: "stop", usage: null }])
  })

  it("honors deltaSize at the boundaries: 1, exact length, and larger than the text", async () => {
    const text = "abcdef"
    for (const [deltaSize, expectedCount] of [
      [1, 6],
      [6, 1],
      [100, 1],
    ] as const) {
      const provider = new MockLLMProvider([{ text, deltaSize }])
      const { deltas } = await collect(provider.stream(request))
      expect(deltas.join("")).toBe(text)
      expect(deltas.length).toBe(expectedCount)
    }
  })

  it("streams an empty scripted text as zero deltas and one done", async () => {
    const provider = new MockLLMProvider([{ text: "" }])
    const { deltas, done } = await collect(provider.stream(request))
    expect(deltas).toEqual([])
    expect(done.length).toBe(1)
  })

  it("carries scripted finishReason and usage on the done event", async () => {
    const provider = new MockLLMProvider([
      {
        text: "truncated {",
        finishReason: "length",
        usage: { inputTokens: 100, outputTokens: 32 },
      },
    ])
    const { done } = await collect(provider.stream(request))
    expect(done[0]).toEqual({
      type: "done",
      finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 32 },
    })
  })

  it("consumes the script in call order and throws loudly when exhausted", async () => {
    const provider = new MockLLMProvider([{ text: "first" }, { text: "second" }])
    expect((await collect(provider.stream(request))).deltas.join("")).toBe("first")
    expect((await collect(provider.stream(request))).deltas.join("")).toBe("second")
    // The third call is the unexpected retry the throw exists to expose.
    await expect(collect(provider.stream(request))).rejects.toThrow("script exhausted")
  })

  it("records every request verbatim for prompt-assembly assertions", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }])
    const detailed: LLMRequest = {
      messages: [
        { role: "system", content: "answer only from context" },
        { role: "user", content: "question" },
      ],
      temperature: 0,
      maxTokens: 512,
      responseSchema: { type: "object" },
    }
    await collect(provider.stream(detailed))
    expect(provider.calls).toEqual([detailed])
  })

  it("throws on an aborted signal instead of yielding further deltas", async () => {
    const controller = new AbortController()
    const provider = new MockLLMProvider([{ text: "abcdefghij", deltaSize: 2 }])
    const events = provider.stream({ ...request, signal: controller.signal })

    const iterator = events[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ type: "delta", text: "ab" })
    controller.abort()
    await expect(iterator.next()).rejects.toThrow("aborted")
  })

  it("derives responses from the request in responder mode — and never exhausts", async () => {
    const provider = new MockLLMProvider((req) => ({
      text: `echo:${req.messages.at(-1)!.content}`,
    }))
    const ask = (content: string) =>
      collect(provider.stream({ messages: [{ role: "user", content }] }))
    expect((await ask("one")).deltas.join("")).toBe("echo:one")
    expect((await ask("two")).deltas.join("")).toBe("echo:two")
    expect(provider.calls).toHaveLength(2)
  })

  it("is deterministic — two providers with the same script emit identical event sequences", async () => {
    const script = [{ text: "same every time", deltaSize: 4 }]
    const a = await collect(new MockLLMProvider(script).stream(request))
    const b = await collect(new MockLLMProvider(script).stream(request))
    expect(a).toEqual(b)
  })
})
