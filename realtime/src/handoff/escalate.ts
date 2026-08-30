//#region Why this file
// The escalation transition (M4.1): the moment a conversation stops being
// the bot's and becomes a person's. Everything else in M4 — the ticketed
// socket, presence, replay — carries messages once this has happened; this
// file decides THAT it has, and does so exactly once per conversation.
//
// Idempotence is the whole design problem. A visitor mashing "talk to a
// human", a widget retrying a request whose response was lost, and an
// auto-escalation racing the button all arrive as concurrent requests for
// the same thing. The answer is not application-side deduplication (a
// check-then-insert races, and the loser corrupts the queue with a second
// row) but the schema: a partial unique index over open rows makes a second
// open handoff UNREPRESENTABLE, so the race resolves in Postgres and the
// loser simply reads back the winner's row.
//#endregion

//#region Imports
import { newId } from "@shared/utils/ids"

import { sql } from "kysely"
import type { Kysely, Transaction } from "kysely"
import type { Database } from "@/db/schema"
import { recordEscalation } from "@/usage/daily"
//#endregion

//#region Types
type HandoffReason = "visitor_request" | "low_confidence"

export interface HandoffRequest {
  orgId: string
  conversationId: string
  /** The visitor the session token is bound to. A conversation may only be
   *  escalated by the visitor whose thread it is — the same binding the
   *  chat route enforces for continuation, for the same reason: a
   *  conversation id is client-supplied input. */
  visitorId: string
  reason: HandoffReason
}

export interface OpenHandoff {
  id: string
  status: "pending" | "active"
  reason: HandoffReason
  requestedAt: Date
  /** Null while nobody has taken it — what the widget renders as "waiting
   *  for someone" versus "you are talking to a person". */
  claimedBy: string | null
}

export type HandoffOutcome =
  | { ok: true; handoff: OpenHandoff; created: boolean }
  /** The conversation does not exist, belongs to another org, or belongs to
   *  another visitor — deliberately ONE outcome, because distinguishing them
   *  to a caller on a public route is an oracle. */
  | { ok: false; error: "not_found" }
//#endregion

//#region Helpers
/** Postgres unique-violation. Checked by code rather than message text: the
 *  message is localized and version-dependent, the SQLSTATE is neither. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  )
}

function toOpenHandoff(row: {
  id: string
  status: "pending" | "active" | "closed"
  reason: HandoffReason
  requested_at: Date
  claimed_by: string | null
}): OpenHandoff {
  return {
    id: row.id,
    // Callers only ever see rows the open-row query returned, so 'closed'
    // cannot arrive here; narrowing rather than casting keeps that true if
    // the query ever changes.
    status: row.status === "active" ? "active" : "pending",
    reason: row.reason,
    requestedAt: row.requested_at,
    claimedBy: row.claimed_by,
  }
}

async function selectOpen(
  db: Kysely<Database> | Transaction<Database>,
  conversationId: string,
): Promise<OpenHandoff | null> {
  const row = await db
    .selectFrom("handoff_sessions")
    .select(["id", "status", "reason", "requested_at", "claimed_by"])
    .where("conversation_id", "=", conversationId)
    .where("status", "!=", "closed")
    .executeTakeFirst()
  return row ? toOpenHandoff(row) : null
}
//#endregion

//#region Read
/** The conversation's open handoff, if it has one. The answer pipeline calls
 *  this on every question to decide whether a human already owns the thread
 *  (§3.15.3) — one indexed read on a covered partial index. */
export async function getOpenHandoff(
  db: Kysely<Database>,
  conversationId: string,
): Promise<OpenHandoff | null> {
  return selectOpen(db, conversationId)
}
//#endregion

//#region Transition
/**
 * Escalates a conversation, or reports the escalation already in flight.
 *
 * The write is one transaction over two tables: the handoff row, and
 * conversations.status — which stays the COARSE state (it is what the widget
 * renders and what the dashboard's list filters on) while this table keeps
 * the record. They move together or not at all; a conversation showing
 * 'escalated' with no handoff row would be a visitor waiting in a queue
 * nobody can see.
 *
 * `created` distinguishes "you are now in the queue" from "you already
 * were", which the widget uses to avoid repeating itself and which M5 needs
 * so one visitor's impatience does not inflate the escalation rate.
 */
export async function requestHandoff(
  db: Kysely<Database>,
  request: HandoffRequest,
): Promise<HandoffOutcome> {
  const conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", request.conversationId)
    .where("org_id", "=", request.orgId)
    .where("visitor_id", "=", request.visitorId)
    .executeTakeFirst()
  if (!conversation) {
    return { ok: false, error: "not_found" }
  }

  const existing = await selectOpen(db, request.conversationId)
  if (existing) {
    return { ok: true, handoff: existing, created: false }
  }

  const id = newId("hnd")
  try {
    return await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("handoff_sessions")
        .values({
          id,
          org_id: request.orgId,
          conversation_id: request.conversationId,
          reason: request.reason,
        })
        .execute()
      await trx
        .updateTable("conversations")
        .set({ status: "escalated" })
        .where("id", "=", request.conversationId)
        .execute()
      // The day's escalation counter (M5.3), in the same transaction as the
      // handoff it counts. Only here — the two paths that return an
      // EXISTING handoff (the read above, and the unique-violation loser
      // below) add nothing, because a visitor mashing the button must not
      // inflate the escalation rate the deflection metric is measured
      // against.
      await recordEscalation(trx, { orgId: request.orgId })
      const handoff = await selectOpen(trx, request.conversationId)
      if (!handoff) throw new Error("handoff vanished inside its own transaction")
      return { ok: true, handoff, created: true } as const
    })
  } catch (error) {
    // Another request won the race in the microseconds since the read above.
    // The index did its job; read back what it let through. Anything else is
    // a real failure and propagates.
    if (!isUniqueViolation(error)) throw error
    const winner = await selectOpen(db, request.conversationId)
    if (!winner) throw error
    return { ok: true, handoff: winner, created: false }
  }
}

/**
 * The other end of the lifecycle (M4.6): an agent is finished, and the
 * conversation goes back to being the bot's.
 *
 * The mirror image of requestHandoff in every way that matters. It moves
 * both rows in ONE transaction — closing the handoff while leaving
 * `conversations.status = 'escalated'` would leave a visitor whose widget
 * says a person owns the thread while the bot answers it. It reports
 * `closed: false` when there was nothing open, so a double-clicked button
 * and a second agent closing the same conversation are both free rather
 * than errors. And the WHERE clause is what makes that safe under
 * concurrency: the UPDATE only touches a row that is still open, so two
 * simultaneous closes produce one write and one no-op instead of a
 * second closed_at overwriting the first.
 *
 * Status goes back to 'open', not 'closed': a conversation whose handoff
 * ended is answerable again (§3.15.3 stops finding an open handoff, so the
 * pipeline resumes), and 'closed' is for a conversation nobody is having.
 * The partial unique index is over OPEN rows only, so this same
 * conversation can be escalated again later — which is exactly why the
 * lifecycle is a table and not a column (§3.3.4).
 */
export async function closeHandoff(
  db: Kysely<Database>,
  request: { orgId: string; conversationId: string; closedBy: string },
): Promise<{ ok: true; closed: boolean } | { ok: false; error: "not_found" }> {
  const conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", request.conversationId)
    .where("org_id", "=", request.orgId)
    .executeTakeFirst()
  if (!conversation) {
    return { ok: false, error: "not_found" }
  }

  return await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("handoff_sessions")
      .set({
        status: "closed",
        closed_at: new Date(),
        // Claim it on the way out if nobody had: an agent who resolves a
        // conversation without ever attaching (answered by phone, say) is
        // still the agent who handled it, and 'closed' with a null
        // claimed_at would say nobody ever did.
        claimed_at: sql`COALESCE(claimed_at, NOW())`,
        claimed_by: sql`COALESCE(claimed_by, ${request.closedBy})`,
      })
      .where("conversation_id", "=", request.conversationId)
      .where("org_id", "=", request.orgId)
      .where("status", "!=", "closed")
      .executeTakeFirst()

    const closed = Number(updated.numUpdatedRows ?? 0n) > 0
    if (closed) {
      await trx
        .updateTable("conversations")
        .set({ status: "open" })
        .where("id", "=", request.conversationId)
        .execute()
    }
    return { ok: true, closed } as const
  })
}
//#endregion
