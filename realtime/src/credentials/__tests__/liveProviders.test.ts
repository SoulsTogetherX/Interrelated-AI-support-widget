//#region Why this suite exists, and why it is gated
// Everything else about the credential path is proven against loopback
// fakes — which is the right default (CI is keyless by design, fork PRs
// must pass, nothing may cost money). But a fake cannot answer the two
// questions that actually decide whether BYO-provider works in the real
// world:
//
//   1. Does a REAL provider accept the exact request the Test button
//      sends, and report a resolved model back?
//   2. Does a REAL provider honor the claims contract — the JSON Schema
//      the whole verification thesis rests on — or is its structured
//      output advisory in practice? (§2.4.5h: enforcement ranges from
//      Gemini's server-side responseJsonSchema to Groq's "please emit
//      JSON", and the difference is a METRIC, not an assumption.)
//
// So this suite runs the real thing, per provider, ONLY when that
// provider's key is present in the environment:
//
//   GROQ_API_KEY=...      npm test   (free tier, no card: console.groq.com)
//   GEMINI_API_KEY=...    npm test   (free tier, no card: aistudio.google.com)
//   ANTHROPIC_API_KEY=... npm test   (PAID — the one that costs, see below)
//
// Both are the SAME variables .env.example already documents for
// `npm run ask --llm groq|gemini` and for server-level LLM_PROVIDER — one
// name per provider across the repo, so pasting a key into .env lights up
// the CLI, the server, and this suite at once. Absent keys → these cases
// skip and the suite still asserts (below) that the keyless default is
// what CI is running, so "gated off" can never be mistaken for "passing".
//
// Cost: a handful of requests of ~16 and ~200 tokens. Free tiers absorb
// this without noticing. Rate limits are the real hazard on repeat runs
// (§2.4.5f's 429 handling), which is why a 429 fails with the provider's
// own retry advice rather than a generic assertion error.
//#endregion

//#region Imports
import { describe, expect, it } from "vitest"

import {
  buildEmbeddingProvider,
  buildGenerationProvider,
  checkCredentialInput,
  testEmbeddingRoundTrip,
  testGenerationRoundTrip,
} from "../validate"
import { decryptProviderKey, encryptProviderKey, keySuffix } from "../vault"
import { ANSWER_JSON_SCHEMA, parseAnswerText } from "@shared/grounding/claims"
import { PADDED_DIM } from "@shared/utils/vectors"
import { LLMHttpError } from "@providers/llm/http"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Gating
const GROQ_KEY = process.env.GROQ_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

interface LiveProvider {
  name: "groq" | "gemini" | "anthropic"
  key: string | undefined
  /** Model override, if the repo's default should be overridden per run —
   *  free-tier model availability moves (the plan says so explicitly), so
   *  these exist to let a run be pinned without a code change. */
  model: string | undefined
}

const PROVIDERS: LiveProvider[] = [
  { name: "groq", key: GROQ_KEY, model: process.env.GROQ_MODEL },
  { name: "gemini", key: GEMINI_KEY, model: process.env.GEMINI_MODEL },
  // Anthropic (M7.8) needs no special case here, which is the point: the
  // adapter satisfies the same LLMProvider contract, so the same three
  // cases exercise it. The one thing that IS different is money — it has
  // no free tier, so setting ANTHROPIC_API_KEY makes `npm test` cost a
  // fraction of a cent per run, and CI never sets it. The structured-output
  // case is the interesting one for this provider: it is the only forced
  // TOOL CALL in the table, and whether that really constrains the claims
  // contract is a measurement, not an assumption (§2.4.5n).
  { name: "anthropic", key: ANTHROPIC_KEY, model: process.env.ANTHROPIC_MODEL },
]

const ANY_KEY = PROVIDERS.some((p) => Boolean(p.key))
//#endregion

//#region Helpers
/** Turns a provider failure into a sentence a human can act on. A 429 on
 *  the free tier is a RATE LIMIT, not a broken adapter, and saying so
 *  saves the next person half an hour. */
function describeFailure(error: unknown): string {
  if (error instanceof LLMHttpError) {
    const retry = error.retryAfterMs !== null ? ` (retry in ~${Math.ceil(error.retryAfterMs / 1000)}s)` : ""
    // LLMHttpError.message already carries the provider label and status
    // (§2.4.5f), so it is used verbatim — re-prefixing would double it.
    return error.status === 429
      ? `rate limited${retry} — free tiers are per-minute; re-run in a moment. ${error.message}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}
//#endregion

//#region Live provider cases
for (const provider of PROVIDERS) {
  const enabled = Boolean(provider.key)

  describe.skipIf(!enabled)(`live ${provider.name} credential path`, () => {
    // The exact payload the dashboard's Test button sends (§3.22), through
    // the exact validator the internal API uses — no test-only shortcut.
    const payload = {
      role: "generation" as const,
      provider: provider.name,
      apiKey: provider.key,
      ...(provider.model !== undefined ? { model: provider.model } : {}),
    }

    it("accepts a real key and completes a live round-trip", async () => {
      const checked = await checkCredentialInput(payload)
      expect(checked.ok, checked.ok ? "" : `validation rejected the payload: ${checked.error}`).toBe(true)
      if (!checked.ok) return

      const llm = buildGenerationProvider(checked.value)
      const trip = await testGenerationRoundTrip(llm, 30_000)
      expect(trip.ok, trip.ok ? "" : `round-trip failed: ${trip.error}`).toBe(true)
      if (!trip.ok) return

      // What the dashboard shows the tenant after a successful test.
      expect(trip.model.length).toBeGreaterThan(0)
      expect(trip.latencyMs).toBeGreaterThan(0)
      console.log(`[live] ${provider.name}: ${trip.model} answered in ${trip.latencyMs}ms`)
    }, 60_000)

    it("survives the vault round-trip — encrypt, store-shape, decrypt, call", async () => {
      // The M3.4 path end to end with a REAL key: the value that comes back
      // out of AES-GCM must still authenticate to the provider. A subtle
      // corruption (encoding, truncation, AAD drift) would pass every
      // loopback test and fail exactly here.
      const hadMasterKey = process.env.CREDENTIAL_MASTER_KEY
      process.env.CREDENTIAL_MASTER_KEY ??= Buffer.alloc(32, 9).toString("base64")
      try {
        const credentialId = newId("prv")
        const ciphertext = encryptProviderKey(provider.key as string, credentialId)
        expect(ciphertext).not.toContain(provider.key as string)
        expect(keySuffix(provider.key as string)).toHaveLength(4)

        const recovered = decryptProviderKey(ciphertext, credentialId)
        const checked = await checkCredentialInput({ ...payload, apiKey: recovered })
        expect(checked.ok).toBe(true)
        if (!checked.ok) return

        const trip = await testGenerationRoundTrip(buildGenerationProvider(checked.value), 30_000)
        expect(trip.ok, trip.ok ? "" : `decrypted key failed: ${trip.error}`).toBe(true)
      } finally {
        if (hadMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
      }
    }, 60_000)

    it("honors the claims contract under a real structured-output request", async () => {
      // The measurement the plan calls for (§2.4.5h): native schema
      // enforcement ranges from real (Gemini) to advisory (Groq's JSON
      // mode). This does not assert WHICH — it asserts the pipeline's
      // parser can make sense of what comes back, and PRINTS the outcome
      // so a schema-violation rate is observable per provider rather than
      // assumed.
      const checked = await checkCredentialInput(payload)
      expect(checked.ok).toBe(true)
      if (!checked.ok) return
      const llm = buildGenerationProvider(checked.value)

      let text = ""
      let finishReason = ""
      try {
        for await (const event of llm.stream({
          messages: [
            {
              role: "system",
              content:
                "Answer ONLY with JSON matching the provided schema. Each claim must quote " +
                "the context verbatim in its `quote` field.",
            },
            {
              role: "user",
              content:
                "<context>\n[chunk chk_00000000000000000000000000000000 | Refunds]\n" +
                "Refunds are processed within five business days of the request.\n</context>\n\n" +
                "How long do refunds take?",
            },
          ],
          maxTokens: 300,
          temperature: 0,
          responseSchema: ANSWER_JSON_SCHEMA,
        })) {
          if (event.type === "delta") text += event.text
          if (event.type === "done") finishReason = event.finishReason
        }
      } catch (error) {
        throw new Error(`${provider.name}: ${describeFailure(error)}`)
      }

      const parsed = parseAnswerText(text)
      console.log(
        `[live] ${provider.name} structured output: ${parsed.ok ? "valid" : "SCHEMA VIOLATION"}` +
          ` (finish=${finishReason}, ${text.length} chars)` +
          (parsed.ok ? "" : ` — ${parsed.errors.join("; ")}`),
      )
      expect(
        parsed.ok,
        parsed.ok ? "" : `${provider.name} violated the claims contract: ${parsed.errors.join("; ")}`,
      ).toBe(true)
      if (!parsed.ok) return
      // A model that returns zero claims for answerable context is not a
      // contract violation, but it is worth seeing in the log above.
      expect(Array.isArray(parsed.payload.claims)).toBe(true)
    }, 90_000)
  })
}
//#endregion

//#region Live embedding (M3.6b)
// Gemini is the only provider in the table that serves BOTH roles on a free
// tier, so the embedding credential path gets the same treatment: the exact
// payload the dashboard sends, through the exact validator, against the
// real API. What only a live run can answer here is whether the reduced
// output dimension we request is actually honored — the whole reason the
// adapter can store its vectors in halfvec(1024) at all.
describe.skipIf(!GEMINI_KEY)("live gemini embedding credential path", () => {
  it("accepts a real key and returns vectors at a storable dimension", async () => {
    const checked = await checkCredentialInput({
      role: "embedding" as const,
      provider: "gemini",
      apiKey: GEMINI_KEY,
      ...(process.env.GEMINI_EMBED_MODEL !== undefined ? { model: process.env.GEMINI_EMBED_MODEL } : {}),
    })
    expect(checked.ok, checked.ok ? "" : `validation rejected the payload: ${checked.error}`).toBe(true)
    if (!checked.ok) return

    const trip = await testEmbeddingRoundTrip(buildEmbeddingProvider(checked.value), 30_000)
    expect(trip.ok, trip.ok ? "" : `round-trip failed: ${trip.error}`).toBe(true)
    if (!trip.ok) return

    expect(trip.dim).toBeGreaterThan(0)
    expect(trip.dim!).toBeLessThanOrEqual(PADDED_DIM)
    console.log(`[live] gemini embeddings: ${trip.model} returned ${trip.dim}-d in ${trip.latencyMs}ms`)
  }, 60_000)

  it("embeds a batch in order, and a query differently from a document", async () => {
    // Order is the property the ingest worker bets every chunk on, and the
    // task hint is the reason the adapter bothers with taskType at all: if
    // RETRIEVAL_QUERY and RETRIEVAL_DOCUMENT produced identical vectors,
    // passing them would be theatre.
    const provider = buildEmbeddingProvider({
      role: "embedding", provider: "gemini", apiKey: GEMINI_KEY as string,
    })
    const texts = ["Refunds are processed within five business days.", "Bananas ripen faster in a paper bag."]
    let asDocuments: number[][]
    let asQuery: number[][]
    try {
      asDocuments = await provider.embed(texts, { task: "document" })
      asQuery = await provider.embed([texts[0] as string], { task: "query" })
    } catch (error) {
      throw new Error(`gemini: ${describeFailure(error)}`)
    }

    expect(asDocuments).toHaveLength(2)
    const dot = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * (b[i] as number), 0)
    // Unit-normalized, as the adapter promises after Matryoshka reduction.
    expect(Math.sqrt(dot(asDocuments[0] as number[], asDocuments[0] as number[]))).toBeCloseTo(1, 4)
    // Real semantics, unlike the mock: the refund sentence is nearer to its
    // own query embedding than the banana sentence is.
    const own = dot(asQuery[0] as number[], asDocuments[0] as number[])
    const other = dot(asQuery[0] as number[], asDocuments[1] as number[])
    expect(own).toBeGreaterThan(other)
    console.log(`[live] gemini task types: same-text ${own.toFixed(3)} vs unrelated ${other.toFixed(3)}`)
  }, 60_000)
})
//#endregion

//#region Gated-off guard
// Without this, "no keys set" and "all live tests passed" look identical
// in CI output — the same trap the fastembed suite guards (§2.4.5c).
describe.skipIf(ANY_KEY)("live provider suites (gated off)", () => {
  it("skips because no provider keys are set — this is the keyless default", () => {
    expect(GROQ_KEY).toBeUndefined()
    expect(GEMINI_KEY).toBeUndefined()
  })
})
//#endregion
