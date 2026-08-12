//#region Imports
import { assertBatch, postJson, toVector } from "./http"
import { DIM_UNKNOWN } from "./types"
import type { EmbeddingProvider, EmbedOptions } from "./types"
//#endregion

//#region Type Defs
/**
 * Ollama embeddings — the self-hosted, zero-cost path, speaking the native
 * /api/embed rather than the compat endpoint for the same reason the
 * generation adapter does: /api/embed is the BATCH endpoint (`input` takes
 * an array), while the older /api/embeddings takes one prompt per request
 * — and this interface is batch-first precisely because per-request cost is
 * what kills an ingest run.
 *
 * No apiKey: Ollama is unauthenticated by design. The base URL is
 * tenant-supplied, which is a textbook SSRF vector; it is vetted at the
 * realtime boundary before this adapter is ever constructed
 * (credentials/validate.ts, the same seam llm/ollama.ts documents).
 *
 * The task hint is ignored: Ollama passes the text to the model as-is, so
 * an asymmetric model's prefix is part of the model's own contract.
 */
interface OllamaEmbeddingOptions {
  /** No default on purpose: whatever model is pulled locally is a machine
   *  fact, not something this file can guess. */
  model: string
  baseUrl?: string
  /** Known dimension, when the credential row carries one; otherwise
   *  discovered from the first response. */
  dim?: number
}

/** The slice of an /api/embed response this adapter reads. */
interface OllamaEmbedResponse {
  embeddings?: unknown[]
}
//#endregion

//#region Constants
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434"
//#endregion

//#region Provider
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  #dim: number
  readonly #baseUrl: string

  constructor(options: OllamaEmbeddingOptions) {
    this.model = options.model
    this.#dim = options.dim ?? DIM_UNKNOWN
    this.#baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, "")
  }

  get dim(): number {
    return this.#dim
  }

  async embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await postJson<OllamaEmbedResponse>({
      provider: "ollama",
      url: `${this.#baseUrl}/api/embed`,
      headers: {},
      body: { model: this.model, input: [...texts] },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    const raw = (response.embeddings ?? []).map((value) => toVector(value))
    this.#dim = assertBatch({
      provider: "ollama",
      model: this.model,
      expected: texts.length,
      declaredDim: this.#dim,
      vectors: raw,
    })
    return raw as number[][]
  }
}
//#endregion

//#region Exports
export { OllamaEmbeddingProvider, OLLAMA_DEFAULT_BASE_URL }
export type { OllamaEmbeddingOptions }
//#endregion
