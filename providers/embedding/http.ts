//#region Imports
import { LLMHttpError, postStream } from "../llm/http"
import { DIM_UNKNOWN } from "./types"
//#endregion

//#region HTTP
/**
 * Shared plumbing for the HTTP-backed embedding providers: one POST, one
 * JSON document back. There is no streaming twin of llm/http.ts's
 * postStream because embedding APIs answer in one shot — the batch, not the
 * token, is the unit of progress.
 *
 * The error class is deliberately the SAME LLMHttpError the generation
 * adapters throw. "A provider's HTTP endpoint refused" is one failure shape
 * with one pair of fields callers act on (status, retryAfterMs), and
 * credentials/validate.ts maps it to a human sentence once for BOTH roles;
 * a parallel EmbeddingHttpError would double that surface to say the same
 * thing. (The LLM prefix is historical — that side landed first.) The
 * key-safety guarantee carries over unchanged with it: the message holds
 * the provider label, the status, and a truncated body, never headers and
 * never the URL.
 *
 * Implemented ON postStream rather than beside it so the non-2xx path —
 * body truncation, Retry-After parsing, the no-credentials-in-the-message
 * rule — has exactly one implementation and one test.
 */
async function postJson<T>(options: {
  provider: string
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}): Promise<T> {
  const stream = await postStream(options)
  // No size cap here, unlike safeFetch's crawl bodies: an embedding
  // response is legitimately large (32 texts × 1024 floats is ~700 KB of
  // JSON) and its size is bounded by the batch WE sent, not by anything a
  // hostile site controls.
  const text = await new Response(stream).text()
  try {
    return JSON.parse(text) as T
  } catch {
    // A 2xx that isn't JSON is a wrong-endpoint or captive-portal answer;
    // reported in the provider's own error shape so callers handle one type.
    throw new LLMHttpError({
      provider: options.provider,
      status: 200,
      detail: `response was not JSON: ${text.slice(0, 120)}`,
    })
  }
}
//#endregion

//#region Vector helpers
/** Narrows an unknown blob to a numeric vector, or null when the shape is
 *  off. Used by every adapter to reject the two failure modes that would
 *  otherwise reach Postgres as corruption: a base64-encoded embedding
 *  (some servers default to it) and a null/absent vector inside an
 *  otherwise-2xx response. */
function toVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out = new Array<number>(value.length)
  for (let i = 0; i < value.length; i++) {
    const component: unknown = value[i]
    if (typeof component !== "number" || !Number.isFinite(component)) return null
    out[i] = component
  }
  return out
}

/** Scales a vector to unit length. Needed only where a provider returns
 *  un-normalized output (Gemini's truncated Matryoshka dimensions); the
 *  callers that already get unit vectors skip it. */
function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((acc, v) => acc + v * v, 0))
  if (norm === 0) return values
  return values.map((v) => v / norm)
}

/**
 * The batch post-conditions every remote adapter shares, in one place
 * because each of them is a silent-corruption bug if skipped:
 *
 *   - one vector per input text, so result[i] really is texts[i]'s vector
 *     (a provider that drops or reorders would misattribute every chunk's
 *     embedding to its neighbour — invisible until retrieval is nonsense);
 *   - every vector numeric and non-empty (see toVector);
 *   - all vectors the same length, and equal to the DECLARED dimension
 *     when the caller supplied one. That last check is the promise
 *     §3.3.1 made when it stored `dim` per row: a model whose
 *     dimension changes upstream stops the ingest loudly instead of
 *     quietly filling one org's index with vectors from a second space.
 *
 * Returns the observed dimension, which is how an adapter constructed
 * without one discovers it.
 */
function assertBatch(options: {
  provider: string
  model: string
  expected: number
  declaredDim: number
  vectors: readonly (number[] | null)[]
}): number {
  const { provider, model, expected, declaredDim, vectors } = options
  if (vectors.length !== expected) {
    throw new Error(
      `${provider}: ${model} returned ${vectors.length} embeddings for ${expected} texts`,
    )
  }
  let dim = declaredDim
  for (const vector of vectors) {
    if (vector === null) {
      throw new Error(
        `${provider}: ${model} returned a non-numeric embedding ` +
          "(a base64 encoding_format, or a null entry in an otherwise-successful response)",
      )
    }
    if (dim === DIM_UNKNOWN) {
      dim = vector.length
    } else if (vector.length !== dim) {
      throw new Error(`${provider}: ${model} returned ${vector.length} dimensions, expected ${dim}`)
    }
  }
  return dim
}
//#endregion

//#region Exports
export { postJson, toVector, normalize, assertBatch }
//#endregion
