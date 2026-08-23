//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createCheckoutSession, createPortalSession, stripeConfig } from "@/lib/stripe/client"
//#endregion

//#region Test Setup
// A loopback fake standing in for api.stripe.com, recording every request
// so the assertions are about what LEFT this process — the same shape as
// the internal-API and provider suites. What a real Stripe would answer is
// their business; what we send is ours, and this is the half that can be
// wrong in a way nobody notices until a webhook arrives with no metadata.
interface Recorded {
  path: string
  auth: string | undefined
  version: string | undefined
  contentType: string | undefined
  form: URLSearchParams
}

let server: Server
let baseUrl: string
let recorded: Recorded[] = []
let reply: { status: number; body: unknown } = { status: 200, body: { url: "https://checkout.stripe.test/c/pay/x" } }

const TEST_KEY = "sk_test_fake_0123456789"

function setEnv(overrides: Record<string, string | undefined>): void {
  const defaults: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_WEBHOOK_SECRET: "whsec_fake",
    STRIPE_PRICE_STARTER: "price_starter_123",
    STRIPE_PRICE_PRO: "price_pro_456",
    STRIPE_API_BASE: baseUrl,
  }
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
//#endregion

describe("stripe client", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        recorded.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          version: req.headers["stripe-version"] as string | undefined,
          contentType: req.headers["content-type"],
          form: new URLSearchParams(body),
        })
        res.writeHead(reply.status, { "content-type": "application/json" })
        res.end(JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    setEnv({
      STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_STARTER: undefined, STRIPE_PRICE_PRO: undefined, STRIPE_API_BASE: undefined,
    })
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    recorded = []
    reply = { status: 200, body: { url: "https://checkout.stripe.test/c/pay/x" } }
    setEnv({})
  })

  it("REFUSES a live secret key, loudly", () => {
    // The guard that makes this deployment safe to leave running: a
    // portfolio demo that could charge a real card is a liability, not a
    // feature, and removing this is a deliberate one-line act.
    setEnv({ STRIPE_SECRET_KEY: "sk_live_realmoney" })
    expect(() => stripeConfig()).toThrow(/live Stripe key/i)
  })

  it("reports absence as absence, not as an error", () => {
    // No key at all is NORMAL — a fresh checkout, a preview deployment, a
    // self-hoster who does not want billing. The surfaces degrade to
    // read-only rather than crashing.
    setEnv({ STRIPE_SECRET_KEY: undefined })
    expect(stripeConfig()).toBeNull()
    setEnv({ STRIPE_WEBHOOK_SECRET: undefined })
    expect(stripeConfig()).toBeNull()
  })

  it("creates a subscription Checkout carrying org and plan on the SUBSCRIPTION", async () => {
    const result = await createCheckoutSession({
      orgId: "org_abc", plan: "pro",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(result).toEqual({ ok: true, value: { url: "https://checkout.stripe.test/c/pay/x" } })

    const call = recorded[0]!
    expect(call.path).toBe("/checkout/sessions")
    expect(call.auth).toBe(`Bearer ${TEST_KEY}`)
    // Pinned so a Stripe upgrade cannot silently change a response shape.
    expect(call.version).toBe("2025-08-27.basil")
    expect(call.contentType).toBe("application/x-www-form-urlencoded")
    expect(call.form.get("mode")).toBe("subscription")
    expect(call.form.get("line_items[0][price]")).toBe("price_pro_456")
    // The load-bearing pair: metadata on the SUBSCRIPTION, not only on the
    // session, is what makes every later customer.subscription.* event
    // already say which tenant and tier it is about — no price-id lookup
    // table to keep in sync with Stripe's dashboard.
    expect(call.form.get("subscription_data[metadata][orgId]")).toBe("org_abc")
    expect(call.form.get("subscription_data[metadata][planId]")).toBe("pro")
    expect(call.form.get("client_reference_id")).toBe("org_abc")
    // No customer id was passed, so none is sent — Stripe creates one.
    expect(call.form.has("customer")).toBe(false)
  })

  it("reuses an existing customer so a returning tenant has one billing history", async () => {
    await createCheckoutSession({
      orgId: "org_abc", plan: "starter", customerId: "cus_existing",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(recorded[0]!.form.get("customer")).toBe("cus_existing")
    expect(recorded[0]!.form.get("line_items[0][price]")).toBe("price_starter_123")
  })

  it("refuses a plan with no configured price rather than checking out the wrong one", async () => {
    setEnv({ STRIPE_PRICE_PRO: undefined })
    const result = await createCheckoutSession({
      orgId: "org_abc", plan: "pro",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(result).toEqual({ ok: false, error: "No Stripe price is configured for the pro plan." })
    expect(recorded).toHaveLength(0)
  })

  it("surfaces Stripe's own error message and never the key", async () => {
    reply = { status: 400, body: { error: { message: "No such price: 'price_pro_456'" } } }
    const result = await createCheckoutSession({
      orgId: "org_abc", plan: "pro",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("No such price")
    // Errors end up in logs; a request header must never travel with them.
    expect(result.error).not.toContain(TEST_KEY)
    expect(result.error).not.toContain("Bearer")
  })

  it("treats a 200 with no URL as a failure rather than redirecting nowhere", async () => {
    reply = { status: 200, body: { id: "cs_test_1" } }
    const result = await createCheckoutSession({
      orgId: "org_abc", plan: "pro",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(result).toEqual({ ok: false, error: "Stripe returned a session with no checkout URL." })
  })

  it("opens a portal session for an existing customer", async () => {
    reply = { status: 200, body: { url: "https://billing.stripe.test/p/session/x" } }
    const result = await createPortalSession({
      customerId: "cus_existing", returnUrl: "https://app.test/dashboard/org_abc/billing",
    })
    expect(result).toEqual({ ok: true, value: { url: "https://billing.stripe.test/p/session/x" } })
    expect(recorded[0]!.path).toBe("/billing_portal/sessions")
    expect(recorded[0]!.form.get("customer")).toBe("cus_existing")
  })

  it("says billing is unconfigured instead of calling an unauthenticated Stripe", async () => {
    setEnv({ STRIPE_SECRET_KEY: undefined })
    const result = await createCheckoutSession({
      orgId: "org_abc", plan: "pro",
      successUrl: "https://app.test/done", cancelUrl: "https://app.test/cancel",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("not configured")
    expect(recorded).toHaveLength(0)
  })
})
