//#region Imports
import { LLMHttpError, postStream, sseData } from "./http"
import type { LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage } from "./types"
//#endregion

//#region Type Defs
/**
 * The generic OpenAI-compatible chat adapter — one implementation covering
 * a large fraction of the ecosystem (Groq, OpenRouter, Together, vLLM,
 * LM Studio, Ollama's compat endpoint), which is exactly the trade the
 * plan calls out: one adapter's worth of work for N providers. Vendors
 * with a REAL native advantage get their own implementation instead
 * (Gemini for server-side schema enforcement — gemini.ts; Ollama for its
 * native format field — ollama.ts).
 */
interface OpenAICompatibleOptions {
  /** Label used in error messages and (later) the provider-comparison
   *  table, e.g. "groq". Defaults to the generic label. */
  provider?: string
  /** API root WITHOUT the endpoint path, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string
  model: string
  /** Absent for keyless servers (local vLLM, LM Studio) — then no
   *  Authorization header is sent at all. */
  apiKey?: string
  /**
   * How LLMRequest.responseSchema maps to the server's structured-output
   * knob. "json_object" (default) is the lowest common denominator every
   * compat server understands — enforcement is "please emit JSON", which
   * is precisely why the pipeline validates and retries. "none" exists for
   * servers that reject response_format outright. json_schema variants are
   * deliberately NOT attempted generically: support is too fragmented
   * across compat servers, and a 400 on every request is worse than weak
   * enforcement plus validation.
   */
  jsonMode?: "json_object" | "none"
}

/** The slice of an OpenAI-style stream chunk this adapter reads. All
 *  optional: real servers differ in which fields each chunk carries. */
interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
  usage?: unknown
  /** Groq puts usage here on the final chunk instead of a top-level field. */
  x_groq?: { usage?: unknown }
}
//#endregion

//#region Helpers
/** Narrows an unknown usage blob to LLMUsage; null when the shape is off —
 *  cost metrics treat null as "unknown", never zero. */
function toUsage(value: unknown): LLMUsage | null {
  if (typeof value !== "object" || value === null) return null
  const usage = value as Record<string, unknown>
  if (typeof usage["prompt_tokens"] !== "number" || typeof usage["completion_tokens"] !== "number")
    return null
  return { inputTokens: usage["prompt_tokens"], outputTokens: usage["completion_tokens"] }
}
//#endregion

//#region Provider
class OpenAICompatibleProvider implements LLMProvider {
  readonly model: string
  readonly #provider: string
  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #jsonMode: "json_object" | "none"

  constructor(options: OpenAICompatibleOptions) {
    this.model = options.model
    this.#provider = options.provider ?? "openai-compatible"
    this.#baseUrl = options.baseUrl.replace(/\/$/, "")
    this.#apiKey = options.apiKey
    this.#jsonMode = options.jsonMode ?? "json_object"
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const body = {
      model: this.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      // max_tokens, not max_completion_tokens: OpenAI renamed it, but the
      // compat ecosystem this adapter exists for speaks the old name.
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.responseSchema !== undefined && this.#jsonMode === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
    }
    const stream = await postStream({
      provider: this.#provider,
      url: `${this.#baseUrl}/chat/completions`,
      headers: this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {},
      body,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    let finishReason: "stop" | "length" | "other" = "other"
    let usage: LLMUsage | null = null
    for await (const data of sseData(stream)) {
      if (data === "[DONE]") break
      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk
      } catch {
        throw new LLMHttpError({
          provider: this.#provider,
          status: 200,
          detail: `stream carried a non-JSON data line: ${data.slice(0, 120)}`,
        })
      }
      const choice = chunk.choices?.[0]
      // Only `content` is forwarded. Reasoning-style side channels
      // (delta.reasoning_content and friends) are deliberately dropped:
      // deliberation is not answer text, and TTFT measures the answer.
      const delta = choice?.delta?.content
      if (typeof delta === "string" && delta.length > 0) yield { type: "delta", text: delta }
      const reason = choice?.finish_reason
      if (typeof reason === "string") {
        finishReason = reason === "stop" ? "stop" : reason === "length" ? "length" : "other"
      }
      usage = toUsage(chunk.usage) ?? toUsage(chunk.x_groq?.usage) ?? usage
    }
    yield { type: "done", finishReason, usage }
  }
}
//#endregion

//#region Exports
export { OpenAICompatibleProvider }

//#endregion
