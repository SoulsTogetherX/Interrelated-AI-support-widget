//#region Imports
import { LLMHttpError, postStream, sseData } from "./http"
import type { LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage } from "./types"
//#endregion

//#region Type Defs
/**
 * Google Gemini — a NATIVE implementation, not the compat adapter, for one
 * load-bearing reason: generationConfig.responseJsonSchema is real
 * SERVER-SIDE schema enforcement, the strongest structured-output
 * guarantee of any supported provider. The pipeline still validates the
 * result (trust isn't transitive, and free-tier models change under us),
 * but with Gemini the retry path should be near-dead — which makes the
 * per-provider schema-violation metric an interesting comparison instead
 * of a constant.
 */
interface GeminiOptions {
  apiKey: string
  model?: string
  /** Overridable for tests; nobody self-hosts Gemini. */
  baseUrl?: string
}

/** The slice of a streamGenerateContent SSE event this provider reads. */
interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> }
    finishReason?: unknown
  }>
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown }
}
//#endregion

//#region Constants
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
/** 2.5 Flash: the free tier's default; Flash-Lite exists for orgs that hit
 *  rate limits harder than quality needs. Overridden per-credential in M3. */
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"
//#endregion

//#region Provider
class GeminiProvider implements LLMProvider {
  readonly model: string
  readonly #apiKey: string
  readonly #baseUrl: string

  constructor(options: GeminiOptions) {
    this.model = options.model ?? GEMINI_DEFAULT_MODEL
    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/$/, "")
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // Gemini splits roles differently: system text is a dedicated
    // systemInstruction field, and the turn list uses "model" where the
    // OpenAI world says "assistant". Multiple system messages (we send at
    // most one) would concatenate — order preserved.
    const systemText = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n")
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))

    const generationConfig = {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      // responseJsonSchema takes our standard JSON Schema as-is. The older
      // responseSchema field wants Gemini's OpenAPI-subset dialect (no
      // additionalProperties) — a lossy translation we refuse to maintain.
      ...(request.responseSchema !== undefined
        ? { responseMimeType: "application/json", responseJsonSchema: request.responseSchema }
        : {}),
    }
    const body = {
      contents,
      ...(systemText.length > 0 ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    }

    const stream = await postStream({
      provider: "gemini",
      url: `${this.#baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse`,
      // Header auth, not ?key= in the URL: URLs land in server logs.
      headers: { "x-goog-api-key": this.#apiKey },
      body,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    let finishReason: "stop" | "length" | "other" = "other"
    let usage: LLMUsage | null = null
    for await (const data of sseData(stream)) {
      let chunk: GeminiStreamChunk
      try {
        chunk = JSON.parse(data) as GeminiStreamChunk
      } catch {
        throw new LLMHttpError({
          provider: "gemini", status: 200,
          detail: `stream carried a non-JSON data line: ${data.slice(0, 120)}`,
        })
      }
      const candidate = chunk.candidates?.[0]
      const text = (candidate?.content?.parts ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
      if (text.length > 0) yield { type: "delta", text }
      const reason = candidate?.finishReason
      if (typeof reason === "string") {
        finishReason = reason === "STOP" ? "stop" : reason === "MAX_TOKENS" ? "length" : "other"
      }
      const meta = chunk.usageMetadata
      if (meta && typeof meta.promptTokenCount === "number" && typeof meta.candidatesTokenCount === "number") {
        usage = { inputTokens: meta.promptTokenCount, outputTokens: meta.candidatesTokenCount }
      }
    }
    yield { type: "done", finishReason, usage }
  }
}
//#endregion

//#region Exports
export { GeminiProvider, GEMINI_DEFAULT_MODEL }
export type { GeminiOptions }
//#endregion
