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

/** Which credential the form is talking about. Unknown values collapse to
 *  "generation" — the same stance as the intent field below: a tampered
 *  form gets the conservative reading, and realtime validates the role
 *  again anyway. */
function role(formData: FormData): "generation" | "embedding" {
  return field(formData, "role") === "embedding" ? "embedding" : "generation"
}

/** "…and 3 sources queued for re-indexing." — said out loud because a
 *  changed embedding model re-crawls the org's sources, and a tenant who
 *  sees crawls restart with no explanation reasonably assumes a bug. */
function reindexNote(count: number): string {
  if (count === 0) return ""
  return ` ${count} source${count === 1 ? "" : "s"} queued for re-indexing under the new model.`
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
      role: role(formData),
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

  // An embedding round-trip reports the dimension it measured; a generation
  // one has none. Both are what the provider ACTUALLY answered, not what
  // was typed into the form.
  const what = result.value.dim !== null
    ? `${result.value.model} (${result.value.dim}-d) answered in ${result.value.latencyMs}ms`
    : `${result.value.model} answered in ${result.value.latencyMs}ms`

  if (save) {
    // The status card is RSC-rendered from the database; a save changes it.
    // The sources page shows the re-index this may have queued.
    revalidatePath(`/dashboard/${orgId}/providers`)
    revalidatePath(`/dashboard/${orgId}/sources`)
    return { error: null, success: `Saved — ${what}.${reindexNote(result.value.reindexed)}` }
  }
  return { error: null, success: `Test passed — ${what}. Nothing was saved.` }
}

export async function removeProviderAction(formData: FormData): Promise<void> {
  const orgId = field(formData, "orgId") ?? ""
  const gate = await requireOwner(orgId)
  if (!gate.ok) {
    return
  }
  await removeCredential(orgId, role(formData))
  revalidatePath(`/dashboard/${orgId}/providers`)
  revalidatePath(`/dashboard/${orgId}/sources`)
}
//#endregion
