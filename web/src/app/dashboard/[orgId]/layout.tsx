// Org-section nav, shared by every /dashboard/[orgId]/* route. Built purely
// from the path param — no queries, no auth here: layouts don't re-run on
// soft navigation, so each PAGE keeps its own requireOrgMember, and a nav
// rendered for an org the user can't access links only to pages that will
// 404 them anyway.
import Link from "next/link"
import "./layout.css"

import type { ReactNode } from "react"

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  return (
    <div className="orgnav-wrap">
      <nav className="orgnav" aria-label="Organization sections">
        <Link className="orgnav-link" href={`/dashboard/${orgId}`}>
          Overview
        </Link>
        {/* Inbox before Conversations: one is people waiting right now, the
            other is the archive, and the order says which is urgent. */}
        <Link className="orgnav-link" href={`/dashboard/${orgId}/inbox`}>
          Inbox
        </Link>
        <Link className="orgnav-link" href={`/dashboard/${orgId}/conversations`}>
          Conversations
        </Link>
        <Link className="orgnav-link" href={`/dashboard/${orgId}/sources`}>
          Sources
        </Link>
        <Link className="orgnav-link" href={`/dashboard/${orgId}/providers`}>
          Providers
        </Link>
        <Link className="orgnav-link" href={`/dashboard/${orgId}/widget`}>
          Install
        </Link>
      </nav>
      {children}
    </div>
  )
}
