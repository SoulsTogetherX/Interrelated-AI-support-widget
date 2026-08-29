// Conversation list — ordered by the (org_id, last_message_at DESC) index
// that §3.3.2 shaped for exactly this page. Agents see this too:
// reading conversations IS the agent job (writes elsewhere are owner-only).
import Link from "next/link"

import { requireOrgMember } from "@/lib/orgs"
import { listConversations } from "@/lib/conversations/queries"
import "./page.css"

export const metadata = { title: "Conversations — Interrelated" }

function statusLabel(status: "open" | "escalated" | "closed"): string {
  return status === "escalated" ? "escalated to a human" : status
}

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params
  const { org } = await requireOrgMember(orgId)
  const conversations = await listConversations(org.id)

  return (
    <div className="convlist">
      <h1 className="convlist-title">Conversations</h1>
      {conversations.length === 0 ? (
        <p className="convlist-empty">
          No conversations yet — they appear here the moment a visitor asks your widget a question.
        </p>
      ) : (
        <ul className="convlist-items">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link className="convlist-item" href={`/dashboard/${org.id}/conversations/${c.id}`}>
                <span className="convlist-preview">{c.preview ?? "(empty conversation)"}</span>
                <span className="convlist-meta">
                  {c.messageCount} message{c.messageCount === 1 ? "" : "s"} ·{" "}
                  {statusLabel(c.status)} ·{" "}
                  {c.lastMessageAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
