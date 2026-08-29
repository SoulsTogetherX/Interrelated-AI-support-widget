//#region Imports
import { LLMHttpError, postStream, sseData } from "./http"
import type { LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage } from "./types"
//#endregion

//#region Type Defs
/**
 * Anthropic Claude — the last row of the plan's provider table, and the
 * only one it marks "paid; supported, never required". It earns a native
 * implementation rather than a preset of the compat adapter (§2.4.5g) for
 * the same reason Gemini does: its structured-output mechanism is not the
 * OpenAI one, and translating it away would delete the interesting part.
 *
 * Anthropic ships an OpenAI-compatible endpoint, and using it was the
 * obvious cheap move. It is rejected deliberately: that endpoint is
 * documented as a migration shim, its JSON mode is "please emit JSON"
 * rather than enforcement, and it would put this provider in the WEAKEST
 * structured-output tier when natively it belongs in the strongest —
 * Anthropic constrains a tool's arguments to that tool's schema, which is
 * real server-side enforcement of exactly our claims contract.
 *
 * The mechanism is the file's one genuinely novel idea, so it is stated
 * once here. There is no `response_format` on the Messages API. What there
 * is instead is TOOL USE: declare one tool whose `input_schema` is our
 * schema, then force it with `tool_choice: {type: "tool", name}`. The model
 * cannot answer any other way, and its "arguments" ARE the answer document.
 * Streamed, those arrive as `input_json_delta` fragments whose
 * concatenation is the JSON — which is precisely what the LLMProvider
 * contract already calls a delta stream (§2.4.5d), so the answer pipeline
 * needs no special case, parseAnswerText sees the same text it sees from
 * every other provider, and TTFT still measures the first real content.
 *
 * Never required, per the plan's $0 constraint: nothing in CI, the demo, or
 * any keyless stack reaches this file. It exists because a tenant may
 * already pay Anthropic, and because "five providers, four mechanisms"
 * (JSON mode, native JSON schema, Ollama's `format`, forced tool use) is
 * the honest shape of structured output across the ecosystem.
 */
interface AnthropicOptions {
  apiKey: string
  model?: string
  /** Overridable for tests; nobody self-hosts Claude. */
  baseUrl?: string
}

/** The slice of a Messages streaming event this provider reads. Each SSE
 *  `data:` line is one complete object that NAMES ITS OWN TYPE, which is
 *  why sseData's deliberate blindness to `event:` lines costs nothing here
 *  (the event name and this `type` are always the same string). */
interface AnthropicStreamEvent {
  type?: unknown
  message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } }
  content_block?: { type?: unknown }
  delta?: {
    type?: unknown
    text?: unknown
    partial_json?: unknown
    stop_reason?: unknown
  }
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
  error?: { type?: unknown; message?: unknown }
}
//#endregion

//#region Constants
const ANTHROPIC_BASE_URL = "https://api.anthropic.com"
/** Haiku, not Sonnet or Opus: this provider answers a support question from
 *  a few retrieved chunks under a forced schema, which is close to the
 *  cheapest thing a frontier model is ever asked to do. A tenant who wants
 *  more overrides the model on their credential. */
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
/** The API version this adapter's request and response shapes were written
 *  against. Anthropic pins breaking changes behind this header, so sending
 *  it is what stops a future default from silently reshaping our stream. */
const ANTHROPIC_VERSION = "2023-06-01"
/** `max_tokens` is REQUIRED by the Messages API — the one provider here
 *  where omitting it is a 400 rather than "use your default". The pipeline
 *  always passes one (MAX_ANSWER_TOKENS); this covers callers that do not,
 *  and matches the pipeline's cap so the behavior does not change with who
 *  is calling. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024
/** The forced tool's name. Arbitrary, but it reaches the model as a word
 *  and models read tool names, so it says what the tool is for. */
const ANSWER_TOOL_NAME = "emit_answer"

/**
 * Anthropic's error `type` → the HTTP status that error means, so a failure
 * arriving mid-stream is classified by the SAME rule as one that arrived as
 * a status line. This matters more here than anywhere else in providers/:
 * a Messages stream can start 200 and then carry an `error` event, so
 * postStream's non-2xx path never sees it, and without this mapping the
 * answer pipeline's retry policy (§3.15.5) could not tell "overloaded, try
 * again in 250 ms" from "your key is wrong, stop now".
 */
const ERROR_TYPE_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
}
//#endregion

//#region Provider
class AnthropicProvider implements LLMProvider {
  readonly model: string
  readonly #apiKey: string
  readonly #baseUrl: string

  constructor(options: AnthropicOptions) {
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL
    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, "")
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // System text is a top-level field, as in Gemini — but unlike Gemini
    // the turn roles are already ours ("assistant" is "assistant"), so only
    // the system messages move. Several would concatenate in order; the
    // pipeline sends one.
    const systemText = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n")
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }))

    // The schema becomes a TOOL, and the tool is forced. `input_schema`
    // takes our standard JSON Schema verbatim, additionalProperties and
    // all — the same "no lossy dialect translation" stance as Gemini's
    // responseJsonSchema (§2.4.5h).
    const tooling =
      request.responseSchema !== undefined
        ? {
            tools: [
              {
                name: ANSWER_TOOL_NAME,
                description:
                  "Return the answer as structured claims. This is the only way to reply.",
                input_schema: request.responseSchema,
              },
            ],
            tool_choice: { type: "tool", name: ANSWER_TOOL_NAME },
          }
        : {}

    const stream = await postStream({
      provider: "anthropic",
      url: `${this.#baseUrl}/v1/messages`,
      // x-api-key, not Authorization: Bearer — Anthropic's own scheme. The
      // version header is not optional.
      headers: { "x-api-key": this.#apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: {
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(systemText.length > 0 ? { system: systemText } : {}),
        ...tooling,
      },
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    let finishReason: "stop" | "length" | "other" = "other"
    // Usage arrives in two halves and neither event carries both: input
    // tokens are known at message_start (the prompt is already counted),
    // output tokens accumulate and are restated on message_delta. Reporting
    // only one half would put a null in the cost metric for a call that
    // really did report its usage.
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    // Only the FORCED tool's arguments are answer text. A model may also
    // emit a text block beside a tool call (thinking out loud before
    // calling it), and forwarding that would splice prose into the JSON the
    // parser is about to read — so under a schema, text deltas are dropped.
    let inToolBlock = false
    const structured = request.responseSchema !== undefined

    for await (const data of sseData(stream)) {
      let event: AnthropicStreamEvent
      try {
        event = JSON.parse(data) as AnthropicStreamEvent
      } catch {
        throw new LLMHttpError({
          provider: "anthropic",
          status: 200,
          detail: `stream carried a non-JSON data line: ${data.slice(0, 120)}`,
        })
      }

      switch (event.type) {
        case "error": {
          // A 200 that turned into a failure. Thrown, per the contract, and
          // carrying the status its type means so the caller's retry policy
          // can act on it (see ERROR_TYPE_STATUS).
          const type = typeof event.error?.type === "string" ? event.error.type : "unknown"
          const message = typeof event.error?.message === "string" ? event.error.message : ""
          throw new LLMHttpError({
            provider: "anthropic",
            status: ERROR_TYPE_STATUS[type] ?? 500,
            detail: `${type}${message !== "" ? `: ${message.slice(0, 200)}` : ""} (mid-stream)`,
          })
        }
        case "message_start": {
          const usage = event.message?.usage
          if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens
          if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens
          break
        }
        case "content_block_start": {
          if (event.content_block?.type === "tool_use") inToolBlock = true
          break
        }
        case "content_block_stop": {
          inToolBlock = false
          break
        }
        case "content_block_delta": {
          const delta = event.delta
          if (typeof delta?.partial_json === "string" && delta.partial_json.length > 0) {
            // The tool's arguments, arriving as JSON fragments. Their
            // concatenation IS the response text the contract promises.
            yield { type: "delta", text: delta.partial_json }
          } else if (
            typeof delta?.text === "string" &&
            delta.text.length > 0 &&
            !inToolBlock &&
            !structured
          ) {
            yield { type: "delta", text: delta.text }
          }
          break
        }
        case "message_delta": {
          const reason = event.delta?.stop_reason
          if (typeof reason === "string") {
            // `tool_use` is a NORMAL completion here, not an anomaly: with
            // the tool forced it is what every well-formed answer ends
            // with, and reporting it as "other" would make the pipeline's
            // finish-reason metric read as though the model never once
            // stopped cleanly.
            finishReason =
              reason === "end_turn" || reason === "stop_sequence" || reason === "tool_use"
                ? "stop"
                : reason === "max_tokens"
                  ? "length"
                  : "other"
          }
          // Cumulative, so the last one wins rather than summing.
          if (typeof event.usage?.output_tokens === "number")
            outputTokens = event.usage.output_tokens
          break
        }
        default:
          // ping, message_stop, and anything a later API version adds.
          break
      }
    }

    const usage: LLMUsage | null =
      inputTokens !== null && outputTokens !== null ? { inputTokens, outputTokens } : null
    yield { type: "done", finishReason, usage }
  }
}
//#endregion

//#region Exports
export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL, ANSWER_TOOL_NAME }
export type { AnthropicOptions }
//#endregion
