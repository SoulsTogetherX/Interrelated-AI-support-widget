"use server"

//#region Server Actions
// Key rotation mutations. The providers/sources/origins trust ladder verbatim
// (signed-in → member → OWNER): a rotation changes what every deployed
// snippet must carry, and "revoke now" can take a customer's widget down —
// org wiring, not conversation work. Both are re-checked here rather than
// trusted from the page, because a Server Action is reachable as a direct
// POST whether or not the page rendered.
//#endregion

//#region Imports
import { revalidatePath } from "next/cache"

import { currentUser } from "@/lib/auth/requireUser"
import { getOrgForMember } from "@/lib/orgs"
import { ROTATION_GRACE_HOURS, revokePublishableKeyNow, rotatePublishableKey } from "./index"
//#endregion

//#region Types
export interface KeyFormState {
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
    return { ok: false, error: "Only the organization owner can rotate keys." }
  }
  return { ok: true }
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === "string" ? value : ""
}

/** The dashboard's timestamp convention (conversations, billing): UTC to the
 *  minute, because the page is rendered on a server that does not know the
 *  reader's timezone, and a wrong local time is worse than a labeled UTC one. */
function utcMinute(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ")
}

/** Both pages that show the key re-render from Postgres after a change:
 *  the overview carries the controls, the install page carries the snippet
 *  that must now say the new value. */
function revalidateKeyPages(orgId: string): void {
  revalidatePath(`/dashboard/${orgId}`)
  revalidatePath(`/dashboard/${orgId}/widget`)
}
//#endregion

//#region Actions
export async function rotatePublishableKeyAction(
  _prev: KeyFormState,
  formData: FormData,
): Promise<KeyFormState> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return { error: gate.error, success: null }
  }
  // keyId is the key the PAGE showed as current. Naming it is what makes a
  // second click a no-op instead of a second rotation (lib/keys/index.ts).
  const result = await rotatePublishableKey(orgId, field(formData, "keyId"))
  revalidateKeyPages(orgId)
  if (!result.rotated) {
    return {
      error: "That key was already rotated — the page now shows the current one.",
      success: null,
    }
  }
  // "unless you revoke it sooner": this sentence lives in the form's
  // client-held state and survives a later "Revoke now" re-render, so it is
  // worded to stay true after one rather than promising 24 hours the owner
  // may have just cut short.
  return {
    error: null,
    success:
      `New key issued. Your previous key keeps working for ${ROTATION_GRACE_HOURS} hours ` +
      `(until ${utcMinute(result.graceEndsAt)} UTC) unless you revoke it sooner — ` +
      `update your snippet before then.`,
  }
}

export async function revokePublishableKeyNowAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  // A false return (already revoked, not retiring, not this org's) needs no
  // message: the re-rendered list IS the answer, and there is nothing a
  // second click could have meant.
  await revokePublishableKeyNow(orgId, field(formData, "keyId"))
  revalidateKeyPages(orgId)
}
//#endregion
