"use server"

//#region Server Actions
// Org mutations. Same reducer shape as auth's actions (useActionState).
//#endregion

//#region Imports
import { redirect } from "next/navigation"

import { currentUser } from "@/lib/auth/requireUser"
import { createOrgForUser, validateOrgName } from "./index"
//#endregion

//#region Types
export interface OrgFormState {
  error: string | null
}
//#endregion

//#region Actions
export async function createOrgAction(
  _prev: OrgFormState,
  formData: FormData,
): Promise<OrgFormState> {
  // Actions are their own trust boundary: the page already required a user,
  // but a POST can arrive without ever rendering the page.
  const user = await currentUser()
  if (!user) {
    redirect("/login")
  }
  const name = validateOrgName(formData.get("name"))
  if (!name.ok) {
    return { error: name.error }
  }
  const { orgId } = await createOrgForUser(user.id, name.value)
  redirect(`/dashboard/${orgId}`)
}
//#endregion
