//#region Imports
import type { Request, Response } from "express"

import type { AnswerEvent } from "@shared/grounding/events"
import { recordOriginMint } from "@/usage/origins"
import type { MintOutcome } from "@/usage/origins"
import { RateLimiter } from "@/widgetAuth/rateLimit"
import { verifySessionToken } from "@/widgetAuth/sessionToken"
import type { SessionTokenPayload } from "@/widgetAuth/sessionToken"
//#endregion

import type { WidgetContext, WidgetRouteOptions } from "./types"

//#region Constants
//#region Constants
/** Mint: 10 burst / ~10 per minute per IP — a human opens one bubble. */
const MINT_CAPACITY = 10
const MINT_REFILL_PER_SECOND = 10 / 60
/** Server-side mint (layer 6): 60 burst / 1 per second per IP. More
 *  generous than the browser bucket because one IP here is a customer's
 *  BACKEND minting for many users, not one person opening one bubble — and
 *  a mint is only ever spent at bubble-open, so even a busy site's rate is
 *  modest. What the bucket bounds is a flood of guesses at a secret key
 *  (each costs a hash and an indexed lookup); what it must not do is
 *  throttle a real customer's servers, which typically share one egress
 *  IP. Chat itself stays bounded downstream by the per-visitor bucket and
 *  the plan quota, whichever mint opened the session. */
const SERVER_MINT_CAPACITY = 60
const SERVER_MINT_REFILL_PER_SECOND = 1
/** Chat per IP: covers several visitors behind one NAT without inviting a
 *  single-host script to farm the org's quota. */
const CHAT_IP_CAPACITY = 20
const CHAT_IP_REFILL_PER_SECOND = 20 / 60
/** Chat per visitor: burst 5, ~6/min sustained — faster than a human
 *  types questions, far slower than a loop. */
const CHAT_VISITOR_CAPACITY = 5
const CHAT_VISITOR_REFILL_PER_SECOND = 6 / 60
const MAX_QUESTION_CHARS = 2_000
//#endregion

//#region Helpers
/** CORS echo for an origin that has ALREADY passed the allowlist (or, for
 *  preflight, is about to be checked on the actual request — preflight
 *  grants nothing by itself, the browser still requires these headers on
 *  the real response). Vary: Origin keeps shared caches honest. */
function corsHeaders(res: Response, origin: string): void {
  res.setHeader("access-control-allow-origin", origin)
  res.setHeader("vary", "origin")
}

function preflight(req: Request, res: Response): void {
  const origin = req.headers.origin
  if (typeof origin === "string") {
    corsHeaders(res, origin)
    res.setHeader("access-control-allow-methods", "POST")
    res.setHeader("access-control-allow-headers", "content-type, authorization")
    res.setHeader("access-control-max-age", "86400")
  }
  res.status(204).end()
}

function sseWrite(res: Response, event: AnswerEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}
//#endregion

//#region Context
/** The pre-split closure's shared state, verbatim (§3.18). */
function buildWidgetContext(options: WidgetRouteOptions): WidgetContext {
  const mintLimiter =
    options.mintLimiter ??
    new RateLimiter({ capacity: MINT_CAPACITY, refillPerSecond: MINT_REFILL_PER_SECOND })
  const serverMintLimiter =
    options.serverMintLimiter ??
    new RateLimiter({
      capacity: SERVER_MINT_CAPACITY,
      refillPerSecond: SERVER_MINT_REFILL_PER_SECOND,
    })
  const chatIpLimiter =
    options.chatIpLimiter ??
    new RateLimiter({ capacity: CHAT_IP_CAPACITY, refillPerSecond: CHAT_IP_REFILL_PER_SECOND })
  const chatVisitorLimiter =
    options.chatVisitorLimiter ??
    new RateLimiter({
      capacity: CHAT_VISITOR_CAPACITY,
      refillPerSecond: CHAT_VISITOR_REFILL_PER_SECOND,
    })

  /** Token auth + the origin re-check, shared by every route that carries a
   *  session. Returns the verified session, or null having ALREADY answered
   *  — callers just return. Extracted when escalate became the second such
   *  route (M4.1): two copies of an auth ladder is how one of them
   *  eventually drifts. */
  const authenticate = (req: Request, res: Response): SessionTokenPayload | null => {
    const origin = req.headers.origin
    if (typeof origin !== "string" || origin.length === 0) {
      res.status(403).json({ error: "origin header required" })
      return null
    }
    const auth = req.headers.authorization
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null
    const session = token !== null ? verifySessionToken(token, options.tokenSecret) : null
    if (session === null) {
      res.status(401).json({ error: "invalid session" })
      return null
    }
    if (session.origin !== origin) {
      // A valid token replayed from a different site — exactly the
      // exfiltration the origin binding exists to kill.
      res.status(403).json({ error: "origin not allowed" })
      return null
    }
    corsHeaders(res, origin)
    return session
  }

  /** Layer 4's per-origin counter (§3.28). AWAITED, so the counter is
   *  visible the moment the response is — a dashboard that lagged the
   *  widget would make "is that copy still out there?" unanswerable — but
   *  never allowed to fail the mint: instrumentation is not the product,
   *  and a visitor must get their session even if this table is having a
   *  bad day. */
  const countOrigin = async (
    orgId: string,
    origin: string,
    outcome: MintOutcome,
  ): Promise<void> => {
    try {
      await recordOriginMint(options.db, { orgId, origin, outcome })
    } catch (err) {
      console.error("[widget] origin counter failed:", err)
    }
  }
  return {
    mintLimiter,
    serverMintLimiter,
    chatIpLimiter,
    chatVisitorLimiter,
    authenticate,
    countOrigin,
  }
}
//#endregion

//#region Exports
export { buildWidgetContext, corsHeaders, preflight, sseWrite, MAX_QUESTION_CHARS }
//#endregion
