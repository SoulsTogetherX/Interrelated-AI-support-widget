// Keyless — runs against the dev-fallback secrets (NODE_ENV is not
// production under vitest, so the fail-closed branch cannot fire here; that
// branch is exercised by reading it, and the boot wiring is
// instrumentation.ts's job).
import { describe, expect, it } from "vitest"

import {
  blindIndexEquals,
  decryptEmail,
  emailBlindIndex,
  encryptEmail,
} from "../emailCrypto"

const USER_ID = "usr_00000000000000000000000000000000"
const OTHER_ID = "usr_11111111111111111111111111111111"

describe("email encryption", () => {
  it("round-trips under the owning user id", () => {
    const ct = encryptEmail("person@example.com", USER_ID)
    expect(ct.startsWith("v1.")).toBe(true)
    expect(ct).not.toContain("person@example.com")
    expect(decryptEmail(ct, USER_ID)).toBe("person@example.com")
  })

  it("fails closed when the ciphertext is moved to another row (AAD)", () => {
    // The swap attack the AAD binding exists for: an attacker with write
    // access relocates a ciphertext to learn whose it is. GCM must refuse.
    const ct = encryptEmail("person@example.com", USER_ID)
    expect(() => decryptEmail(ct, OTHER_ID)).toThrow()
  })

  it("fails closed on tampering and truncation", () => {
    const ct = encryptEmail("person@example.com", USER_ID)
    const parts = ct.split(".")
    // Flip one character inside the ciphertext part.
    const dataChar = parts[3][0] === "A" ? "B" : "A"
    const tampered = [parts[0], parts[1], parts[2], dataChar + parts[3].slice(1)].join(".")
    expect(() => decryptEmail(tampered, USER_ID)).toThrow()
    expect(() => decryptEmail("v1.only.three", USER_ID)).toThrow()
    expect(() => decryptEmail("v2." + parts.slice(1).join("."), USER_ID)).toThrow()
  })

  it("randomizes the IV: same plaintext encrypts differently", () => {
    const a = encryptEmail("person@example.com", USER_ID)
    const b = encryptEmail("person@example.com", USER_ID)
    expect(a).not.toBe(b)
  })
})

describe("blind index", () => {
  it("is deterministic per address and distinct across addresses", async () => {
    const [a1, a2, b] = await Promise.all([
      emailBlindIndex("person@example.com"),
      emailBlindIndex("person@example.com"),
      emailBlindIndex("other@example.com"),
    ])
    expect(a1).toBe(a2) // what makes lookup possible
    expect(a1).not.toBe(b)
    expect(a1).not.toContain("person") // one-way: no plaintext residue
  })

  it("compares in constant time semantics: equal, unequal, length mismatch", async () => {
    const a = await emailBlindIndex("person@example.com")
    const b = await emailBlindIndex("other@example.com")
    expect(blindIndexEquals(a, a)).toBe(true)
    expect(blindIndexEquals(a, b)).toBe(false)
    expect(blindIndexEquals(a, a.slice(2))).toBe(false)
  })
})
