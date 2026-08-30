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
  usageMetadata?: {
    promptTokenCount?: unknown
    candidatesTokenCount?: unknown
    /** Reasoning tokens, on models that think. Billed as output. */
    thoughtsTokenCount?: unknown
  }
}
//#endregion

//#region Constants
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
/** The free tier's general-purpose Flash model; the Lite siblings exist for
 *  orgs that hit rate limits harder than quality needs, and any of them can
 *  be overridden per-credential (M3).
 *
 *  Bumped from `gemini-2.5-flash` at M7.11, and the reason is worth keeping:
 *  a live call with a NEW free-tier key returns 404 for 2.5 Flash — "no
 *  longer available to new users … please update to gemini-3.6-flash" —
 *  even though the /models listing still advertises it. So an existing key
 *  kept working while a new tenant's first question 404'd, which is a class
 *  of failure no keyless test can see and the plan named in its risk table:
 *  free tiers move without notice. The gated live suite (§3.8) is what
 *  caught it, on the first run that ever had a key. */
const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash"
/**
 * Cap on the tokens Gemini may spend THINKING before it writes anything.
 *
 * Measured, not guessed (M7.11). Gemini 3.x models reason by default, and
 * their thoughts are drawn from the SAME `maxOutputTokens` budget the answer
 * is: a live call with maxOutputTokens 300 spent 285 tokens thinking, emitted
 * ZERO characters, and finished MAX_TOKENS. In the pipeline that is a
 * truncated JSON document — a schema violation, then the one retry, then very
 * likely the same again, and the visitor gets an opaque error. The widget
 * would simply not work for a tenant on a 3.x model.
 *
 * Zero is not an option: `thinkingBudget: 0` is a 400 on 3.x ("invalid
 * argument"), unlike 2.5 where it disabled thinking outright. So the budget
 * is small and positive — enough for the short deliberation a grounded
 * extraction needs, small enough that the answer always has room. 128
 * against the pipeline's 1024 leaves 87% of the budget for output, and the
 * same call that failed above returns valid claims JSON with it set.
 *
 * Sent whenever the caller sets maxTokens, because that is exactly when the
 * two compete. A model that does not support the field answers 400 at the
 * Test button (§3.21 does a live round-trip before saving), which is the
 * designed place to discover it rather than a visitor's first question.
 */
const GEMINI_THINKING_BUDGET = 128
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

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
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
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }))

    const generationConfig = {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined
        ? {
            maxOutputTokens: request.maxTokens,
            thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
          }
        : {}),
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
          provider: "gemini",
          status: 200,
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
      if (
        meta &&
        typeof meta.promptTokenCount === "number" &&
        typeof meta.candidatesTokenCount === "number"
      ) {
        // Thinking tokens are BILLED as output and reported separately, so
        // they are added rather than ignored: a cost metric that counted only
        // the visible answer would under-report every reasoning model, and
        // under-reporting is the direction that gets believed. Absent on
        // models that do not think, hence the ?? 0.
        const thoughts = typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0
        usage = {
          inputTokens: meta.promptTokenCount,
          outputTokens: meta.candidatesTokenCount + thoughts,
        }
      }
    }
    yield { type: "done", finishReason, usage }
  }
}
//#endregion

//#region Exports
export { GeminiProvider }

//#endregion
