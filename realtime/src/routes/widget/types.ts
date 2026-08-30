//#region Imports
import type { Request, Response } from "express"
import type { Kysely } from "kysely"

import type { Database } from "@/db/schema"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { LLMProvider } from "@providers/llm/types"
import type { MintOutcome } from "@/usage/origins"
import { RateLimiter } from "@/widgetAuth/rateLimit"
import type { SessionTokenPayload } from "@/widgetAuth/sessionToken"
//#endregion

//#region Types
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
  /** Deadline override for the whole answer (ANSWER_DEADLINE_MS env at
   *  boot; pipeline default 60 s — see DEFAULT_ANSWER_DEADLINE_MS for the
   *  measured arithmetic behind the number). Unlike dailyAnswerCap below,
   *  this may move in EITHER direction: it is an operational bound with no
   *  cross-layer contract to break — a deployment fronting a slow
   *  self-hosted model legitimately widens it, a demo legitimately
   *  tightens it. */
  answerDeadlineMs?: number
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

/** Everything the registrars share, built once in index.ts: the four
 *  token buckets (escalate deliberately REUSES chat's visitor bucket),
 *  the token+origin auth ladder, and the layer-4 origin counter. */
interface WidgetContext {
  mintLimiter: RateLimiter
  serverMintLimiter: RateLimiter
  chatIpLimiter: RateLimiter
  chatVisitorLimiter: RateLimiter
  authenticate: (req: Request, res: Response) => SessionTokenPayload | null
  countOrigin: (orgId: string, origin: string, outcome: MintOutcome) => Promise<void>
}
//#endregion

//#region Exports
export type { WidgetRouteOptions, WidgetContext }
//#endregion
