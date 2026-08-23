// Keyless. The allowlist is trust-model layer 1, and every case here is a
// way a stored entry could silently never match the browser's Origin
// header — which reads as "the allowlist mysteriously doesn't work"
// (§3.3's CHECK comment says exactly this).
import { describe, expect, it } from "vitest"

import { validateOrigin } from "../index"

describe("validateOrigin", () => {
  it("passes a plain origin through unchanged", () => {
    expect(validateOrigin("https://docs.example.com")).toEqual({
      ok: true,
      value: "https://docs.example.com",
    })
  })

  it("normalizes what customers actually paste", () => {
    // Each of these would be a permanently-non-matching row if stored raw.
    const cases: Array<[string, string]> = [
      ["https://docs.example.com/", "https://docs.example.com"],
      ["  https://docs.example.com/help/faq?x=1#top  ", "https://docs.example.com"],
      ["https://DOCS.Example.COM", "https://docs.example.com"],
      ["https://docs.example.com:8443/path", "https://docs.example.com:8443"],
      ["http://localhost:3000/fixtures/a.html", "http://localhost:3000"],
    ]
    for (const [input, expected] of cases) {
      expect(validateOrigin(input)).toEqual({ ok: true, value: expected })
    }
  })

  it("keeps a non-default port and drops a default one, like the browser does", () => {
    // The Origin header omits :443 for https and :80 for http; storing them
    // would make the comparison fail.
    expect(validateOrigin("https://a.example:443")).toEqual({
      ok: true,
      value: "https://a.example",
    })
    expect(validateOrigin("http://a.example:80")).toEqual({
      ok: true,
      value: "http://a.example",
    })
    expect(validateOrigin("https://a.example:8443")).toEqual({
      ok: true,
      value: "https://a.example:8443",
    })
  })

  it("requires an explicit scheme rather than guessing one", () => {
    // Guessing https for someone's allowlist would be us deciding their
    // security posture.
    const bare = validateOrigin("docs.example.com")
    expect(bare.ok).toBe(false)
    if (bare.ok) return
    expect(bare.error).toContain("scheme")
  })

  it("rejects non-http schemes, credentials, blanks, and non-strings", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "   ",
      "ftp://files.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@docs.example.com",
      "not a url at all",
    ]) {
      expect(validateOrigin(bad).ok).toBe(false)
    }
  })

  it("rejects the null origin — what a file:// page sends", () => {
    // A sandboxed iframe or file:// page sends `Origin: null`; allowlisting
    // the literal string would open the widget to every one of them.
    expect(validateOrigin("null").ok).toBe(false)
  })

  it("produces only values the schema CHECK accepts", () => {
    // The CHECK is `^https?://[^/]+$` — the backstop this validator must
    // never hand a violation to, since a constraint error is a 500 the
    // tenant cannot act on.
    const inputs = [
      "https://docs.example.com/deep/path?q=1",
      "http://localhost:4400/",
      "https://a.example:8443",
    ]
    for (const input of inputs) {
      const result = validateOrigin(input)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.value).toMatch(/^https?:\/\/[^/]+$/)
    }
  })
})
