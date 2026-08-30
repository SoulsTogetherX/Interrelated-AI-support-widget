//#region Imports
import type { Express, Request, Response } from "express"

import { isId } from "@shared/utils/ids"
import { requestHandoff } from "@/handoff/escalate"
import { mintHandoffTicket } from "@/handoff/ticket"
//#endregion

import type { WidgetContext, WidgetRouteOptions } from "./types"

//#region Route
/** Escalate + the socket ticket (§3.23, §3.24) — the two routes that
 *  hand a conversation to a person. Bodies verbatim. */
function registerHandoffRoutes(
  app: Express,
  options: WidgetRouteOptions,
  ctx: WidgetContext,
): void {
  const { chatIpLimiter, chatVisitorLimiter, authenticate } = ctx

  // ── Escalate: hand the conversation to a person (M4.1) ───────────────────
  // Plain JSON, not SSE: the transition is one small state change, and the
  // stream that carries the human's messages is M4's WebSocket, not this.
  // The per-visitor chat bucket is deliberately REUSED rather than given its
  // own: escalation is cheap for us but expensive for the tenant (it puts a
  // person on the hook), and a visitor who has just spent their question
  // budget should not have a separate allowance for summoning staff.
  app.post("/v1/widget/escalate", async (req: Request, res: Response) => {
    try {
      const session = authenticate(req, res)
      if (session === null) return

      if (
        !chatIpLimiter.take(req.ip ?? "unknown") ||
        !chatVisitorLimiter.take(`${session.org}:${session.visitor}`)
      ) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const conversationId = body["conversationId"]
      if (typeof conversationId !== "string" || !isId("con", conversationId)) {
        res.status(400).json({ error: "invalid conversationId" })
        return
      }

      const outcome = await requestHandoff(options.db, {
        orgId: session.org,
        conversationId,
        visitorId: session.visitor,
        // The button. Auto-escalation after a refusal (reason
        // 'low_confidence') is the pipeline's call to make, not a visitor's
        // to claim — a request cannot ask for it.
        reason: "visitor_request",
      })
      if (!outcome.ok) {
        // Unknown, another org's, and another visitor's conversation are one
        // answer: which it was is not information this surface shares.
        res.status(404).json({ error: "conversation not found" })
        return
      }
      res.json({ status: outcome.handoff.status, created: outcome.created })
    } catch (err) {
      console.error("[widget] escalate failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })

  // ── Handoff ticket: the visitor's key to the socket (M4.2) ───────────────
  // The session token cannot ride a WebSocket handshake (browsers set no
  // headers there), so it is spent HERE, on an ordinary authenticated POST,
  // for a ticket that is good for 60 seconds and one upgrade. What ends up
  // in the URL — and therefore in every access log between here and the
  // browser — is the disposable one. See handoff/ticket.ts.
  app.post("/v1/widget/handoff-ticket", async (req: Request, res: Response) => {
    try {
      const session = authenticate(req, res)
      if (session === null) return

      const body = (req.body ?? {}) as Record<string, unknown>
      const conversationId = body["conversationId"]
      if (typeof conversationId !== "string" || !isId("con", conversationId)) {
        res.status(400).json({ error: "invalid conversationId" })
        return
      }

      // A ticket is only issued for a conversation this visitor owns AND
      // that actually has a human waiting: no handoff, nothing to connect
      // to. Both failures are one 404 — the socket's own upgrade check
      // repeats this, so nothing here is the only line of defense.
      const open = await options.db
        .selectFrom("handoff_sessions")
        .innerJoin("conversations", "conversations.id", "handoff_sessions.conversation_id")
        .select("handoff_sessions.id")
        .where("handoff_sessions.conversation_id", "=", conversationId)
        .where("handoff_sessions.status", "!=", "closed")
        .where("conversations.org_id", "=", session.org)
        .where("conversations.visitor_id", "=", session.visitor)
        .executeTakeFirst()
      if (!open) {
        res.status(404).json({ error: "conversation not found" })
        return
      }

      const minted = mintHandoffTicket(
        { con: conversationId, org: session.org, role: "visitor", sub: session.visitor },
        options.tokenSecret,
      )
      res.json({ ticket: minted.ticket, expiresAt: minted.expiresAt })
    } catch (err) {
      console.error("[widget] handoff ticket failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })
}
//#endregion

//#region Exports
export { registerHandoffRoutes }
//#endregion
