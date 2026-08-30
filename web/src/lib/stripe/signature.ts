//#region Why this file
// Stripe webhook signature verification (M5.4) — the only thing standing
// between a public URL and an UPDATE on organizations.plan. Anyone can POST
// to a webhook endpoint; what makes a payload trustworthy is that it is
// signed with a secret only Stripe and this deployment hold.
//
// Hand-rolled rather than `stripe.webhooks.constructEvent`, for the reason
// the RRF fusion and the session tokens are hand-rolled: this is 40 lines
// of HMAC over a documented string format, it is the security-critical part
// of the integration, and reading it is how someone convinces themselves it
// is right. The trade is stated in client.ts, which is where the argument
// for the SDK is strongest and still loses.
//
// The scheme (Stripe's `Stripe-Signature` header):
//
//     t=1737054000,v1=5257a869e7...,v1=8a1b...
//
// The signed payload is `${t}.${rawBody}` — the timestamp is INSIDE the
// MAC, which is what makes it tamper-proof and therefore usable as a replay
// bound. Verification is three checks in this order, and each one matters:
//
//   1. The MAC matches, compared in CONSTANT TIME. A byte-by-byte early
//      exit leaks how much of a forged signature was right, and a few
//      thousand requests turn that into a valid one.
//   2. The timestamp is within tolerance. Without it a captured-and-
//      replayed request is valid forever, and "downgrade this org to free"
//      is a request worth capturing.
//   3. The body parses as JSON with an event id and type.
//
// MULTIPLE v1 signatures are accepted if ANY matches, because that is how
// Stripe's endpoint-secret rotation works: during the overlap both the old
// and new secrets sign every event. Taking only the first would break
// every rotation, which is precisely the operation this must not
// discourage.
//#endregion

//#region Imports
import { createHmac, timingSafeEqual } from "node:crypto"
//#endregion

//#region Types
export interface StripeEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export type VerifyResult =
  | { ok: true; event: StripeEvent }
  | { ok: false; reason: "malformed_header" | "bad_signature" | "stale" | "malformed_body" }
//#endregion

//#region Constants
/** Stripe's own default tolerance. Five minutes is generous enough to
 *  survive clock skew between their servers and ours, and short enough that
 *  a captured request is worthless by the time anyone reads a log. */
const DEFAULT_TOLERANCE_SECONDS = 300
//#endregion

//#region Helpers
/** Parses `t=…,v1=…,v1=…` without trusting its shape. Returns null rather
 *  than throwing: a malformed header is an ordinary hostile request, not an
 *  exceptional condition. */
function parseHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") {
      // Integer seconds only. Number("1e9") is a number; a timestamp is not
      // written that way, and accepting exotic spellings here is the same
      // class of mistake as accepting 0x7f000001 as an IP (§3.10.1).
      if (!/^\d{1,15}$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === "v1") {
      if (/^[0-9a-f]+$/i.test(value)) signatures.push(value.toLowerCase())
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

/** Constant-time compare of two hex digests. Length is compared first and
 *  in the clear — the digest length is a property of the ALGORITHM, not of
 *  the secret, so it leaks nothing, while timingSafeEqual throws on a length
 *  mismatch and would otherwise turn a short forgery into a 500. */
function digestsMatch(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length) return false
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"))
}
//#endregion

//#region Exports
/**
 * Verifies a webhook delivery and returns the parsed event.
 *
 * `rawBody` must be the EXACT bytes Stripe sent — the signature covers the
 * body verbatim, so anything that re-serializes it (a JSON body parser, a
 * pretty-printer) invalidates the MAC. That is why the route handler reads
 * `await req.text()` and parses only afterwards.
 *
 * The failure reason is returned for LOGGING, never for the response body:
 * telling an unauthenticated caller whether their signature was wrong or
 * merely stale is an oracle, so the route answers 400 either way.
 */
// eslint-disable-next-line complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed_header" }
  const parsed = parseHeader(header)
  if (!parsed) return { ok: false, reason: "malformed_header" }

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`, "utf8")
    .digest("hex")
  // Signature BEFORE freshness: the timestamp is only meaningful once the
  // MAC has proven nobody chose it. Checking staleness first would be
  // answering a question about attacker-controlled data.
  if (!parsed.signatures.some((candidate) => digestsMatch(expected, candidate))) {
    return { ok: false, reason: "bad_signature" }
  }

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000)
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  // Absolute difference: a timestamp far in the FUTURE is as suspicious as
  // one far in the past, and clock skew cuts both ways.
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "stale" }
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: "malformed_body" }
  }
  if (typeof body !== "object" || body === null) return { ok: false, reason: "malformed_body" }
  const event = body as Record<string, unknown>
  if (typeof event.id !== "string" || event.id === "" || typeof event.type !== "string") {
    return { ok: false, reason: "malformed_body" }
  }
  const data = event.data
  const object =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).object : undefined

  return {
    ok: true,
    event: {
      id: event.id,
      type: event.type,
      data: {
        object: (typeof object === "object" && object !== null ? object : {}) as Record<
          string,
          unknown
        >,
      },
    },
  }
}

/** Signs a payload the way Stripe does. Exported for TESTS only — a
 *  verifier tested against fixtures its own author generated proves the
 *  format was implemented consistently, which is exactly what a signature
 *  check must be. Nothing in the application signs webhooks. */
export function signStripePayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex")
  return `t=${timestampSeconds},v1=${signature}`
}

//#endregion
