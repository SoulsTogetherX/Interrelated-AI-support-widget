"use server"

//#region Server Actions
// Origin mutations. Same trust ladder as providers and sources (signed-in
// → member → OWNER): the allowlist IS the widget's front door, so widening
// it is org wiring, not conversation work.
//#endregion

//#region Imports
import { revalidatePath } from "next/cache"

import { currentUser } from "@/lib/auth/requireUser"
import { getOrgForMember } from "@/lib/orgs"
import { addOrigin, removeOrigin, validateOrigin } from "./index"
//#endregion

//#region Types
export interface OriginFormState {
  error: string | null
  success: string | null
}
//#endregion

//#region Helpers
async function requireOwner(orgId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await currentUser()
  if (!user) {
    return { ok: false, error: "Your session expired — sign in again." }
  }
  const org = await getOrgForMember(orgId, user.id)
  if (!org) {
    return { ok: false, error: "Organization not found." }
  }
  if (org.role !== "owner") {
    return { ok: false, error: "Only the organization owner can change the allowlist." }
  }
  return { ok: true }
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === "string" ? value : ""
}
//#endregion

//#region Actions
export async function addOriginAction(
  _prev: OriginFormState,
  formData: FormData,
): Promise<OriginFormState> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return { error: gate.error, success: null }
  }
  const origin = validateOrigin(formData.get("origin"))
  if (!origin.ok) {
    return { error: origin.error, success: null }
  }
  await addOrigin(orgId, origin.value)
  revalidatePath(`/dashboard/${orgId}/widget`)
  // Echo the NORMALIZED value: a customer who pasted a full page URL should
  // see what was actually allowlisted, since that string is what the
  // browser's Origin header must match exactly.
  return { error: null, success: `${origin.value} can now load your widget.` }
}

export async function removeOriginAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  // No validation on the way out: whatever string is in the row is what
  // must be deletable, including one a stricter validator would now reject.
  await removeOrigin(orgId, field(formData, "origin"))
  revalidatePath(`/dashboard/${orgId}/widget`)
}

/** The one-click "Allow" beside a REFUSED origin in the traffic table
 *  (M7.2, §9.18): the forgotten-staging-domain case, where the flag layer 4
 *  raises is one the tenant answers by allowlisting. Same ladder, same
 *  validator, same idempotent insert as the typed form — the origin comes
 *  from a counter row realtime shape-checked, but it is validated again
 *  here regardless, because a hidden field is still a request field. A
 *  plain form action: the re-rendered table (the row turns from refused to
 *  allowlisted, and the widget accepts it on the very next mint) is the
 *  message. */
export async function allowOriginNowAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  const origin = validateOrigin(formData.get("origin"))
  if (!origin.ok) {
    return
  }
  await addOrigin(orgId, origin.value)
  revalidatePath(`/dashboard/${orgId}/widget`)
  revalidatePath(`/dashboard/${orgId}`)
}
//#endregion
