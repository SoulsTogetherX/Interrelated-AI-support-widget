//#region Imports
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { mintSessionToken, verifySessionToken, SESSION_TOKEN_TTL_MS } from "@/widget/sessionToken"
//#endregion

//#region Test Setup
const SECRET = "test-secret-with-enough-length-0123456789"
const FIELDS = { org: "org_a", origin: "https://docs.example.com", visitor: "vis_1" }
const NOW = 1_700_000_000_000
//#endregion

describe("session tokens", () => {
  it("round-trips the org, origin, visitor binding", () => {
    const { token, expiresAt } = mintSessionToken(FIELDS, SECRET, NOW)
    expect(expiresAt).toBe(NOW + SESSION_TOKEN_TTL_MS)
    const payload = verifySessionToken(token, SECRET, NOW + 1000)
    expect(payload).toEqual({ ...FIELDS, exp: expiresAt })
  })

  it("verifies at one ms before expiry and rejects AT expiry — the boundary", () => {
    const { token, expiresAt } = mintSessionToken(FIELDS, SECRET, NOW)
    expect(verifySessionToken(token, SECRET, expiresAt - 1)).not.toBeNull()
    expect(verifySessionToken(token, SECRET, expiresAt)).toBeNull()
  })

  it("rejects a tampered payload — the signature covers every field", () => {
    const { token } = mintSessionToken(FIELDS, SECRET, NOW)
    const [payload, sig] = token.split(".") as [string, string]
    const forged = Buffer.from(
      JSON.stringify({ ...FIELDS, org: "org_victim", exp: NOW + SESSION_TOKEN_TTL_MS }),
    ).toString("base64url")
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull()
    // And a tampered signature against the honest payload.
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A")
    expect(verifySessionToken(`${payload}.${flipped}`, SECRET, NOW)).toBeNull()
  })

  it("rejects a token minted under a different secret", () => {
    const { token } = mintSessionToken(FIELDS, "another-secret-also-long-enough-000000", NOW)
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull()
  })

  it("rejects malformed inputs without throwing", () => {
    for (const garbage of ["", "no-dot", "a.b.c", "!!!.???", "eyJv.sig"]) {
      expect(verifySessionToken(garbage, SECRET, NOW)).toBeNull()
    }
  })

  it("rejects a VALIDLY SIGNED payload whose fields are the wrong shape", () => {
    // Signed with the real secret but structurally wrong — a bug in a
    // future minter must not become a valid session. The signature check
    // passes here by construction (same HMAC recipe as the implementation),
    // so this pins the shape validation specifically.
    const sigOf = (payload: string) =>
      createHmac("sha256", SECRET).update(payload).digest().toString("base64url")
    for (const fields of [
      { org: 42, origin: "https://a.com", visitor: "v", exp: NOW + 60_000 },
      { org: "org_a", origin: "https://a.com", visitor: "v" }, // no exp
      "just a string",
      null,
    ]) {
      const payload = Buffer.from(JSON.stringify(fields)).toString("base64url")
      expect(verifySessionToken(`${payload}.${sigOf(payload)}`, SECRET, NOW)).toBeNull()
    }
  })
})
