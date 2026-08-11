//#region Type Defs
/**
 * The generation side of the provider abstraction (the embedding side lives
 * in providers/embedding/). One interface, several implementations — mock
 * (tests/CI), then Groq, Gemini, OpenAI-compatible, and Ollama — chosen
 * per-org at runtime once BYO-provider lands in M3.
 *
 * Streaming-first on purpose: the widget's headline metric is time-to-first-
 * token, and a Promise<string> interface would make streaming a per-provider
 * afterthought instead of the contract. Callers that want the whole response
 * just collect the deltas — the reverse (faking a stream from a blocking
 * call) throws the latency away.
 */
interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface LLMRequest {
  messages: readonly ChatMessage[]
  /** Upper bound on generated tokens. Callers set this LOW for structured
   *  claim output (answers are a handful of sentences) — it is the cheap
   *  defense against a runaway generation spending a tenant's quota. */
  maxTokens?: number
  /** Callers pass 0 for the answer pipeline: grounded claims should be the
   *  model's most likely reading of the context, and reproducible runs make
   *  schema-violation rates a measurable number instead of a mood. */
  temperature?: number
  /**
   * JSON Schema the response must satisfy. Implementations map this to
   * whatever native enforcement the provider has (Gemini: responseSchema;
   * Groq/OpenAI-compatible: JSON mode; Ollama: format) — which ranges from
   * real schema enforcement to "please emit JSON". Callers therefore MUST
   * validate the result regardless (shared/grounding/claims.ts) — this
   * field improves the odds, it does not create a guarantee.
   */
  responseSchema?: Record<string, unknown>
  /** Cancels generation mid-stream — a visitor closing the widget must stop
   *  spending the tenant's tokens. Implementations stop yielding and throw. */
  signal?: AbortSignal
}

interface LLMUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * The stream contract: zero or more deltas whose concatenation is the full
 * response text, then EXACTLY ONE terminal `done` event. finishReason
 * distinguishes a natural stop from a maxTokens cutoff — a length cutoff
 * mid-JSON is why the claims parser sees truncated output, so the pipeline
 * counts it separately instead of blaming the model's JSON discipline.
 * usage is null where the provider doesn't report it (some OpenAI-compatible
 * servers omit it on streams); cost metrics (M5) treat null as "unknown",
 * never as zero.
 */
type LLMStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finishReason: "stop" | "length" | "other"; usage: LLMUsage | null }

interface LLMProvider {
  /** Model identifier as reported to metrics and stored on messages —
   *  the provider-comparison table (M2/M5) is keyed on this value. */
  readonly model: string
  /**
   * Streams one completion. Implementations throw on transport failure —
   * retry/backoff policy belongs to the caller (the answer pipeline), which
   * knows whether it is interactive (fail fast, tell the visitor) or
   * background work (jittered retry). Same division of labor as
   * EmbeddingProvider.embed.
   */
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}
//#endregion

//#region Exports
export type { ChatMessage, LLMRequest, LLMUsage, LLMStreamEvent, LLMProvider }
//#endregion
