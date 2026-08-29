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
import {
  ROTATION_GRACE_HOURS,
  issueSecretKey,
  revokePublishableKeyNow,
  revokeSecretKeyNow,
  rotatePublishableKey,
  rotateSecretKey,
} from "./index"
//#endregion

//#region Types
export interface KeyFormState {
  error: string | null
  success: string | null
}

/** The secret-key form's state. `secretKey` is the plaintext, present ONLY
 *  in the action result that issued it — client-held state on its way to
 *  the owner's screen, persisted nowhere (the row holds a hash). `keyId` is
 *  the row it belongs to, so the form can stop showing a value whose key
 *  the owner has since revoked. */
export interface SecretKeyFormState {
  error: string | null
  success: string | null
  secretKey: string | null
  keyId: string | null
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

/** Issue-or-rotate for the SECRET key (M7.3), one action because the form
 *  is one component that must stay mounted across the change from "no key"
 *  to "a key" — the revealed plaintext lives in its client state, and a
 *  component that unmounted would take it with it. An empty keyId means the
 *  page showed no current secret key and this is a first issue; a keyId
 *  means it is a rotation FROM that key (the guarded-UPDATE idempotence,
 *  as for the publishable key). Either way the plaintext rides back in the
 *  state exactly once and is written nowhere. */
export async function secretKeyAction(
  _prev: SecretKeyFormState,
  formData: FormData,
): Promise<SecretKeyFormState> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return { error: gate.error, success: null, secretKey: null, keyId: null }
  }
  const fromKeyId = field(formData, "keyId")
  if (fromKeyId === "") {
    const result = await issueSecretKey(orgId)
    revalidateKeyPages(orgId)
    if (!result.issued) {
      // 007's one-current-secret index refused a second: another owner
      // (or another tab) got there first, and the page now shows that key.
      return {
        error:
          "This organization already has a secret key — the page now shows it. Rotate it if you need a new value.",
        success: null,
        secretKey: null,
        keyId: null,
      }
    }
    return {
      error: null,
      success:
        "Secret key issued. Copy it now and store it in your server's configuration — " +
        "it is shown only this once, and the dashboard keeps only its last four characters.",
      secretKey: result.secretKey,
      keyId: result.keyId,
    }
  }
  const result = await rotateSecretKey(orgId, fromKeyId)
  revalidateKeyPages(orgId)
  if (!result.rotated) {
    return {
      error: "That key was already rotated — the page now shows the current one.",
      success: null,
      secretKey: null,
      keyId: null,
    }
  }
  return {
    error: null,
    success:
      `New secret key issued — copy it now; it is shown only this once. Your previous key keeps ` +
      `minting sessions for ${ROTATION_GRACE_HOURS} hours (until ${utcMinute(result.graceEndsAt)} UTC) ` +
      `unless you revoke it sooner — redeploy your server with the new key before then.`,
    secretKey: result.secretKey,
    keyId: result.keyId,
  }
}

export async function revokeSecretKeyNowAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId")
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  await revokeSecretKeyNow(orgId, field(formData, "keyId"))
  revalidateKeyPages(orgId)
}
//#endregion
