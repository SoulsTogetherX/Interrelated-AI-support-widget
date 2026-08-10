//#region Imports
import type { EmbeddingProvider } from "./types"
//#endregion

//#region Helpers
/** FNV-1a — a tiny, well-known string hash. Chosen over crypto hashes
 *  because this provider must run identically in any runtime with zero
 *  imports, and "deterministic and well-spread" is the whole requirement —
 *  nothing here is security-sensitive. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** xorshift32 — deterministic PRNG seeded from the text hash. */
function xorshift32(seed: number): () => number {
  let s = seed || 1 // xorshift's one degenerate state is 0; nudge off it
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0xffffffff
  }
}
//#endregion

//#region Provider
/**
 * Deterministic fake embeddings for tests and CI.
 *
 * Properties the test suite relies on:
 *   - Same text → same vector, forever, on every machine (seeded from a
 *     hash of the text — no Math.random, no state).
 *   - Different texts → uncorrelated vectors (hash-seeded PRNG).
 *   - Unit-normalized, so cosine math behaves like a real model's output.
 *
 * What it deliberately does NOT provide: semantic similarity. "refund
 * policy" and "money back" are unrelated vectors here. Retrieval-quality
 * tests therefore use the LOCAL model via the eval harness; the mock exists
 * so plumbing tests (storage, padding, tenant filtering, rate limiting) run
 * in milliseconds with zero downloads. Using the mock in a quality eval is
 * a bug, and the eval harness refuses it by name.
 *
 * model "mock-384" has its own partial HNSW index in migration 002, so even
 * index-usage EXPLAIN tests can run against mock vectors.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-384"
  readonly dim = 384

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const next = xorshift32(fnv1a(text))
      const raw = Array.from({ length: this.dim }, () => next() * 2 - 1)
      const norm = Math.sqrt(raw.reduce((acc, v) => acc + v * v, 0)) || 1
      return raw.map((v) => v / norm)
    })
  }
}
//#endregion

//#region Exports
export { MockEmbeddingProvider }
//#endregion
