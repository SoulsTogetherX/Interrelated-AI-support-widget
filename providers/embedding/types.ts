//#region Type Defs
/**
 * The embedding side of the provider abstraction. One interface, several
 * real implementations — mock (tests/CI), local fastembed (eval/offline),
 * and since M3.6b the remote adapters (Gemini, OpenAI-compatible, Ollama)
 * a tenant selects with their own key.
 *
 * Batch-first on purpose: every real embedding API is batched, free tiers
 * are rate-limited per REQUEST, and an ingest run embeds hundreds of chunks.
 * A single-text convenience method would invite N-requests-for-N-chunks
 * code, which is exactly how free-tier quotas die.
 */

/**
 * What the text will be used FOR. Asymmetric retrieval models embed a
 * QUESTION and a PASSAGE differently on purpose — into the same space, from
 * different sides — and Gemini exposes that as taskType
 * (RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT). Passing the wrong one costs real
 * recall on those models, so the hint is part of the interface rather than
 * a per-adapter guess.
 *
 * Optional, defaulting to "document", because the symmetric implementations
 * (mock, local) ignore it entirely and the ingest worker — the dominant
 * caller by volume — always embeds documents.
 */
type EmbedTask = "document" | "query"

interface EmbedOptions {
  task?: EmbedTask
  /** Cancellation, for the same reason LLMRequest carries one: Node's fetch
   *  has NO default timeout, so a provider that accepts a connection and
   *  then goes quiet would hang the caller forever — including a request
   *  handler (the dashboard's Test button) and the ingest worker's tick.
   *  Ignored by the local implementations, which cannot block on a socket. */
  signal?: AbortSignal
}

interface EmbeddingProvider {
  /** Model identifier as stored in chunk_embeddings.model — also the
   *  predicate of that model's partial HNSW index (§3.3.1). */
  readonly model: string
  /** The model's NATIVE dimension, before zero-padding to PADDED_DIM.
   *  Stored per-row in chunk_embeddings.dim so a model whose dimension
   *  changes upstream is detectable against existing vectors.
   *
   *  Remote adapters may not know it before their first call — a
   *  self-hosted server's model is a machine fact, not something this code
   *  can guess — so they report DIM_UNKNOWN until they have seen a
   *  response. The credential flow discovers it once at Test time and
   *  persists it (§3.3.3), which is what lets every LATER
   *  construction declare the dimension up front and fail loudly when the
   *  provider stops honoring it. */
  readonly dim: number
  /**
   * Embeds a batch, preserving order: result[i] is the vector for texts[i],
   * with exactly `dim` components each. Implementations throw on failure —
   * retry/backoff policy belongs to the caller (the ingest worker), which
   * knows whether it is interactive or background work.
   */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]>
}

/** A remote adapter's `dim` before its first successful response. Zero
 *  rather than null so the interface stays a plain number for the local
 *  implementations that always know theirs. */
const DIM_UNKNOWN = 0
//#endregion

//#region Exports
export { DIM_UNKNOWN }
export type { EmbeddingProvider, EmbedOptions, EmbedTask }
//#endregion
