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
//   XAI_API_KEY=...       npm test   (PAID — no card-free tier, see below)
//
// Most are the SAME variables .env.example already documents for
// `npm run ask --llm groq|gemini` and for server-level LLM_PROVIDER — one
// name per provider across the repo, so pasting a key into .env lights up
// the CLI, the server, and this suite at once. Absent keys → these cases
// skip and the suite still asserts (below) that the keyless default is
// what CI is running, so "gated off" can never be mistaken for "passing".
//
// XAI_API_KEY (M8.6) is the one exception: nothing else in the repo reads
// it. It exists because the GENERIC OpenAI-compatible adapter (§2.4.5g) —
// the row of the plan's table that covers OpenRouter, Together, vLLM and
// LM Studio — had no dedicated key of its own and so had never met a real
// remote endpoint (Groq shares the code path, but through its preset, and
// its cases had never run either). api.x.ai is an ordinary hosted
// OpenAI-compatible endpoint, so an xAI key is what proves that adapter,
// through the exact self-hosted credential shape a tenant would save:
// provider openai_compatible + base URL + explicit model, base URL through
// the PRODUCTION SSRF vet. One sharp edge, observed 2026-08-22: a newly
// created xAI team has NO credits, and until it is funded on console.x.ai
// EVERY endpoint — the models listing included — answers one 403 naming
// that console URL. `GET /v1/api-key` can say the key itself is fine
// (api_key_blocked false) while team_blocked is true, so a red run here
// with that sentence is an unfunded team, not a broken adapter.
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
import type { CredentialInput } from "../validate"
import { decryptProviderKey, encryptProviderKey, keySuffix } from "../vault"
import { buildAnswerMessages, buildRetryMessages } from "@/answer/prompt"
import { ANSWER_JSON_SCHEMA, parseAnswerText } from "@shared/grounding/claims"
import { PADDED_DIM } from "@shared/utils/vectors"
import { LLMHttpError } from "@providers/llm/http"
import { newId } from "@shared/utils/ids"

import type { ChatMessage } from "@providers/llm/types"
import type { RetrievedChunk } from "@/retrieval/search"
//#endregion

//#region Gating
const GROQ_KEY = process.env.GROQ_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const XAI_KEY = process.env.XAI_API_KEY

interface LiveProvider {
  /** Display label for logs and failure sentences. */
  name: string
  /** The schema-union value the Test button would send (§3.3.3) — distinct
   *  from `name` since M8.6, because xAI is not a provider of its own here:
   *  it is the generic openai_compatible shape pointed at a real host. */
  provider: CredentialInput["provider"]
  key: string | undefined
  /** Model override, if the repo's default should be overridden per run —
   *  free-tier model availability moves (the plan says so explicitly), so
   *  these exist to let a run be pinned without a code change. */
  model: string | undefined
  /** Present only for the self-hosted credential shape, where
   *  checkCredentialInput requires it — and vets it for SSRF, which is part
   *  of what this suite then exercises for real. */
  baseUrl?: string
}

const PROVIDERS: LiveProvider[] = [
  { name: "groq", provider: "groq", key: GROQ_KEY, model: process.env.GROQ_MODEL },
  { name: "gemini", provider: "gemini", key: GEMINI_KEY, model: process.env.GEMINI_MODEL },
  // Anthropic (M7.8) needs no special case here, which is the point: the
  // adapter satisfies the same LLMProvider contract, so the same three
  // cases exercise it. The one thing that IS different is money — it has
  // no free tier, so setting ANTHROPIC_API_KEY makes `npm test` cost a
  // fraction of a cent per run, and CI never sets it. The structured-output
  // case is the interesting one for this provider: it is the only forced
  // TOOL CALL in the table, and whether that really constrains the claims
  // contract is a measurement, not an assumption (§2.4.5n).
  {
    name: "anthropic",
    provider: "anthropic",
    key: ANTHROPIC_KEY,
    model: process.env.ANTHROPIC_MODEL,
  },
  // xAI (M8.6) — the generic compat adapter against a real hosted endpoint;
  // the header comment is the full argument. The model must be EXPLICIT
  // (checkCredentialInput refuses the self-hosted shape without one — there
  // is no sane server-side default), so the suite supplies one and lets
  // XAI_MODEL pin a run: the default is xAI's cheap NON-reasoning model,
  // non-reasoning on purpose — a reasoning model spends the answer budget
  // thinking, the trap M7.11 measured on Gemini 3.x (§2.4.5h), and the
  // compat adapter has no thinking-budget knob to bound it with. Model
  // lineups move; with a funded team, GET /v1/models is the truth.
  {
    name: "xai",
    provider: "openai_compatible",
    key: XAI_KEY,
    model: process.env.XAI_MODEL ?? "grok-4-1-fast-non-reasoning",
    baseUrl: "https://api.x.ai/v1",
  },
]

const ANY_KEY = PROVIDERS.some((p) => Boolean(p.key))
//#endregion

//#region Helpers
/** Turns a provider failure into a sentence a human can act on. A 429 on
 *  the free tier is a RATE LIMIT, not a broken adapter, and saying so
 *  saves the next person half an hour. */
function describeFailure(error: unknown): string {
  if (error instanceof LLMHttpError) {
    const retry =
      error.retryAfterMs !== null ? ` (retry in ~${Math.ceil(error.retryAfterMs / 1000)}s)` : ""
    // LLMHttpError.message already carries the provider label and status
    // (§2.4.5f), so it is used verbatim — re-prefixing would double it.
    // The 429 sentence has been wrong twice, in opposite directions, and
    // both live runs are why it now hedges. Until M8.3 it said "re-run in
    // a moment" — then a run met gemini-3.6-flash's 20-generate-per-DAY
    // quota, where a loop cannot succeed. Until M8.6 it said only the
    // per-day quota — then a FRESH key's run tripped the per-MINUTE limit
    // with the suite's own three back-to-back calls (the third answered
    // 429 after ~25s of suite time; a manual call one minute later
    // succeeded), and the per-day advice sent the reader the wrong way.
    // Both limits are real; when the provider's own retry hint is absent,
    // one re-run a minute later is what tells them apart.
    return error.status === 429
      ? `rate limited${retry} — a free tier, not a broken adapter. Generation is limited ` +
          `per MINUTE (this suite's own back-to-back calls can trip it — re-run in a minute) ` +
          `AND per DAY (20/day on gemini-3.6-flash — then only the window's rollover helps). ${error.message}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** One retrieved chunk, shaped exactly as retrieval hands the pipeline, so
 *  the structured-output case below can send the PRODUCTION prompt. */
const REFUND_TEXT = "Refunds are processed within five business days of the request."
const REFUND_CHUNK: RetrievedChunk = {
  chunkId: "chk_00000000000000000000000000000000",
  documentId: "doc_00000000000000000000000000000000",
  url: "https://docs.example/billing/refunds",
  title: "Billing",
  headingPath: "Billing > Refunds",
  text: REFUND_TEXT,
  charStart: 0,
  charEnd: REFUND_TEXT.length,
  score: 0.03,
  denseRank: 1,
  denseDistance: 0.12,
  lexicalRank: 1,
  lexicalScore: 0.5,
}
//#endregion

//#region Live provider cases
for (const provider of PROVIDERS) {
  const enabled = Boolean(provider.key)

  describe.skipIf(!enabled)(`live ${provider.name} credential path`, () => {
    // The exact payload the dashboard's Test button sends (§3.22), through
    // the exact validator the internal API uses — no test-only shortcut.
    // For the compat entry that includes the PRODUCTION url vet on the base
    // URL: assertPublicUrl resolves api.x.ai for real, which is the one part
    // of the credential path no loopback test can run un-mocked.
    const payload = {
      role: "generation" as const,
      provider: provider.provider,
      apiKey: provider.key,
      ...(provider.model !== undefined ? { model: provider.model } : {}),
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    }

    it("accepts a real key and completes a live round-trip", async () => {
      const checked = await checkCredentialInput(payload)
      expect(
        checked.ok,
        checked.ok ? "" : `validation rejected the payload: ${checked.error}`,
      ).toBe(true)
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
      //
      // The prompt is the PRODUCTION one (buildAnswerMessages), not a
      // hand-built stand-in, and that is a fix as much as a fidelity
      // upgrade (M8.6): the previous version's system prompt said "match
      // the provided schema" while providing none — which Gemini and
      // Anthropic survive because responseSchema reaches them NATIVELY
      // (responseJsonSchema; a forced tool), but a json_object provider
      // (Groq, the compat adapter) receives no schema at all and would
      // have been asked to guess the shape. Production never has that
      // bug: SYSTEM_PROMPT states the exact format inline (§3.15.2). The
      // gap stayed latent for five milestones because no key for a
      // json_object provider had ever run this case.
      const checked = await checkCredentialInput(payload)
      expect(checked.ok).toBe(true)
      if (!checked.ok) return
      const llm = buildGenerationProvider(checked.value)

      // One stream, collected the way the pipeline collects it — plus one
      // bounded wait for exactly one failure: a 429 from the per-MINUTE
      // window this suite's own two preceding cases just spent (observed
      // M8.6 on a fresh free-tier key — the third back-to-back generate
      // call answered 429, and a manual call one minute later succeeded).
      // Waiting the window out is the suite fixing its own pacing, not
      // hiding a provider signal: a rate limit says nothing about the
      // claims contract this case measures, and testGenerationRoundTrip
      // has retried the same class since M8.2. A second 429 — or anything
      // else — fails with the full sentence, so a spent DAILY quota still
      // reads as what it is.
      const streamOnce = async (messages: ChatMessage[], allow429Wait: boolean) => {
        const attempt = async () => {
          let text = ""
          let finishReason = ""
          for await (const event of llm.stream({
            messages,
            maxTokens: 300,
            temperature: 0,
            responseSchema: ANSWER_JSON_SCHEMA,
          })) {
            if (event.type === "delta") text += event.text
            if (event.type === "done") finishReason = event.finishReason
          }
          return { text, finishReason }
        }
        try {
          return await attempt()
        } catch (error) {
          if (!allow429Wait || !(error instanceof LLMHttpError) || error.status !== 429) {
            throw new Error(`${provider.name}: ${describeFailure(error)}`, { cause: error })
          }
          const waitMs = error.retryAfterMs ?? 60_000
          console.log(
            `[live] ${provider.name}: 429 mid-suite — waiting ${Math.ceil(waitMs / 1000)}s ` +
              "for the per-minute window this suite's earlier calls spent, then retrying once",
          )
          await new Promise((resolve) => setTimeout(resolve, waitMs))
          try {
            return await attempt()
          } catch (retryError) {
            throw new Error(`${provider.name}: ${describeFailure(retryError)}`, {
              cause: retryError,
            })
          }
        }
      }

      // The pipeline's shape exactly (§3.15.2): one attempt, and on a
      // schema violation ONE retry through the real buildRetryMessages —
      // then the contract must hold. Asserting single-shot compliance was
      // stricter than the product, and a live run showed why that is wrong
      // rather than admirably strict: during a gemini-3.7-flash demand
      // spike (503s bracketing it), a 200 stream died after 10 characters
      // and a manual replication answered perfectly a minute later — the
      // exact transient the pipeline's one retry absorbs. Both outcomes
      // are PRINTED, so the per-provider violation rate stays observable
      // here even when the retry rescues the answer.
      const messages = buildAnswerMessages({
        question: "How long do refunds take?",
        retrieved: [REFUND_CHUNK],
      })
      let { text, finishReason } = await streamOnce(messages, true)
      let parsed = parseAnswerText(text)
      console.log(
        `[live] ${provider.name} structured output: ${parsed.ok ? "valid" : "SCHEMA VIOLATION"}` +
          ` (finish=${finishReason}, ${text.length} chars)` +
          (parsed.ok ? "" : ` — ${parsed.errors.join("; ")}`),
      )
      if (!parsed.ok) {
        const retry = await streamOnce(buildRetryMessages(messages, text, parsed.errors), false)
        text = retry.text
        finishReason = retry.finishReason
        parsed = parseAnswerText(text)
        console.log(
          `[live] ${provider.name} structured output, retry: ${parsed.ok ? "valid" : "SCHEMA VIOLATION"}` +
            ` (finish=${finishReason}, ${text.length} chars)` +
            (parsed.ok ? "" : ` — ${parsed.errors.join("; ")}`),
        )
      }
      expect(
        parsed.ok,
        parsed.ok
          ? ""
          : `${provider.name} violated the claims contract twice — production grants exactly ` +
              `one retry (§3.15.2), so this is the failure a visitor would see: ${parsed.errors.join("; ")}`,
      ).toBe(true)
      if (!parsed.ok) return
      // A model that returns zero claims for answerable context is not a
      // contract violation, but it is worth seeing in the log above.
      expect(Array.isArray(parsed.payload.claims)).toBe(true)
      // 180s, not the siblings' 60: this case may legitimately spend a
      // 60s per-minute wait plus TWO structured calls (the schema retry),
      // and the live suite has watched one such call take 29.4s.
    }, 180_000)
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
      ...(process.env.GEMINI_EMBED_MODEL !== undefined
        ? { model: process.env.GEMINI_EMBED_MODEL }
        : {}),
    })
    expect(checked.ok, checked.ok ? "" : `validation rejected the payload: ${checked.error}`).toBe(
      true,
    )
    if (!checked.ok) return

    const trip = await testEmbeddingRoundTrip(buildEmbeddingProvider(checked.value), 30_000)
    expect(trip.ok, trip.ok ? "" : `round-trip failed: ${trip.error}`).toBe(true)
    if (!trip.ok) return

    expect(trip.dim).toBeGreaterThan(0)
    expect(trip.dim!).toBeLessThanOrEqual(PADDED_DIM)
    console.log(
      `[live] gemini embeddings: ${trip.model} returned ${trip.dim}-d in ${trip.latencyMs}ms`,
    )
  }, 60_000)

  it("embeds a batch in order, and a query differently from a document", async () => {
    // Order is the property the ingest worker bets every chunk on, and the
    // task hint is the reason the adapter bothers with taskType at all: if
    // RETRIEVAL_QUERY and RETRIEVAL_DOCUMENT produced identical vectors,
    // passing them would be theatre.
    const provider = buildEmbeddingProvider({
      role: "embedding",
      provider: "gemini",
      apiKey: GEMINI_KEY,
    })
    const texts = [
      "Refunds are processed within five business days.",
      "Bananas ripen faster in a paper bag.",
    ]
    let asDocuments: number[][]
    let asQuery: number[][]
    try {
      asDocuments = await provider.embed(texts, { task: "document" })
      asQuery = await provider.embed([texts[0]], { task: "query" })
    } catch (error) {
      throw new Error(`gemini: ${describeFailure(error)}`, { cause: error })
    }

    expect(asDocuments).toHaveLength(2)
    const dot = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * b[i], 0)
    // Unit-normalized, as the adapter promises after Matryoshka reduction.
    expect(Math.sqrt(dot(asDocuments[0], asDocuments[0]))).toBeCloseTo(1, 4)
    // Real semantics, unlike the mock: the refund sentence is nearer to its
    // own query embedding than the banana sentence is.
    const own = dot(asQuery[0], asDocuments[0])
    const other = dot(asQuery[0], asDocuments[1])
    expect(own).toBeGreaterThan(other)
    console.log(
      `[live] gemini task types: same-text ${own.toFixed(3)} vs unrelated ${other.toFixed(3)}`,
    )
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
    expect(ANTHROPIC_KEY).toBeUndefined()
    expect(XAI_KEY).toBeUndefined()
  })
})
//#endregion
