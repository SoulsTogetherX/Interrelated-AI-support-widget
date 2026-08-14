"use server"

//#region Server Actions
// The two buttons on the billing page: start a Checkout, or open Stripe's
// portal. Both redirect the browser to stripe.com — this dashboard never
// renders a card field, because every payment surface carries regulatory
// weight and the interesting engineering here is the webhook that makes
// their outcome true in our database, not a second copy of their UI.
//
// The trust ladder is the providers/sources one: signed-in → member →
// OWNER. Billing is the owner's, unambiguously; an agent answers
// conversations. A Server Action is reachable as a direct POST, so the
// check lives inside it rather than only on the page.
//#endregion

//#region Imports
import { redirect } from "next/navigation"

import { isPlanId } from "@shared/billing/plans"
import type { PlanId } from "@shared/billing/plans"

import { currentUser } from "@/lib/auth/requireUser"
import { getSubscription } from "@/lib/billing/queries"
import { getOrgForMember } from "@/lib/orgs"
import { createCheckoutSession, createPortalSession } from "@/lib/stripe/client"
//#endregion

//#region Types
export interface BillingFormState {
  error: string | null
}
//#endregion

//#region Helpers
async function requireOwner(orgId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await currentUser()
  if (!user) return { ok: false, error: "Your session expired — sign in again." }
  const org = await getOrgForMember(orgId, user.id)
  if (!org) return { ok: false, error: "Organization not found." }
  if (org.role !== "owner") {
    return { ok: false, error: "Only the organization owner can change billing." }
  }
  return { ok: true }
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Where Stripe sends the browser back to. Built from an env-configured
 * origin rather than the request's Host header: a redirect target derived
 * from an attacker-controllable header is how open redirects happen, and
 * this one would be handed to a third party to bounce a user through.
 */
function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001").replace(/\/$/, "")
  return `${base}${path}`
}
//#endregion

//#region Actions
/**
 * Upgrade: mint a Checkout Session and redirect to it.
 *
 * `redirect()` throws a control-flow signal Next catches, so it MUST be
 * called outside the try/catch shape used elsewhere — here there is no
 * try at all, and every failure path returns a form state instead.
 */
export async function startCheckoutAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) return { error: gate.error }

  const plan = field(formData, "plan")
  // "free" is not a purchase — it is the absence of a subscription, and
  // there is no price to check out. Downgrading to it happens in Stripe's
  // portal (cancel), which is the flow that also handles proration.
  if (!isPlanId(plan) || plan === "free") {
    return { error: "Choose a paid plan to upgrade to." }
  }

  // Reuse the org's existing Stripe customer if it has one, so a tenant who
  // upgrades, cancels, and returns is one customer with one billing history
  // rather than three strangers who share an email.
  const existing = await getSubscription(orgId)
  const result = await createCheckoutSession({
    orgId,
    plan: plan as Exclude<PlanId, "free">,
    successUrl: appUrl(`/dashboard/${orgId}/billing?checkout=done`),
    cancelUrl: appUrl(`/dashboard/${orgId}/billing?checkout=cancelled`),
    customerId: existing?.stripeCustomerId,
  })
  if (!result.ok) return { error: result.error }
  redirect(result.value.url)
}

/** Manage: Stripe's hosted portal, where a customer changes a card,
 *  downgrades, or cancels. Requires a customer id, which only exists once
 *  something has been bought. */
export async function openPortalAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) return { error: gate.error }

  const existing = await getSubscription(orgId)
  if (!existing) return { error: "This organization has no subscription to manage yet." }

  const result = await createPortalSession({
    customerId: existing.stripeCustomerId,
    returnUrl: appUrl(`/dashboard/${orgId}/billing`),
  })
  if (!result.ok) return { error: result.error }
  redirect(result.value.url)
}
//#endregion
