// Chrome for every /dashboard/* route: brand, signed-in identity, sign-out.
// The layout renders the header from currentUser (cached per request —
// lib/auth/requireUser.ts) but does NOT gate: layouts don't re-run on soft
// navigation, so the database-backed check belongs to each page's
// requireUser/requireOrgMember opening line. A null user here just renders
// chrome without an email — the page beneath is already redirecting.
import Link from "next/link"

import { logoutAction } from "@/lib/auth/actions"
import { currentUser } from "@/lib/auth/requireUser"
import "./layout.css"

import type { ReactNode } from "react"

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await currentUser()
  return (
    <div className="dashshell">
      <header className="dashshell-header">
        <Link className="dashshell-brand" href="/dashboard">
          Interrelated
        </Link>
        {user ? (
          <div className="dashshell-session">
            <span className="dashshell-email">{user.email}</span>
            <form className="dashshell-signout-form" action={logoutAction}>
              <button className="dashshell-signout" type="submit">
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </header>
      <main className="dashshell-body">{children}</main>
    </div>
  )
}
