//#region Imports
import { LLMHttpError, postStream, ndjsonObjects } from "./http"
import type { LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage } from "./types"
//#endregion

//#region Type Defs
/**
 * Ollama — the self-hosted path, speaking Ollama's NATIVE /api/chat
 * (NDJSON) rather than its OpenAI-compat endpoint, because the native
 * `format` field takes a full JSON Schema and constrains generation
 * server-side — much stronger than compat-mode json_object, and the whole
 * reason a local model can hold the claims contract at all.
 *
 * No apiKey: Ollama is unauthenticated by design. The base URL today comes
 * from the developer (.env); when tenants supply their own Ollama URLs
 * (M3), the realtime boundary vets them through the safeFetch hostGuard
 * seam BEFORE a provider is constructed — a tenant-supplied URL is a
 * textbook SSRF vector, and that defense belongs where the URL enters the
 * system, not down here where every call would re-pay it.
 */
interface OllamaOptions {
  /** No default on purpose: whatever model is pulled locally is a machine
   *  fact, not something this file can guess. */
  model: string
  baseUrl?: string
}

/** The slice of an /api/chat NDJSON line this provider reads. */
interface OllamaStreamChunk {
  message?: { content?: unknown }
  done?: unknown
  done_reason?: unknown
  prompt_eval_count?: unknown
  eval_count?: unknown
}
//#endregion

//#region Constants
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434"
//#endregion

//#region Provider
class OllamaProvider implements LLMProvider {
  readonly model: string
  readonly #baseUrl: string

  constructor(options: OllamaOptions) {
    this.model = options.model
    this.#baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, "")
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const body = {
      model: this.model,
      // Ollama's chat shape matches ours directly — system rides in the
      // messages list, no role renames.
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(request.responseSchema !== undefined ? { format: request.responseSchema } : {}),
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
      },
    }
    const stream = await postStream({
      provider: "ollama",
      url: `${this.#baseUrl}/api/chat`,
      headers: {},
      body,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    let finishReason: "stop" | "length" | "other" = "other"
    let usage: LLMUsage | null = null
    for await (const parsed of ndjsonObjects(stream)) {
      if (typeof parsed !== "object" || parsed === null) {
        throw new LLMHttpError({
          provider: "ollama",
          status: 200,
          detail: "stream carried a non-object line",
        })
      }
      const chunk = parsed as OllamaStreamChunk
      const content = chunk.message?.content
      if (typeof content === "string" && content.length > 0) yield { type: "delta", text: content }
      if (chunk.done === true) {
        const reason = chunk.done_reason
        finishReason = reason === "stop" ? "stop" : reason === "length" ? "length" : "other"
        if (typeof chunk.prompt_eval_count === "number" && typeof chunk.eval_count === "number") {
          usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count }
        }
      }
    }
    yield { type: "done", finishReason, usage }
  }
}
//#endregion

//#region Exports
export { OllamaProvider, OLLAMA_DEFAULT_BASE_URL }
export type { OllamaOptions }
//#endregion
