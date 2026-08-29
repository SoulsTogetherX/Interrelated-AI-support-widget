"use client"

//#region Plan cards
// The upgrade surface. Client for useActionState, like every mutation form
// here — but with one difference worth knowing: the success path of these
// actions never returns. `redirect()` hands the browser to stripe.com, so
// state only ever carries a FAILURE, and there is no success message to
// render.
//
// One form per paid plan rather than a radio group and one submit: the
// pending state then belongs to the button that was actually pressed, so
// upgrading to Pro does not grey out Starter as if both were happening.
//#endregion

//#region Imports
import { useActionState } from "react"
import "./styles.css"

import { PLAN_ORDER, PLANS } from "@shared/billing/plans"
import type { PlanId } from "@shared/billing/plans"

import { openPortalAction, startCheckoutAction } from "@/lib/billing/actions"
import type { BillingFormState } from "@/lib/billing/actions"
//#endregion

//#region Component
const INITIAL: BillingFormState = { error: null }

function PlanCard({
  planId,
  orgId,
  current,
  configured,
}: {
  planId: PlanId
  orgId: string
  current: boolean
  configured: boolean
}) {
  const [state, formAction, pending] = useActionState(startCheckoutAction, INITIAL)
  const plan = PLANS[planId]
  const buyable = planId !== "free" && !current && configured

  return (
    <form className={`plancard${current ? " plancard-current" : ""}`} action={formAction}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="plan" value={planId} />
      <h3 className="plancard-name">{plan.name}</h3>
      <p className="plancard-price">
        {plan.priceUsdPerMonth === 0 ? "Free" : `$${plan.priceUsdPerMonth}`}
        {plan.priceUsdPerMonth === 0 ? null : <span className="plancard-per"> / month</span>}
      </p>
      <ul className="plancard-limits">
        <li>{plan.dailyAnswers.toLocaleString("en-US")} answers per day</li>
        <li>
          {plan.sources} {plan.sources === 1 ? "source" : "sources"}
        </li>
      </ul>
      <p className="plancard-blurb">{plan.blurb}</p>
      {current ? (
        <p className="plancard-badge">Current plan</p>
      ) : buyable ? (
        <button className="plancard-buy" type="submit" disabled={pending}>
          {pending ? "Opening Stripe…" : `Upgrade to ${plan.name}`}
        </button>
      ) : (
        <p className="plancard-note">
          {planId === "free"
            ? "Cancel a paid plan to return here."
            : "Billing is not configured on this deployment."}
        </p>
      )}
      {state.error ? (
        <p className="plancard-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}

export default function PlanCards({
  orgId,
  currentPlan,
  configured,
  manageable,
}: {
  orgId: string
  currentPlan: PlanId
  configured: boolean
  manageable: boolean
}) {
  const [state, formAction, pending] = useActionState(openPortalAction, INITIAL)

  return (
    <div>
      <div className="plancards">
        {PLAN_ORDER.map((planId) => (
          <PlanCard
            key={planId}
            planId={planId}
            orgId={orgId}
            current={planId === currentPlan}
            configured={configured}
          />
        ))}
      </div>
      {manageable ? (
        <form className="plancards-manage" action={formAction}>
          <input type="hidden" name="orgId" value={orgId} />
          <button className="plancards-portal" type="submit" disabled={pending}>
            {pending ? "Opening Stripe…" : "Manage billing"}
          </button>
          <span className="plancards-managenote">
            Cards, invoices, downgrades and cancellation live in Stripe&rsquo;s own portal — this
            dashboard never handles a card number.
          </span>
          {state.error ? (
            <p className="plancard-error" role="alert">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  )
}
//#endregion
