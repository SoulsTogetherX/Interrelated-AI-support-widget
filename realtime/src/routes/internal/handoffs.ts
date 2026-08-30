//#region Imports

import { isId } from "@shared/utils/ids"

import { db } from "@/db/pool"
import { mintHandoffTicket } from "@/handoff/ticket"
import { closeHandoff } from "@/handoff/escalate"

import type { Express, Request, Response } from "express"
//#endregion

import type { InternalGuards, InternalRouteOptions } from "./types"

//#region Routes
/** Handoffs: close (rings the room exactly once) and agent tickets —
 *  §3.22/§3.24. Handler bodies are verbatim from the pre-split file. */
function registerHandoffRoutes(
  app: Express,
  options: InternalRouteOptions,
  guards: InternalGuards,
): void {
  const { requireSecret, requireOrg } = guards

  app.post(
    "/internal/orgs/:orgId/handoffs/:conversationId/close",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      // Same stance as the role param below: a path segment is untrusted
      // input until isId has looked at it, and Express 5 types it wide.
      const conversationId =
        typeof req.params.conversationId === "string" ? req.params.conversationId : ""
      const b = (req.body ?? {}) as Record<string, unknown>
      const userId = typeof b.userId === "string" ? b.userId : ""
      if (!isId("con", conversationId) || !isId("usr", userId)) {
        res.status(422).json({ ok: false, error: "conversationId and userId are required." })
        return
      }

      const member = await db
        .selectFrom("org_members")
        .select("user_id")
        .where("org_id", "=", res.locals.orgId as string)
        .where("user_id", "=", userId)
        .executeTakeFirst()
      if (!member) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const outcome = await closeHandoff(db, {
        orgId: res.locals.orgId as string,
        conversationId,
        closedBy: userId,
      })
      if (!outcome.ok) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }
      // Only when a row actually changed: a second close must not hang up
      // on a room that a LATER escalation of the same conversation has
      // since filled.
      if (outcome.closed) options.onHandoffClosed?.(conversationId)
      res.json({ ok: true, closed: outcome.closed })
    },
  )

  /**
   * Mint an AGENT's handoff-socket ticket (M4.2). The dashboard cannot sign
   * one itself — the ticket key is derived from realtime's token secret,
   * which web has no business holding — so a Server Action asks for one
   * here, having already established the user's session.
   *
   * This route is the only thing in the system that can mint an agent
   * ticket, so it re-establishes what web claims rather than trusting it:
   * the user must be a MEMBER of the org (either role — reading and
   * answering conversations is the agent job), and the conversation must
   * belong to that org and have a handoff still open. The socket's upgrade
   * check repeats the last part; this one keeps a ticket from existing at
   * all for a conversation nobody is waiting on.
   */

  app.post(
    "/internal/orgs/:orgId/handoff-tickets",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const conversationId = typeof b.conversationId === "string" ? b.conversationId : ""
      const userId = typeof b.userId === "string" ? b.userId : ""
      if (!isId("con", conversationId) || !isId("usr", userId)) {
        res.status(422).json({ ok: false, error: "conversationId and userId are required." })
        return
      }

      const member = await db
        .selectFrom("org_members")
        .select("user_id")
        .where("org_id", "=", res.locals.orgId as string)
        .where("user_id", "=", userId)
        .executeTakeFirst()
      if (!member) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const open = await db
        .selectFrom("handoff_sessions")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("org_id", "=", res.locals.orgId as string)
        .where("status", "!=", "closed")
        .executeTakeFirst()
      if (!open) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const minted = mintHandoffTicket(
        { con: conversationId, org: res.locals.orgId as string, role: "agent", sub: userId },
        options.ticketSecret,
      )
      res.json({ ok: true, ticket: minted.ticket, expiresAt: minted.expiresAt })
    },
  )

  /** Remove a role's credential. Hard delete — see §3.3.3. */
}
//#endregion

//#region Exports
export { registerHandoffRoutes }
//#endregion
