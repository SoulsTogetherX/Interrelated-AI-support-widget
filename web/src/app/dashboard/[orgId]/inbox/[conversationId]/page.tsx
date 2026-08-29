// One handed-off conversation, live (M4.5). This page is the WORKING
// surface; /conversations/[id] stays the audit view where claim verdicts
// live (§9.10), and each links to the other rather than duplicating it.
//
// The thread itself is not rendered here: the socket replays it on attach
// (§8.4), so a server-rendered copy would be a second, staler one that
// disagrees with the live channel the moment a message lands.
import Link from "next/link"
import { notFound } from "next/navigation"

import { requireOrgMember } from "@/lib/orgs"
import { getOpenHandoff } from "@/lib/handoff/queries"
import { getConversation } from "@/lib/conversations/queries"
import { IDENTIFIED_SUFFIX, describeVisitor } from "@/lib/conversations/visitors"
import HandoffChat from "@/components/HandoffChat"
import "./page.css"

export const metadata = { title: "Live conversation — Interrelated" }

export default async function InboxConversationPage({
  params,
}: {
  params: Promise<{ orgId: string; conversationId: string }>
}) {
  const { orgId, conversationId } = await params
  const { org } = await requireOrgMember(orgId)

  // Org-scoped, so another tenant's id and a fabricated one are the same
  // 404 — the indistinguishability the rest of the dashboard keeps.
  const conversation = await getConversation(org.id, conversationId)
  if (!conversation) {
    notFound()
  }
  const handoff = await getOpenHandoff(org.id, conversationId)

  // CONFIG, not derived: the dashboard is on Vercel and the socket on
  // Render, so this host cannot infer the other's (§9.11).
  const apiBase = process.env.NEXT_PUBLIC_WIDGET_API_URL?.replace(/\/$/, "") ?? null
  const visitor = describeVisitor(conversation.visitorId)

  return (
    <div className="live">
      <header className="live-head">
        <h1 className="live-title">
          {/* Named the way the agent should trust it (M7.3): "User 42 —
              identified by your server" is an identity the tenant's own
              backend asserted with the secret key; "Visitor vis_…" is an
              anonymous browser handle. */}
          {visitor.noun === "user" ? "User" : "Visitor"} {visitor.name}
          {visitor.identified ? IDENTIFIED_SUFFIX : null}
        </h1>
        <Link className="live-audit" href={`/dashboard/${org.id}/conversations/${conversationId}`}>
          Full transcript and citation verdicts →
        </Link>
      </header>

      {handoff === null ? (
        // A NORMAL state, not an error: it was closed, or was never
        // escalated. Saying so beats a socket that could only fail.
        <p className="live-closed">
          Nobody is waiting on this conversation — it was never escalated, or the handoff has been
          closed. The transcript is still available above.
        </p>
      ) : (
        <>
          <p className="live-lede">
            {handoff.status === "pending"
              ? "This visitor asked for a person. Sending your first message — or simply being here — claims the conversation."
              : "This conversation has been claimed. Everything below is live."}
          </p>
          <HandoffChat orgId={org.id} conversationId={conversationId} apiBase={apiBase} />
        </>
      )}
    </div>
  )
}
