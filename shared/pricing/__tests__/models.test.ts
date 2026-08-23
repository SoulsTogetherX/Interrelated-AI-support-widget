//#region Imports
import { describe, expect, it } from "vitest"

import { MODEL_PRICES, PRICES_AS_OF, costUsd, priceFor } from "../models"
//#endregion

//#region Tests
// The price table is data, so most of it cannot be tested — whether Groq
// really charges $0.59/MTok is a fact about the world, checked by reading
// their pricing page on the date in PRICES_AS_OF. What IS testable is the
// arithmetic and, more importantly, the REFUSALS: every guard here exists
// because the failure it prevents would produce a plausible-looking number
// that is wrong, which is worse than no number.
describe("model pricing", () => {
  it("computes cost from published per-million prices", () => {
    // 1M in + 1M out on Gemini Flash: $0.30 + $2.50.
    expect(costUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(2.8, 10)
    // A realistic single answer: ~3k of context in, ~200 tokens of claims
    // out. Fractions of a cent — which is why the page formats to 4 places
    // below a dollar instead of rendering a day's traffic as "$0.00".
    expect(costUsd("gemini-2.5-flash", 3000, 200)).toBeCloseTo(0.0014, 10)
  })

  it("prices an UNKNOWN model as null, never as free", () => {
    // A tenant's self-hosted Ollama model. Electricity and a GPU are real
    // costs we cannot see; reporting $0.00 would state a specific falsehood
    // where null renders as "—".
    expect(priceFor("qwen2.5:7b")).toBeNull()
    expect(costUsd("qwen2.5:7b", 500_000, 20_000)).toBeNull()
    // Same for a model released after this table was written, and for the
    // NULL model a gate refusal stores.
    expect(costUsd("gemini-9.9-ultra", 1000, 100)).toBeNull()
    expect(costUsd(null, 1000, 100)).toBeNull()
  })

  it("never prefix-matches a model onto a cheaper sibling", () => {
    // The trap this rule exists for: "gemini-2.5-pro" starts with the same
    // characters as the Flash entries and costs an order of magnitude more.
    // A helpful prefix match would under-report a bill by ~10× and be
    // believed, because the output looks like a real number.
    expect(priceFor("gemini-2.5-flash-preview-09-2025")).toBeNull()
    expect(priceFor("gemini-2.5-pro")).toBeNull()
    expect(priceFor("llama-3.3-70b")).toBeNull() // the real id is …-versatile
  })

  it("prices the mock at a true zero, so keyless stacks report $0.00 rather than unknown", () => {
    // The one legitimate zero in the table: the mock never leaves the
    // process. Without it every keyless stack — dev compose, CI, the demo
    // org — would show its cost as unpriced, when the true answer is known
    // and is exactly nothing.
    expect(costUsd("mock-llm", 12_000, 3_000)).toBe(0)
  })

  it("charges output tokens at their own rate", () => {
    // Every model in the table bills output above input (Flash by ~8×),
    // which is the whole reason the pipeline caps generated tokens. A
    // single blended rate would hide that, so the shape is asserted rather
    // than assumed.
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      if (model === "mock-llm") continue
      expect(price.outputPerMTok).toBeGreaterThan(price.inputPerMTok)
      expect(costUsd(model, 0, 1000)).toBeGreaterThan(costUsd(model, 1000, 0)!)
    }
  })

  it("carries a date, because a price list without one is a rumor", () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}$/)
  })
})
//#endregion
