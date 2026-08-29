//#region Imports
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
//#endregion

//#region Type Defs
/**
 * Widget session tokens — trust-model layer 2. The publishable key is
 * spent ONCE, at bubble-open, on POST /v1/widget/session (where the
 * origin check bites); every subsequent message authenticates with one of
 * these instead. So the pk is not a bearer credential for chat — it is an
 * application for one.
 *
 * Hand-rolled HMAC token, not a JWT library: the payload is four fields,
 * the algorithm is fixed (HS256-equivalent), and JWT's flexibility —
 * pluggable algorithms, unverified-decode APIs — is precisely its
 * historical vulnerability surface. base64url(payload).base64url(hmac).
 *
 * The token BINDS org + origin + visitor: the chat route re-checks the
 * live Origin header against token.origin, so a token exfiltrated to
 * another site fails even before rate limits; visitor binding is what
 * stops one visitor continuing another's conversation.
 */
interface SessionTokenPayload {
  org: string
  origin: string
  visitor: string
  /** Unix ms expiry. Short-lived: the widget re-mints on expiry, and the
   *  re-mint repeats the origin check — a revoked origin dies within TTL. */
  exp: number
}
//#endregion

//#region Constants
/** 30 min: long enough that a support conversation never re-mints
 *  mid-thought, short enough that a leaked token is a bounded problem. */
const SESSION_TOKEN_TTL_MS = 30 * 60 * 1000
//#endregion

//#region Codec
function b64url(buffer: Buffer): string {
  return buffer.toString("base64url")
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest())
}

function mintSessionToken(
  fields: { org: string; origin: string; visitor: string },
  secret: string,
  now: number = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_TOKEN_TTL_MS
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...fields, exp: expiresAt } satisfies SessionTokenPayload)),
  )
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt }
}

/**
 * Verifies signature THEN expiry, returning the payload or null — never a
 * reason string, because "invalid" and "expired" being distinguishable to
 * a caller is fine but distinguishable to an ATTACKER is an oracle; the
 * route maps null to one uniform 401. timingSafeEqual on the signature:
 * a byte-by-byte compare leaks how much of a forged signature matched.
 */
function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionTokenPayload | null {
  const dot = token.indexOf(".")
  if (dot === -1 || token.indexOf(".", dot + 1) !== -1) return null
  const payload = token.slice(0, dot)
  const givenSig = token.slice(dot + 1)
  const wantSig = sign(payload, secret)
  const given = Buffer.from(givenSig, "base64url")
  const want = Buffer.from(wantSig, "base64url")
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate["org"] !== "string" ||
    typeof candidate["origin"] !== "string" ||
    typeof candidate["visitor"] !== "string" ||
    typeof candidate["exp"] !== "number"
  )
    return null
  if (candidate["exp"] <= now) return null
  return {
    org: candidate["org"],
    origin: candidate["origin"],
    visitor: candidate["visitor"],
    exp: candidate["exp"],
  }
}

/**
 * The signing secret, from WIDGET_TOKEN_SECRET — or an ephemeral random
 * one when unset. Ephemeral is the correct dev default: tokens die on
 * restart (harmless — the widget re-mints) and there is no
 * hardcoded-secret footgun to ship. Production sets the env var so tokens
 * survive deploys; render.yaml marks it sync:false like the DB password.
 */
function resolveTokenSecret(): string {
  // Empty string counts as unset: compose pass-throughs materialize
  // ${WIDGET_TOKEN_SECRET:-} as "" when the host has no value, and that
  // must mean "use ephemeral", not "fail the boot".
  const configured = process.env.WIDGET_TOKEN_SECRET || undefined
  if (configured !== undefined && configured.length >= 32) return configured
  if (configured !== undefined) {
    // A short secret is worse than a random one — refuse to limp.
    throw new Error("WIDGET_TOKEN_SECRET must be at least 32 characters")
  }
  console.warn(
    "[widget] WIDGET_TOKEN_SECRET unset — using an ephemeral secret (sessions die on restart)",
  )
  return randomBytes(32).toString("base64url")
}
//#endregion

//#region Exports
export { mintSessionToken, verifySessionToken, resolveTokenSecret, SESSION_TOKEN_TTL_MS }
export type { SessionTokenPayload }
//#endregion
