// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; the
// schema must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts, which states it in full).
//
// What this pins is the inbox's ONE job: the person who has waited longest
// is at the top, and nobody else's tenants appear at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { getOpenHandoff, listOpenHandoffs } from "../queries"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const RUN = Math.random().toString(36).slice(2, 10)

let orgId: string
let otherOrgId: string
const conversations: Record<string, string> = {}

async function seedOrg(name: string): Promise<string> {
  const id = newId("org")
  await db.insertInto("organizations").values({ id, name: `${name} ${RUN}` }).execute()
  return id
}

/** A conversation plus, optionally, the handoff that escalated it. */
async function seedConversation(options: {
  key: string
  org: string
  visitor: string
  message?: string
  handoff?: {
    status: "pending" | "active" | "closed"
    requestedAt: string
    claimedAt?: string
    closedAt?: string
  }
}): Promise<string> {
  const id = newId("con")
  conversations[options.key] = id
  await db.insertInto("conversations").values({
    id,
    org_id: options.org,
    visitor_id: options.visitor,
    ...(options.handoff && options.handoff.status !== "closed" ? { status: "escalated" as const } : {}),
  }).execute()
  if (options.message !== undefined) {
    await db.insertInto("messages").values({
      id: newId("msg"),
      conversation_id: id,
      org_id: options.org,
      role: "visitor",
      content: options.message,
    }).execute()
  }
  if (options.handoff) {
    await db.insertInto("handoff_sessions").values({
      id: newId("hnd"),
      conversation_id: id,
      org_id: options.org,
      status: options.handoff.status,
      reason: "visitor_request",
      requested_at: new Date(options.handoff.requestedAt),
      ...(options.handoff.claimedAt !== undefined
        ? { claimed_at: new Date(options.handoff.claimedAt) }
        : {}),
      ...(options.handoff.closedAt !== undefined
        ? { closed_at: new Date(options.handoff.closedAt) }
        : {}),
    }).execute()
  }
  return id
}

describe.skipIf(!hasDb)("handoff inbox queries (integration)", () => {
  beforeAll(async () => {
    orgId = await seedOrg("Inbox Co")
    otherOrgId = await seedOrg("Other Inbox Co")

    // Deliberately seeded out of order, so passing cannot be an accident of
    // insertion order.
    await seedConversation({
      key: "claimed", org: orgId, visitor: "vis_claimed",
      message: "already being helped",
      handoff: { status: "active", requestedAt: "2026-01-01T09:00:00Z", claimedAt: "2026-01-01T09:01:00Z" },
    })
    await seedConversation({
      key: "newest", org: orgId, visitor: "vis_newest",
      message: "just asked for a person",
      handoff: { status: "pending", requestedAt: "2026-01-01T11:00:00Z" },
    })
    await seedConversation({
      key: "longest", org: orgId, visitor: "vis_longest",
      message: "has been waiting since breakfast",
      handoff: { status: "pending", requestedAt: "2026-01-01T08:00:00Z" },
    })
    await seedConversation({
      key: "resolved", org: orgId, visitor: "vis_resolved",
      message: "sorted out yesterday",
      handoff: { status: "closed", requestedAt: "2025-12-31T08:00:00Z", closedAt: "2025-12-31T08:30:00Z" },
    })
    await seedConversation({
      key: "never", org: orgId, visitor: "vis_never", message: "the bot handled it",
    })
    await seedConversation({
      key: "foreign", org: otherOrgId, visitor: "vis_foreign",
      message: "another tenant's problem",
      handoff: { status: "pending", requestedAt: "2026-01-01T07:00:00Z" },
    })
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrgId]).execute()
  })

  it("queues the longest wait first, claimed conversations last, and nothing else", async () => {
    const waiting = await listOpenHandoffs(orgId)
    expect(waiting.map((h) => h.conversationId)).toEqual([
      conversations["longest"],
      conversations["newest"],
      conversations["claimed"],
    ])
    // A closed handoff and a conversation that was never escalated are both
    // absent — the queue is who is waiting NOW, not who ever waited.
    expect(waiting.map((h) => h.conversationId)).not.toContain(conversations["resolved"])
    expect(waiting.map((h) => h.conversationId)).not.toContain(conversations["never"])
    // And the other tenant's waiting visitor is invisible, though they have
    // waited longer than anyone here.
    expect(waiting.map((h) => h.conversationId)).not.toContain(conversations["foreign"])

    const longest = waiting[0]!
    expect(longest.status).toBe("pending")
    expect(longest.claimedAt).toBeNull()
    expect(longest.preview).toBe("has been waiting since breakfast")
    expect(longest.reason).toBe("visitor_request")
  })

  it("reports a claimed handoff as claimed", async () => {
    const waiting = await listOpenHandoffs(orgId)
    const claimed = waiting.find((h) => h.conversationId === conversations["claimed"])!
    expect(claimed.status).toBe("active")
    expect(claimed.claimedAt).toBeInstanceOf(Date)
  })

  it("scopes a single lookup by org, and treats every miss the same way", async () => {
    const found = await getOpenHandoff(orgId, conversations["longest"]!)
    expect(found?.visitorId).toBe("vis_longest")

    // Another tenant's conversation, a closed handoff, one that was never
    // escalated, and a fabricated id: all null, all indistinguishable.
    expect(await getOpenHandoff(orgId, conversations["foreign"]!)).toBeNull()
    expect(await getOpenHandoff(orgId, conversations["resolved"]!)).toBeNull()
    expect(await getOpenHandoff(orgId, conversations["never"]!)).toBeNull()
    expect(await getOpenHandoff(orgId, newId("con"))).toBeNull()
    // A malformed id short-circuits before any query runs.
    expect(await getOpenHandoff(orgId, "not-an-id")).toBeNull()
  })
})
