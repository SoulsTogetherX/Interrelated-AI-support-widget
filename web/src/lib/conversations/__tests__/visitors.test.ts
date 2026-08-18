// Keyless. How the dashboard names the other party (M7.3): an anonymous
// browser handle is truncated, a server-identified user is shown whole and
// labelled — and the split is by the SAME shape rule realtime enforces on
// its two mint routes (shared/utils/visitorIds.ts), so what this file calls
// "identified" is exactly what only the tenant's secret key could have put
// in a session.
import { describe, expect, it } from "vitest"

import { newAnonymousVisitorId } from "@shared/utils/visitorIds"

import { IDENTIFIED_SUFFIX, describeVisitor } from "../visitors"

describe("describeVisitor", () => {
  it("truncates an anonymous handle to twelve characters, as a visitor", () => {
    const id = newAnonymousVisitorId()
    const described = describeVisitor(id)
    expect(described).toEqual({ noun: "visitor", name: `${id.slice(0, 12)}…`, identified: false })
    expect(described.name.length).toBe(13)
  })

  it("names a server-identified user in full", () => {
    for (const id of ["42", "usr_8f3a91", "550e8400-e29b-41d4-a716-446655440000"]) {
      expect(describeVisitor(id)).toEqual({ noun: "user", name: id, identified: true })
    }
  })

  it("does not mistake a near-anonymous shape for anonymity — the browser route would refuse it, so a server minted it", () => {
    const nearMiss = `vis_${"a".repeat(31)}`
    expect(describeVisitor(nearMiss).identified).toBe(true)
  })

  it("carries the reason the name can be trusted", () => {
    expect(IDENTIFIED_SUFFIX).toMatch(/identified by your server/)
  })
})
