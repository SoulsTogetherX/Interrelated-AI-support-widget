//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import {
  answerQuestion,
  AnswerSchemaError,
  REFUSAL_TEXT,
  NOTHING_VERIFIED_TEXT,
} from "@/answer/pipeline"
import { requestHandoff } from "@/handoff/escalate"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { MockLLMProvider } from "@providers/llm/mock"
import { LLMHttpError } from "@providers/llm/http"
import type { AnswerEvent } from "@shared/grounding/events"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"
//#endregion

//#region Test Setup
// The first suite where the ENTIRE answer path runs against real Postgres:
// retrieve → gate → prompt → mock LLM → parse → verify → strip → persist →
// events. Same gating as the other integration suites.
//
// Mock embeddings make gating controllable: a question IDENTICAL to a
// chunk's text lands at distance ~0 (passes the gate); any other text is
// an uncorrelated vector at distance ~1.0 (refused at the 0.75 default).
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

const embedder = new MockEmbeddingProvider()

const REFUND_TEXT = "Refunds are processed within five business days of the request."
const SHIPPING_TEXT = "International shipping takes up to two weeks after dispatch."

let orgId: string
let refundChunkId: string
let shippingChunkId: string

function scriptedAnswer(
  claims: ReadonlyArray<{ text: string; chunkId: string; quote: string }>,
): string {
  return JSON.stringify({ claims })
}

async function seed(): Promise<void> {
  orgId = newId("org")
  await db.insertInto("organizations").values({ id: orgId, name: "Pipeline Co" }).execute()
  const sourceId = newId("src")
  await db
    .insertInto("sources")
    .values({
      id: sourceId,
      org_id: orgId,
      kind: "url",
      location: "https://pipeline.example.com",
    })
    .execute()
  const documentId = newId("doc")
  await db
    .insertInto("documents")
    .values({
      id: documentId,
      org_id: orgId,
      source_id: sourceId,
      url: "https://pipeline.example.com/policies",
      title: "Policies",
      content_hash: "d".repeat(64),
    })
    .execute()

  const texts = [REFUND_TEXT, SHIPPING_TEXT]
  const vectors = await embedder.embed(texts)
  const ids = [newId("chk"), newId("chk")]
  refundChunkId = ids[0]!
  shippingChunkId = ids[1]!
  await db
    .insertInto("chunks")
    .values(
      texts.map((text, i) => ({
        id: ids[i],
        org_id: orgId,
        document_id: documentId,
        ord: i,
        heading_path: i === 0 ? "Policies > Refunds" : "Policies > Shipping",
        text,
        token_count: Math.ceil(text.length / 4),
        char_start: null,
        char_end: null,
      })),
    )
    .execute()
  await db
    .insertInto("chunk_embeddings")
    .values(
      texts.map((_, i) => ({
        chunk_id: ids[i],
        org_id: orgId,
        model: embedder.model,
        dim: embedder.dim,
        embedding: toPgvector(padVector(vectors[i])),
      })),
    )
    .execute()
}
//#endregion

describe.skipIf(!DB_CONFIGURED)("answer pipeline", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
    await seed()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.destroy()
  })

  it("answers a grounded question end to end — persistence, citations, events", async () => {
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          {
            text: "Refunds take five business days.",
            chunkId: refundChunkId,
            quote: "within five business days",
          },
        ]),
      },
    ])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-e2e",
      question: REFUND_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(false)
    expect(result.content).toBe("Refunds take five business days.")
    expect(result.ttftMs).not.toBeNull()
    expect(result.claims).toHaveLength(1)
    expect(result.claims[0].verdict.status).toBe("verified")

    // Events arrive in SSE order with the citation attached to the claim.
    expect(events.map((e) => e.type)).toEqual(["meta", "claim", "done"])
    const claimEvent = events[1] as Extract<AnswerEvent, { type: "claim" }>
    expect(claimEvent.url).toBe("https://pipeline.example.com/policies")
    expect(claimEvent.headingPath).toBe("Policies > Refunds")
    expect(events[2]).toEqual({ type: "done", claimsTotal: 1, claimsShown: 1 })

    // Persistence: visitor + assistant rows, the verified citation with its
    // span, and a bumped conversation.
    const messages = await db
      .selectFrom("messages")
      .selectAll()
      .where("conversation_id", "=", result.conversationId)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor", "assistant"])
    const assistant = messages[1]
    expect(assistant.id).toBe(result.messageId)
    expect(assistant.model).toBe("mock-llm")
    expect(assistant.refused).toBe(false)
    expect(Number(assistant.retrieval_score)).toBeLessThan(0.1)
    expect(assistant.ttft_ms).not.toBeNull()
    expect(assistant.total_ms).not.toBeNull()

    const citations = await db
      .selectFrom("message_citations")
      .selectAll()
      .where("message_id", "=", result.messageId)
      .execute()
    expect(citations).toHaveLength(1)
    expect(citations[0].verdict).toBe("verified")
    expect(citations[0].url).toBe("https://pipeline.example.com/policies")
    const span = REFUND_TEXT.slice(citations[0].span_start!, citations[0].span_end!)
    expect(span).toBe("within five business days")
  })

  it("strips the unverifiable claim and stores BOTH verdicts", async () => {
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "Kept.", chunkId: refundChunkId, quote: "within five business days" },
          {
            text: "Stripped.",
            chunkId: refundChunkId,
            quote: "refunds are instant and unconditional",
          },
        ]),
      },
    ])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-strip",
      question: REFUND_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.content).toBe("Kept.")
    expect(events.at(-1)).toEqual({ type: "done", claimsTotal: 2, claimsShown: 1 })

    const citations = await db
      .selectFrom("message_citations")
      .select(["ord", "verdict", "claim_text"])
      .where("message_id", "=", result.messageId)
      .orderBy("ord")
      .execute()
    expect(citations.map((c) => c.verdict)).toEqual(["verified", "quote_not_found"])
    expect(citations[1].claim_text).toBe("Stripped.")
  })

  it("falls back — refused=false, strip rate 100% — when nothing verifies", async () => {
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "Invented.", chunkId: shippingChunkId, quote: "shipping is always free" },
        ]),
      },
    ])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-allstrip",
      question: SHIPPING_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(false)
    expect(result.content).toBe(NOTHING_VERIFIED_TEXT)
    expect(events.map((e) => e.type)).toEqual(["meta", "refusal", "done"])
    // The stripped claim is still on record — that IS the strip-rate data.
    const citations = await db
      .selectFrom("message_citations")
      .select("verdict")
      .where("message_id", "=", result.messageId)
      .execute()
    expect(citations.map((c) => c.verdict)).toEqual(["quote_not_found"])
  })

  it("refuses off-corpus questions BEFORE any model call", async () => {
    const llm = new MockLLMProvider([]) // any call would throw "exhausted"
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-refuse",
      question: "What is the airspeed of an unladen swallow?",
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(true)
    expect(result.content).toBe(REFUSAL_TEXT)
    expect(llm.calls).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(["meta", "refusal", "done"])

    const assistant = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(assistant.refused).toBe(true)
    expect(assistant.model).toBeNull()
    // The gate signal is recorded even on refusals — threshold tuning needs
    // exactly these rows.
    expect(Number(assistant.retrieval_score)).toBeGreaterThan(0.75)
  })

  it("records the provider's reported token usage on the answer", async () => {
    // M5.2: cost per 1k answers is built on these two columns, so the
    // pipeline must carry the provider's own numbers through rather than
    // estimating from text length. The mock reports usage the way a real
    // provider does.
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "Metered.", chunkId: refundChunkId, quote: "within five business days" },
        ]),
        usage: { inputTokens: 1234, outputTokens: 56 },
      },
    ])
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-usage",
      question: REFUND_TEXT,
    })

    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 56 })
    const assistant = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(assistant.input_tokens).toBe(1234)
    expect(assistant.output_tokens).toBe(56)
  })

  it("SUMS tokens across the retry — a retried answer really did cost twice", async () => {
    // The interesting half of the cost story. Recording only the successful
    // attempt would make schema violations look free, which is exactly
    // backwards: the reason the violation rate is a metric at all is that
    // failing the contract costs the tenant money.
    const llm = new MockLLMProvider([
      { text: "prose, not JSON", usage: { inputTokens: 1000, outputTokens: 20 } },
      {
        text: scriptedAnswer([
          { text: "Recovered.", chunkId: refundChunkId, quote: "within five business days" },
        ]),
        usage: { inputTokens: 1100, outputTokens: 40 },
      },
    ])
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-usage-retry",
      question: REFUND_TEXT,
    })

    expect(result.usage).toEqual({ inputTokens: 2100, outputTokens: 60 })
    const assistant = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(assistant.input_tokens).toBe(2100)
  })

  it("leaves tokens NULL when the provider reports none, and on a refusal", async () => {
    // Two different silences, both of which must stay null rather than
    // becoming a zero the cost metric would average in as free: a provider
    // that omits usage on streams, and a gate refusal that never ran a
    // model at all.
    const quiet = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "Unmetered.", chunkId: refundChunkId, quote: "within five business days" },
        ]),
      },
    ])
    const answered = await answerQuestion({
      db,
      embedder,
      llm: quiet,
      orgId,
      visitorId: "vis-unmetered",
      question: REFUND_TEXT,
    })
    expect(answered.usage).toBeNull()
    const unmetered = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", answered.messageId)
      .executeTakeFirstOrThrow()
    expect(unmetered.input_tokens).toBeNull()
    expect(unmetered.output_tokens).toBeNull()
    // A model DID run here and held the contract, so violations is 0 —
    // the distinction the column exists for (M7.10).
    expect(unmetered.schema_violations).toBe(0)

    const refused = await answerQuestion({
      db,
      embedder,
      llm: new MockLLMProvider([]),
      orgId,
      visitorId: "vis-refuse-usage",
      question: "Who won the 1994 world cup?",
    })
    expect(refused.refused).toBe(true)
    const refusalRow = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", refused.messageId)
      .executeTakeFirstOrThrow()
    expect(refusalRow.input_tokens).toBeNull()
    // Same argument, same answer: no model ran, so "how many times did it
    // break the contract" has no value — NULL, never 0, which would pad the
    // violation rate's denominator with answers nobody generated.
    expect(refusalRow.schema_violations).toBeNull()
    expect(refusalRow.model).toBeNull()
  })

  it("stays out of a handed-off conversation but keeps the question", async () => {
    // M4.1: once a human owns the thread, the bot must not answer over
    // them — and must not spend the tenant's tokens trying. The visitor's
    // message still persists, because it is precisely what the waiting
    // agent needs to read.
    const opening = new MockLLMProvider([
      {
        text: scriptedAnswer([
          {
            text: "Refunds take five business days.",
            chunkId: refundChunkId,
            quote: "within five business days",
          },
        ]),
      },
    ])
    const first = await answerQuestion({
      db,
      embedder,
      llm: opening,
      orgId,
      visitorId: "vis-handoff",
      question: "How long do refunds take?",
    })

    const escalated = await requestHandoff(db, {
      orgId,
      conversationId: first.conversationId,
      visitorId: "vis-handoff",
      reason: "visitor_request",
    })
    expect(escalated.ok).toBe(true)

    const llm = new MockLLMProvider([]) // any call would throw "exhausted"
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-handoff",
      conversationId: first.conversationId,
      question: "Actually, can someone check my order?",
      onEvent: (e) => events.push(e),
    })

    expect(llm.calls).toHaveLength(0)
    expect(result.handoff).toBe("pending")
    expect(events.map((e) => e.type)).toEqual(["meta", "handoff", "done"])
    // The question is history; no assistant row was invented to answer it.
    const rows = await db
      .selectFrom("messages")
      .selectAll()
      .where("conversation_id", "=", first.conversationId)
      .orderBy("created_at")
      .execute()
    expect(rows.at(-1)?.role).toBe("visitor")
    expect(rows.at(-1)?.content).toBe("Actually, can someone check my order?")
    expect(rows.filter((r) => r.id === result.messageId)).toHaveLength(0)
  })

  it("retries once on a schema violation, feeding the errors back", async () => {
    const good = scriptedAnswer([
      { text: "Recovered.", chunkId: refundChunkId, quote: "within five business days" },
    ])
    const llm = new MockLLMProvider([
      { text: "Sure! Here's my answer as prose, not JSON." },
      { text: good },
    ])
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-retry",
      question: REFUND_TEXT,
    })

    expect(result.content).toBe("Recovered.")
    expect(llm.calls).toHaveLength(2)
    // The retry request replays the failure and names the problem.
    const retryMessages = llm.calls[1].messages
    expect(retryMessages.at(-2)).toEqual({
      role: "assistant",
      content: "Sure! Here's my answer as prose, not JSON.",
    })
    expect(retryMessages.at(-1)!.content).toContain("rejected by the JSON validator")

    // M7.10: the violation is COUNTED, not just handled. Without this the
    // rate the provider-comparison table reports could only ever be zero.
    const row = await db
      .selectFrom("messages")
      .select(["schema_violations", "model"])
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(row.schema_violations).toBe(1)
    expect(row.model).not.toBeNull()
  })

  it("throws AnswerSchemaError after the second failure and persists NO assistant row", async () => {
    const llm = new MockLLMProvider([{ text: "garbage one" }, { text: "garbage two" }])
    const events: AnswerEvent[] = []
    let conversationId: string | undefined
    const before = await db
      .selectFrom("usage_daily")
      .select("answers")
      .where("org_id", "=", orgId)
      .executeTakeFirst()
    const answersBefore = Number(before?.answers ?? 0)
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId,
        visitorId: "vis-fail",
        question: REFUND_TEXT,
        onEvent: (e) => {
          events.push(e)
          if (e.type === "meta") conversationId = e.conversationId
        },
      }),
    ).rejects.toThrow(AnswerSchemaError)

    // The question survives; the failed answer does not.
    const messages = await db
      .selectFrom("messages")
      .select("role")
      .where("conversation_id", "=", conversationId!)
      .execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor"])

    // M7.10: with no assistant row there is nothing to hang a violation on,
    // which is exactly why the org's day counts it. A provider failing
    // systematically must not read as a provider that never fails.
    const usage = await db
      .selectFrom("usage_daily")
      .select(["schema_failures", "answers"])
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow()
    expect(Number(usage.schema_failures)).toBe(1)
    // And it does NOT spend the tenant's quota: charging a customer's plan
    // for a question the product failed to answer would let a misbehaving
    // model burn their allowance.
    expect(Number(usage.answers)).toBe(answersBefore)
  })

  it("continues an existing conversation and rejects a foreign org's", async () => {
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "A.", chunkId: refundChunkId, quote: "within five business days" },
        ]),
      },
      {
        text: scriptedAnswer([
          { text: "B.", chunkId: refundChunkId, quote: "Refunds are processed" },
        ]),
      },
    ])
    const first = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-cont",
      question: REFUND_TEXT,
    })
    const second = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-cont",
      question: REFUND_TEXT,
      conversationId: first.conversationId,
    })
    expect(second.conversationId).toBe(first.conversationId)
    const messages = await db
      .selectFrom("messages")
      .select("role")
      .where("conversation_id", "=", first.conversationId)
      .execute()
    expect(messages).toHaveLength(4)

    // Cross-tenant guard: another org cannot append to this thread.
    const otherOrg = newId("org")
    await db.insertInto("organizations").values({ id: otherOrg, name: "Intruder Co" }).execute()
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId: otherOrg,
        visitorId: "vis-evil",
        question: "hello",
        conversationId: first.conversationId,
      }),
    ).rejects.toThrow(/conversation not found/)
    await db.deleteFrom("organizations").where("id", "=", otherOrg).execute()
  })

  it("rejects a blank question before touching the database", async () => {
    const llm = new MockLLMProvider([])
    await expect(
      answerQuestion({ db, embedder, llm, orgId, visitorId: "v", question: "   " }),
    ).rejects.toThrow(/blank/)
  })

  //#region Surviving a provider's rate limit (M7.7)
  // The failure a free tier produces routinely — 30 RPM at Groq, 10–15 at
  // Gemini — and until now it reached the visitor as the same opaque error a
  // real outage gives. `retry: { sleep }` swallows the backoff so these run
  // instantly; the policy's own arithmetic is pinned in retry.test.ts.
  const instant = { sleep: async () => {}, random: () => 0.5 }

  it("absorbs a 429 and answers on the retry — nothing was shown, so nothing is lost", async () => {
    // The property that makes retrying safe here at all: no generated text
    // reaches the visitor until it is verified, so a call that died has
    // shown nobody anything.
    const llm = new MockLLMProvider([
      {
        text: "",
        error: new LLMHttpError({
          provider: "groq",
          status: 429,
          detail: "rate limit",
          retryAfterMs: 50,
        }),
      },
      {
        text: scriptedAnswer([
          {
            text: "Refunds take five business days.",
            chunkId: refundChunkId,
            quote: "within five business days",
          },
        ]),
      },
    ])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-429",
      question: REFUND_TEXT,
      retry: instant,
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(false)
    expect(result.content).toBe("Refunds take five business days.")
    // The visitor's stream never mentions it: meta → claim → done, exactly
    // as on a first-try answer.
    expect(events.map((e) => e.type)).toEqual(["meta", "claim", "done"])
    // TTFT comes from the attempt that actually produced tokens — the
    // refused call never streamed one, so it contributes nothing to measure.
    expect(result.ttftMs).not.toBeNull()
    const row = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(row.refused).toBe(false)
  })

  it("gives up after the policy's attempts and lets the provider's error through", async () => {
    const rateLimited = new LLMHttpError({
      provider: "groq",
      status: 429,
      detail: "rate limit",
      retryAfterMs: 50,
    })
    const llm = new MockLLMProvider([
      { text: "", error: rateLimited },
      { text: "", error: rateLimited },
      { text: "", error: rateLimited },
    ])
    // The route turns this into its one opaque error event; what matters
    // here is that the ORIGINAL error survives for the log, and that no
    // assistant row was written for an answer that never happened.
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId,
        visitorId: "vis-429-hard",
        question: REFUND_TEXT,
        retry: instant,
      }),
    ).rejects.toMatchObject({ name: "LLMHttpError", status: 429 })
  })

  it("does NOT retry a wrong key — one attempt, then the truth", async () => {
    // A 401 is a configuration fact. Retrying it spends the visitor's
    // patience to reach the identical failure, and the mock proves the
    // count: a second call would throw "script exhausted" instead.
    const llm = new MockLLMProvider([
      {
        text: "",
        error: new LLMHttpError({ provider: "groq", status: 401, detail: "invalid api key" }),
      },
    ])
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId,
        visitorId: "vis-401",
        question: REFUND_TEXT,
        retry: instant,
      }),
    ).rejects.toMatchObject({ status: 401 })
    expect(llm.calls).toHaveLength(1)
  })

  it("falls back to a SECOND provider once the first is spent, and says whose answer it is", async () => {
    const down = new LLMHttpError({ provider: "groq", status: 503, detail: "service unavailable" })
    const primary = new MockLLMProvider([
      { text: "", error: down },
      { text: "", error: down },
      { text: "", error: down },
    ])
    // A DISTINGUISHABLE name: with both mocks called "mock-llm" this
    // assertion passed while the pipeline was still recording the primary's
    // name — a vacuous green the live run caught and this fixes.
    const fallback = new MockLLMProvider(
      [
        {
          text: scriptedAnswer([
            {
              text: "Refunds take five business days.",
              chunkId: refundChunkId,
              quote: "within five business days",
            },
          ]),
        },
      ],
      { model: "standby-model" },
    )

    const result = await answerQuestion({
      db,
      embedder,
      llm: primary,
      llmFallback: fallback,
      orgId,
      visitorId: "vis-fallback",
      question: REFUND_TEXT,
      retry: instant,
    })

    expect(result.content).toBe("Refunds take five business days.")
    // The primary spent every attempt it was allowed; the fallback got ONE,
    // because by now the visitor has already waited out a whole budget.
    expect(primary.calls).toHaveLength(3)
    expect(fallback.calls).toHaveLength(1)
    // The row names the model that actually answered — a transcript that
    // credited the configured provider for a standby's answer would make
    // the by-model metrics quietly wrong.
    const row = await db
      .selectFrom("messages")
      .select("model")
      .where("id", "=", result.messageId)
      .executeTakeFirstOrThrow()
    expect(row.model).toBe("standby-model")
    expect(row.model).not.toBe(primary.model)
  })

  it("rethrows the FIRST provider's error when the fallback fails too", async () => {
    const primaryErr = new LLMHttpError({ provider: "groq", status: 429, detail: "rate limit" })
    const primary = new MockLLMProvider([
      { text: "", error: primaryErr },
      { text: "", error: primaryErr },
      { text: "", error: primaryErr },
    ])
    const fallback = new MockLLMProvider([
      {
        text: "",
        error: new LLMHttpError({ provider: "gemini", status: 503, detail: "unavailable" }),
      },
    ])
    // The primary is the configured path, so its failure is the finding;
    // the standby's is a footnote (it gets logged, not thrown).
    await expect(
      answerQuestion({
        db,
        embedder,
        llm: primary,
        llmFallback: fallback,
        orgId,
        visitorId: "vis-both-down",
        question: REFUND_TEXT,
        retry: instant,
      }),
    ).rejects.toMatchObject({ status: 429 })
  })

  it("never reaches for the fallback when the primary simply answered", async () => {
    const primary = new MockLLMProvider([
      {
        text: scriptedAnswer([
          {
            text: "Refunds take five business days.",
            chunkId: refundChunkId,
            quote: "within five business days",
          },
        ]),
      },
    ])
    const fallback = new MockLLMProvider([]) // any call would throw "exhausted"
    const result = await answerQuestion({
      db,
      embedder,
      llm: primary,
      llmFallback: fallback,
      orgId,
      visitorId: "vis-no-fallback",
      question: REFUND_TEXT,
      retry: instant,
    })
    expect(result.refused).toBe(false)
    expect(fallback.calls).toHaveLength(0)
  })

  it("stops retrying when the visitor closes the tab", async () => {
    const controller = new AbortController()
    const llm = new MockLLMProvider([
      {
        text: "",
        error: new LLMHttpError({
          provider: "groq",
          status: 429,
          detail: "rate limit",
          retryAfterMs: 10,
        }),
      },
      {
        text: scriptedAnswer([
          { text: "unreachable", chunkId: refundChunkId, quote: "within five business days" },
        ]),
      },
    ])
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId,
        visitorId: "vis-gone",
        question: REFUND_TEXT,
        signal: controller.signal,
        // Aborted DURING the backoff: the retry that would have succeeded
        // must not happen, because the abort exists to stop the spending.
        retry: {
          sleep: async () => {
            controller.abort()
          },
          random: () => 0.5,
        },
      }),
    ).rejects.toMatchObject({ status: 429 })
    expect(llm.calls).toHaveLength(1)
  })
  //#endregion

  //#region The deadline (M8.4)
  // The failure the retry policy CANNOT see: a provider that accepts the
  // connection and never fails — no error, no retry, nothing bounding the
  // wait. M8.3 measured one first token arriving after 310 seconds, held
  // open because Node's fetch has no default timeout and the only abort was
  // the visitor closing the tab. The hanging fixture below is that
  // provider: it resolves ONLY when the request's signal aborts, which is
  // exactly what a real fetch does when its socket is quietly held.

  class HangingLLMProvider {
    readonly model = "hanging-llm"
    calls = 0
    // eslint-disable-next-line require-yield
    async *stream(request: { signal?: AbortSignal }): AsyncGenerator<never> {
      this.calls++
      await new Promise<never>((_, reject) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a real fetch rejects with the signal's reason verbatim; the fixture must too
        const fail = () => reject(request.signal?.reason ?? new Error("aborted"))
        if (request.signal?.aborted) return fail()
        request.signal?.addEventListener("abort", fail, { once: true })
      })
    }
  }

  it("cuts off a provider that never answers at the deadline — once, with the question kept", async () => {
    const llm = new HangingLLMProvider()
    let conversationId: string | undefined
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        orgId,
        visitorId: "vis-hang",
        question: REFUND_TEXT,
        deadlineMs: 60,
        onEvent: (e) => {
          if (e.type === "meta") conversationId = e.conversationId
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })

    // Called exactly ONCE: a TimeoutError is an abort to retry.ts's
    // classification, so the policy must not spend a second attempt on a
    // deadline that has already passed.
    expect(llm.calls).toBe(1)
    // The visitor's question survives — persisted before retrieval, the
    // same guarantee every other failure path holds — and no assistant row
    // exists for an answer that never arrived.
    const messages = await db
      .selectFrom("messages")
      .select("role")
      .where("conversation_id", "=", conversationId!)
      .execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor"])
  })

  it("never kills an answer that arrives in time", async () => {
    // The composed signal must be invisible on the happy path: a scripted
    // mock answers instantly, far inside a generous deadline.
    const llm = new MockLLMProvider([
      {
        text: scriptedAnswer([
          {
            text: "Refunds take five business days.",
            chunkId: refundChunkId,
            quote: "within five business days",
          },
        ]),
      },
    ])
    const result = await answerQuestion({
      db,
      embedder,
      llm,
      orgId,
      visitorId: "vis-in-time",
      question: REFUND_TEXT,
      deadlineMs: 5_000,
    })
    expect(result.refused).toBe(false)
    expect(result.content).toBe("Refunds take five business days.")
  })

  it("does not reach for the platform fallback after the deadline", async () => {
    // The case where checking only the VISITOR's signal would go wrong: by
    // the time the deadline has fired the visitor's wait is spent, and
    // running the standby would bill the platform for an answer nobody will
    // be shown. The fallback's script staying unconsumed is the proof.
    const llm = new HangingLLMProvider()
    const fallback = new MockLLMProvider([
      {
        text: scriptedAnswer([
          { text: "unreachable", chunkId: refundChunkId, quote: "within five business days" },
        ]),
      },
    ])
    await expect(
      answerQuestion({
        db,
        embedder,
        llm,
        llmFallback: fallback,
        orgId,
        visitorId: "vis-hang-fb",
        question: REFUND_TEXT,
        deadlineMs: 60,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect(llm.calls).toBe(1)
    expect(fallback.calls).toHaveLength(0)
  })
  //#endregion
})

describe.skipIf(DB_CONFIGURED)("answer pipeline (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})

void pool
//#endregion
