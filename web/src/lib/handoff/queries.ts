//#region Why this file
// The agent inbox's read side (M4.5): who is waiting for a person, and how
// long they have been waiting. Straight from Postgres like every dashboard
// read (§9.4) and org-scoped in the WHERE, so another tenant's conversation
// id behaves exactly like one that never existed.
//
// The queue is `handoff_sessions` rather than `conversations.status`
// because the row is the RECORD of an escalation — requested/claimed
// timestamps and all — while the conversation's status is only the coarse
// state the widget renders (§3.3.4). M5's headline product metric,
// time-to-first-human-response, is a duration between two columns here.
//#endregion

//#region Imports
import { isId } from "@shared/utils/ids"

import { db } from "@/lib/db"
//#endregion

//#region Types
export interface WaitingHandoff {
  handoffId: string
  conversationId: string
  /** Open handoffs only — 'closed' never reaches this surface. */
  status: "pending" | "active"
  visitorId: string
  reason: "visitor_request" | "low_confidence"
  requestedAt: Date
  /** When an agent attached; null while nobody has (§3.25 — attaching IS
   *  the claim, so this doubles as "is anyone on it"). */
  claimedAt: Date | null
  /** The user id that claimed it, or null — either nobody has, or the
   *  account was deleted (claimed_by is ON DELETE SET NULL so history
   *  outlives employment, §3.3.4). The inbox compares it against the
   *  viewer to say "you" instead of decrypting a colleague's email. */
  claimedBy: string | null
  /** The newest turn, for the queue's one-line preview. */
  preview: string | null
}
//#endregion

//#region Queries
/**
 * The queue, ordered the way a person works it: unclaimed first, and within
 * each group the longest wait first. Deliberately NOT ordered by newest
 * activity — that is the conversations list's job (§9.10); an inbox sorted
 * by recency buries whoever has been waiting longest, which is precisely
 * the person the tenant is failing.
 */
export async function listOpenHandoffs(orgId: string, limit = 50): Promise<WaitingHandoff[]> {
  const handoffs = await db
    .selectFrom("handoff_sessions")
    .innerJoin("conversations", "conversations.id", "handoff_sessions.conversation_id")
    .select([
      "handoff_sessions.id as handoff_id",
      "handoff_sessions.conversation_id",
      "handoff_sessions.status",
      "handoff_sessions.reason",
      "handoff_sessions.requested_at",
      "handoff_sessions.claimed_at",
      "handoff_sessions.claimed_by",
      "conversations.visitor_id",
    ])
    .where("handoff_sessions.org_id", "=", orgId)
    .where("handoff_sessions.status", "!=", "closed")
    .orderBy("handoff_sessions.status", "asc") // 'active' < 'pending' alphabetically — re-sorted below
    .orderBy("handoff_sessions.requested_at", "asc")
    .limit(limit)
    .execute()
  if (handoffs.length === 0) {
    return []
  }

  // Previews in one query, like listConversations: a handful of rows per
  // org, so the newest-per-conversation pick is cheaper in JS than a
  // correlated subquery per row.
  const messages = await db
    .selectFrom("messages")
    .select(["conversation_id", "content", "created_at"])
    .where("conversation_id", "in", handoffs.map((h) => h.conversation_id))
    .orderBy("created_at", "desc")
    .execute()
  const newest = new Map<string, string>()
  for (const message of messages) {
    if (!newest.has(message.conversation_id)) newest.set(message.conversation_id, message.content)
  }

  const rows = handoffs.map((h) => ({
    handoffId: h.handoff_id,
    conversationId: h.conversation_id,
    status: h.status as "pending" | "active",
    visitorId: h.visitor_id,
    reason: h.reason,
    requestedAt: h.requested_at,
    claimedAt: h.claimed_at,
    claimedBy: h.claimed_by,
    preview: newest.get(h.conversation_id) ?? null,
  }))
  // Pending ahead of active, oldest first inside each — done here rather
  // than in SQL because the status strings do not sort in that order and a
  // CASE expression would hide the intent behind syntax.
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1
    return a.requestedAt.getTime() - b.requestedAt.getTime()
  })
}

/** One conversation's open handoff, or null — which is a NORMAL state (it
 *  was closed, or was never escalated), not an error: the inbox detail page
 *  says so and links to the transcript instead. Null is also what another
 *  tenant's conversation id returns, and a malformed one, which is the
 *  same indistinguishability the rest of the dashboard keeps (§9.10). */
export async function getOpenHandoff(
  orgId: string,
  conversationId: string,
): Promise<WaitingHandoff | null> {
  if (!isId("con", conversationId)) {
    return null
  }
  const handoff = await db
    .selectFrom("handoff_sessions")
    .innerJoin("conversations", "conversations.id", "handoff_sessions.conversation_id")
    .select([
      "handoff_sessions.id as handoff_id",
      "handoff_sessions.status",
      "handoff_sessions.reason",
      "handoff_sessions.requested_at",
      "handoff_sessions.claimed_at",
      "handoff_sessions.claimed_by",
      "conversations.visitor_id",
    ])
    .where("handoff_sessions.conversation_id", "=", conversationId)
    .where("handoff_sessions.org_id", "=", orgId)
    .where("handoff_sessions.status", "!=", "closed")
    .executeTakeFirst()
  if (!handoff) {
    return null
  }
  return {
    handoffId: handoff.handoff_id,
    conversationId,
    status: handoff.status as "pending" | "active",
    visitorId: handoff.visitor_id,
    reason: handoff.reason,
    requestedAt: handoff.requested_at,
    claimedAt: handoff.claimed_at,
    claimedBy: handoff.claimed_by,
    // The detail page renders the live thread from the socket's own
    // replay, so a preview here would be a second, staler copy.
    preview: null,
  }
}
//#endregion
