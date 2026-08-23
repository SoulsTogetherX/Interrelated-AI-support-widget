//#region Imports
import { assertBatch, normalize, postJson, toVector } from "./http"
import { DIM_UNKNOWN } from "./types"
import type { EmbeddingProvider, EmbedOptions } from "./types"
//#endregion

//#region Type Defs
/**
 * Google Gemini embeddings — the hosted default of the BYO-embedding path,
 * because it is the only provider in the plan's table that offers real
 * embeddings on a free tier without a credit card (~100 req/min).
 *
 * Two decisions carry this file:
 *
 * 1. outputDimensionality, always. gemini-embedding-001 is natively 3072-d
 *    and our storage column is halfvec(1024) (§3.3.1 — 2 bytes per
 *    dimension is what fits a corpus inside Neon's 0.5 GB free tier), so
 *    the native output simply does not fit. The model is Matryoshka-trained
 *    and 768 is one of the sizes Google documents for it, so we ask for 768
 *    rather than truncating something that was never trained to be
 *    truncated. Widening the column instead would triple every row AND
 *    every index entry for the one provider that needs it.
 *
 * 2. Re-normalization. Only the full 3072-d output comes back unit-length;
 *    a Matryoshka-reduced vector does not. Cosine ranking is scale-invariant
 *    so this is not correctness for THIS index, but every other consumer in
 *    the repo assumes unit vectors — the zero-padding proof, halfvec's fp16
 *    range, and any future L2 or inner-product index — so the adapter hands
 *    back what the rest of the system expects.
 *
 * taskType is honored (EmbedOptions.task): a question and a passage go into
 * the same space from different sides, and using RETRIEVAL_DOCUMENT for a
 * query is the standard way to leave recall on the table.
 */
interface GeminiEmbeddingOptions {
  apiKey: string
  model?: string
  /** Output dimension to request. Defaults to 768 — see above. A stored
   *  credential passes the dimension its Test round-trip observed, which
   *  turns the response check into a real assertion. */
  dim?: number
  /** Overridable for tests; nobody self-hosts Gemini. */
  baseUrl?: string
}

/** The slice of a batchEmbedContents response this adapter reads. */
interface GeminiEmbedResponse {
  embeddings?: Array<{ values?: unknown }>
}
//#endregion

//#region Constants
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
/** The current generation; the retired embedding-001/text-embedding-004
 *  models are deliberately not offered as defaults. */
const GEMINI_EMBED_MODEL = "gemini-embedding-001"
/** 768: a documented Matryoshka size for this model, and the largest of
 *  them that fits the 1024-d storage column with room to spare. */
const GEMINI_EMBED_DIM = 768
//#endregion

//#region Provider
class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  #dim: number
  readonly #apiKey: string
  readonly #baseUrl: string

  constructor(options: GeminiEmbeddingOptions) {
    this.model = options.model ?? GEMINI_EMBED_MODEL
    this.#dim = options.dim ?? GEMINI_EMBED_DIM
    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/$/, "")
  }

  get dim(): number {
    return this.#dim
  }

  async embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]> {
    // An empty batch is a legal no-op for the caller and a 400 from the
    // API — every adapter short-circuits it rather than spending a request.
    if (texts.length === 0) return []

    const taskType = options?.task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT"
    const body = {
      requests: texts.map((text) => ({
        // The model is required on EVERY sub-request, as a full resource
        // name, even though the URL already names it — an API quirk, not a
        // redundancy we could drop.
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: this.#dim === DIM_UNKNOWN ? GEMINI_EMBED_DIM : this.#dim,
      })),
    }

    const response = await postJson<GeminiEmbedResponse>({
      provider: "gemini",
      url: `${this.#baseUrl}/v1beta/models/${this.model}:batchEmbedContents`,
      // Header auth, not ?key= in the URL: URLs land in server logs.
      headers: { "x-goog-api-key": this.#apiKey },
      body,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    const raw = (response.embeddings ?? []).map((e) => toVector(e.values))
    this.#dim = assertBatch({
      provider: "gemini",
      model: this.model,
      expected: texts.length,
      declaredDim: this.#dim,
      vectors: raw,
    })
    return raw.map((vector) => normalize(vector as number[]))
  }
}
//#endregion

//#region Exports
export { GeminiEmbeddingProvider, GEMINI_EMBED_MODEL, GEMINI_EMBED_DIM }
export type { GeminiEmbeddingOptions }
//#endregion
