//#region Imports
import { describe, expect, it } from "vitest"

import { summarizeProvider, percentileOf } from "../providerComparison"
import type { AnswerOutcome } from "../providerComparison"
//#endregion

//#region Fixtures
/** Hand-built outcomes, so every expectation below is arithmetic a reader
 *  can redo — the standard eval/metrics.ts and eval/tenantScan.ts hold
 *  themselves to, and the reason it matters is that these numbers get
 *  published in a comparison table someone will quote. */
function answered(
  questionId: string,
  fields: Partial<AnswerOutcome> = {},
): AnswerOutcome {
  return {
    questionId,
    outcome: "answered",
    claimsTotal: 2,
    claimsVerified: 2,
    schemaViolations: 0,
    ttftMs: 100,
    totalMs: 200,
    inputTokens: 600,
    outputTokens: 20,
    costUsd: 0.0001,
    ...fields,
  }
}

/** A gate refusal: no model ran, so no first token, no claims, no violation
 *  count, and nothing to price (§3.15.3). */
function refused(questionId: string): AnswerOutcome {
  return {
    questionId,
    outcome: "refused",
    claimsTotal: 0,
    claimsVerified: 0,
    schemaViolations: null,
    ttftMs: null,
    totalMs: 40,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  }
}

/** The model broke the contract twice — the pipeline threw and wrote no
 *  assistant row, so there is no violation count to read back. */
function contractFailure(questionId: string): AnswerOutcome {
  return {
    questionId,
    outcome: "contract_failure",
    claimsTotal: 0,
    claimsVerified: 0,
    schemaViolations: null,
    ttftMs: null,
    totalMs: 3_000,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  }
}
//#endregion

describe("summarizeProvider", () => {
  it("scores a clean run", () => {
    const s = summarizeProvider("gemini", "gemini-3.6-flash", [
      answered("q1"),
      answered("q2"),
      answered("q3"),
    ])
    expect(s.provider).toBe("gemini")
    expect(s.model).toBe("gemini-3.6-flash")
    expect(s.questions).toBe(3)
    expect(s.answered).toBe(3)
    expect(s.citationVerificationRate).toBe(1)
    expect(s.claimStripRate).toBe(0)
    expect(s.schemaViolationRate).toBe(0)
    expect(s.contractFailureRate).toBe(0)
    // 3 answers × 600 in / 20 out.
    expect(s.inputTokens).toBe(1_800)
    expect(s.outputTokens).toBe(60)
    // $0.0001 each → $0.10 per 1,000.
    expect(s.costPer1kAnswersUsd).toBeCloseTo(0.1, 10)
    expect(s.pricedAnswers).toBe(3)
    expect(s.unpricedAnswers).toBe(0)
  })

  it("counts stripped claims against the verification rate", () => {
    // The number this project exists to be able to state: 5 of 8 claims
    // survived verification, so 3 were withheld from the visitor.
    const s = summarizeProvider("mock", "mock-llm", [
      answered("q1", { claimsTotal: 4, claimsVerified: 3 }),
      answered("q2", { claimsTotal: 4, claimsVerified: 2 }),
    ])
    expect(s.citationVerificationRate).toBe(5 / 8)
    expect(s.claimStripRate).toBe(3 / 8)
  })

  it("reports a rate of null, never zero, when no claim was ever emitted", () => {
    // A provider that refused everything has no verification rate. 0% would
    // read as "it cited and every citation was fake" — the opposite finding.
    const s = summarizeProvider("gemini", "gemini-3.6-flash", [
      refused("q1"),
      refused("q2"),
    ])
    expect(s.citationVerificationRate).toBeNull()
    expect(s.claimStripRate).toBeNull()
    expect(s.schemaViolationRate).toBeNull()
    expect(s.refused).toBe(2)
    expect(s.answered).toBe(0)
  })

  it("keeps contract failures out of the answer count and gives them their own rate", () => {
    // The trap migration 010 was written around (§3.3.12): a summary built
    // only from rows that landed would score this provider as flawless,
    // because its worst outcome wrote no row at all.
    const s = summarizeProvider("flaky", "flaky-model", [
      answered("q1"),
      contractFailure("q2"),
      contractFailure("q3"),
      contractFailure("q4"),
    ])
    expect(s.answered).toBe(1)
    expect(s.contractFailures).toBe(3)
    expect(s.contractFailureRate).toBe(0.75)
    // The one answer that landed held the contract, and that stays true —
    // the violation rate is about answers, and the failures are their own
    // column precisely so this number cannot hide them.
    expect(s.schemaViolationRate).toBe(0)
  })

  it("averages schema violations over answers that ran a model", () => {
    // One answer needed the retry, two did not, and a refusal ran no model
    // at all — so the denominator is 3, not 4. Padding it with answers
    // nobody generated is 003's argument for the nullable column.
    const s = summarizeProvider("groq", "llama-3.3-70b-versatile", [
      answered("q1", { schemaViolations: 1 }),
      answered("q2", { schemaViolations: 0 }),
      answered("q3", { schemaViolations: 0 }),
      refused("q4"),
    ])
    expect(s.schemaViolationRate).toBeCloseTo(1 / 3, 10)
  })

  it("excludes refusals from the TTFT percentiles", () => {
    // §9.13 found this live: a gate refusal is fast for a reason that has
    // nothing to do with the model, so folding it in as 0 would report a
    // provider as quicker the more often the corpus failed to answer.
    const s = summarizeProvider("gemini", "gemini-3.6-flash", [
      answered("q1", { ttftMs: 1_000 }),
      answered("q2", { ttftMs: 3_000 }),
      refused("q3"),
      refused("q4"),
    ])
    // Nearest-rank over [1000, 3000]: p50 is rank ceil(0.5×2)=1 → 1000.
    expect(s.ttftP50Ms).toBe(1_000)
    expect(s.ttftP95Ms).toBe(3_000)
  })

  it("prices only what it can, and says how much it could not", () => {
    // §2.4.8's rule: unknown is null, never 0. Two priced answers at
    // $0.0002 each average $0.0002 → $0.20 per 1,000, and the fact that the
    // figure covers 2 of 3 answers travels with it.
    const s = summarizeProvider("gemini", "gemini-3.6-flash", [
      answered("q1", { costUsd: 0.0002 }),
      answered("q2", { costUsd: 0.0002 }),
      answered("q3", { costUsd: null }),
    ])
    expect(s.costPer1kAnswersUsd).toBeCloseTo(0.2, 10)
    expect(s.pricedAnswers).toBe(2)
    expect(s.unpricedAnswers).toBe(1)
  })

  it("reports cost as null when nothing could be priced", () => {
    // A self-hosted model on someone's own GPU. "$0.00" would be a specific
    // falsehood about a tenant paying for electricity.
    const s = summarizeProvider("ollama", "qwen2.5:7b", [
      answered("q1", { costUsd: null }),
      answered("q2", { costUsd: null }),
    ])
    expect(s.costPer1kAnswersUsd).toBeNull()
    expect(s.unpricedAnswers).toBe(2)
  })

  it("counts an outright provider failure apart from a contract failure", () => {
    // A 401 and a model that cannot hold a JSON schema are different
    // findings, and a table that merged them would blame the wrong thing.
    const s = summarizeProvider("anthropic", "claude-haiku-4-5-20251001", [
      answered("q1"),
      contractFailure("q2"),
      { ...refused("q3"), outcome: "error" },
    ])
    expect(s.errors).toBe(1)
    expect(s.refused).toBe(0)
    expect(s.contractFailures).toBe(1)
  })

  it("throws on an empty run rather than reporting a flawless one", () => {
    // eval/metrics.ts's and eval/tenantScan.ts's stance: "made no mistakes"
    // and "was never asked" are opposite findings.
    expect(() => summarizeProvider("gemini", "gemini-3.6-flash", [])).toThrow(/no questions measured/)
  })
})

describe("percentileOf", () => {
  it("sorts its input, so an unsorted array cannot yield a plausible wrong number", () => {
    expect(percentileOf([300, 100, 200], 50)).toBe(200)
  })

  it("is nearest-rank, never interpolated", () => {
    // p95 of four samples is rank ceil(0.95×4)=4 → the largest, not a
    // weighted blend of the top two that nobody measured.
    expect(percentileOf([10, 20, 30, 40], 95)).toBe(40)
  })

  it("returns NaN for an empty set, so it can render as an em dash", () => {
    expect(Number.isNaN(percentileOf([], 50))).toBe(true)
  })
})
