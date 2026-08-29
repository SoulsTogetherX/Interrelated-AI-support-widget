//#region Why this file
// The Stripe REST calls this product makes, which is two: create a Checkout
// Session, and create a Billing Portal Session. Server-only — the secret
// key lives in env and nothing client-side can import this.
//
// **Why not the `stripe` SDK.** The honest case FOR it is real: retries,
// idempotency keys, API-version pinning, typed responses, and a decade of
// edge cases. The case against, for this product: we call two endpoints,
// both of which take a form-encoded body and return JSON, and the only
// security-critical piece — webhook signature verification — is 40 lines we
// would rather have someone read than trust (signature.ts). Against that,
// the SDK is several megabytes in a serverless bundle and a version
// coupling to maintain. If this grew invoices, refunds, tax, or usage-based
// billing, that trade flips and the SDK is the right answer; it is written
// here so the reversal is a decision rather than a rediscovery.
//
// **Test mode only, enforced.** A live secret key is REFUSED by config()
// with a named error. This is a portfolio deployment that must cost $0 and
// must never charge a real card: a demo that could take money is a
// liability, not a feature. Removing the guard is a one-line, deliberate
// act — which is the point.
//#endregion

//#region Imports
import type { PlanId } from "@shared/billing/plans"
//#endregion

//#region Types
export type StripeResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface StripeConfig {
  secretKey: string
  webhookSecret: string
  /** Stripe Price ids for the paid tiers. `free` has no price — it is the
   *  absence of a subscription, not a $0 one, so there is nothing to buy
   *  and nothing to look up. */
  prices: Partial<Record<Exclude<PlanId, "free">, string>>
}
//#endregion

//#region Constants
const STRIPE_API = "https://api.stripe.com/v1"

const NOT_CONFIGURED =
  "Billing is not configured on this deployment — STRIPE_SECRET_KEY and " +
  "STRIPE_WEBHOOK_SECRET must both be set."

const LIVE_KEY_REFUSED =
  "This deployment refuses a live Stripe key: it is a demo and must never " +
  "charge a real card. Use a test-mode key (sk_test_…)."
//#endregion

//#region Config
/**
 * The billing configuration, or null when this deployment has none.
 *
 * Absence is a NORMAL state — a fresh checkout, a Vercel preview, a
 * self-hoster who does not want billing — so it surfaces as null and every
 * surface degrades to read-only, the same stance lib/realtime takes toward
 * an unset internal secret. A LIVE key, by contrast, is a misconfiguration
 * worth shouting about rather than silently honoring.
 */
export function stripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) return null
  if (!secretKey.startsWith("sk_test_")) {
    // Thrown, not returned: a live key in this deployment is an operator
    // mistake with money attached, and the loudest failure is the kindest.
    throw new Error(LIVE_KEY_REFUSED)
  }
  return {
    secretKey,
    webhookSecret,
    prices: {
      ...(process.env.STRIPE_PRICE_STARTER ? { starter: process.env.STRIPE_PRICE_STARTER } : {}),
      ...(process.env.STRIPE_PRICE_PRO ? { pro: process.env.STRIPE_PRICE_PRO } : {}),
    },
  }
}

/** Where the Stripe API lives. Overridable ONLY through an env var a test
 *  sets, so the suite can point at a loopback fake — the same seam shape as
 *  safeFetch's hostGuard and validate.ts's url vet. Production never sets
 *  it, and the default is a constant rather than configuration. */
function apiBase(): string {
  return process.env.STRIPE_API_BASE ?? STRIPE_API
}
//#endregion

//#region Requests
/**
 * One POST to Stripe. Form-encoded, because that is what their API takes —
 * including the bracket notation for nested fields, which is why the caller
 * builds flat key/value pairs rather than an object graph.
 *
 * The error path never echoes the key or the URL: a Stripe error message is
 * safe to show a tenant ("No such price: price_…"), a request header is
 * not, and errors end up in logs. Same rule as providers/llm/http.ts.
 */
async function post(
  path: string,
  form: Record<string, string>,
  config: StripeConfig,
): Promise<StripeResult<Record<string, unknown>>> {
  let res: Response
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Pinning the API version means a Stripe upgrade cannot silently
        // change a response shape under a deployment nobody is watching.
        "stripe-version": "2025-08-27.basil",
      },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return { ok: false, error: "Could not reach Stripe." }
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // Non-JSON (a proxy error page) — the status check below still holds.
  }
  if (!res.ok) {
    const error = body.error as { message?: unknown } | undefined
    const message =
      typeof error?.message === "string" ? error.message : `Stripe request failed (${res.status}).`
    return { ok: false, error: message }
  }
  return { ok: true, value: body }
}
//#endregion

//#region Exports
/**
 * A Checkout Session for one org upgrading to one plan.
 *
 * Two details carry the webhook side of this. `client_reference_id` and
 * `metadata` name the org on the SESSION, and `subscription_data[metadata]`
 * copies org and plan onto the SUBSCRIPTION itself — so every later
 * `customer.subscription.*` event arrives already saying which tenant and
 * which tier it is about. The alternative is a price-id → plan lookup table
 * that has to stay in sync with Stripe's dashboard; carrying the answer on
 * the object is one less thing to keep true.
 */
export async function createCheckoutSession(args: {
  orgId: string
  plan: Exclude<PlanId, "free">
  successUrl: string
  cancelUrl: string
  customerId?: string | undefined
}): Promise<StripeResult<{ url: string }>> {
  const config = stripeConfig()
  if (!config) return { ok: false, error: NOT_CONFIGURED }
  const price = config.prices[args.plan]
  if (!price) {
    return { ok: false, error: `No Stripe price is configured for the ${args.plan} plan.` }
  }

  const form: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.orgId,
    "metadata[orgId]": args.orgId,
    "metadata[planId]": args.plan,
    "subscription_data[metadata][orgId]": args.orgId,
    "subscription_data[metadata][planId]": args.plan,
    ...(args.customerId ? { customer: args.customerId } : {}),
  }
  const result = await post("/checkout/sessions", form, config)
  if (!result.ok) return result
  const url = result.value.url
  if (typeof url !== "string") {
    return { ok: false, error: "Stripe returned a session with no checkout URL." }
  }
  return { ok: true, value: { url } }
}

/**
 * A Billing Portal session — Stripe's own hosted page for changing a card,
 * downgrading, or cancelling. Deliberately not rebuilt in this dashboard:
 * every one of those flows is a payment surface with regulatory weight, and
 * the interesting engineering here is the webhook that makes their outcome
 * true in our database, not a second copy of their UI.
 */
export async function createPortalSession(args: {
  customerId: string
  returnUrl: string
}): Promise<StripeResult<{ url: string }>> {
  const config = stripeConfig()
  if (!config) return { ok: false, error: NOT_CONFIGURED }
  const result = await post(
    "/billing_portal/sessions",
    {
      customer: args.customerId,
      return_url: args.returnUrl,
    },
    config,
  )
  if (!result.ok) return result
  const url = result.value.url
  if (typeof url !== "string") {
    return { ok: false, error: "Stripe returned a portal session with no URL." }
  }
  return { ok: true, value: { url } }
}

export { NOT_CONFIGURED, LIVE_KEY_REFUSED }
//#endregion
