//#region Why this file
// Applying a verified Stripe event to the database (M5.4) — the half of
// the webhook that is not about signatures. Separated from the route
// handler so it can be tested directly against real Postgres, the way the
// answer pipeline is tested without an HTTP surface.
//
// Everything lands in ONE transaction with the event's own id, which is
// what makes redelivery safe: either the event is recorded AND applied, or
// neither happened and Stripe's retry does it. There is no window where a
// row moved but the ledger did not.
//
// **Which events, and why not the obvious one.** Only
// `customer.subscription.created|updated|deleted` are applied.
// `checkout.session.completed` is deliberately ignored: it says a checkout
// finished, not what the subscription IS, and the subscription events carry
// both — plus our own metadata, plus every later change. Handling both
// would put two writers on one row whose outcome depended on Stripe's
// delivery order, which is not guaranteed.
//
// **Entitlement vs. record.** This writes `subscriptions` (what Stripe
// knows) and `organizations.plan` (what the product allows). The mapping is
// a product decision, stated in entitlementFor() below.
//#endregion

//#region Imports
import { sql } from "kysely"

import { isPlanId } from "@shared/billing/plans"
import type { PlanId } from "@shared/billing/plans"

import { db } from "@/lib/db"
import type { StripeEvent } from "@/lib/stripe/signature"
//#endregion

//#region Types
export type ApplyOutcome =
  | { applied: true; orgId: string; plan: PlanId; status: string }
  | {
      applied: false
      reason: "duplicate" | "ignored_type" | "unknown_org" | "malformed" | "terminal"
    }

type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused"

const STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]

const APPLIED_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
])
//#endregion

//#region Helpers
/**
 * What a subscription in this state entitles the org to.
 *
 * `past_due` KEEPS the plan on purpose. Stripe retries a failed payment for
 * days before giving up, and breaking a customer's support widget the hour
 * their card expired would be a worse product than one that waits for the
 * dunning cycle to finish — the status is visible on the billing page
 * meanwhile. `unpaid` and `canceled` are where that cycle ENDED, so those
 * drop to free. `incomplete` never started, and `paused` is an explicit
 * stop.
 */
function entitlementFor(status: SubscriptionStatus, plan: PlanId): PlanId {
  switch (status) {
    case "trialing":
    case "active":
    case "past_due":
      return plan
    case "canceled":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return "free"
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * The subscription's period end, in seconds, from either place Stripe puts
 * it. It moved off the subscription object and onto its items in the 2025
 * API versions; reading both means this survives the pin in client.ts being
 * raised, and a subscription with neither is simply period-less (null),
 * which an incomplete one legitimately is.
 */
function periodEnd(object: Record<string, unknown>): Date | null {
  const direct = object.current_period_end
  if (typeof direct === "number") return new Date(direct * 1000)
  const items = object.items as { data?: unknown } | undefined
  const first: unknown = Array.isArray(items?.data) ? items.data[0] : undefined
  const nested =
    typeof first === "object" && first !== null
      ? (first as Record<string, unknown>).current_period_end
      : undefined
  return typeof nested === "number" ? new Date(nested * 1000) : null
}

/** Pulls org and plan out of the subscription's own metadata — put there by
 *  createCheckoutSession's `subscription_data[metadata]`, so every event
 *  about this subscription already says which tenant and tier it concerns.
 *  A missing or unknown plan is malformed rather than a default: guessing
 *  "starter" would entitle someone to something nobody bought. */
function metadata(object: Record<string, unknown>): { orgId: string; plan: PlanId } | null {
  const meta = object.metadata
  if (typeof meta !== "object" || meta === null) return null
  const record = meta as Record<string, unknown>
  const orgId = asString(record.orgId)
  const plan = asString(record.planId)
  if (!orgId || !plan || !isPlanId(plan)) return null
  return { orgId, plan }
}
//#endregion

//#region Exports
/**
 * Records the event and applies it. Safe to call twice with the same event:
 * the second call reports `duplicate` and changes nothing.
 *
 * Every non-applied outcome is still a SUCCESS for the caller — an ignored
 * type, an org that no longer exists, and a malformed payload must all
 * answer Stripe with a 2xx, or they are redelivered forever. Only a thrown
 * error (a database failure, a constraint that caught something genuinely
 * wrong) should become a retry.
 */
export async function applyStripeEvent(event: StripeEvent): Promise<ApplyOutcome> {
  return db.transaction().execute(async (trx) => {
    // The ledger insert comes FIRST and is the deduplication: a conflict
    // means this event was already applied, and the transaction ends having
    // done nothing. A read-then-write would race itself under exactly the
    // retry storm this exists to survive.
    const recorded = await trx
      .insertInto("stripe_events")
      .values({ id: event.id, type: event.type })
      .onConflict((oc) => oc.column("id").doNothing())
      .executeTakeFirst()
    if (Number(recorded.numInsertedOrUpdatedRows ?? 0) === 0) {
      return { applied: false, reason: "duplicate" } as const
    }

    if (!APPLIED_TYPES.has(event.type)) {
      // Recorded, not applied. Stripe sends many event types and an
      // endpoint that 400s on the ones it does not care about generates a
      // permanent retry loop and a dashboard full of red.
      return { applied: false, reason: "ignored_type" } as const
    }

    const object = event.data.object
    const meta = metadata(object)
    const subscriptionId = asString(object.id)
    const customerId = asString(object.customer)
    const rawStatus = asString(object.status)
    if (!meta || !subscriptionId || !customerId) {
      return { applied: false, reason: "malformed" } as const
    }

    // A deleted subscription is canceled whatever its object says; for the
    // others the status must be one Stripe documents, or we would write a
    // value the CHECK rejects and turn a routine event into a retry loop.
    const status: SubscriptionStatus =
      event.type === "customer.subscription.deleted"
        ? "canceled"
        : STATUSES.includes(rawStatus as SubscriptionStatus)
          ? (rawStatus as SubscriptionStatus)
          : "incomplete"

    const org = await trx
      .selectFrom("organizations")
      .select("id")
      .where("id", "=", meta.orgId)
      .executeTakeFirst()
    if (!org) {
      // The org was deleted while a subscription lived on. Nothing to
      // apply, and nothing Stripe can do about it — 2xx and move on. (The
      // human follow-up is cancelling that subscription in Stripe, which is
      // outside this system's reach.)
      return { applied: false, reason: "unknown_org" } as const
    }

    const existing = await trx
      .selectFrom("subscriptions")
      .select(["stripe_subscription_id", "status"])
      .where("org_id", "=", meta.orgId)
      .executeTakeFirst()

    // Out-of-order delivery is possible — Stripe does not promise ordering —
    // and the case that would actually hurt is a late `updated` arriving
    // after a `deleted` and resurrecting a cancelled subscription. Deletion
    // is terminal for a subscription id, so once a row is cancelled, later
    // events for the SAME id change nothing. (A NEW subscription id is a
    // genuine resubscribe and proceeds normally.) The general fix — fetching
    // the live object from Stripe on every webhook — costs an API call per
    // event to order a stream that is already almost always in order.
    if (
      existing?.stripe_subscription_id === subscriptionId &&
      existing.status === "canceled" &&
      event.type !== "customer.subscription.deleted"
    ) {
      return { applied: false, reason: "terminal" } as const
    }

    const plan = entitlementFor(status, meta.plan)
    await trx
      .insertInto("subscriptions")
      .values({
        org_id: meta.orgId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        // The subscription row keeps the plan that was BOUGHT; the org's
        // column keeps what is currently allowed. They differ exactly while
        // a subscription is cancelled or unpaid, which is the difference
        // worth being able to see.
        plan: meta.plan,
        status,
        cancel_at_period_end: object.cancel_at_period_end === true,
        current_period_end: periodEnd(object),
      })
      .onConflict((oc) =>
        oc.column("org_id").doUpdateSet({
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan: meta.plan,
          status,
          cancel_at_period_end: object.cancel_at_period_end === true,
          current_period_end: periodEnd(object),
          updated_at: sql`NOW()`,
        }),
      )
      .execute()

    await trx.updateTable("organizations").set({ plan }).where("id", "=", meta.orgId).execute()

    return { applied: true, orgId: meta.orgId, plan, status } as const
  })
}

//#endregion
