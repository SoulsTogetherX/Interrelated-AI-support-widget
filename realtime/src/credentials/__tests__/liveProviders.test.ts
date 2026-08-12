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
//   GROQ_API_KEY=...   npm test      (free tier, no card: console.groq.com)
//   GEMINI_API_KEY=... npm test      (free tier, no card: aistudio.google.com)
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
  buildCredentialProvider,
  checkCredentialInput,
  testGenerationRoundTrip,
} from "../validate"
import { decryptProviderKey, encryptProviderKey, keySuffix } from "../vault"
import { ANSWER_JSON_SCHEMA, parseAnswerText } from "@shared/grounding/claims"
import { LLMHttpError } from "@providers/llm/http"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Gating
const GROQ_KEY = process.env.GROQ_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY

interface LiveProvider {
  name: "groq" | "gemini"
  key: string | undefined
  /** Model override, if the repo's default should be overridden per run —
   *  free-tier model availability moves (the plan says so explicitly), so
   *  these exist to let a run be pinned without a code change. */
  model: string | undefined
}

const PROVIDERS: LiveProvider[] = [
  { name: "groq", key: GROQ_KEY, model: process.env.GROQ_MODEL },
  { name: "gemini", key: GEMINI_KEY, model: process.env.GEMINI_MODEL },
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

      const llm = buildCredentialProvider(checked.value)
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

        const trip = await testGenerationRoundTrip(buildCredentialProvider(checked.value), 30_000)
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
      const llm = buildCredentialProvider(checked.value)

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
