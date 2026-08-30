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
  /** Throw this instead of streaming — how a test scripts a provider that
   *  REFUSED the call (M7.7): a 429 from a free tier, a 503 mid-outage, a
   *  socket that died. The pipeline's retry policy is a behavior of the
   *  caller (providers throw; retry belongs to whoever called — types.ts),
   *  so the mock has to be able to produce the throw that policy exists to
   *  absorb. Thrown BEFORE any delta, which is where a rejected request
   *  really fails: a non-2xx response never becomes a stream. */
  error?: Error
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
  readonly model: string
  readonly calls: LLMRequest[] = []
  #script: MockLLMScript
  #next = 0

  /** `model` overrides the default name. It exists because two mocks in one
   *  test are otherwise INDISTINGUISHABLE, and an assertion that cannot tell
   *  them apart passes without proving anything — which is exactly how the
   *  M7.7 fallback's "the transcript names the model that actually answered"
   *  test went green while the pipeline was still recording the primary's
   *  name. Found by a live run, not by the suite. */
  constructor(script: MockLLMScript, options: { model?: string } = {}) {
    this.#script = script
    this.model = options.model ?? "mock-llm"
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request)
    let response: MockLLMResponse | undefined
    if (typeof this.#script === "function") {
      response = this.#script(request)
    } else {
      response = this.#script[this.#next]
      if (response === undefined) {
        throw new Error(
          `MockLLMProvider: script exhausted (call ${this.#next + 1} of ${this.#script.length})`,
        )
      }
    }
    this.#next += 1
    if (response.error) throw response.error

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
export type { MockLLMResponse }
//#endregion
