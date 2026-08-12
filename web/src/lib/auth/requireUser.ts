//#region Page-level auth guards
// The RSC-side gate. currentUser answers "who is this?" (null when nobody);
// requireUser answers "this page needs somebody" by redirecting to /login —
// redirect() throws internally, so code after it never runs and callers get
// a non-null user by type. Every authenticated page starts with one line:
//   const user = await requireUser()
// There is deliberately NO middleware.ts doing this instead: middleware
// runs on every asset request, cannot reach the database cheaply, and a
// cookie-presence check there would be security theater — the page-level
// database-backed check is the real one, so it is the only one.
//#endregion

//#region Imports
import { redirect } from "next/navigation"

import { readSessionToken } from "./cookies"
import { resolveSessionUser } from "./session"

import type { SessionUser } from "./session"
//#endregion

//#region Guards
export async function currentUser(): Promise<SessionUser | null> {
  return resolveSessionUser(await readSessionToken())
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser()
  if (!user) {
    redirect("/login")
  }
  return user
}
//#endregion
