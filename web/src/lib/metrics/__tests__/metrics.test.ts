//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/lib/db"
import { getOrgMetrics } from "@/lib/metrics/queries"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// DB-gated like every integration suite here (§9.5): the schema must already
// be migrated — realtime's suite does that in CI's verify job before the web
// steps run.
//
// The fixture is hand-built and small enough that every expected number can
// be computed by reading it: 3 conversations, 4 answers, 5 claims, 2
// handoffs. A metrics layer whose expectations are themselves computed by
// the code under test would prove nothing.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

let orgId: string
let otherOrgId: string
let agentId: string

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60 * 1000)

async function conversation(org: string, visitor: string, at: Date): Promise<string> {
  const id = newId("con")
  await db.insertInto("conversations")
    .values({ id, org_id: org, visitor_id: visitor, created_at: at, last_message_at: at })
    .execute()
  return id
}

async function answer(
  org: string,
  conversationId: string,
  fields: {
    at: Date
    refused?: boolean
    model?: string
    ttft?: number
    total?: number
    content?: string
  },
): Promise<string> {
  const id = newId("msg")
  await db.insertInto("messages").values({
    id,
    conversation_id: conversationId,
    org_id: org,
    role: "assistant",
    content: fields.content ?? "an answer",
    model: fields.model ?? "mock-llm",
    refused: fields.refused ?? false,
    ttft_ms: fields.ttft ?? null,
    total_ms: fields.total ?? null,
    created_at: fields.at,
  }).execute()
  return id
}

async function claim(messageId: string, verdict: "verified" | "quote_not_found" | "unknown_chunk", ord: number): Promise<void> {
  await db.insertInto("message_citations").values({
    message_id: messageId,
    ord,
    chunk_id: newId("chk"),
    claim_text: "a claim",
    quote: "a quote",
    verdict,
    ...(verdict === "verified" ? { span_start: 0, span_end: 7 } : {}),
    url: null,
    heading_path: null,
  }).execute()
}
//#endregion

describe.skipIf(!DB_CONFIGURED)("org metrics", () => {
  beforeAll(async () => {
    orgId = newId("org")
    otherOrgId = newId("org")
    agentId = newId("usr")
    await db.insertInto("organizations").values([
      { id: orgId, name: "Metrics Co" },
      { id: otherOrgId, name: "Other Co" },
    ]).execute()
    await db.insertInto("users").values({
      id: agentId, email_index: `idx_${agentId}`, email_ciphertext: "x", password_hash: "x",
    }).execute()
    await db.insertInto("org_members")
      .values({ org_id: orgId, user_id: agentId, role: "agent" })
      .execute()

    // ── Conversation A: answered twice, never escalated → a deflection.
    const a = await conversation(orgId, "vis_a", minutesAgo(60))
    const a1 = await answer(orgId, a, { at: minutesAgo(59), ttft: 100, total: 400 })
    await claim(a1, "verified", 0)
    await claim(a1, "verified", 1)
    await answer(orgId, a, { at: minutesAgo(58), ttft: 200, total: 800 })

    // ── Conversation B: one refusal, then escalated and answered by a
    // person 5 minutes later.
    const b = await conversation(orgId, "vis_b", minutesAgo(40))
    const b1 = await answer(orgId, b, { at: minutesAgo(39), refused: true, ttft: 300, total: 1200 })
    await claim(b1, "quote_not_found", 0)
    await db.insertInto("handoff_sessions").values({
      id: newId("hnd"),
      org_id: orgId,
      conversation_id: b,
      reason: "visitor_request",
      requested_at: minutesAgo(38),
      status: "closed",
      claimed_at: minutesAgo(35),
      closed_at: minutesAgo(20),
      claimed_by: agentId,
    }).execute()
    // Two agent turns; only the FIRST counts toward response time.
    await db.insertInto("messages").values([
      {
        id: newId("msg"), conversation_id: b, org_id: orgId, role: "agent",
        content: "hello, looking now", created_at: minutesAgo(33),
      },
      {
        id: newId("msg"), conversation_id: b, org_id: orgId, role: "agent",
        content: "all sorted", created_at: minutesAgo(21),
      },
    ]).execute()

    // ── Conversation C: answered by a different model, with one fabricated
    // citation, escalated but never answered by a person (still waiting).
    const c = await conversation(orgId, "vis_c", minutesAgo(30))
    const c1 = await answer(orgId, c, { at: minutesAgo(29), model: "llama-3.3-70b", ttft: 400, total: 1600 })
    await claim(c1, "unknown_chunk", 0)
    await claim(c1, "verified", 1)
    await db.insertInto("handoff_sessions").values({
      id: newId("hnd"), org_id: orgId, conversation_id: c,
      reason: "low_confidence", requested_at: minutesAgo(28),
    }).execute()

    // ── Conversation D: no assistant message at all. A visitor who opened
    // the bubble and typed nothing is neither deflected nor escalated, so
    // this must not reach any denominator.
    const d = await conversation(orgId, "vis_d", minutesAgo(25))
    await db.insertInto("messages").values({
      id: newId("msg"), conversation_id: d, org_id: orgId, role: "visitor",
      content: "hello?", created_at: minutesAgo(24),
    }).execute()

    // ── Another tenant, busier than this one, entirely invisible.
    const x = await conversation(otherOrgId, "vis_x", minutesAgo(50))
    for (let i = 0; i < 5; i++) {
      const m = await answer(otherOrgId, x, { at: minutesAgo(49 - i), ttft: 9999, total: 9999 })
      await claim(m, "quote_not_found", 0)
    }
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrgId]).execute()
    await db.deleteFrom("users").where("id", "=", agentId).execute()
  })

  it("counts answers, refusals, and latency percentiles for THIS org only", async () => {
    const { answers } = await getOrgMetrics(orgId)
    // 4 assistant messages: A×2, B×1, C×1. The other tenant's 5 are absent.
    expect(answers.answers).toBe(4)
    expect(answers.refusals).toBe(1)
    expect(answers.refusalRate).toBeCloseTo(0.25, 5)
    // Latency covers ANSWERED rows only: the refusal (ttft 300 / total 1200)
    // is excluded, because a gate refusal never called a model and has no
    // first token to time. So 100/200/400 → median 200, and 400/800/1600 →
    // median 800. (percentile_cont interpolates, which is right for a
    // continuous quantity like latency.) Including it made a live page show
    // a full answer that was faster than its own first token.
    expect(answers.ttftP50Ms).toBeCloseTo(200, 5)
    expect(answers.totalP50Ms).toBeCloseTo(800, 5)
  })

  it("reports the strip rate with its two failure modes split", async () => {
    const { grounding } = await getOrgMetrics(orgId)
    // 5 claims: 3 verified, 1 quote_not_found, 1 unknown_chunk.
    expect(grounding.claims).toBe(5)
    expect(grounding.stripped).toBe(2)
    expect(grounding.stripRate).toBeCloseTo(0.4, 5)
    expect(grounding.quoteNotFound).toBe(1)
    expect(grounding.unknownChunk).toBe(1)
  })

  it("counts deflection per conversation, ignoring one nobody answered", async () => {
    const { deflection } = await getOrgMetrics(orgId)
    // A, B, C have answers; D does not and must not count either way.
    expect(deflection.conversations).toBe(3)
    expect(deflection.escalated).toBe(2)
    expect(deflection.deflectionRate).toBeCloseTo(1 / 3, 5)
  })

  it("measures time to first human RESPONSE, not to the agent arriving", async () => {
    const { deflection } = await getOrgMetrics(orgId)
    // One of the two handoffs got an agent message: requested at T-38,
    // first agent turn at T-33 → 5 minutes. The second agent turn (T-21) is
    // the same person still talking and must not be averaged in, and the
    // unanswered handoff must not count as a fast one.
    expect(deflection.handoffsAnswered).toBe(1)
    expect(deflection.firstHumanResponseP50Ms).toBeCloseTo(5 * 60 * 1000, -3)
  })

  it("breaks answers down by model — a comparison is a query, not a migration", async () => {
    const { byModel } = await getOrgMetrics(orgId)
    expect(byModel.map((row) => row.model).sort()).toEqual(["llama-3.3-70b", "mock-llm"])
    const mock = byModel.find((row) => row.model === "mock-llm")
    expect(mock?.answers).toBe(3)
    expect(mock?.refusals).toBe(1)
    const llama = byModel.find((row) => row.model === "llama-3.3-70b")
    expect(llama?.answers).toBe(1)
    expect(llama?.ttftP50Ms).toBeCloseTo(400, 5)
  })

  it("returns NULL rates for an org with no data, never a flattering zero", async () => {
    const emptyOrg = newId("org")
    await db.insertInto("organizations").values({ id: emptyOrg, name: "Empty Co" }).execute()
    try {
      const metrics = await getOrgMetrics(emptyOrg)
      expect(metrics.answers.answers).toBe(0)
      // The distinction the UI depends on: "no deflection rate yet" renders
      // as "—", while 0 would read as "this bot deflects nothing".
      expect(metrics.answers.refusalRate).toBeNull()
      expect(metrics.grounding.stripRate).toBeNull()
      expect(metrics.deflection.deflectionRate).toBeNull()
      expect(metrics.answers.ttftP50Ms).toBeNull()
      expect(metrics.deflection.firstHumanResponseP50Ms).toBeNull()
      expect(metrics.byModel).toEqual([])
    } finally {
      await db.deleteFrom("organizations").where("id", "=", emptyOrg).execute()
    }
  })

  it("excludes anything older than the window", async () => {
    // The same org, asked for a window that predates every fixture row.
    const metrics = await getOrgMetrics(orgId, 0)
    expect(metrics.answers.answers).toBe(0)
    expect(metrics.grounding.claims).toBe(0)
    expect(metrics.deflection.conversations).toBe(0)
  })
})
