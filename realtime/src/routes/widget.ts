//#region Imports
import { randomBytes } from "node:crypto"
import type { Express, Request, Response } from "express"
import type { Kysely } from "kysely"

import type { Database } from "@/db/schema"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { LLMProvider } from "@providers/llm/types"
import type { AnswerEvent } from "@shared/grounding/events"
import { isId } from "@shared/utils/ids"
import { answerQuestion } from "@/answer/pipeline"
import { resolveEmbeddingProvider, resolveGenerationProvider } from "@/credentials/resolve"
import { requestHandoff } from "@/handoff/escalate"
import { mintHandoffTicket } from "@/handoff/ticket"
import { RateLimiter } from "@/widget/rateLimit"
import { mintSessionToken, verifySessionToken } from "@/widget/sessionToken"
import type { SessionTokenPayload } from "@/widget/sessionToken"
//#endregion

//#region Type Defs
/**
 * The widget's public surface — the only routes an untrusted browser ever
 * calls. The trust model (plan §widget-trust-model) is implemented here in
 * layer order:
 *
 *   1. Origin allowlist, server-enforced: the browser sets Origin and page
 *      JS cannot forge it, so an unlisted origin dies here. CORS echoes
 *      ONLY allowlisted origins — an unlisted site cannot even read the
 *      response. (The honest limit, stated in the plan: curl forges
 *      Origin trivially; layers below bound that.)
 *   2. Session tokens: the publishable key is spent once at bubble-open;
 *      chat authenticates with a short-lived token BOUND to org + origin
 *      + visitor, and the chat route re-checks the live Origin against
 *      the token's.
 *   3. Rate limits + the daily ceiling: per-IP and per-visitor token
 *      buckets, then a per-org answers-per-day cap counted from the
 *      messages table (the (org_id, created_at) index exists for exactly
 *      this query) and checked BEFORE the model call — the worst case is
 *      a stopped widget, never a surprise bill.
 *
 * Uniform failures on purpose: bad key, revoked key, and unknown key are
 * the same 401; bad, expired, and tampered tokens are the same 401. Which
 * failure occurred is an oracle this surface does not provide.
 */
interface WidgetRouteOptions {
  db: Kysely<Database>
  /** The FALLBACK query embedder (env-selected; mock in every keyless
   *  stack). Since M3.6b an org's saved BYO embedding credential outranks
   *  it — and MUST, since it is what embedded their chunks. */
  embedder: EmbeddingProvider
  /** The FALLBACK generation provider (env-selected; mock in every keyless
   *  stack). Since M3.5 an org's saved BYO credential outranks it at answer
   *  time — credentials/resolve.ts. */
  llm: LLMProvider
  /** HMAC secret for session tokens (resolveTokenSecret() at boot). */
  tokenSecret: string
  /** Groundedness threshold override (ANSWER_MAX_DISTANCE env at boot). */
  maxDistance?: number
  /** Per-org answers per UTC day. Flat default until per-plan caps arrive
   *  with M5 billing. */
  dailyAnswerCap?: number
  /** Injectable for tests; production uses the defaults below. */
  mintLimiter?: RateLimiter
  chatIpLimiter?: RateLimiter
  chatVisitorLimiter?: RateLimiter
}
//#endregion

//#region Constants
const DEFAULT_DAILY_ANSWER_CAP = 200
/** Mint: 10 burst / ~10 per minute per IP — a human opens one bubble. */
const MINT_CAPACITY = 10
const MINT_REFILL_PER_SECOND = 10 / 60
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

/** Start of the current UTC day — the daily cap's window. UTC (not org
 *  timezone) so the boundary is deterministic and cheap; M5 can refine. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

const VISITOR_ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/
//#endregion

//#region Routes
function configureWidgetRoutes(app: Express, options: WidgetRouteOptions): void {
  const dailyCap = options.dailyAnswerCap ?? DEFAULT_DAILY_ANSWER_CAP
  const mintLimiter = options.mintLimiter
    ?? new RateLimiter({ capacity: MINT_CAPACITY, refillPerSecond: MINT_REFILL_PER_SECOND })
  const chatIpLimiter = options.chatIpLimiter
    ?? new RateLimiter({ capacity: CHAT_IP_CAPACITY, refillPerSecond: CHAT_IP_REFILL_PER_SECOND })
  const chatVisitorLimiter = options.chatVisitorLimiter
    ?? new RateLimiter({ capacity: CHAT_VISITOR_CAPACITY, refillPerSecond: CHAT_VISITOR_REFILL_PER_SECOND })

  app.options("/v1/widget/session", preflight)
  app.options("/v1/widget/chat", preflight)
  app.options("/v1/widget/escalate", preflight)
  app.options("/v1/widget/handoff-ticket", preflight)

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

  // ── Session mint: the publishable key's ONLY moment ──────────────────────
  app.post("/v1/widget/session", async (req: Request, res: Response) => {
    try {
      const origin = req.headers.origin
      if (typeof origin !== "string" || origin.length === 0) {
        // No Origin, no session: every browser sends it on cross-origin
        // POSTs, so its absence means a script — which layer 3 exists for,
        // but there is no reason to hand scripts sessions for free.
        res.status(403).json({ error: "origin header required" })
        return
      }
      if (!mintLimiter.take(req.ip ?? "unknown")) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const publishableKey = body["publishableKey"]
      if (typeof publishableKey !== "string" || !publishableKey.startsWith("pk_")) {
        res.status(401).json({ error: "invalid publishable key" })
        return
      }
      const givenVisitor = body["visitorId"]
      if (givenVisitor !== undefined && (typeof givenVisitor !== "string" || !VISITOR_ID_SHAPE.test(givenVisitor))) {
        res.status(400).json({ error: "invalid visitorId" })
        return
      }

      const key = await options.db.selectFrom("api_keys")
        .select(["id", "org_id"])
        .where("kind", "=", "public")
        .where("public_id", "=", publishableKey)
        .where("revoked_at", "is", null)
        .executeTakeFirst()
      if (!key) {
        // Unknown and revoked collapse into one answer — key state is not
        // probeable from the outside.
        res.status(401).json({ error: "invalid publishable key" })
        return
      }

      const allowed = await options.db.selectFrom("allowed_origins")
        .select("origin")
        .where("org_id", "=", key.org_id)
        .where("origin", "=", origin)
        .executeTakeFirst()
      if (!allowed) {
        // No CORS headers on this path: an unlisted site's browser cannot
        // even read this error. Copy-pasted snippets die here.
        res.status(403).json({ error: "origin not allowed" })
        return
      }

      await options.db.updateTable("api_keys")
        .set({ last_used_at: new Date() })
        .where("id", "=", key.id)
        .execute()

      // This handshake fires at bubble-open, which is ALSO what warms Neon
      // during the seconds a human spends typing (the free-tier design:
      // the keepalive cron never touches the DB; the widget does, here).
      const visitorId = givenVisitor ?? `vis_${randomBytes(16).toString("hex")}`
      const minted = mintSessionToken({ org: key.org_id, origin, visitor: visitorId }, options.tokenSecret)
      corsHeaders(res, origin)
      res.json({ token: minted.token, expiresAt: minted.expiresAt, visitorId })
    } catch (err) {
      console.error("[widget] session mint failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })

  // ── Chat: token-authenticated SSE ────────────────────────────────────────
  app.post("/v1/widget/chat", async (req: Request, res: Response) => {
    try {
      const session = authenticate(req, res)
      if (session === null) return
      const origin = session.origin

      // Rate limits AFTER auth (so their 429s carry CORS headers and the
      // widget can render a "one moment" state) and BEFORE any real work.
      if (!chatIpLimiter.take(req.ip ?? "unknown") || !chatVisitorLimiter.take(`${session.org}:${session.visitor}`)) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      // The daily ceiling, checked BEFORE the model call. Counting
      // assistant rows (refusals included) makes the cap about model
      // spend, not conversation length.
      const dayStart = utcDayStart(new Date())
      const answered = await options.db.selectFrom("messages")
        .select(({ fn }) => fn.countAll<string>().as("n"))
        .where("org_id", "=", session.org)
        .where("role", "=", "assistant")
        .where("created_at", ">=", dayStart)
        .executeTakeFirst()
      if (Number(answered?.n ?? 0) >= dailyCap) {
        res.status(429).json({ error: "daily quota reached" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const question = typeof body["question"] === "string" ? body["question"].trim() : ""
      if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
        res.status(400).json({ error: `question must be 1-${MAX_QUESTION_CHARS} characters` })
        return
      }
      const conversationId = body["conversationId"]
      if (conversationId !== undefined && (typeof conversationId !== "string" || !isId("con", conversationId))) {
        res.status(400).json({ error: "invalid conversationId" })
        return
      }

      // SSE begins — headers flush NOW so time-to-first-byte is paid
      // before retrieval, not after. Every failure past this point is an
      // in-stream {type:"error"} event, not a status code.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        // Render sits us behind a proxy; without this hint it may buffer
        // the stream and turn token-by-token into all-at-once.
        "x-accel-buffering": "no",
        "access-control-allow-origin": origin,
        "vary": "origin",
      })

      // A closed tab must stop the token spend mid-generation.
      const aborter = new AbortController()
      req.on("close", () => aborter.abort())

      try {
        // Per-org BYO generation (M3.5): the org's saved credential decides
        // which model answers — decrypted here, inside realtime, for the
        // lifetime of this request only. The app-level llm (the env-selected
        // mock in every keyless stack) is the FALLBACK for orgs without a
        // credential, which is what keeps the demo org and CI keyless. A
        // resolve failure lands in the catch below: one opaque error event,
        // the truth in the server log.
        //
        // The embedding credential resolves the same way and for a
        // stricter reason (M3.6b): the question must be embedded by the
        // model that embedded the org's CHUNKS, or the dense arm searches
        // an empty space and the gate refuses everything. The ingest worker
        // resolves the identical row, so that agreement holds by
        // construction rather than by two settings matching.
        const [orgLLM, orgEmbedder] = await Promise.all([
          resolveGenerationProvider(options.db, session.org),
          resolveEmbeddingProvider(options.db, session.org),
        ])
        await answerQuestion({
          db: options.db,
          embedder: orgEmbedder ?? options.embedder,
          llm: orgLLM ?? options.llm,
          orgId: session.org,
          visitorId: session.visitor,
          question,
          ...(conversationId !== undefined ? { conversationId: conversationId as string } : {}),
          ...(options.maxDistance !== undefined ? { maxDistance: options.maxDistance } : {}),
          signal: aborter.signal,
          onEvent: (event) => sseWrite(res, event),
        })
      } catch (err) {
        if (!aborter.signal.aborted) {
          // Model contract failure, provider outage, hijacked-conversation
          // probe — the stream gets one opaque error event (details on a
          // public stream are reconnaissance) and the log gets the truth.
          console.error("[widget] answer failed:", err instanceof Error ? err.message : err)
          sseWrite(res, { type: "error" })
        }
      }
      res.end()
    } catch (err) {
      console.error("[widget] chat route failed:", err)
      if (!res.headersSent) res.status(500).json({ error: "internal error" })
      else res.end()
    }
  })

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

      if (!chatIpLimiter.take(req.ip ?? "unknown") || !chatVisitorLimiter.take(`${session.org}:${session.visitor}`)) {
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
export { configureWidgetRoutes, DEFAULT_DAILY_ANSWER_CAP }
export type { WidgetRouteOptions }
//#endregion
