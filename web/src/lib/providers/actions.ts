"use server"

//#region Server Actions
// The credential mutation surface. Trust rules, in order: a signed-in user;
// membership in the org (a logged-in outsider POSTing an orgId they don't
// belong to gets the same 404-shaped rejection the pages give); OWNER role
// for anything that writes — a provider key is billing-adjacent, and agents
// answer conversations, they don't rewire the org. The plaintext key passes
// through here as FormData → payload → lib/realtime and is never assigned
// anywhere else.
//#endregion

//#region Imports
import { revalidatePath } from "next/cache"

import { currentUser } from "@/lib/auth/requireUser"
import { getOrgForMember } from "@/lib/orgs"
import { removeCredential, submitCredential } from "@/lib/realtime"
//#endregion

//#region Types
export interface ProviderFormState {
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
    return { ok: false, error: "Only the organization owner can change provider settings." }
  }
  return { ok: true }
}

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}
//#endregion

//#region Actions
export async function submitProviderAction(
  _prev: ProviderFormState,
  formData: FormData,
): Promise<ProviderFormState> {
  const orgId = field(formData, "orgId") ?? ""
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return { error: gate.error, success: null }
  }

  // Two submit buttons share this action; the pressed one contributes
  // intent. Anything unexpected is treated as the safe option (test).
  const save = formData.get("intent") === "save"
  const result = await submitCredential(
    orgId,
    {
      role: "generation",
      provider: field(formData, "provider") ?? "",
      apiKey: field(formData, "apiKey"),
      baseUrl: field(formData, "baseUrl"),
      model: field(formData, "model"),
    },
    save,
  )
  if (!result.ok) {
    return { error: result.error, success: null }
  }

  if (save) {
    // The status card is RSC-rendered from the database; a save changes it.
    revalidatePath(`/dashboard/${orgId}/providers`)
    return {
      error: null,
      success: `Saved — ${result.value.model} answered in ${result.value.latencyMs}ms.`,
    }
  }
  return {
    error: null,
    success: `Test passed — ${result.value.model} answered in ${result.value.latencyMs}ms. Nothing was saved.`,
  }
}

export async function removeProviderAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId") ?? ""
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  await removeCredential(orgId, "generation")
  revalidatePath(`/dashboard/${orgId}/providers`)
}
//#endregion
