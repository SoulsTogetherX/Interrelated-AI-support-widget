//#region Imports
import { describe, expect, it } from "vitest"

import {
  ANONYMOUS_VISITOR_ID_SHAPE,
  VISITOR_ID_SHAPE,
  isAnonymousVisitorId,
  isIdentifiedVisitorId,
  newAnonymousVisitorId,
} from "../visitorIds"
//#endregion

// The two namespaces must be DISJOINT by construction: every value is
// anonymous, identified, or malformed — never two of those. That is the
// property both session routes lean on (realtime/src/routes/widget.ts), so
// it is asserted here rather than assumed there.
describe("visitor id namespaces", () => {
  it("mints anonymous ids as vis_ + 32 hex, distinct per draw", () => {
    const id = newAnonymousVisitorId()
    expect(id).toMatch(ANONYMOUS_VISITOR_ID_SHAPE)
    expect(id).toMatch(VISITOR_ID_SHAPE)
    expect(newAnonymousVisitorId()).not.toBe(id)
  })

  it("classifies a minted anonymous id as anonymous and NOT identified", () => {
    const id = newAnonymousVisitorId()
    expect(isAnonymousVisitorId(id)).toBe(true)
    expect(isIdentifiedVisitorId(id)).toBe(false)
  })

  it("classifies a customer's user id as identified and NOT anonymous", () => {
    // The shapes a customer's backend will actually send: an integer id, a
    // prefixed id, a UUID, a ULID.
    for (const id of [
      "42",
      "usr_8f3a91",
      "550e8400-e29b-41d4-a716-446655440000",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]) {
      expect(isIdentifiedVisitorId(id)).toBe(true)
      expect(isAnonymousVisitorId(id)).toBe(false)
    }
  })

  it("keeps the anonymous namespace exact — a near miss is identified, not anonymous", () => {
    // 31 hex characters, uppercase hex, and a different prefix are all
    // well-formed ids a server could mint but a browser must not — and a
    // browser presenting them must be refused, so they must NOT read as
    // anonymous.
    const hex32 = "0123456789abcdef0123456789abcdef"
    for (const nearMiss of [
      `vis_${hex32.slice(1)}`,
      `vis_${hex32.toUpperCase()}`,
      `vis-${hex32}`,
      `vix_${hex32}`,
    ]) {
      expect(isAnonymousVisitorId(nearMiss)).toBe(false)
      expect(isIdentifiedVisitorId(nearMiss)).toBe(true)
    }
  })

  it("rejects malformed values from BOTH namespaces", () => {
    // Spaces, punctuation an email carries, an empty string, and 101
    // characters: not an id of either kind. (An email is refused on
    // purpose — the docs say to send a user id, so our database never
    // becomes a copy of the customer's address book.)
    for (const bad of ["", "has space", "alice@example.com", "a/b", "x".repeat(101)]) {
      expect(isAnonymousVisitorId(bad)).toBe(false)
      expect(isIdentifiedVisitorId(bad)).toBe(false)
    }
    // …while exactly 100 characters is still an id (the schema's ceiling).
    expect(isIdentifiedVisitorId("x".repeat(100))).toBe(true)
  })
})
