//#region Imports
import type { LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage } from "./types"
//#endregion

//#region Type Defs
/** One scripted completion. `deltaSize` controls how the text is sliced into
 *  stream events — tests pick awkward sizes (1, or larger than the text) to
 *  prove consumers reassemble correctly instead of assuming one delta. */
interface MockLLMResponse {
  text: string
  /** Characters per delta. Default 7 — deliberately odd, so word and JSON
   *  token boundaries almost never align with delta boundaries and a
   *  consumer that parses per-delta instead of per-buffer breaks loudly. */
  deltaSize?: number
  finishReason?: "stop" | "length" | "other"
  usage?: LLMUsage
}
//#endregion

//#region Provider
/** A scripted response list, or a RESPONDER — a pure function deriving the
 *  response from the request. Scripts are the test default (exact JSON,
 *  exact chunks); the responder form exists for the dev CLI, which cannot
 *  know retrieval results before the call and instead derives a grounded
 *  answer from the prompt it receives. A responder must stay deterministic
 *  — same request, same response — or it defeats the mock's purpose. */
type MockLLMScript = readonly MockLLMResponse[] | ((request: LLMRequest) => MockLLMResponse)

/**
 * Scripted deterministic LLM for tests and CI — the generation-side sibling
 * of MockEmbeddingProvider, with one deliberate difference: embeddings can
 * be DERIVED from input (hash → vector), but a mock completion faking the
 * answer pipeline must be exact JSON grounded in exact chunks, so the test
 * SCRIPTS each response instead. Responses are consumed in call order; a
 * call past the end throws, because a test making more LLM calls than it
 * scripted is a test that lost track of its own pipeline (an extra call is
 * usually an unexpected retry — worth a loud failure, not a shrug).
 *
 * `calls` records every request verbatim so pipeline tests can assert what
 * was actually SENT — prompt assembly (is the context delimited? is the
 * schema attached?) is behavior worth pinning, not an implementation detail.
 */
class MockLLMProvider implements LLMProvider {
  readonly model = "mock-llm"
  readonly calls: LLMRequest[] = []
  #script: MockLLMScript
  #next = 0

  constructor(script: MockLLMScript) {
    this.#script = script
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request)
    let response: MockLLMResponse | undefined
    if (typeof this.#script === "function") {
      response = this.#script(request)
    } else {
      response = this.#script[this.#next]
      if (response === undefined) {
        throw new Error(`MockLLMProvider: script exhausted (call ${this.#next + 1} of ${this.#script.length})`)
      }
    }
    this.#next += 1

    const deltaSize = response.deltaSize ?? 7
    for (let i = 0; i < response.text.length; i += deltaSize) {
      // Checked before EVERY yield, not once at entry: the pipeline aborts
      // mid-stream when a visitor disconnects, and a mock that ignores the
      // signal after the first delta would let cancellation tests pass
      // vacuously.
      if (request.signal?.aborted) throw new Error("MockLLMProvider: aborted")
      yield { type: "delta", text: response.text.slice(i, i + deltaSize) }
    }
    if (request.signal?.aborted) throw new Error("MockLLMProvider: aborted")
    yield {
      type: "done",
      finishReason: response.finishReason ?? "stop",
      usage: response.usage ?? null,
    }
  }
}
//#endregion

//#region Exports
export { MockLLMProvider }
export type { MockLLMResponse, MockLLMScript }
//#endregion
