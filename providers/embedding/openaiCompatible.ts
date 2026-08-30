//#region Imports
import { assertBatch, postJson, toVector } from "./http"
import { DIM_UNKNOWN } from "./types"
import type { EmbeddingProvider, EmbedOptions } from "./types"
//#endregion

//#region Type Defs
/**
 * The generic OpenAI-compatible embeddings adapter — the same
 * one-implementation-covers-N-providers trade as its generation sibling
 * (llm/openaiCompatible.ts): Together, OpenRouter, vLLM, LM Studio,
 * text-embedding-inference, and Ollama's compat endpoint all speak
 * POST /embeddings with {model, input} and answer with {data:[{index,
 * embedding}]}.
 *
 * Two things this adapter deliberately does NOT do:
 *
 *   - It never sends `dimensions`. The parameter only means anything for
 *     Matryoshka-trained models, and compat servers disagree about whether
 *     an unknown field is ignored or a 400. A model whose native dimension
 *     exceeds the 1024-d storage column is therefore REFUSED at the Test
 *     button with a sentence naming the fix (credentials/validate.ts),
 *     rather than silently truncated — truncating an embedding that was not
 *     trained for it destroys the geometry that made it worth storing.
 *   - It ignores the task hint. The OpenAI embeddings API has no field for
 *     it; models that want an asymmetric prefix expect it in the TEXT, which
 *     is the tenant's choice of model to make, not ours to guess.
 */
interface OpenAICompatibleEmbeddingOptions {
  /** Label used in error messages, e.g. "together". */
  provider?: string
  /** API root WITHOUT the endpoint path, e.g. "https://api.together.xyz/v1". */
  baseUrl: string
  model: string
  /** Absent for keyless servers (local vLLM, LM Studio) — then no
   *  Authorization header is sent at all. */
  apiKey?: string
  /** Known dimension, when the credential row carries one; otherwise
   *  discovered from the first response. */
  dim?: number
}

/** The slice of an /embeddings response this adapter reads. */
interface OpenAIEmbedResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>
}
//#endregion

//#region Provider
class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  #dim: number
  readonly #provider: string
  readonly #baseUrl: string
  readonly #apiKey: string | undefined

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.model = options.model
    this.#dim = options.dim ?? DIM_UNKNOWN
    this.#provider = options.provider ?? "openai-compatible"
    this.#baseUrl = options.baseUrl.replace(/\/$/, "")
    this.#apiKey = options.apiKey
  }

  get dim(): number {
    return this.#dim
  }

  async embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await postJson<OpenAIEmbedResponse>({
      provider: this.#provider,
      url: `${this.#baseUrl}/embeddings`,
      headers: this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {},
      body: { model: this.model, input: [...texts] },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    // The spec says data comes back in input order and ALSO carries an
    // explicit index; sorting by it costs nothing and makes the contract
    // depend on the documented field rather than on server politeness.
    const data = [...(response.data ?? [])].sort((a, b) => {
      const ai = typeof a.index === "number" ? a.index : 0
      const bi = typeof b.index === "number" ? b.index : 0
      return ai - bi
    })
    const raw = data.map((row) => toVector(row.embedding))
    this.#dim = assertBatch({
      provider: this.#provider,
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
export { OpenAICompatibleEmbeddingProvider }

//#endregion
