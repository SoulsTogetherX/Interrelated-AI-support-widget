// The billing page (M5.4). Three things, in the order a customer needs
// them: where they stand today, what the tiers are, and — if they bought
// one — the status of the subscription behind it.
//
// The page states out loud what it is: Stripe TEST MODE. A portfolio
// deployment that could charge a real card is a liability, and the client
// refuses a live key by name (lib/stripe/client.ts), so saying so here is
// the product being honest about itself rather than a disclaimer.
import { notFound } from "next/navigation"

import { PLANS } from "@shared/billing/plans"

import PlanCards from "@/components/PlanCards"
import { getSubscription } from "@/lib/billing/queries"
import { requireOrgMember } from "@/lib/orgs"
import { stripeConfig } from "@/lib/stripe/client"
import { getTodayUsage } from "@/lib/usage/queries"
import "./page.css"

export const metadata = { title: "Billing — Interrelated" }

/** Stripe's status vocabulary, in the product's words. Kept beside the
 *  page rather than in the query layer, because this is presentation: the
 *  DATABASE deliberately stores Stripe's own strings so a support
 *  conversation held with their dashboard open matches on both screens. */
const STATUS_TEXT: Record<string, string> = {
  trialing: "Trialing — full access until the trial ends.",
  active: "Active.",
  past_due: "Payment failed. Your plan still works while Stripe retries the charge.",
  canceled: "Cancelled — this organization is back on the Free plan.",
  incomplete: "Waiting for the first payment to complete.",
  incomplete_expired: "The first payment never completed, so no subscription was created.",
  unpaid: "Unpaid after every retry — this organization is back on the Free plan.",
  paused: "Paused.",
}

export default async function BillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  // Billing is the owner's. Agents get the same nothing a non-member gets,
  // rather than a page explaining what they may not do.
  if (org.role !== "owner") notFound()

  const [subscription, usage] = await Promise.all([getSubscription(org.id), getTodayUsage(org.id)])
  // stripeConfig() throws on a LIVE key by design — a misconfigured
  // deployment must fail loudly rather than quietly take money. Everything
  // else (no key at all) is a normal unconfigured state.
  const configured = stripeConfig() !== null
  const plan = PLANS[org.plan]

  return (
    <div className="billing">
      <h1 className="billing-title">Billing</h1>
      <p className="billing-lede">
        {org.name} is on the <strong>{plan.name}</strong> plan
        {usage ? (
          <>
            {" "}
            — {usage.answers.toLocaleString("en-US")} of {usage.limit.toLocaleString("en-US")}{" "}
            answers used today.
          </>
        ) : (
          "."
        )}
      </p>

      {!configured ? (
        <p className="billing-banner" role="status">
          Billing is not configured on this deployment, so the plans below are read-only. The quota
          above is still enforced — it comes from the organization&rsquo;s plan, not from Stripe.
        </p>
      ) : (
        <p className="billing-banner" role="status">
          <strong>Stripe test mode.</strong> This deployment refuses a live key by design, so no
          real card can be charged here. Use Stripe&rsquo;s test card{" "}
          <code>4242 4242 4242 4242</code> with any future expiry and any CVC.
        </p>
      )}

      <PlanCards
        orgId={org.id}
        currentPlan={org.plan}
        configured={configured}
        manageable={configured && subscription !== null}
      />

      {subscription ? (
        <section className="billing-card">
          <h2 className="billing-cardtitle">Subscription</h2>
          <dl className="billing-facts">
            <div>
              <dt>Purchased</dt>
              <dd>{subscription.plan.name}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{STATUS_TEXT[subscription.status] ?? subscription.status}</dd>
            </div>
            <div>
              <dt>{subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"}</dt>
              <dd>
                {subscription.currentPeriodEnd
                  ? subscription.currentPeriodEnd.toISOString().slice(0, 10)
                  : "—"}
              </dd>
            </div>
          </dl>
          {/* The one place the two columns can disagree, and the page says
              why: what was bought vs. what is currently allowed. */}
          {subscription.plan.id !== org.plan ? (
            <p className="billing-cardnote">
              This organization bought {subscription.plan.name} but is currently entitled to{" "}
              {plan.name}, because the subscription is {subscription.status}. Entitlement lives on
              the organization and is what the widget enforces; this row is what Stripe knows.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="billing-card">
        <h2 className="billing-cardtitle">How the quota is enforced</h2>
        <p className="billing-cardnote">
          The ceiling is checked before the model is called, against a counter written in the same
          transaction as each answer — so the worst case is a stopped widget, never a surprise bill.
          Refusals count, because they still cost a retrieval. The count resets at midnight UTC. A
          plan change takes effect on the very next question: nothing caches it.
        </p>
      </section>
    </div>
  )
}
