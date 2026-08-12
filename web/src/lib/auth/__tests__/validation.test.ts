// Keyless. Boundaries tested AT the boundary on both sides (the length
// caps), not just with a comfortable middle case.
import { describe, expect, it } from "vitest"

import { validateEmail, validatePassword } from "../validation"

describe("validateEmail", () => {
  it("normalizes case and whitespace", () => {
    const result = validateEmail("  Person@EXAMPLE.com ")
    expect(result).toEqual({ ok: true, value: "person@example.com" })
  })

  it("rejects non-strings and obvious nonsense", () => {
    for (const bad of [undefined, null, 42, "", "nope", "a@b", "@x.com", "a b@x.com"]) {
      expect(validateEmail(bad).ok).toBe(false)
    }
  })

  it("accepts 254 characters and rejects 255", () => {
    // 254 is the SMTP path limit. Local part padded to hit the totals.
    const domain = "@example.com" // 12 chars
    const local254 = "a".repeat(254 - domain.length)
    expect(validateEmail(local254 + domain).ok).toBe(true)
    expect(validateEmail("a" + local254 + domain).ok).toBe(false)
  })
})

describe("validatePassword", () => {
  it("accepts 8 characters and rejects 7", () => {
    expect(validatePassword("eight-ch").ok).toBe(true)
    expect(validatePassword("seven-c").ok).toBe(false)
  })

  it("accepts 200 characters and rejects 201", () => {
    expect(validatePassword("x".repeat(200)).ok).toBe(true)
    expect(validatePassword("x".repeat(201)).ok).toBe(false)
  })

  it("rejects the common-password floor case-insensitively", () => {
    expect(validatePassword("Password123").ok).toBe(false)
    expect(validatePassword("interrelated").ok).toBe(false)
  })

  it("rejects non-strings", () => {
    expect(validatePassword(undefined).ok).toBe(false)
    expect(validatePassword(12345678).ok).toBe(false)
  })
})
