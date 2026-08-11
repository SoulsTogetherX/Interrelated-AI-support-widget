//#region Imports
import type { LLMRequest } from "@providers/llm/types"
import type { MockLLMResponse } from "@providers/llm/mock"
//#endregion

//#region Responder
/**
 * The context-quoting mock responder: parses the "[chunk chk_… | url …]"
 * blocks out of the prompt it actually receives and claims the opening of
 * the two best chunks, verbatim — grounded by construction, so
 * verification PASSES and the full loop (persistence, citations, SSE) is
 * drivable with zero API keys.
 *
 * Lives in answer/ (not providers/) because it knows the prompt format —
 * prompt.ts's formatChunk is the other half of this contract, and the two
 * must change together. Two consumers: the askDev CLI and server boot
 * under LLM_PROVIDER=mock, which is what lets the compose stacks and the
 * e2e job drive the REAL chat route end to end keylessly (the plan's
 * "seeded mock provider" testing layer).
 *
 * `tamper` corrupts the first quote so the strip path is observable on
 * demand: the tampered claim must be stored quote_not_found and never
 * displayed.
 */
function groundedMockResponder(tamper = false): (request: LLMRequest) => MockLLMResponse {
  return (request) => {
    const user = request.messages.at(-1)?.content ?? ""
    const blocks = [...user.matchAll(/\[chunk (chk_[0-9a-z]{32}) \|[^\]]*\]\n([^\n]+)/g)]
    const claims = blocks.slice(0, 2).map(([, chunkId, firstLine], i) => {
      const quote = (firstLine as string).slice(0, 90)
      return {
        text: `According to the documentation: ${quote}`,
        chunkId: chunkId as string,
        quote: tamper && i === 0 ? `${quote} (embellished)` : quote,
      }
    })
    return { text: JSON.stringify({ claims }) }
  }
}
//#endregion

//#region Exports
export { groundedMockResponder }
//#endregion
