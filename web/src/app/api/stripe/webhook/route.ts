//#region Why this file
// The Stripe webhook endpoint (M5.4) — the one PUBLIC route in the
// dashboard, and the only unauthenticated request in the system that can
// change what a tenant is entitled to. Everything about it is shaped by
// that: the signature is checked before the body is trusted, the event id
// is the deduplication, and the response says as little as possible.
//
// It lives in web/ rather than realtime/ for the reason the whole
// control-plane split exists: this is a short request/response with no
// stream and no socket, and it belongs beside the billing tables it writes.
//
// Route-handler details that are load-bearing:
//   · `req.text()`, never `req.json()`. The signature covers the exact
//     bytes Stripe sent, so anything that re-serializes the body
//     invalidates it.
//   · runtime "nodejs" — the verifier uses node:crypto, and the edge
//     runtime has no such module.
//   · dynamic "force-dynamic" — a cached webhook response would be an
//     absurdity, and Next's default for a POST route is already dynamic;
//     saying so out loud costs one line and removes the question.
//#endregion

//#region Imports
import { applyStripeEvent } from "@/lib/billing/apply"
import { stripeConfig } from "@/lib/stripe/client"
import { verifyStripeSignature } from "@/lib/stripe/signature"
//#endregion

//#region Config
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
//#endregion

//#region Handler
export async function POST(req: Request): Promise<Response> {
  const config = stripeConfig()
  if (!config) {
    // Unconfigured deployments have no billing surface at all — the same
    // stance realtime's internal API takes (§3.22): a 404 is
    // indistinguishable from the route not existing, which is exactly what
    // it means here.
    return new Response(null, { status: 404 })
  }

  const rawBody = await req.text()
  const verified = verifyStripeSignature(
    rawBody,
    req.headers.get("stripe-signature"),
    config.webhookSecret,
  )
  if (!verified.ok) {
    // The reason is logged, never returned: telling an unauthenticated
    // caller whether their signature was wrong or merely stale is an
    // oracle, and 400 is what Stripe's own tooling expects for a rejected
    // delivery (it does not retry a 4xx).
    console.warn(`[stripe] rejected webhook: ${verified.reason}`)
    return new Response(null, { status: 400 })
  }

  try {
    const outcome = await applyStripeEvent(verified.event)
    if (outcome.applied) {
      console.log(
        `[stripe] ${verified.event.type} → org ${outcome.orgId} is ${outcome.plan} (${outcome.status})`,
      )
    } else if (outcome.reason !== "ignored_type") {
      // Duplicates, unknown orgs, malformed payloads and terminal-state
      // events are all NORMAL and all answer 2xx — but they are worth a log
      // line, because a stream of them means something upstream is wrong.
      console.log(`[stripe] ${verified.event.type} not applied: ${outcome.reason}`)
    }
    return Response.json({ received: true })
  } catch (error) {
    // A database failure is the ONE case that should become a retry: the
    // event was signed and well-formed, so Stripe redelivering it is
    // exactly what we want. The transaction rolled back, so the redelivery
    // will not see it as a duplicate.
    console.error("[stripe] webhook failed:", error)
    return new Response(null, { status: 500 })
  }
}
//#endregion
