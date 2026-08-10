//#region Type Defs
/**
 * The embedding side of the provider abstraction (the LLM side arrives in
 * M2). One interface, several real implementations — mock (tests/CI), local
 * fastembed (eval/offline), Gemini (production default) — chosen per-org at
 * runtime once BYO-provider lands in M3.
 *
 * Batch-first on purpose: every real embedding API is batched, free tiers
 * are rate-limited per REQUEST, and an ingest run embeds hundreds of chunks.
 * A single-text convenience method would invite N-requests-for-N-chunks
 * code, which is exactly how free-tier quotas die.
 */
interface EmbeddingProvider {
  /** Model identifier as stored in chunk_embeddings.model — also the
   *  predicate of that model's partial HNSW index (migration 002). */
  readonly model: string
  /** The model's NATIVE dimension, before zero-padding to PADDED_DIM.
   *  Stored per-row in chunk_embeddings.dim so a model whose dimension
   *  changes upstream is detectable against existing vectors. */
  readonly dim: number
  /**
   * Embeds a batch, preserving order: result[i] is the vector for texts[i],
   * with exactly `dim` components each. Implementations throw on failure —
   * retry/backoff policy belongs to the caller (the ingest worker), which
   * knows whether it is interactive or background work.
   */
  embed(texts: readonly string[]): Promise<number[][]>
}
//#endregion

//#region Exports
export type { EmbeddingProvider }
//#endregion
