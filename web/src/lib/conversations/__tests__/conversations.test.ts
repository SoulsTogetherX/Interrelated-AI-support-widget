// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; the
// schema must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts, which states it in full).
//
// The centerpiece is the strip-visibility contract: message_citations
// stores EVERY claim, verified and stripped alike, so the dashboard can
// show what the visitor did NOT see. A query that quietly filtered to
// verified rows would make the product's core promise unauditable, and
// this suite is what would catch that.
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { getConversation, listConversations } from "../queries"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const RUN = Math.random().toString(36).slice(2, 10)

let orgId: string
let otherOrgId: string
let conversationId: string
let otherConversationId: string

async function seedOrg(name: string): Promise<string> {
  const id = newId("org")
  await db.insertInto("organizations").values({ id, name: `${name} ${RUN}` }).execute()
  return id
}

describe.skipIf(!hasDb)("conversation queries (integration)", () => {
  beforeAll(async () => {
    orgId = await seedOrg("Conversations Co")
    otherOrgId = await seedOrg("Other Tenant Co")

    // Two conversations in the org, so the list's ordering is observable.
    const older = newId("con")
    conversationId = newId("con")
    await db.insertInto("conversations").values([
      {
        id: older,
        org_id: orgId,
        visitor_id: "vis_older",
        last_message_at: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: conversationId,
        org_id: orgId,
        visitor_id: "vis_newer",
        last_message_at: new Date("2026-06-01T00:00:00Z"),
      },
    ]).execute()
    await db.insertInto("messages").values({
      id: newId("msg"),
      conversation_id: older,
      org_id: orgId,
      role: "visitor",
      content: "older thread question",
    }).execute()

    // The interesting conversation: a visitor turn, then an assistant turn
    // whose claims split verified / stripped.
    const visitorMessageId = newId("msg")
    const assistantMessageId = newId("msg")
    await db.insertInto("messages").values([
      {
        id: visitorMessageId,
        conversation_id: conversationId,
        org_id: orgId,
        role: "visitor",
        content: "How long do refunds take?",
        created_at: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: assistantMessageId,
        conversation_id: conversationId,
        org_id: orgId,
        role: "assistant",
        content: "Refunds are processed within five business days.",
        model: "test-model",
        retrieval_score: 0.21,
        ttft_ms: 120,
        total_ms: 900,
        created_at: new Date("2026-06-01T00:00:01Z"),
      },
    ]).execute()
    await db.insertInto("message_citations").values([
      {
        message_id: assistantMessageId,
        ord: 0,
        chunk_id: newId("chk"),
        claim_text: "Refunds are processed within five business days.",
        quote: "processed within five business days",
        verdict: "verified",
        span_start: 10,
        span_end: 45,
        url: "https://docs.example/refunds",
        heading_path: "Refunds",
      },
      {
        message_id: assistantMessageId,
        ord: 1,
        chunk_id: newId("chk"),
        claim_text: "Refunds are always instant.",
        quote: "always instant",
        verdict: "quote_not_found",
        span_start: null,
        span_end: null,
        url: "https://docs.example/refunds",
        heading_path: "Refunds",
      },
    ]).execute()

    // A conversation belonging to a DIFFERENT tenant, for the isolation case.
    otherConversationId = newId("con")
    await db.insertInto("conversations").values({
      id: otherConversationId,
      org_id: otherOrgId,
      visitor_id: "vis_other",
    }).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrgId]).execute()
    await db.destroy()
  })

  it("lists the org's conversations newest-first with counts and previews", async () => {
    const list = await listConversations(orgId)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(conversationId) // (org_id, last_message_at DESC)
    expect(list[0].messageCount).toBe(2)
    expect(list[0].preview).toBe("Refunds are processed within five business days.")
    expect(list[0].status).toBe("open")
    expect(list[1].preview).toBe("older thread question")
  })

  it("scopes the list to the org", async () => {
    const otherList = await listConversations(otherOrgId)
    expect(otherList.map((c) => c.id)).toEqual([otherConversationId])
  })

  it("returns the transcript with STRIPPED claims visible alongside verified ones", async () => {
    const conversation = await getConversation(orgId, conversationId)
    expect(conversation).not.toBeNull()
    if (!conversation) return

    expect(conversation.messages.map((m) => m.role)).toEqual(["visitor", "assistant"])
    const assistant = conversation.messages[1]
    expect(assistant.model).toBe("test-model")
    expect(assistant.ttftMs).toBe(120)
    expect(assistant.totalMs).toBe(900)

    // BOTH verdicts must reach the dashboard: content is what the visitor
    // saw; the stripped claim is what the verifier refused to show.
    expect(assistant.citations.map((c) => c.verdict)).toEqual(["verified", "quote_not_found"])
    expect(assistant.content).not.toContain("always instant")
    expect(assistant.citations[1].claimText).toContain("always instant")
  })

  it("hides another tenant's conversation exactly like a nonexistent one", async () => {
    // Cross-tenant read and fabricated id must be INDISTINGUISHABLE — the
    // page turns both into the same 404.
    expect(await getConversation(orgId, otherConversationId)).toBeNull()
    expect(await getConversation(orgId, newId("con"))).toBeNull()
    // Malformed ids fail before any query.
    expect(await getConversation(orgId, "not-an-id")).toBeNull()
    expect(await getConversation(orgId, "con_short")).toBeNull()
  })
})
