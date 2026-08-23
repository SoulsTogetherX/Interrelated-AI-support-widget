//#region Imports
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { signStripePayload, verifyStripeSignature } from "@/lib/stripe/signature"
//#endregion

//#region Test Setup
// Keyless — this is pure crypto over a documented string format. It is also
// the most security-critical file in the dashboard: the endpoint it guards
// is public and the thing it authorizes is "change what this tenant is
// entitled to", so the tests are mostly about what must be REFUSED.
const SECRET = "whsec_test_0123456789abcdefghijklmnop"
const NOW = new Date("2026-08-13T12:00:00Z")
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

const BODY = JSON.stringify({
  id: "evt_test_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_123", status: "active" } },
})
//#endregion

describe("stripe webhook signatures", () => {
  it("accepts a well-formed, fresh, correctly signed delivery", () => {
    const header = signStripePayload(BODY, SECRET, NOW_SECONDS)
    const result = verifyStripeSignature(BODY, header, SECRET, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.id).toBe("evt_test_1")
    expect(result.event.type).toBe("customer.subscription.updated")
    expect(result.event.data.object.id).toBe("sub_123")
  })

  it("rejects a body altered after signing", () => {
    // The whole point: an attacker who can replay a captured delivery must
    // not be able to change which org or which plan it names.
    const header = signStripePayload(BODY, SECRET, NOW_SECONDS)
    const tampered = BODY.replace("sub_123", "sub_evil")
    const result = verifyStripeSignature(tampered, header, SECRET, { now: NOW })
    expect(result).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects a signature made with a different secret", () => {
    const header = signStripePayload(BODY, "whsec_someone_elses_secret", NOW_SECONDS)
    const result = verifyStripeSignature(BODY, header, SECRET, { now: NOW })
    expect(result).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects a REPLAY outside the tolerance window, in both directions", () => {
    // The timestamp is inside the MAC, so it cannot be edited — which is
    // exactly what makes it usable as a replay bound. Without this check a
    // captured "downgrade to free" is valid forever.
    const stale = signStripePayload(BODY, SECRET, NOW_SECONDS - 301)
    expect(verifyStripeSignature(BODY, stale, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: "stale" })
    // A timestamp far in the FUTURE is as suspicious as one far in the
    // past, and clock skew cuts both ways.
    const future = signStripePayload(BODY, SECRET, NOW_SECONDS + 301)
    expect(verifyStripeSignature(BODY, future, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: "stale" })
    // At the boundary it is still good.
    const edge = signStripePayload(BODY, SECRET, NOW_SECONDS - 300)
    expect(verifyStripeSignature(BODY, edge, SECRET, { now: NOW }).ok).toBe(true)
  })

  it("accepts a delivery carrying MULTIPLE v1 signatures if any matches", () => {
    // This is how Stripe's endpoint-secret rotation works: during the
    // overlap, both the old and the new secret sign every event. Taking
    // only the first signature would break every rotation — precisely the
    // operation a webhook secret must not discourage.
    const ours = createHmac("sha256", SECRET).update(`${NOW_SECONDS}.${BODY}`).digest("hex")
    const theirs = createHmac("sha256", "whsec_previous").update(`${NOW_SECONDS}.${BODY}`).digest("hex")
    expect(verifyStripeSignature(BODY, `t=${NOW_SECONDS},v1=${theirs},v1=${ours}`, SECRET, { now: NOW }).ok).toBe(true)
    expect(verifyStripeSignature(BODY, `t=${NOW_SECONDS},v1=${ours},v1=${theirs}`, SECRET, { now: NOW }).ok).toBe(true)
  })

  it("rejects malformed headers instead of throwing", () => {
    // A public endpoint receives garbage. Every one of these must be an
    // ordinary 400, not a 500 with a stack trace: timingSafeEqual throws on
    // a length mismatch, which is why the compare checks length first.
    const cases = [
      null,
      "",
      "garbage",
      `t=${NOW_SECONDS}`, // no signature
      "v1=abc", // no timestamp
      `t=not-a-number,v1=abc`,
      // Exotic numeric spellings are refused rather than normalized — the
      // same stance as the SSRF guard's address parsing.
      `t=1e9,v1=abc`,
      `t=${NOW_SECONDS},v1=nothex!!`,
      // A short forgery: timingSafeEqual would throw on the length
      // mismatch if the compare did not guard it.
      `t=${NOW_SECONDS},v1=ab`,
    ]
    for (const header of cases) {
      const result = verifyStripeSignature(BODY, header, SECRET, { now: NOW })
      expect(result.ok).toBe(false)
    }
  })

  it("rejects a correctly signed body that is not a Stripe event", () => {
    // Signature valid, shape wrong. Whoever holds the secret can sign
    // anything; the handler still needs an id and a type, and a payload
    // without them must not reach the applier.
    for (const body of ["not json", "[]", "null", '{"type":"x"}', '{"id":"evt_1"}', '{"id":"","type":"x"}']) {
      const header = signStripePayload(body, SECRET, NOW_SECONDS)
      const result = verifyStripeSignature(body, header, SECRET, { now: NOW })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe("malformed_body")
    }
  })

  it("tolerates an event with no data object rather than failing", () => {
    // Some Stripe event types genuinely carry nothing useful. They are
    // recorded and ignored downstream, so verification must let them
    // through as an empty object rather than rejecting a legitimate,
    // correctly signed delivery.
    const body = JSON.stringify({ id: "evt_2", type: "ping" })
    const header = signStripePayload(body, SECRET, NOW_SECONDS)
    const result = verifyStripeSignature(body, header, SECRET, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.data.object).toEqual({})
  })
})
