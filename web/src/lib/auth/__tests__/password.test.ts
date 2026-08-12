// Keyless. scrypt round-trips are slow BY DESIGN (~100ms each) — the suite
// keeps the hash count low on purpose rather than pretending the KDF is
// cheap.
import { describe, expect, it } from "vitest"

import { hashPassword, verifyPassword } from "../password"

describe("password hashing", () => {
  it("round-trips and self-describes its parameters", async () => {
    const stored = await hashPassword("correct horse battery staple")
    // scrypt$N$saltHex$hashHex — the format that makes cost raises painless.
    const parts = stored.split("$")
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe("scrypt")
    expect(Number(parts[1])).toBe(32_768)
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true)
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false)
  })

  it("salts: the same password hashes differently twice", async () => {
    const a = await hashPassword("same-password")
    const b = await hashPassword("same-password")
    expect(a).not.toBe(b)
    // …but both verify.
    expect(await verifyPassword("same-password", a)).toBe(true)
    expect(await verifyPassword("same-password", b)).toBe(true)
  })

  it("rejects malformed stored values instead of throwing", async () => {
    // Every shape a corrupted or hostile password_hash could take: the
    // verifier must answer false, never crash a login route.
    for (const bad of [
      "",
      "plaintext",
      "scrypt$notanumber$aa$bb",
      "scrypt$16384$$bb", // empty salt
      "scrypt$16384$aa$", // empty hash
      "bcrypt$10$aa$bb", // wrong scheme
      "scrypt$16384$aa", // missing field
    ]) {
      expect(await verifyPassword("whatever", bad)).toBe(false)
    }
  })
})
