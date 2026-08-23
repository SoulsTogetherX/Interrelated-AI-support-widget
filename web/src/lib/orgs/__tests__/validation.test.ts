// Keyless. Boundary cases at the boundary, both sides.
import { describe, expect, it } from "vitest"

import { validateOrgName } from "../index"

describe("validateOrgName", () => {
  it("trims and accepts a normal name", () => {
    expect(validateOrgName("  Acme Support  ")).toEqual({
      ok: true,
      value: "Acme Support",
    })
  })

  it("accepts 2 characters and rejects 1 (post-trim)", () => {
    expect(validateOrgName("ab").ok).toBe(true)
    expect(validateOrgName("a").ok).toBe(false)
    expect(validateOrgName("  a  ").ok).toBe(false)
  })

  it("accepts 64 characters and rejects 65", () => {
    expect(validateOrgName("x".repeat(64)).ok).toBe(true)
    expect(validateOrgName("x".repeat(65)).ok).toBe(false)
  })

  it("rejects non-strings", () => {
    expect(validateOrgName(undefined).ok).toBe(false)
    expect(validateOrgName(42).ok).toBe(false)
  })
})
