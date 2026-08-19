//#region Imports
import type { Express, Request, Response } from "express"
import { sql } from "kysely"
import type { Kysely } from "kysely"

import type { Database } from "@/db/schema"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { LLMProvider } from "@providers/llm/types"
import type { AnswerEvent } from "@shared/grounding/events"
import { hashSecretKey, isId } from "@shared/utils/ids"
import { isAnonymousVisitorId, isIdentifiedVisitorId, newAnonymousVisitorId } from "@shared/utils/visitorIds"
import { answerQuestion } from "@/answer/pipeline"
import { resolveEmbeddingProvider, resolveGenerationProvider } from "@/credentials/resolve"
import { requestHandoff } from "@/handoff/escalate"
import { mintHandoffTicket } from "@/handoff/ticket"
import { getDailyQuota } from "@/usage/daily"
import { looksLikeOrigin, recordOriginMint } from "@/usage/origins"
import type { MintOutcome } from "@/usage/origins"
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
 *      buckets, then a per-org answers-per-day cap (since M5.3 the plan's,
 *      read from the usage_daily counter) checked BEFORE the model call —
 *      the worst case is a stopped widget, never a surprise bill.
 *   4. Per-origin visibility (M7.2, §3.28): every mint attempt that names
 *      an org is counted per Origin, minted or refused, so a copied
 *      snippet shows up in the dashboard as a name and a number rather
 *      than being inferred from a bill. Layer 1 stops it; layer 4 shows it.
 *   5. Rotation (M7.1, §9.17): a key inside its grace window is still live
 *      here — the lookup below is where that rule is enforced.
 *   6. Server-side session minting (M7.3): POST /v1/sessions, where a
 *      customer's OWN backend presents the SECRET key to mint a session for
 *      a user it has authenticated. The page then carries no publishable
 *      key at all — nothing worth copying — and only that customer's
 *      logged-in users can open a conversation. Same token, same chat
 *      route; only the mint differs. The one route here a browser never
 *      calls: no Origin gate (a server has none), no CORS (a browser page
 *      must not be able to use a secret key even by mistake).
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
  /**
   * A SECOND platform provider, tried when the first one is still failing
   * after its retries (M7.7, LLM_FALLBACK_PROVIDER). Optional, and unset in
   * every keyless stack.
   *
   * The rule that makes this safe is enforced at the call site below and is
   * worth stating here too: it is a fallback for the PLATFORM's provider
   * only, never for a tenant's. An org that configured their own key chose a
   * vendor, a model, and a data processor; answering their visitor from our
   * key on a different vendor would send their customers' questions
   * somewhere they never agreed to, bill us for it, charge it against the
   * wrong quota, and change the answer's quality profile without saying so.
   * A transient 429 does not justify any of that — an honest failure does
   * less harm. What this exists for is the demo: one always-on service on
   * free tiers, where a daily cap on our own key is exactly the "the demo
   * dies mid-visit" risk the plan names.
   */
  llmFallback?: LLMProvider
  /** HMAC secret for session tokens (resolveTokenSecret() at boot). */
  tokenSecret: string
  /** Groundedness threshold override (ANSWER_MAX_DISTANCE env at boot). */
  maxDistance?: number
  /** A deployment-wide ceiling on answers per org per UTC day
   *  (WIDGET_DAILY_ANSWER_CAP). Since M5.3 the cap normally comes from the
   *  org's PLAN (shared/billing/plans.ts); this can only TIGHTEN it, never
   *  widen it — see the chat route for why that direction is the only safe
   *  one. Unset means the plan alone decides. */
  dailyAnswerCap?: number
  /** Injectable for tests; production uses the defaults below. */
  mintLimiter?: RateLimiter
  serverMintLimiter?: RateLimiter
  chatIpLimiter?: RateLimiter
  chatVisitorLimiter?: RateLimiter
}
//#endregion

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

//#region Routes
function configureWidgetRoutes(app: Express, options: WidgetRouteOptions): void {
  const mintLimiter = options.mintLimiter
    ?? new RateLimiter({ capacity: MINT_CAPACITY, refillPerSecond: MINT_REFILL_PER_SECOND })
  const serverMintLimiter = options.serverMintLimiter
    ?? new RateLimiter({ capacity: SERVER_MINT_CAPACITY, refillPerSecond: SERVER_MINT_REFILL_PER_SECOND })
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

  /** Layer 4's per-origin counter (§3.28). AWAITED, so the counter is
   *  visible the moment the response is — a dashboard that lagged the
   *  widget would make "is that copy still out there?" unanswerable — but
   *  never allowed to fail the mint: instrumentation is not the product,
   *  and a visitor must get their session even if this table is having a
   *  bad day. */
  const countOrigin = async (orgId: string, origin: string, outcome: MintOutcome): Promise<void> => {
    try {
      await recordOriginMint(options.db, { orgId, origin, outcome })
    } catch (err) {
      console.error("[widget] origin counter failed:", err)
    }
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
      // A browser may hand back ONLY an anonymous id (vis_<hex>, the shape
      // this route itself mints and the widget stores). Any other id is
      // refused: an IDENTIFIED visitor — a customer's own user id, which is
      // guessable — can be minted only by that customer's server through
      // POST /v1/sessions below, and letting a page claim one would let
      // anyone on an allowlisted origin impersonate user 42 to the support
      // agent reading the inbox (shared/utils/visitorIds.ts).
      const givenVisitor = body["visitorId"]
      if (givenVisitor !== undefined && (typeof givenVisitor !== "string" || !isAnonymousVisitorId(givenVisitor))) {
        res.status(400).json({ error: "invalid visitorId" })
        return
      }

      // A key is live while revoked_at is NULL — or still in the FUTURE:
      // rotation (web/src/lib/keys, M7.1) schedules the old key's revocation
      // at the end of a grace window rather than killing it on the click, so
      // a snippet the customer has not yet updated keeps working. Postgres's
      // clock decides, not this process's: the dashboard wrote that instant
      // with NOW() on Neon, and Render's clock is a different machine's.
      const key = await options.db.selectFrom("api_keys")
        .select(["id", "org_id"])
        .where("kind", "=", "public")
        .where("public_id", "=", publishableKey)
        .where((eb) => eb.or([
          eb("revoked_at", "is", null),
          eb("revoked_at", ">", sql<Date>`NOW()`),
        ]))
        .executeTakeFirst()
      if (!key) {
        // Unknown, revoked, and past-its-grace collapse into one answer —
        // key state is not probeable from the outside.
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
        // even read this error. Copy-pasted snippets die here — and are
        // COUNTED here (layer 4, §3.28): the key named the org, so the
        // tenant gets to see which origin presented it. Refusals for a
        // missing Origin or a bad key are not counted: neither names an org
        // without a lookup this route deliberately does not spend on them.
        await countOrigin(key.org_id, origin, "refused")
        res.status(403).json({ error: "origin not allowed" })
        return
      }

      // Stamped on Postgres's clock: the dashboard shows "last used" beside
      // "accepted until", and the latter is NOW() on Neon (§9.17), so the
      // two must be read off the same clock or a retiring key can look used
      // after it stopped being accepted.
      await options.db.updateTable("api_keys")
        .set({ last_used_at: sql`NOW()` })
        .where("id", "=", key.id)
        .execute()
      await countOrigin(key.org_id, origin, "minted")

      // This handshake fires at bubble-open, which is ALSO what warms Neon
      // during the seconds a human spends typing (the free-tier design:
      // the keepalive cron never touches the DB; the widget does, here).
      const visitorId = givenVisitor ?? newAnonymousVisitorId()
      const minted = mintSessionToken({ org: key.org_id, origin, visitor: visitorId }, options.tokenSecret)
      corsHeaders(res, origin)
      res.json({ token: minted.token, expiresAt: minted.expiresAt, visitorId })
    } catch (err) {
      console.error("[widget] session mint failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })

  // ── Server-side session mint: the SECRET key's only moment (M7.3) ────────
  // Trust-model layer 6, "the strong mode". The customer's backend — never a
  // browser — presents the sk_… key to mint a session for a user IT has
  // authenticated, then hands the token to its page (the widget fetches it
  // from an endpoint on the customer's own site, widget/src/api.ts). The
  // page carries no publishable key at all, so there is nothing on it worth
  // copying, and only that customer's logged-in users can open a chat. Same
  // token as the browser mint, same chat route, same everything after — the
  // ONLY difference is who proves what at the mint:
  //
  //   · identity: the visitorId is the customer's own stable user id, and it
  //     must be IDENTIFIED-shaped (anything but vis_<hex>) — the anonymous
  //     namespace belongs to the browser route, and the two never overlap,
  //     which is what lets an agent trust that "user 42" is user 42.
  //   · origin: the customer's server names the origin its page runs on
  //     (a server sends no Origin header of its own), the token binds to it
  //     like any other, and it must be allowlisted — the allowlist is the
  //     one statement of where the widget may run, and layer 4 counts the
  //     attempt either way, so a forgotten allowlist entry shows up in the
  //     dashboard with an Allow button rather than as a mystery 403.
  //   · CORS: never. There is no preflight handler and no echo, so a browser
  //     page cannot use this route even if a customer mistakenly put their
  //     secret key in it — the browser refuses to read the response, which
  //     is the right feedback. A secret key belongs on a server.
  //
  // Refusals are uniform where an outsider could probe them (missing,
  // malformed, unknown, revoked, and past-grace keys are ONE 401 — key
  // state is not probeable, exactly as for the publishable key) and
  // helpful where the caller has already proven who they are: an
  // authenticated tenant's server gets a sentence saying why its origin or
  // visitor id was refused, because that is its own configuration to fix.
  //
  // Named /v1/sessions rather than under /v1/widget/ on purpose: the
  // /v1/widget/* routes are the ones a browser calls (Origin-gated, CORS);
  // this one is called by a server with a bearer credential — a different
  // caller and a different posture, and a path that says so.
  app.post("/v1/sessions", async (req: Request, res: Response) => {
    try {
      if (!serverMintLimiter.take(req.ip ?? "unknown")) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      const auth = req.headers.authorization
      const secretKey = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
      if (!secretKey.startsWith("sk_")) {
        // The publishable key presented here, garbage, or nothing at all: a
        // shape refusal that never reaches the database — and byte-identical
        // to the unknown-key answer below.
        res.status(401).json({ error: "invalid secret key" })
        return
      }
      // Live means the same thing it means for the publishable key: revoked_at
      // NULL, or still in the FUTURE — a rotation's grace window keeps the
      // old secret working until the customer has redeployed their backend
      // with the new one (§9.17), decided on Postgres's clock.
      const key = await options.db.selectFrom("api_keys")
        .select(["id", "org_id"])
        .where("kind", "=", "secret")
        .where("secret_hash", "=", hashSecretKey(secretKey))
        .where((eb) => eb.or([
          eb("revoked_at", "is", null),
          eb("revoked_at", ">", sql<Date>`NOW()`),
        ]))
        .executeTakeFirst()
      if (!key) {
        res.status(401).json({ error: "invalid secret key" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const visitorId = body["visitorId"]
      if (typeof visitorId !== "string" || !isIdentifiedVisitorId(visitorId)) {
        res.status(400).json({
          error: "invalid visitorId",
          detail:
            "visitorId must be your own stable identifier for the signed-in user " +
            "(1-100 characters of A-Z a-z 0-9 _ -); the vis_… form is reserved for " +
            "anonymous browser sessions. Send a user id, not an email address.",
        })
        return
      }
      const origin = body["origin"]
      if (typeof origin !== "string" || origin.length === 0) {
        res.status(400).json({
          error: "invalid origin",
          detail: "origin is required: the exact origin your page runs on, e.g. https://app.example.com",
        })
        return
      }

      const allowed = await options.db.selectFrom("allowed_origins")
        .select("origin")
        .where("org_id", "=", key.org_id)
        .where("origin", "=", origin)
        .executeTakeFirst()
      if (!allowed) {
        // Counted (layer 4): the key named the org, and a server naming an
        // unlisted origin is the tenant's OWN configuration to see and fix —
        // the dashboard's traffic table gets the row and the Allow button.
        await countOrigin(key.org_id, origin, "refused")
        res.status(403).json({
          error: "origin not allowed",
          detail: looksLikeOrigin(origin)
            ? "this origin is not on the organization's allowlist — allow it on the dashboard's Install page"
            : "origin must be a browser origin: scheme://host[:port] with no path or trailing slash, e.g. https://app.example.com",
        })
        return
      }

      // last_used_at, on the database's clock as above: for a retiring
      // secret key this is how the owner can see their OLD backend config
      // is still out there before revoking it early.
      await options.db.updateTable("api_keys")
        .set({ last_used_at: sql`NOW()` })
        .where("id", "=", key.id)
        .execute()
      await countOrigin(key.org_id, origin, "minted")

      // The same response shape as the browser mint, so the customer's
      // endpoint can proxy it to the widget verbatim.
      const minted = mintSessionToken({ org: key.org_id, origin, visitor: visitorId }, options.tokenSecret)
      res.json({ token: minted.token, expiresAt: minted.expiresAt, visitorId })
    } catch (err) {
      console.error("[widget] server session mint failed:", err)
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

      // The daily ceiling, checked BEFORE the model call — the plan's
      // promise that the worst case is a stopped widget, never a surprise
      // bill. Since M5.3 the number comes from the org's PLAN and the count
      // from usage_daily, so this is one primary-key-shaped read whose cost
      // does not grow with the tenant's traffic (it used to scan the day's
      // messages, which ran before EVERY question and got slower the more
      // successful the customer became).
      //
      // The env override can only TIGHTEN the plan's cap, never widen it:
      // one mistyped variable that handed every tenant an unlimited
      // allowance is precisely the failure a quota exists to prevent.
      const quota = await getDailyQuota(options.db, session.org, {
        overrideLimit: options.dailyAnswerCap,
      })
      if (quota?.exceeded) {
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
          // Only when the org has NO credential of its own — see the option's
          // comment. A tenant's provider failing is the tenant's to see.
          ...(orgLLM === null && options.llmFallback !== undefined
            ? { llmFallback: options.llmFallback }
            : {}),
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
export { configureWidgetRoutes }
export type { WidgetRouteOptions }
//#endregion
