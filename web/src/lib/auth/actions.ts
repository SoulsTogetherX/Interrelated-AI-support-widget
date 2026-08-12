"use server"

//#region Server Actions
// The mutation surface of auth — the plan's "Server Actions for mutations"
// applied to sign-up/sign-in/sign-out. Each is an (state, formData) reducer
// compatible with useActionState: user errors come back as strings for the
// form; success SETS THE COOKIE then redirects (redirect() throws
// NEXT_REDIRECT, so it must be the last statement — nothing after it runs).
//
// CSRF: Server Actions only accept POSTs whose Origin matches the request
// host (Next enforces this), and the session cookie is SameSite=Lax — two
// independent reasons a cross-site form can't drive these.
//#endregion

//#region Imports
import { redirect } from "next/navigation"

import { clearSessionCookie, readSessionToken, setSessionCookie } from "./cookies"
import { createSessionForUser, destroySession } from "./session"
import { authenticateUser, registerUser } from "./user"
//#endregion

//#region Types
export interface AuthFormState {
  error: string | null
}
//#endregion

//#region Actions
export async function signupAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await registerUser(formData.get("email"), formData.get("password"))
  if (!result.ok) {
    return { error: result.error }
  }
  const session = await createSessionForUser(result.userId)
  await setSessionCookie(session.token, session.expiresAt)
  redirect("/dashboard")
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await authenticateUser(formData.get("email"), formData.get("password"))
  if (!result.ok) {
    return { error: result.error }
  }
  const session = await createSessionForUser(result.userId)
  await setSessionCookie(session.token, session.expiresAt)
  redirect("/dashboard")
}

export async function logoutAction(): Promise<void> {
  // Server-side revocation FIRST, cookie clearing second: if the delete
  // throws, the worst case is a cookie pointing at a dead session, not a
  // live session the user believes is gone.
  await destroySession(await readSessionToken())
  await clearSessionCookie()
  redirect("/login")
}
//#endregion
