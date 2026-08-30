//#region Imports
import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  HANDOFF_TICKET_TTL_MS,
  TicketRegistry,
  mintHandoffTicket,
  verifyHandoffTicket,
} from "@/handoff/ticket"
import { mintSessionToken, verifySessionToken } from "@/widgetAuth/sessionToken"
//#endregion

//#region Test Setup
// Keyless and instant — tickets are pure crypto plus one in-memory set.
// The interesting cases are the ones a WebSocket upgrade actually faces:
// replay (the ticket rides in a URL, so it WILL be logged), expiry, and
// cross-type confusion with the session token it is derived from.
const SECRET = "handoff-ticket-test-secret-0123456789ab"
const FIELDS = { con: "con_x", org: "org_y", role: "visitor" as const, sub: "vis_z" }
//#endregion

describe("handoff tickets", () => {
  it("round-trips every field", () => {
    const { ticket, expiresAt } = mintHandoffTicket(FIELDS, SECRET)
    const payload = verifyHandoffTicket(ticket, SECRET)
    expect(payload).toMatchObject(FIELDS)
    expect(payload?.exp).toBe(expiresAt)
    expect(payload?.jti).toBeTruthy()
  })

  it("mints a distinct nonce every time — two tickets are never the same one", () => {
    const a = verifyHandoffTicket(mintHandoffTicket(FIELDS, SECRET).ticket, SECRET)
    const b = verifyHandoffTicket(mintHandoffTicket(FIELDS, SECRET).ticket, SECRET)
    expect(a?.jti).not.toBe(b?.jti)
  })

  it("expires exactly at exp, not a millisecond later", () => {
    const now = 1_000_000
    const { ticket } = mintHandoffTicket(FIELDS, SECRET, now)
    const exp = now + HANDOFF_TICKET_TTL_MS
    expect(verifyHandoffTicket(ticket, SECRET, exp - 1)).not.toBeNull()
    expect(verifyHandoffTicket(ticket, SECRET, exp)).toBeNull()
  })

  it("rejects tampering, the wrong secret, and garbage", () => {
    const { ticket } = mintHandoffTicket(FIELDS, SECRET)
    const [payload, signature] = ticket.split(".")

    // A payload edited to name another conversation.
    const forged = Buffer.from(
      JSON.stringify({ ...FIELDS, exp: Date.now() + 60_000, jti: "x" }),
    ).toString("base64url")
    expect(verifyHandoffTicket(`${forged}.${signature}`, SECRET)).toBeNull()
    // A flipped signature character — in the MIDDLE. The last base64url
    // character of a 32-byte MAC carries two padding bits, so replacing it
    // with "A" is a no-op whenever it was already A–D: a 1-in-16 flake this
    // suite carried until the M6 ladder hit it (§6.3 records the same
    // mistake in the probe).
    const mid = Math.floor((signature?.length ?? 0) / 2)
    const flipped = `${signature?.slice(0, mid)}${signature?.[mid] === "a" ? "b" : "a"}${signature?.slice(mid + 1)}`
    expect(verifyHandoffTicket(`${payload}.${flipped}`, SECRET)).toBeNull()
    expect(verifyHandoffTicket(ticket, "another-secret-0123456789abcdefghij")).toBeNull()
    expect(verifyHandoffTicket("not-a-ticket", SECRET)).toBeNull()
    expect(verifyHandoffTicket("", SECRET)).toBeNull()
    expect(verifyHandoffTicket(`${payload}.${signature}.extra`, SECRET)).toBeNull()
  })

  it("rejects a validly-signed ticket of the wrong SHAPE", () => {
    // Signed with the real key, but missing role/sub — the check that stops
    // a future refactor from admitting a half-populated payload.
    const key = createHmac("sha256", SECRET).update("interrelated/handoff-ticket/v1").digest()
    const encoded = Buffer.from(
      JSON.stringify({ con: "con_x", exp: Date.now() + 60_000 }),
    ).toString("base64url")
    const signature = createHmac("sha256", key).update(encoded).digest("base64url")
    expect(verifyHandoffTicket(`${encoded}.${signature}`, SECRET)).toBeNull()
  })

  it("is key-separated from session tokens — neither verifies as the other", () => {
    // Same env secret, two token types. Derivation is what keeps a
    // 30-minute session token from ever being spendable as an upgrade
    // ticket (and vice versa) regardless of payload shape.
    const session = mintSessionToken(
      { org: "org_y", origin: "https://a.test", visitor: "vis_z" },
      SECRET,
    )
    expect(verifyHandoffTicket(session.token, SECRET)).toBeNull()

    const { ticket } = mintHandoffTicket(FIELDS, SECRET)
    expect(verifySessionToken(ticket, SECRET)).toBeNull()
  })

  describe("single use", () => {
    it("admits a ticket once and never again", () => {
      const registry = new TicketRegistry()
      const exp = Date.now() + 60_000
      expect(registry.consume("jti-1", exp)).toBe(true)
      expect(registry.consume("jti-1", exp)).toBe(false)
      expect(registry.consume("jti-1", exp)).toBe(false)
      // A different ticket is unaffected.
      expect(registry.consume("jti-2", exp)).toBe(true)
    })

    it("sweeps only entries whose tickets already expired", () => {
      // The invariant that makes single-use airtight: an entry is dropped
      // only after the ticket it remembers could no longer be replayed
      // anyway, so a sweep can never re-open a spent ticket.
      let now = 1_000_000
      const registry = new TicketRegistry({ now: () => now })
      for (let i = 0; i < 10_000; i++) registry.consume(`old-${i}`, now + 1_000)
      expect(registry.size).toBe(10_000)

      now += 2_000 // every remembered ticket is now expired
      registry.consume("fresh", now + 60_000)
      expect(registry.size).toBe(1)
      // And a ticket old enough to have been swept cannot be replayed
      // anyway: the verifier rejects it on expiry, before the registry is
      // ever consulted. That ordering is what makes the sweep safe.
      const stale = mintHandoffTicket(FIELDS, SECRET, now - HANDOFF_TICKET_TTL_MS - 1)
      expect(verifyHandoffTicket(stale.ticket, SECRET, now)).toBeNull()
    })
  })
})
