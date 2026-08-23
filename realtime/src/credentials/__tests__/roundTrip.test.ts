//#region Why this file
// The Test button's attempt policy (M8.2) — keyless, and instant, because
// what is under test is a DECISION about failures rather than any real
// latency: which ones earn a second attempt, which ones are facts that a
// second attempt would only repeat, and what the tenant is told when the
// budget runs out.
//
// It exists because the old policy was "one attempt, 15 seconds" — a number
// chosen before this project had ever called a real provider — and M7.11
// measured the free tier it is designed around at a TTFT p95 of 27.9 s, with
// the live suite since watching a 503 arrive after 11 s. Both failure modes
// told a tenant with a perfectly good key that something was wrong with it.
//#endregion

//#region Imports
import { describe, expect, it } from "vitest"

import { testGenerationRoundTrip, testEmbeddingRoundTrip } from "@/credentials/validate"
import { LLMHttpError } from "@providers/llm/http"
import type { LLMProvider, LLMStreamEvent } from "@providers/llm/types"
import type { EmbeddingProvider } from "@providers/embedding/types"
//#endregion

//#region Fakes
/** A provider whose every call is scripted: an Error to throw, or null to
 *  answer normally. Records how many times it was asked, which is the whole
 *  question here. */
function scriptedLLM(script: Array<Error | null>): LLMProvider & { calls: number } {
  const provider = {
    model: "test-model",
    calls: 0,
    async *stream(): AsyncIterable<LLMStreamEvent> {
      const next = provider.calls < script.length ? script[provider.calls] : null
      provider.calls += 1
      if (next instanceof Error) throw next
      yield { type: "delta", text: "ok" }
      yield { type: "done", finishReason: "stop", usage: null }
    },
  }
  return provider
}

function scriptedEmbedder(script: Array<Error | null>): EmbeddingProvider & { calls: number } {
  const provider = {
    model: "test-embed",
    dim: 8,
    calls: 0,
    async embed(): Promise<number[][]> {
      const next = provider.calls < script.length ? script[provider.calls] : null
      provider.calls += 1
      if (next instanceof Error) throw next
      return [[0, 1, 0, 1, 0, 1, 0, 1]]
    },
  }
  return provider
}

const http = (status: number) => new LLMHttpError({ provider: "test", status, detail: "scripted" })
//#endregion

describe("the Test button's attempt policy", () => {
  it("retries a transient 503 and succeeds — the failure this machine's free tier actually produced", async () => {
    const provider = scriptedLLM([http(503)])
    const result = await testGenerationRoundTrip(provider)
    expect(result.ok).toBe(true)
    expect(provider.calls).toBe(2)
  })

  it("retries a 429 — a rate limit is the textbook second-attempt case", async () => {
    const provider = scriptedLLM([http(429)])
    expect((await testGenerationRoundTrip(provider)).ok).toBe(true)
    expect(provider.calls).toBe(2)
  })

  it("never retries a 401 — a wrong key is just as wrong a second later", async () => {
    // The distinction the whole policy turns on: weather versus fact. A
    // second call here would spend the tenant's patience to reach the same
    // sentence.
    const provider = scriptedLLM([http(401), null])
    const result = await testGenerationRoundTrip(provider)
    expect(result.ok).toBe(false)
    expect(provider.calls).toBe(1)
    if (!result.ok) expect(result.error).toContain("rejected the request")
  })

  it("never retries a 400 either, and reports the provider's own message", async () => {
    const provider = scriptedLLM([http(400), null])
    const result = await testGenerationRoundTrip(provider)
    expect(provider.calls).toBe(1)
    if (!result.ok) expect(result.error).toContain("HTTP 400")
  })

  it("gives up after the second attempt rather than looping", async () => {
    // Two attempts, not "until it works": a person is watching a form.
    const provider = scriptedLLM([http(503), http(503), null])
    const result = await testGenerationRoundTrip(provider)
    expect(result.ok).toBe(false)
    expect(provider.calls).toBe(2)
  })

  it("tells the tenant slowness is not a bad key when the budget runs out", async () => {
    // The sentence matters as much as the timeout: "did not answer within
    // 15s" reads as "your key is broken", which is what sent a good key back
    // to a tenant before M8.2.
    const slow: LLMProvider = {
      model: "slow",
      async *stream({ signal }) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
        yield { type: "done", finishReason: "stop", usage: null }
      },
    }
    const result = await testGenerationRoundTrip(slow, 60)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("did not answer within")
      expect(result.error).toContain("Free tiers are often slow")
    }
  })

  it("applies the same policy to the embedding twin", async () => {
    const transient = scriptedEmbedder([http(503)])
    const embedded = await testEmbeddingRoundTrip(transient)
    expect(embedded.ok).toBe(true)
    expect(transient.calls).toBe(2)
    if (embedded.ok) expect(embedded.dim).toBe(8)

    const wrongKey = scriptedEmbedder([http(401), null])
    expect((await testEmbeddingRoundTrip(wrongKey)).ok).toBe(false)
    expect(wrongKey.calls).toBe(1)
  })

  it("does not retry a contract violation from the adapter — that is a fact about the model", async () => {
    // assertBatch's complaints (wrong count, changed dimension) are plain
    // Errors and are deterministic: asking again produces the same answer,
    // and the message is already written for a human.
    const bad = scriptedEmbedder([new Error("expected 1 vector, got 3")])
    const result = await testEmbeddingRoundTrip(bad)
    expect(result.ok).toBe(false)
    expect(bad.calls).toBe(1)
    if (!result.ok) expect(result.error).toContain("response was unusable")
  })
})
