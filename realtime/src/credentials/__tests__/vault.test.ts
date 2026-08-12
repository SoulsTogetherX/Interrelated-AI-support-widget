// Keyless — the vault is pure crypto over env config. Each test sets
// CREDENTIAL_MASTER_KEY itself (worker threads own a private process.env
// copy, so this cannot leak into other files).
import { randomBytes } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"

import { decryptProviderKey, encryptProviderKey, hasMasterKey, keySuffix } from "../vault"

const CRED_ID = "prv_00000000000000000000000000000000"
const OTHER_ID = "prv_11111111111111111111111111111111"

afterEach(() => {
  delete process.env.CREDENTIAL_MASTER_KEY
})

function armVault(): void {
  process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64")
}

describe("credential vault", () => {
  it("round-trips under the owning row id and never emits plaintext", () => {
    armVault()
    const ct = encryptProviderKey("gsk_live_supersecretvalue123", CRED_ID)
    expect(ct.startsWith("v1.")).toBe(true)
    expect(ct).not.toContain("supersecret")
    expect(decryptProviderKey(ct, CRED_ID)).toBe("gsk_live_supersecretvalue123")
  })

  it("fails closed when a ciphertext is moved to another row (AAD)", () => {
    armVault()
    const ct = encryptProviderKey("gsk_live_supersecretvalue123", CRED_ID)
    expect(() => decryptProviderKey(ct, OTHER_ID)).toThrow()
  })

  it("fails closed on tampering and format garbage", () => {
    armVault()
    const ct = encryptProviderKey("gsk_live_supersecretvalue123", CRED_ID)
    const parts = ct.split(".")
    const flipped = parts[3][0] === "A" ? "B" : "A"
    const tampered = [parts[0], parts[1], parts[2], flipped + parts[3].slice(1)].join(".")
    expect(() => decryptProviderKey(tampered, CRED_ID)).toThrow()
    expect(() => decryptProviderKey("v2." + parts.slice(1).join("."), CRED_ID)).toThrow()
    expect(() => decryptProviderKey("not-a-payload", CRED_ID)).toThrow()
  })

  it("refuses to operate without a real 32-byte key — NO dev fallback", () => {
    // The deliberate difference from email crypto: a provider key is real
    // even in dev, so there is no published-constant fallback to fall into.
    expect(hasMasterKey()).toBe(false)
    expect(() => encryptProviderKey("anything", CRED_ID)).toThrow(/CREDENTIAL_MASTER_KEY/)
    process.env.CREDENTIAL_MASTER_KEY = Buffer.from("short").toString("base64")
    expect(() => encryptProviderKey("anything", CRED_ID)).toThrow(/32 bytes/)
  })

  it("derives the display suffix without touching crypto", () => {
    expect(keySuffix("gsk_live_supersecretvalue123")).toBe("e123")
  })
})
