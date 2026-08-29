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
 *
 * It also REPORTS USAGE (M5.2), like every real provider does, so the token
 * columns and the cost metric are exercised end to end in the keyless
 * stacks rather than only in scripted tests. The counts are the chunker's
 * ceil(chars/4) approximation (§2.4.0) rather than an invented number, and
 * the mock's price is a true 0.00 in the price list — so a keyless demo
 * shows real token volume against an honestly free bill, attributed to
 * "mock-llm" in the by-model table where nobody can mistake it for Groq.
 */
function groundedMockResponder(tamper = false): (request: LLMRequest) => MockLLMResponse {
  return (request) => {
    const user = request.messages.at(-1)?.content ?? ""
    const blocks = [...user.matchAll(/\[chunk (chk_[0-9a-z]{32}) \|[^\]]*\]\n([^\n]+)/g)]
    const claims = blocks.slice(0, 2).map(([, chunkId, firstLine], i) => {
      const quote = firstLine.slice(0, 90)
      return {
        text: `According to the documentation: ${quote}`,
        chunkId: chunkId,
        quote: tamper && i === 0 ? `${quote} (embellished)` : quote,
      }
    })
    const text = JSON.stringify({ claims })
    const promptChars = request.messages.reduce((sum, message) => sum + message.content.length, 0)
    return {
      text,
      usage: {
        inputTokens: Math.ceil(promptChars / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    }
  }
}
//#endregion

//#region Exports
export { groundedMockResponder }
//#endregion
