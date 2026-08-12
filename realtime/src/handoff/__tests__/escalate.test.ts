//#region Imports
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { getOpenHandoff, requestHandoff } from "@/handoff/escalate"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// The escalation transition against real Postgres — DB-gated like every
// integration suite. The centerpiece is the race: escalation's idempotence
// is claimed to come from the SCHEMA (a partial unique index over open
// rows), not from application-side deduplication, and the only way to show
// that is to fire concurrent requests at it.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

let orgId: string
let otherOrgId: string

async function makeConversation(org: string, visitor: string): Promise<string> {
  const id = newId("con")
  await db.insertInto("conversations").values({ id, org_id: org, visitor_id: visitor }).execute()
  return id
}

const conversationStatus = async (id: string): Promise<string> =>
  (await db.selectFrom("conversations").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status

const openRows = (conversationId: string) =>
  db.selectFrom("handoff_sessions").selectAll()
    .where("conversation_id", "=", conversationId).where("status", "!=", "closed").execute()
//#endregion

describe.skipIf(!DB_CONFIGURED)("handoff escalation", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
    orgId = newId("org")
    otherOrgId = newId("org")
    await db.insertInto("organizations").values([
      { id: orgId, name: "Handoff Co" },
      { id: otherOrgId, name: "Other Co" },
    ]).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrgId]).execute()
    await db.destroy()
  })

  it("escalates: one handoff row, and the conversation says so", async () => {
    const conversationId = await makeConversation(orgId, "vis_a")
    expect(await conversationStatus(conversationId)).toBe("open")

    const outcome = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_a", reason: "visitor_request",
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.created).toBe(true)
    expect(outcome.handoff.status).toBe("pending")
    expect(outcome.handoff.claimedBy).toBeNull()

    // The coarse state and the record move together — a conversation
    // showing 'escalated' with no row would be a visitor queued where
    // nobody can see them.
    expect(await conversationStatus(conversationId)).toBe("escalated")
    const rows = await openRows(conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reason).toBe("visitor_request")
    expect(rows[0]?.claimed_at).toBeNull()
  })

  it("is idempotent: a second request reports the first, and creates nothing", async () => {
    const conversationId = await makeConversation(orgId, "vis_b")
    const first = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_b", reason: "visitor_request",
    })
    const second = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_b", reason: "low_confidence",
    })

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.created).toBe(false)
    expect(second.handoff.id).toBe(first.handoff.id)
    // The reason belongs to the escalation that actually happened; a later
    // request does not rewrite why the visitor is waiting.
    expect(second.handoff.reason).toBe("visitor_request")
    expect(await openRows(conversationId)).toHaveLength(1)
  })

  it("survives a concurrent double-escalation with exactly one row", async () => {
    // The claim under test: idempotence comes from the index, not from the
    // read above it. Fired together, one insert must lose on the unique
    // constraint and read back the winner rather than erroring or
    // duplicating.
    const conversationId = await makeConversation(orgId, "vis_c")
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        requestHandoff(db, { orgId, conversationId, visitorId: "vis_c", reason: "visitor_request" }),
      ),
    )

    expect(results.every((r) => r.ok)).toBe(true)
    const ids = new Set(results.map((r) => (r.ok ? r.handoff.id : "")))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1)
    expect(await openRows(conversationId)).toHaveLength(1)
  })

  it("refuses another org's and another visitor's conversation identically", async () => {
    const mine = await makeConversation(orgId, "vis_d")
    const theirs = await makeConversation(otherOrgId, "vis_e")

    const crossTenant = await requestHandoff(db, {
      orgId, conversationId: theirs, visitorId: "vis_e", reason: "visitor_request",
    })
    const crossVisitor = await requestHandoff(db, {
      orgId, conversationId: mine, visitorId: "vis_someone_else", reason: "visitor_request",
    })
    const fabricated = await requestHandoff(db, {
      orgId, conversationId: newId("con"), visitorId: "vis_d", reason: "visitor_request",
    })

    for (const outcome of [crossTenant, crossVisitor, fabricated]) {
      expect(outcome).toEqual({ ok: false, error: "not_found" })
    }
    // Nothing was written for any of them, in either org.
    expect(await openRows(theirs)).toHaveLength(0)
    expect(await openRows(mine)).toHaveLength(0)
  })

  it("lets a closed handoff be followed by a new one", async () => {
    // A conversation resolved by a human can come back later. The unique
    // index is over OPEN rows precisely so history does not block that.
    const conversationId = await makeConversation(orgId, "vis_f")
    const first = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_f", reason: "visitor_request",
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    await db.updateTable("handoff_sessions")
      .set({ status: "closed", closed_at: new Date() })
      .where("id", "=", first.handoff.id)
      .execute()
    expect(await getOpenHandoff(db, conversationId)).toBeNull()

    const second = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_f", reason: "low_confidence",
    })
    expect(second.ok && second.created).toBe(true)
    if (!second.ok) return
    expect(second.handoff.id).not.toBe(first.handoff.id)
    expect(await db.selectFrom("handoff_sessions").selectAll()
      .where("conversation_id", "=", conversationId).execute()).toHaveLength(2)
  })

  it("reports an active handoff as active, so the widget can word the wait", async () => {
    const conversationId = await makeConversation(orgId, "vis_g")
    const agentId = newId("usr")
    await db.insertInto("users").values({
      id: agentId, email_index: `idx_${agentId}`, email_ciphertext: "x", password_hash: "x",
    }).execute()
    const created = await requestHandoff(db, {
      orgId, conversationId, visitorId: "vis_g", reason: "visitor_request",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await db.updateTable("handoff_sessions")
      .set({ status: "active", claimed_by: agentId, claimed_at: new Date() })
      .where("id", "=", created.handoff.id)
      .execute()

    const open = await getOpenHandoff(db, conversationId)
    expect(open?.status).toBe("active")
    expect(open?.claimedBy).toBe(agentId)

    // Deleting the agent must SUCCEED and must not damage the handoff:
    // "history outlives employment" is only true if an org can actually
    // remove a departing member while they hold a live conversation. (Tying
    // the 'active' CHECK to claimed_by instead of claimed_at made this
    // throw — the reason it is written the way it is.)
    await db.deleteFrom("users").where("id", "=", agentId).execute()
    const orphaned = await db.selectFrom("handoff_sessions").selectAll()
      .where("id", "=", created.handoff.id).executeTakeFirstOrThrow()
    expect(orphaned.status).toBe("active")
    expect(orphaned.claimed_by).toBeNull()
    expect(orphaned.claimed_at).not.toBeNull()
  })

  it("rejects the schema states that would corrupt the queue", async () => {
    const conversationId = await makeConversation(orgId, "vis_h")
    const base = { org_id: orgId, conversation_id: conversationId, reason: "visitor_request" as const }

    // Active without an owner: an escalation nobody is holding, which is
    // exactly what 'pending' means.
    await expect(
      db.insertInto("handoff_sessions").values({ ...base, id: newId("hnd"), status: "active" }).execute(),
    ).rejects.toThrow()
    // Closed without a closing time — M5 measures durations on these.
    await expect(
      db.insertInto("handoff_sessions").values({ ...base, id: newId("hnd"), status: "closed" }).execute(),
    ).rejects.toThrow()
    // An unknown reason.
    await expect(
      sql`INSERT INTO handoff_sessions (id, org_id, conversation_id, reason)
          VALUES (${newId("hnd")}, ${orgId}, ${conversationId}, 'because')`.execute(db),
    ).rejects.toThrow()

    expect(await openRows(conversationId)).toHaveLength(0)
  })
})
