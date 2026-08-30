//#region Imports
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import type { HandoffRole } from "@shared/handoff/protocol"
//#endregion

//#region Type Defs
/**
 * Handoff socket tickets (M4.2) — identity at UPGRADE, the pattern the plan
 * names: authenticate before the WebSocket handshake completes, never after.
 *
 * Why a ticket at all, when both ends already hold a credential (the visitor
 * a session token, the agent a dashboard cookie)? Because a browser cannot
 * set headers on a WebSocket handshake. The credential therefore has to ride
 * in the URL, and a URL is the worst place in the system to put one: it
 * lands in access logs, proxy logs, and error reports. So neither long-lived
 * credential goes there. Each side spends its real credential on an ordinary
 * authenticated POST, receives a ticket that is good for SIXTY SECONDS and
 * exactly ONE upgrade, and puts that in the URL instead. A ticket recovered
 * from a log is already spent, already expired, or both.
 *
 * Single-use is the half that needs state, and it is deliberately in-memory:
 * this deployment is exactly one always-on instance (Render's free tier
 * funds one), so a shared store would be a second stateful service
 * defending against a topology that cannot occur. The honest limitation,
 * which belongs in the README next to the rate limiter's: a second instance
 * would need the consumed set — and the room registry — in Redis. That is
 * the one place where "a second worker is a deploy, not a rewrite" stops
 * being true for this codebase, and saying so is better than implying
 * otherwise.
 */
interface HandoffTicketPayload {
  /** Conversation this ticket opens. A ticket is not a session — it admits
   *  its holder to exactly one room. */
  con: string
  org: string
  role: HandoffRole
  /** Visitor id or dashboard user id, depending on role. Becomes the
   *  connection's identity; the socket never takes identity from a frame. */
  sub: string
  /** Unix ms expiry. */
  exp: number
  /** Single-use nonce. */
  jti: string
}
//#endregion

//#region Constants
/** 60s: the plan's number, and the right one — a ticket exists to survive
 *  the milliseconds between "mint" and "connect", not to be storable. */
const HANDOFF_TICKET_TTL_MS = 60 * 1000
/** Consumed ids are swept once the map passes this, rather than on a timer:
 *  no interval handle to leak, and the map only grows when tickets are
 *  actually being spent. Same stance as widget/rateLimit.ts. */
const SWEEP_THRESHOLD = 10_000
//#endregion

//#region Key separation
/**
 * Tickets are signed with a key DERIVED from the widget token secret rather
 * than with the secret itself. One env var, two token types, zero risk of
 * cross-acceptance: a session token can never verify as a ticket even if a
 * future refactor made their payload shapes overlap, because the keys
 * differ. The label is versioned so the derivation can change without
 * silently accepting old tickets.
 */
function ticketKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("interrelated/handoff-ticket/v1").digest()
}
//#endregion

//#region Codec
function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url")
}

function mintHandoffTicket(
  fields: { con: string; org: string; role: HandoffRole; sub: string },
  secret: string,
  now: number = Date.now(),
): { ticket: string; expiresAt: number } {
  const expiresAt = now + HANDOFF_TICKET_TTL_MS
  const payload: HandoffTicketPayload = {
    ...fields,
    exp: expiresAt,
    // 128 bits: the nonce only has to be unique among tickets alive in a
    // 60-second window, and this is unguessable besides.
    jti: randomBytes(16).toString("base64url"),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return { ticket: `${encoded}.${sign(encoded, ticketKey(secret))}`, expiresAt }
}

/** Signature, then expiry, then SHAPE — payload or null, never a reason.
 *  Same stance as the session token: which check failed is not information
 *  an upgrade attempt gets to learn. */
// eslint-disable-next-line complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function verifyHandoffTicket(
  ticket: string,
  secret: string,
  now: number = Date.now(),
): HandoffTicketPayload | null {
  const dot = ticket.indexOf(".")
  if (dot === -1 || ticket.indexOf(".", dot + 1) !== -1) return null
  const encoded = ticket.slice(0, dot)
  const given = Buffer.from(ticket.slice(dot + 1), "base64url")
  const want = Buffer.from(sign(encoded, ticketKey(secret)), "base64url")
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const c = parsed as Record<string, unknown>
  if (
    typeof c["con"] !== "string" ||
    typeof c["org"] !== "string" ||
    (c["role"] !== "visitor" && c["role"] !== "agent") ||
    typeof c["sub"] !== "string" ||
    typeof c["exp"] !== "number" ||
    typeof c["jti"] !== "string"
  )
    return null
  if (c["exp"] <= now) return null
  return {
    con: c["con"],
    org: c["org"],
    role: c["role"],
    sub: c["sub"],
    exp: c["exp"],
    jti: c["jti"],
  }
}
//#endregion

//#region Single use
/**
 * The consumed-ticket registry. `consume` returns true the FIRST time it
 * sees a jti and false forever after (until the entry is swept, which
 * cannot happen before the ticket has expired anyway — the entry outlives
 * the ticket by construction, so a replay can never slip through a sweep).
 */
class TicketRegistry {
  readonly #consumed = new Map<string, number>()
  readonly #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  consume(jti: string, expiresAt: number): boolean {
    if (this.#consumed.has(jti)) return false
    if (this.#consumed.size >= SWEEP_THRESHOLD) this.#sweep()
    this.#consumed.set(jti, expiresAt)
    return true
  }

  /** Drops entries whose tickets are already expired — they can no longer
   *  be replayed, so remembering them buys nothing. */
  #sweep(): void {
    const now = this.#now()
    for (const [jti, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(jti)
    }
  }

  /** Test/observability hook. */
  get size(): number {
    return this.#consumed.size
  }
}
//#endregion

//#region Exports
export { mintHandoffTicket, verifyHandoffTicket, TicketRegistry, HANDOFF_TICKET_TTL_MS }

//#endregion
