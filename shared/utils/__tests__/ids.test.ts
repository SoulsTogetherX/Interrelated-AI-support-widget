//#region Imports
import { describe, expect, it } from "vitest"

import { isId, newId, newPublishableKey } from "../ids"
//#endregion

//#region Constants
// Every prefix in the registry, so format tests cover the whole closed union
// and adding a prefix without updating tests is caught by review, not luck.
const PREFIXES = ["org", "usr", "mem", "ses", "key", "ori", "src", "doc", "chk", "job"] as const
//#endregion

describe("newId", () => {
  it("produces <prefix>_<32 base32 chars> for every registered prefix", () => {
    for (const prefix of PREFIXES) {
      const id = newId(prefix)
      expect(id.startsWith(`${prefix}_`)).toBe(true)
      const body = id.slice(prefix.length + 1)
      expect(body).toHaveLength(32)
      expect(body).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{32}$/)
    }
  })

  it("never collides across 10,000 draws", () => {
    // 160 bits of entropy makes a real collision astronomically unlikely, so
    // any duplicate here means the generator is broken (e.g. a seeded or
    // truncated source), not that we got unlucky.
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) seen.add(newId("org"))
    expect(seen.size).toBe(10_000)
  })
})

describe("newPublishableKey", () => {
  it("produces pk_live_<32 base32 chars>, distinct per draw", () => {
    const key = newPublishableKey()
    // The pk_ prefix is what realtime's session route gates on before any
    // lookup (routes/widget.ts) — the cross-package contract under test.
    expect(key).toMatch(/^pk_live_[0-9abcdefghjkmnpqrstvwxyz]{32}$/)
    expect(newPublishableKey()).not.toBe(key)
  })

  it("is never mistakable for an api_keys row id", () => {
    // The credential and the row id must stay visibly different shapes.
    expect(isId("key", newPublishableKey())).toBe(false)
  })
})

describe("isId", () => {
  it("accepts every id newId produces", () => {
    for (const prefix of PREFIXES) {
      expect(isId(prefix, newId(prefix))).toBe(true)
    }
  })

  it("rejects an id under a different prefix", () => {
    // The cross-tenant bug this guards against: passing a user id where an
    // org id belongs. The prefix check is what makes that a loud failure.
    expect(isId("org", newId("usr"))).toBe(false)
  })

  // Boundary cases: exactly-right length passes (covered above); one short
  // and one long must both fail, as must the degenerate empty forms.
  it("rejects malformed bodies at and around the length boundary", () => {
    const good = newId("org")
    expect(isId("org", good.slice(0, -1))).toBe(false) // 31 chars
    expect(isId("org", `${good}0`)).toBe(false)        // 33 chars
    expect(isId("org", "org_")).toBe(false)            // empty body
    expect(isId("org", "org")).toBe(false)             // no underscore
    expect(isId("org", "")).toBe(false)                // empty string
  })

  it("rejects characters outside the Crockford alphabet", () => {
    const body = newId("org").slice(4)
    // 'i', 'l', 'o', 'u' are excluded from the alphabet; uppercase is never
    // emitted. Each substitution lands at position 0 — the boundary a lazy
    // regex with a missing anchor would miss.
    for (const bad of ["i", "l", "o", "u", "A", "_", "-"]) {
      expect(isId("org", `org_${bad}${body.slice(1)}`)).toBe(false)
    }
  })
})
