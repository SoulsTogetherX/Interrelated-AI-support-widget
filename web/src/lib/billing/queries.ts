//#region Why this file
// The billing page's read side. Straight from Postgres, never from Stripe:
// the row was written by the webhook, so reading it costs nothing, works
// while Stripe is down, and cannot rate-limit a dashboard page. What Stripe
// is authoritative about — cards, invoices, proration — is reached through
// their hosted portal instead of mirrored here.
//#endregion

//#region Imports
import { planFor } from "@shared/billing/plans"
import type { Plan, PlanId } from "@shared/billing/plans"

import { db } from "@/lib/db"
//#endregion

//#region Types
export interface OrgSubscription {
  /** What the org BOUGHT. Differs from the entitlement exactly while a
   *  subscription is cancelled or unpaid — which is the difference the page
   *  needs to explain to a customer whose card failed. */
  plan: Plan
  status: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
  stripeCustomerId: string
}
//#endregion

//#region Queries
/** The org's subscription, or null — which is the NORMAL state for every
 *  free-tier org, not an error. */
export async function getSubscription(orgId: string): Promise<OrgSubscription | null> {
  const row = await db
    .selectFrom("subscriptions")
    .select([
      "plan", "status", "cancel_at_period_end", "current_period_end", "stripe_customer_id",
    ])
    .where("org_id", "=", orgId)
    .executeTakeFirst()
  if (!row) return null

  return {
    plan: planFor(row.plan as PlanId),
    status: row.status,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodEnd: row.current_period_end,
    stripeCustomerId: row.stripe_customer_id,
  }
}
//#endregion
