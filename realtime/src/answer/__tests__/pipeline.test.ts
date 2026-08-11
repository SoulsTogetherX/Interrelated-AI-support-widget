//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { answerQuestion, AnswerSchemaError, REFUSAL_TEXT, NOTHING_VERIFIED_TEXT } from "@/answer/pipeline"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { MockLLMProvider } from "@providers/llm/mock"
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

function scriptedAnswer(claims: ReadonlyArray<{ text: string; chunkId: string; quote: string }>): string {
  return JSON.stringify({ claims })
}

async function seed(): Promise<void> {
  orgId = newId("org")
  await db.insertInto("organizations").values({ id: orgId, name: "Pipeline Co" }).execute()
  const sourceId = newId("src")
  await db.insertInto("sources").values({
    id: sourceId, org_id: orgId, kind: "url", location: "https://pipeline.example.com",
  }).execute()
  const documentId = newId("doc")
  await db.insertInto("documents").values({
    id: documentId, org_id: orgId, source_id: sourceId,
    url: "https://pipeline.example.com/policies", title: "Policies",
    content_hash: "d".repeat(64),
  }).execute()

  const texts = [REFUND_TEXT, SHIPPING_TEXT]
  const vectors = await embedder.embed(texts)
  const ids = [newId("chk"), newId("chk")]
  refundChunkId = ids[0]!
  shippingChunkId = ids[1]!
  await db.insertInto("chunks").values(texts.map((text, i) => ({
    id: ids[i]!, org_id: orgId, document_id: documentId, ord: i,
    heading_path: i === 0 ? "Policies > Refunds" : "Policies > Shipping",
    text, token_count: Math.ceil(text.length / 4), char_start: null, char_end: null,
  }))).execute()
  await db.insertInto("chunk_embeddings").values(texts.map((_, i) => ({
    chunk_id: ids[i]!, org_id: orgId, model: embedder.model, dim: embedder.dim,
    embedding: toPgvector(padVector(vectors[i]!)),
  }))).execute()
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
    const llm = new MockLLMProvider([{
      text: scriptedAnswer([{
        text: "Refunds take five business days.",
        chunkId: refundChunkId,
        quote: "within five business days",
      }]),
    }])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db, embedder, llm, orgId,
      visitorId: "vis-e2e", question: REFUND_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(false)
    expect(result.content).toBe("Refunds take five business days.")
    expect(result.ttftMs).not.toBeNull()
    expect(result.claims).toHaveLength(1)
    expect(result.claims[0]!.verdict.status).toBe("verified")

    // Events arrive in SSE order with the citation attached to the claim.
    expect(events.map((e) => e.type)).toEqual(["meta", "claim", "done"])
    const claimEvent = events[1] as Extract<AnswerEvent, { type: "claim" }>
    expect(claimEvent.url).toBe("https://pipeline.example.com/policies")
    expect(claimEvent.headingPath).toBe("Policies > Refunds")
    expect(events[2]).toEqual({ type: "done", claimsTotal: 1, claimsShown: 1 })

    // Persistence: visitor + assistant rows, the verified citation with its
    // span, and a bumped conversation.
    const messages = await db.selectFrom("messages")
      .selectAll().where("conversation_id", "=", result.conversationId)
      .orderBy("created_at").orderBy("id").execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor", "assistant"])
    const assistant = messages[1]!
    expect(assistant.id).toBe(result.messageId)
    expect(assistant.model).toBe("mock-llm")
    expect(assistant.refused).toBe(false)
    expect(Number(assistant.retrieval_score)).toBeLessThan(0.1)
    expect(assistant.ttft_ms).not.toBeNull()
    expect(assistant.total_ms).not.toBeNull()

    const citations = await db.selectFrom("message_citations")
      .selectAll().where("message_id", "=", result.messageId).execute()
    expect(citations).toHaveLength(1)
    expect(citations[0]!.verdict).toBe("verified")
    expect(citations[0]!.url).toBe("https://pipeline.example.com/policies")
    const span = REFUND_TEXT.slice(citations[0]!.span_start!, citations[0]!.span_end!)
    expect(span).toBe("within five business days")
  })

  it("strips the unverifiable claim and stores BOTH verdicts", async () => {
    const llm = new MockLLMProvider([{
      text: scriptedAnswer([
        { text: "Kept.", chunkId: refundChunkId, quote: "within five business days" },
        { text: "Stripped.", chunkId: refundChunkId, quote: "refunds are instant and unconditional" },
      ]),
    }])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db, embedder, llm, orgId,
      visitorId: "vis-strip", question: REFUND_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.content).toBe("Kept.")
    expect(events.at(-1)).toEqual({ type: "done", claimsTotal: 2, claimsShown: 1 })

    const citations = await db.selectFrom("message_citations")
      .select(["ord", "verdict", "claim_text"])
      .where("message_id", "=", result.messageId).orderBy("ord").execute()
    expect(citations.map((c) => c.verdict)).toEqual(["verified", "quote_not_found"])
    expect(citations[1]!.claim_text).toBe("Stripped.")
  })

  it("falls back — refused=false, strip rate 100% — when nothing verifies", async () => {
    const llm = new MockLLMProvider([{
      text: scriptedAnswer([
        { text: "Invented.", chunkId: shippingChunkId, quote: "shipping is always free" },
      ]),
    }])
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db, embedder, llm, orgId,
      visitorId: "vis-allstrip", question: SHIPPING_TEXT,
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(false)
    expect(result.content).toBe(NOTHING_VERIFIED_TEXT)
    expect(events.map((e) => e.type)).toEqual(["meta", "refusal", "done"])
    // The stripped claim is still on record — that IS the strip-rate data.
    const citations = await db.selectFrom("message_citations")
      .select("verdict").where("message_id", "=", result.messageId).execute()
    expect(citations.map((c) => c.verdict)).toEqual(["quote_not_found"])
  })

  it("refuses off-corpus questions BEFORE any model call", async () => {
    const llm = new MockLLMProvider([]) // any call would throw "exhausted"
    const events: AnswerEvent[] = []
    const result = await answerQuestion({
      db, embedder, llm, orgId,
      visitorId: "vis-refuse", question: "What is the airspeed of an unladen swallow?",
      onEvent: (e) => events.push(e),
    })

    expect(result.refused).toBe(true)
    expect(result.content).toBe(REFUSAL_TEXT)
    expect(llm.calls).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(["meta", "refusal", "done"])

    const assistant = await db.selectFrom("messages")
      .selectAll().where("id", "=", result.messageId).executeTakeFirstOrThrow()
    expect(assistant.refused).toBe(true)
    expect(assistant.model).toBeNull()
    // The gate signal is recorded even on refusals — threshold tuning needs
    // exactly these rows.
    expect(Number(assistant.retrieval_score)).toBeGreaterThan(0.75)
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
      db, embedder, llm, orgId, visitorId: "vis-retry", question: REFUND_TEXT,
    })

    expect(result.content).toBe("Recovered.")
    expect(llm.calls).toHaveLength(2)
    // The retry request replays the failure and names the problem.
    const retryMessages = llm.calls[1]!.messages
    expect(retryMessages.at(-2)).toEqual({
      role: "assistant", content: "Sure! Here's my answer as prose, not JSON.",
    })
    expect(retryMessages.at(-1)!.content).toContain("rejected by the JSON validator")
  })

  it("throws AnswerSchemaError after the second failure and persists NO assistant row", async () => {
    const llm = new MockLLMProvider([
      { text: "garbage one" },
      { text: "garbage two" },
    ])
    const events: AnswerEvent[] = []
    let conversationId: string | undefined
    await expect(
      answerQuestion({
        db, embedder, llm, orgId, visitorId: "vis-fail", question: REFUND_TEXT,
        onEvent: (e) => {
          events.push(e)
          if (e.type === "meta") conversationId = e.conversationId
        },
      }),
    ).rejects.toThrow(AnswerSchemaError)

    // The question survives; the failed answer does not.
    const messages = await db.selectFrom("messages")
      .select("role").where("conversation_id", "=", conversationId!).execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor"])
  })

  it("continues an existing conversation and rejects a foreign org's", async () => {
    const llm = new MockLLMProvider([
      { text: scriptedAnswer([{ text: "A.", chunkId: refundChunkId, quote: "within five business days" }]) },
      { text: scriptedAnswer([{ text: "B.", chunkId: refundChunkId, quote: "Refunds are processed" }]) },
    ])
    const first = await answerQuestion({
      db, embedder, llm, orgId, visitorId: "vis-cont", question: REFUND_TEXT,
    })
    const second = await answerQuestion({
      db, embedder, llm, orgId, visitorId: "vis-cont", question: REFUND_TEXT,
      conversationId: first.conversationId,
    })
    expect(second.conversationId).toBe(first.conversationId)
    const messages = await db.selectFrom("messages")
      .select("role").where("conversation_id", "=", first.conversationId).execute()
    expect(messages).toHaveLength(4)

    // Cross-tenant guard: another org cannot append to this thread.
    const otherOrg = newId("org")
    await db.insertInto("organizations").values({ id: otherOrg, name: "Intruder Co" }).execute()
    await expect(
      answerQuestion({
        db, embedder, llm, orgId: otherOrg, visitorId: "vis-evil",
        question: "hello", conversationId: first.conversationId,
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
})

describe.skipIf(DB_CONFIGURED)("answer pipeline (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})

void pool
//#endregion
