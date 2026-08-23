//#region Why this file
// Everything between "the dashboard sent a credential payload" and "a row
// is worth encrypting": shape validation, the SSRF vet on tenant-supplied
// base URLs, provider construction, and the LIVE round-trip the Test button
// promises — a real completion against the real provider, reporting latency
// and the resolved model before anything is saved. Validation is a genuine
// call on purpose: a key that "looks right" but is revoked, out of quota,
// or scoped wrong would otherwise fail at a visitor's first question, which
// is the worst possible place.
//
// The SSRF boundary: base_url is a tenant-typed URL this server will later
// dial (§2.4.5i said this vetting belongs at the realtime boundary BEFORE a
// provider is constructed — this is that seam). assertPublicUrl resolves
// DNS and rejects anything non-public, fail-closed. Honest limitation, for
// M6's hardening pass: the vet runs at save/test time, and the provider's
// own fetch has no connect-time re-check — a DNS answer that flips private
// AFTER validation (rebinding) is not yet caught on the chat path.
//#endregion

//#region Imports
import { assertPublicUrl } from "@/ingest/safeFetch"
import { GroqProvider } from "@providers/llm/groq"
import { GeminiProvider } from "@providers/llm/gemini"
import { OllamaProvider } from "@providers/llm/ollama"
import { OpenAICompatibleProvider } from "@providers/llm/openaiCompatible"
import { AnthropicProvider } from "@providers/llm/anthropic"
import { LLMHttpError } from "@providers/llm/http"
import { GeminiEmbeddingProvider, GEMINI_EMBED_MODEL } from "@providers/embedding/gemini"
import { OllamaEmbeddingProvider } from "@providers/embedding/ollama"
import { OpenAICompatibleEmbeddingProvider } from "@providers/embedding/openaiCompatible"
import { PADDED_DIM } from "@shared/utils/vectors"

import type { LLMProvider } from "@providers/llm/types"
import type { EmbeddingProvider } from "@providers/embedding/types"
//#endregion

//#region Types
export interface CredentialInput {
  role: "generation" | "embedding"
  /** The same five values the schema's CHECK allows (§3.3.3). Since M7.8
   *  this union is EQUAL to the stored one rather than narrower than it —
   *  anthropic was forward provision for two milestones, and every
   *  "unreachable provider" workaround it forced could go with it. */
  provider: "groq" | "gemini" | "ollama" | "openai_compatible" | "anthropic"
  apiKey?: string
  baseUrl?: string
  model?: string
}

export type CredentialCheck =
  | { ok: true; value: CredentialInput }
  | { ok: false; error: string }

export type RoundTrip =
  | { ok: true; model: string; latencyMs: number; dim?: number }
  | { ok: false; error: string }

/** The URL vet, injectable for tests (which must reach loopback fakes that
 *  the production default rightly refuses) — the same seam shape as
 *  safeFetch's hostGuard. */
export type UrlVet = (url: URL) => Promise<void>
//#endregion

//#region Shape validation
const PROVIDERS = new Set(["groq", "gemini", "ollama", "openai_compatible", "anthropic"])

// Sanity bounds only — real proof is the round-trip. The cap matters: a
// megabyte "key" would be embedded in every provider request header.
const KEY_MIN = 8
const KEY_MAX = 512

export async function checkCredentialInput(
  body: unknown,
  vetUrl: UrlVet = (url) => assertPublicUrl(url),
): Promise<CredentialCheck> {
  const b = (body ?? {}) as Record<string, unknown>

  if (b.role !== "generation" && b.role !== "embedding") {
    return { ok: false, error: "role must be 'generation' or 'embedding'." }
  }
  const role = b.role

  if (typeof b.provider !== "string" || !PROVIDERS.has(b.provider)) {
    return {
      ok: false,
      error: "provider must be one of groq, gemini, ollama, openai_compatible, anthropic.",
    }
  }
  const provider = b.provider as CredentialInput["provider"]

  // Groq and Anthropic serve generation only — neither has an embeddings
  // endpoint at all (the plan's provider table has a dash in that column
  // for both). Naming the gap beats a confusing 404 from an endpoint that
  // was never there.
  if (role === "embedding" && (provider === "groq" || provider === "anthropic")) {
    const name = provider === "groq" ? "Groq" : "Anthropic"
    return {
      ok: false,
      error: `${name} does not serve embeddings — use Gemini, Ollama, or an OpenAI-compatible endpoint.`,
    }
  }

  const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() !== "" ? b.apiKey.trim() : undefined
  const baseUrl = typeof b.baseUrl === "string" && b.baseUrl.trim() !== "" ? b.baseUrl.trim() : undefined
  const model = typeof b.model === "string" && b.model.trim() !== "" ? b.model.trim() : undefined

  if (provider === "ollama" && apiKey !== undefined) {
    return { ok: false, error: "Ollama is unauthenticated — remove the API key." }
  }
  if ((provider === "groq" || provider === "gemini" || provider === "anthropic") && apiKey === undefined) {
    return { ok: false, error: "An API key is required for this provider." }
  }
  if (apiKey !== undefined && (apiKey.length < KEY_MIN || apiKey.length > KEY_MAX)) {
    return { ok: false, error: "That does not look like an API key." }
  }

  const needsBase = provider === "ollama" || provider === "openai_compatible"
  if (needsBase && baseUrl === undefined) {
    return { ok: false, error: "A base URL is required for this provider." }
  }
  if (!needsBase && baseUrl !== undefined) {
    return { ok: false, error: "This provider's endpoint is fixed — remove the base URL." }
  }
  if (needsBase && model === undefined) {
    return {
      ok: false,
      error: "A model name is required — there is no sane default for self-hosted providers.",
    }
  }

  if (baseUrl !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      return { ok: false, error: "The base URL is not a valid URL." }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "The base URL must be http(s)." }
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, error: "The base URL must not embed credentials." }
    }
    try {
      await vetUrl(parsed)
    } catch {
      // One generic message: which private range it landed in is
      // reconnaissance for whoever is probing our egress.
      return { ok: false, error: "The base URL must resolve to a public address." }
    }
  }

  return { ok: true, value: { role, provider, apiKey, baseUrl, model } }
}
//#endregion

//#region Provider construction + round-trip
export function buildGenerationProvider(input: CredentialInput): LLMProvider {
  switch (input.provider) {
    case "groq":
      return new GroqProvider({ apiKey: input.apiKey!, model: input.model })
    case "gemini":
      return new GeminiProvider({ apiKey: input.apiKey!, model: input.model })
    case "anthropic":
      return new AnthropicProvider({ apiKey: input.apiKey!, model: input.model })
    case "ollama":
      return new OllamaProvider({ model: input.model!, baseUrl: input.baseUrl })
    case "openai_compatible":
      return new OpenAICompatibleProvider({
        baseUrl: input.baseUrl!,
        model: input.model!,
        apiKey: input.apiKey,
      })
  }
}

/**
 * The model id a stored embedding credential resolves to — the exact value
 * that lands in chunk_embeddings.model, and therefore the thing retrieval
 * filters on. Only gemini has a default worth having; the self-hosted
 * shapes always carry an explicit model (checkCredentialInput requires it).
 *
 * Exists so the internal API can compare "what the corpus was embedded
 * with" against "what it will be embedded with next" WITHOUT decrypting a
 * key just to read a name.
 */
export function effectiveEmbeddingModel(
  provider: CredentialInput["provider"],
  model: string | null,
): string {
  if (model !== null && model !== "") return model
  return provider === "gemini" ? GEMINI_EMBED_MODEL : ""
}

/** The embedding twin. `dim` comes from the stored credential row
 *  (§3.3.3) on every construction AFTER the first Test, which is
 *  what turns each response into an assertion instead of a discovery —
 *  omit it exactly once, during validation, and the adapter learns it. */
export function buildEmbeddingProvider(
  input: CredentialInput,
  dim?: number,
): EmbeddingProvider {
  switch (input.provider) {
    case "gemini":
      return new GeminiEmbeddingProvider({
        apiKey: input.apiKey!,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(dim !== undefined ? { dim } : {}),
      })
    case "ollama":
      return new OllamaEmbeddingProvider({
        model: input.model!,
        baseUrl: input.baseUrl,
        ...(dim !== undefined ? { dim } : {}),
      })
    case "openai_compatible":
      return new OpenAICompatibleEmbeddingProvider({
        baseUrl: input.baseUrl!,
        model: input.model!,
        apiKey: input.apiKey,
        ...(dim !== undefined ? { dim } : {}),
      })
    case "groq":
    case "anthropic":
      // Unreachable through checkCredentialInput, which refuses both
      // pairings by name; a row here would mean the schema was written
      // around us.
      throw new Error(`${input.provider} has no embedding endpoint`)
  }
}

/**
 * How long the Test button may spend on the provider, and why it is not 15
 * seconds any more (M8.2).
 *
 * 15 s was a guess made before this project had ever called a real provider.
 * M7.11 then MEASURED the free tier the product is designed around and found
 * a TTFT p95 of 27.9 s — bimodal, most answers under 5 s with a long tail —
 * and the key-gated live suite has since watched a structured-output call
 * take 29.4 s and a plain one 503 after 11 s. So the old cap failed a
 * PERFECTLY GOOD key often enough to matter, and the sentence it produced
 * ("the provider did not answer within 15s") reads as "your key is bad".
 *
 * The ceiling is not ours to choose freely: web/src/lib/realtime waits 30 s
 * for the whole internal call, so anything at or past that turns a provider
 * timeout into a dashboard timeout — a worse error, because it names nothing.
 * 25 s spends the headroom that already existed and leaves the round trip
 * itself room to answer.
 *
 * It still does not cover a 27.9 s p95, and pretending a number could is why
 * this comment exists rather than a bigger constant: an unbounded tail is
 * bounded by a RETRY, below, not by waiting longer.
 */
const TEST_TIMEOUT_MS = 25_000

/**
 * One extra attempt, for the failures a second try actually fixes.
 *
 * §3.15.5 already decided which failures those are and the answer path uses
 * it per question; the Test button had none of it, so a transient 503 — which
 * this machine's free tier produced on the third of three calls — failed the
 * save outright and told the tenant to doubt their key. Only the retryable
 * class is re-attempted (429 / 408 / 5xx / transport); a 401 is a wrong key
 * and will be just as wrong in a second.
 *
 * Bounded by the SAME wall clock as the first attempt rather than doubling
 * it: a person is watching a form, and two 25 s waits is not a Test button,
 * it is an abandoned tab. So the retry happens only if the failure came back
 * with time left, which is exactly the case a fast 503 presents.
 */
const TEST_ATTEMPTS = 2

/** True for the failures §3.15.5 calls worth retrying. Re-derived here from
 *  the error rather than imported, because answer/retry.ts's withRetry owns
 *  sleeping and backoff — neither of which belongs in front of a form. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof LLMHttpError)) {
    // A transport failure (dropped socket, DNS blip) is the original reason
    // retries exist; an abort is the caller giving up and is never retried.
    return !(error instanceof Error && error.name === "AbortError")
  }
  return error.status === 429 || error.status === 408 || error.status >= 500
}

/** The Test button's promise: one real, tiny completion. maxTokens 16 keeps
 *  the spend under a fraction of a cent on any provider; temperature 0 for
 *  reproducibility; latency measured to DONE (the whole round-trip is what
 *  the tenant will feel, not TTFT of a 16-token reply). Errors surface as
 *  human sentences — LLMHttpError's message already excludes the key and
 *  headers by construction (§2.4.5f), and that guarantee has its own test. */
export async function testGenerationRoundTrip(
  provider: LLMProvider,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<RoundTrip> {
  const deadline = Date.now() + timeoutMs
  let last: RoundTrip = { ok: false, error: "Could not reach the provider." }

  for (let attempt = 1; attempt <= TEST_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now()
    // A second attempt only happens with real time left to make it in.
    if (remaining < 2000 && attempt > 1) break

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    const startedAt = Date.now()
    try {
      for await (const event of provider.stream({
        messages: [{ role: "user", content: 'Reply with the single word "ok".' }],
        maxTokens: 16,
        temperature: 0,
        signal: controller.signal,
      })) {
        if (event.type === "done") {
          return { ok: true, model: provider.model, latencyMs: Date.now() - startedAt }
        }
      }
      last = { ok: false, error: "The provider's stream ended without completing." }
    } catch (error) {
      if (controller.signal.aborted) {
        // Out of budget: no retry can help, and the sentence says what the
        // tenant should conclude — the provider was slow, not that the key
        // is wrong.
        return {
          ok: false,
          error:
            `The provider did not answer within ${timeoutMs / 1000}s. ` +
            "Free tiers are often slow — try again before assuming the key is wrong.",
        }
      }
      last = error instanceof LLMHttpError
        ? { ok: false, error: `The provider rejected the request: ${error.message}` }
        : { ok: false, error: "Could not reach the provider." }
      if (!isTransient(error)) return last
    } finally {
      clearTimeout(timer)
    }
  }
  return last
}

/**
 * The embedding role's Test button: one real embedding of one short text.
 * It answers three questions no shape check can, and each of them is a
 * failure a visitor would otherwise discover mid-question:
 *
 *   - does the key authenticate against THIS endpoint (an embedding key
 *     and a generation key are often scoped differently);
 *   - what dimension does the model actually return — the number stored on
 *     the credential row and asserted on every later call (§3.3.3);
 *   - does that dimension FIT. halfvec(1024) is the storage contract
 *     (PADDED_DIM), so a 1536-d or 3072-d model is refused here, with a
 *     sentence naming the fix, rather than silently truncated: cutting an
 *     embedding that was not Matryoshka-trained destroys exactly the
 *     geometry that made it worth storing.
 *
 * The pair with testGenerationRoundTrip is deliberate — same shape, same
 * error vocabulary, so the internal API tests and saves both roles through
 * one branch.
 */
export async function testEmbeddingRoundTrip(
  provider: EmbeddingProvider,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<RoundTrip> {
  const deadline = Date.now() + timeoutMs
  let last: RoundTrip = { ok: false, error: "Could not reach the provider." }

  // Same budget and same retry class as its generation twin — the pairing is
  // deliberate (one error vocabulary, one branch in the internal API), and an
  // embedding endpoint has the same transient failures a generation one does.
  for (let attempt = 1; attempt <= TEST_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining < 2000 && attempt > 1) break

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    const startedAt = Date.now()
    try {
      // Embedded as a DOCUMENT: it is the ingest path — the one that runs
      // hundreds of times per crawl — that this credential mostly serves.
      const vectors = await provider.embed(["Interrelated credential check."], {
        task: "document",
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt
      const vector = vectors[0]
      if (vectors.length !== 1 || vector === undefined || vector.length === 0) {
        return { ok: false, error: "The provider returned no embedding." }
      }
      if (vector.length > PADDED_DIM) {
        return {
          ok: false,
          error:
            `That model returns ${vector.length} dimensions; this platform stores up to ${PADDED_DIM}. ` +
            "Choose a smaller embedding model, or one that supports a reduced output dimension.",
        }
      }
      return { ok: true, model: provider.model, latencyMs, dim: vector.length }
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          error:
            `The provider did not answer within ${timeoutMs / 1000}s. ` +
            "Free tiers are often slow — try again before assuming the key is wrong.",
        }
      }
      if (error instanceof LLMHttpError) {
        last = { ok: false, error: `The provider rejected the request: ${error.message}` }
      } else if (error instanceof Error) {
        // The adapters' own contract violations (wrong count, non-numeric
        // vectors, a changed dimension) arrive as plain Errors whose messages
        // are already written for a human and contain no credential material.
        // They are FACTS about the model, not weather: never retried.
        return { ok: false, error: `The provider's response was unusable: ${error.message}` }
      } else {
        last = { ok: false, error: "Could not reach the provider." }
      }
      if (!isTransient(error)) return last
    } finally {
      clearTimeout(timer)
    }
  }
  return last
}
//#endregion
