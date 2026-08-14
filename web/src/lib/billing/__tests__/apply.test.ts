//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/lib/db"
import { applyStripeEvent } from "@/lib/billing/apply"
import { getSubscription } from "@/lib/billing/queries"
import type { StripeEvent } from "@/lib/stripe/signature"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// DB-gated. This suite is about the two properties the webhook must have
// and cannot be talked into: applying an event exactly once no matter how
// often Stripe delivers it, and never letting a payment state that ENDED
// leave a tenant entitled to something they are not paying for.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

let orgId: string
let eventSeq = 0

function subscriptionEvent(overrides: {
  type?: string
  eventId?: string
  subscriptionId?: string
  customerId?: string
  status?: string
  plan?: string
  org?: string
  cancelAtPeriodEnd?: boolean
  periodEnd?: number
  metadata?: Record<string, unknown> | null
} = {}): StripeEvent {
  eventSeq += 1
  const metadata = overrides.metadata !== undefined
    ? overrides.metadata
    : { orgId: overrides.org ?? orgId, planId: overrides.plan ?? "starter" }
  return {
    id: overrides.eventId ?? `evt_test_${eventSeq}`,
    type: overrides.type ?? "customer.subscription.created",
    data: {
      object: {
        id: overrides.subscriptionId ?? "sub_test_1",
        customer: overrides.customerId ?? "cus_test_1",
        status: overrides.status ?? "active",
        cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
        current_period_end: overrides.periodEnd ?? 1_800_000_000,
        ...(metadata === null ? {} : { metadata }),
      },
    },
  }
}

const orgPlan = async (id: string): Promise<string> =>
  (await db.selectFrom("organizations").select("plan").where("id", "=", id).executeTakeFirstOrThrow()).plan
//#endregion

describe.skipIf(!DB_CONFIGURED)("stripe event application", () => {
  beforeAll(async () => {
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Billing Co" }).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.deleteFrom("stripe_events").where("id", "like", "evt_test_%").execute()
  })

  it("upgrades the org and records what Stripe knows", async () => {
    const outcome = await applyStripeEvent(subscriptionEvent())
    expect(outcome).toMatchObject({ applied: true, orgId, plan: "starter", status: "active" })

    // The ENTITLEMENT moved — the column the quota check reads, with no
    // join to Stripe state on the hot path.
    expect(await orgPlan(orgId)).toBe("starter")

    const subscription = await getSubscription(orgId)
    expect(subscription?.plan.id).toBe("starter")
    expect(subscription?.status).toBe("active")
    expect(subscription?.stripeCustomerId).toBe("cus_test_1")
    expect(subscription?.currentPeriodEnd?.getTime()).toBe(1_800_000_000 * 1000)
  })

  it("applies a REDELIVERED event exactly once", async () => {
    // Stripe redelivers, by design and more often when a response is slow.
    // The event id is the primary key of the ledger, so the second
    // application is a no-op decided by Postgres rather than by a
    // check-then-act read that would race under exactly this load.
    const event = subscriptionEvent({ eventId: "evt_test_dup", plan: "pro" })
    const first = await applyStripeEvent(event)
    expect(first.applied).toBe(true)
    expect(await orgPlan(orgId)).toBe("pro")

    // Someone downgrades in between; the redelivery must NOT undo it.
    await db.updateTable("organizations").set({ plan: "starter" }).where("id", "=", orgId).execute()
    const second = await applyStripeEvent(event)
    expect(second).toEqual({ applied: false, reason: "duplicate" })
    expect(await orgPlan(orgId)).toBe("starter")
  })

  it("survives CONCURRENT redelivery of the same event", async () => {
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Racy Co" }).execute()
    try {
      const event = subscriptionEvent({
        eventId: "evt_test_race", org, subscriptionId: "sub_race", customerId: "cus_race", plan: "pro",
      })
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => applyStripeEvent(event)))
      expect(outcomes.filter((o) => o.applied)).toHaveLength(1)
      expect(await orgPlan(org)).toBe("pro")
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("keeps the plan while a payment is retrying, and drops it when the retries END", async () => {
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Dunning Co" }).execute()
    try {
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_dunning", customerId: "cus_dunning", plan: "pro",
      }))
      expect(await orgPlan(org)).toBe("pro")

      // past_due: Stripe is still retrying the card. Breaking a customer's
      // support widget the hour their card expired would be a worse
      // product than one that waits for the dunning cycle.
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_dunning", customerId: "cus_dunning", plan: "pro",
        type: "customer.subscription.updated", status: "past_due",
      }))
      expect(await orgPlan(org)).toBe("pro")
      expect((await getSubscription(org))?.status).toBe("past_due")

      // unpaid: the cycle ended. Now the entitlement goes.
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_dunning", customerId: "cus_dunning", plan: "pro",
        type: "customer.subscription.updated", status: "unpaid",
      }))
      expect(await orgPlan(org)).toBe("free")
      // The subscription row still says what was BOUGHT — the difference
      // between "what Stripe knows" and "what the product allows" is
      // exactly what the billing page explains to a customer.
      expect((await getSubscription(org))?.plan.id).toBe("pro")
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("downgrades to free on cancellation, whatever the object claims", async () => {
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Leaving Co" }).execute()
    try {
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_leaving", customerId: "cus_leaving", plan: "starter",
      }))
      // A deleted subscription is cancelled even if the payload still says
      // "active" — the event type is the fact, and trusting the field over
      // the type is how a cancelled tenant keeps their plan.
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_leaving", customerId: "cus_leaving", plan: "starter",
        type: "customer.subscription.deleted", status: "active",
      }))
      expect(await orgPlan(org)).toBe("free")
      expect((await getSubscription(org))?.status).toBe("canceled")
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("ignores a late update that would RESURRECT a cancelled subscription", async () => {
    // Stripe does not promise ordering. The case that actually hurts is an
    // `updated` arriving after a `deleted`: deletion is terminal for a
    // subscription id, so later events for the SAME id change nothing.
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Zombie Co" }).execute()
    try {
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_zombie", customerId: "cus_zombie", plan: "pro",
      }))
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_zombie", customerId: "cus_zombie", plan: "pro",
        type: "customer.subscription.deleted",
      }))
      expect(await orgPlan(org)).toBe("free")

      const late = await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_zombie", customerId: "cus_zombie", plan: "pro",
        type: "customer.subscription.updated", status: "active",
      }))
      expect(late).toEqual({ applied: false, reason: "terminal" })
      expect(await orgPlan(org)).toBe("free")

      // A NEW subscription id is a genuine resubscribe and proceeds.
      await applyStripeEvent(subscriptionEvent({
        org, subscriptionId: "sub_zombie_2", customerId: "cus_zombie", plan: "pro",
      }))
      expect(await orgPlan(org)).toBe("pro")
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("reads the period end from wherever this API version puts it", async () => {
    // It moved off the subscription object and onto its items in the 2025
    // versions. Reading both means raising the pinned version does not
    // silently blank every renewal date.
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Period Co" }).execute()
    try {
      const event = subscriptionEvent({
        org, subscriptionId: "sub_period", customerId: "cus_period", plan: "starter",
      })
      delete event.data.object.current_period_end
      event.data.object.items = { data: [{ current_period_end: 1_900_000_000 }] }
      await applyStripeEvent(event)
      expect((await getSubscription(org))?.currentPeriodEnd?.getTime()).toBe(1_900_000_000 * 1000)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("records and ignores event types it does not act on", async () => {
    // Stripe sends many types, and an endpoint that errors on the ones it
    // does not care about generates a permanent retry loop.
    const outcome = await applyStripeEvent(subscriptionEvent({
      eventId: "evt_test_invoice", type: "invoice.paid",
    }))
    expect(outcome).toEqual({ applied: false, reason: "ignored_type" })
    const recorded = await db.selectFrom("stripe_events").select("type")
      .where("id", "=", "evt_test_invoice").executeTakeFirst()
    expect(recorded?.type).toBe("invoice.paid")
  })

  it("refuses to guess when the payload names no org or no known plan", async () => {
    // Guessing a plan would entitle someone to something nobody bought;
    // guessing an org would entitle the WRONG tenant.
    const noMeta = await applyStripeEvent(subscriptionEvent({ eventId: "evt_test_nometa", metadata: null }))
    expect(noMeta).toEqual({ applied: false, reason: "malformed" })

    const badPlan = await applyStripeEvent(subscriptionEvent({
      eventId: "evt_test_badplan", metadata: { orgId, planId: "enterprise" },
    }))
    expect(badPlan).toEqual({ applied: false, reason: "malformed" })

    const goneOrg = await applyStripeEvent(subscriptionEvent({
      eventId: "evt_test_goneorg", org: newId("org"), subscriptionId: "sub_gone", customerId: "cus_gone",
    }))
    expect(goneOrg).toEqual({ applied: false, reason: "unknown_org" })
    // Every one of these still RECORDS the event: they are answered 2xx,
    // so a redelivery must not re-run them.
    const recorded = await db.selectFrom("stripe_events").select("id")
      .where("id", "in", ["evt_test_nometa", "evt_test_badplan", "evt_test_goneorg"]).execute()
    expect(recorded).toHaveLength(3)
  })

  it("keeps one tenant's subscription out of another's", async () => {
    const other = newId("org")
    await db.insertInto("organizations").values({ id: other, name: "Neighbour Co" }).execute()
    try {
      await applyStripeEvent(subscriptionEvent({
        org: other, subscriptionId: "sub_neighbour", customerId: "cus_neighbour", plan: "pro",
      }))
      expect(await orgPlan(other)).toBe("pro")
      // The fixture org's own state is untouched by the neighbour's
      // upgrade — it is whatever its last event left it as.
      expect(await orgPlan(orgId)).toBe("starter")
      expect((await getSubscription(orgId))?.stripeCustomerId).toBe("cus_test_1")
    } finally {
      await db.deleteFrom("organizations").where("id", "=", other).execute()
    }
  })
})
