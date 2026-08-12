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
import { LLMHttpError } from "@providers/llm/http"

import type { LLMProvider } from "@providers/llm/types"
//#endregion

//#region Types
export interface CredentialInput {
  role: "generation" | "embedding"
  provider: "groq" | "gemini" | "ollama" | "openai_compatible"
  apiKey?: string
  baseUrl?: string
  model?: string
}

export type CredentialCheck =
  | { ok: true; value: CredentialInput }
  | { ok: false; error: string }

export type RoundTrip =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error: string }

/** The URL vet, injectable for tests (which must reach loopback fakes that
 *  the production default rightly refuses) — the same seam shape as
 *  safeFetch's hostGuard. */
export type UrlVet = (url: URL) => Promise<void>
//#endregion

//#region Shape validation
const PROVIDERS = new Set(["groq", "gemini", "ollama", "openai_compatible"])

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
  // The schema accepts embedding rows, but no remote embedding adapters
  // exist yet — saving a credential nothing can use would look like a
  // finished feature. M3.5 builds the adapters and deletes this branch.
  if (b.role === "embedding") {
    return {
      ok: false,
      error: "Embedding credentials arrive with M3.5 — generation only for now.",
    }
  }

  if (typeof b.provider !== "string" || !PROVIDERS.has(b.provider)) {
    return {
      ok: false,
      error: "provider must be one of groq, gemini, ollama, openai_compatible.",
    }
  }
  const provider = b.provider as CredentialInput["provider"]

  const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() !== "" ? b.apiKey.trim() : undefined
  const baseUrl = typeof b.baseUrl === "string" && b.baseUrl.trim() !== "" ? b.baseUrl.trim() : undefined
  const model = typeof b.model === "string" && b.model.trim() !== "" ? b.model.trim() : undefined

  if (provider === "ollama" && apiKey !== undefined) {
    return { ok: false, error: "Ollama is unauthenticated — remove the API key." }
  }
  if ((provider === "groq" || provider === "gemini") && apiKey === undefined) {
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

  return { ok: true, value: { role: "generation", provider, apiKey, baseUrl, model } }
}
//#endregion

//#region Provider construction + round-trip
export function buildCredentialProvider(input: CredentialInput): LLMProvider {
  switch (input.provider) {
    case "groq":
      return new GroqProvider({ apiKey: input.apiKey!, model: input.model })
    case "gemini":
      return new GeminiProvider({ apiKey: input.apiKey!, model: input.model })
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

/** The Test button's promise: one real, tiny completion. maxTokens 16 keeps
 *  the spend under a fraction of a cent on any provider; temperature 0 for
 *  reproducibility; latency measured to DONE (the whole round-trip is what
 *  the tenant will feel, not TTFT of a 16-token reply). Errors surface as
 *  human sentences — LLMHttpError's message already excludes the key and
 *  headers by construction (§2.4.5f), and that guarantee has its own test. */
export async function testGenerationRoundTrip(
  provider: LLMProvider,
  timeoutMs = 15_000,
): Promise<RoundTrip> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
    return { ok: false, error: "The provider's stream ended without completing." }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: `The provider did not answer within ${timeoutMs / 1000}s.` }
    }
    if (error instanceof LLMHttpError) {
      return { ok: false, error: `The provider rejected the request: ${error.message}` }
    }
    return { ok: false, error: "Could not reach the provider." }
  } finally {
    clearTimeout(timer)
  }
}
//#endregion
