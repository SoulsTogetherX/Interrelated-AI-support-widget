// The agent inbox (M4.5): who is waiting for a person right now. Deliberately
// a different surface from Conversations (§9.10), which lists everything by
// recency — an inbox sorted by recency buries whoever has waited longest,
// and that is exactly the visitor the tenant is failing.
//
// Readable by every member, not just owners: answering a waiting visitor IS
// the agent role.
import Link from "next/link"

import { requireOrgMember } from "@/lib/orgs"
import { listOpenHandoffs } from "@/lib/handoff/queries"
import { describeVisitor } from "@/lib/conversations/visitors"
import AutoRefresh from "@/components/AutoRefresh"
import "./page.css"

export const metadata = { title: "Inbox — Interrelated" }

const REASON_LABEL: Record<string, string> = {
  visitor_request: "asked for a person",
  low_confidence: "the assistant couldn't answer",
}

/** "4 min" — a wait, in the units someone triaging a queue thinks in. */
function waited(since: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - since.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export default async function InboxPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const { org, user } = await requireOrgMember(orgId)
  const waiting = await listOpenHandoffs(org.id)
  const now = Date.now()

  return (
    <div className="inbox">
      {/* The queue changes when a VISITOR acts, not when this page does, so
          unlike the sources page this refresh runs unconditionally — an
          inbox that only updates on reload is an inbox nobody trusts. */}
      <AutoRefresh everyMs={8000} />

      <h1 className="inbox-title">Inbox</h1>
      <p className="inbox-lede">
        Conversations a visitor is waiting on. Opening one connects you to them — attaching is what
        claims it, so there is no separate button to forget.
      </p>

      {waiting.length === 0 ? (
        <p className="inbox-empty">
          Nobody is waiting. Escalations appear here the moment a visitor asks for a person.
        </p>
      ) : (
        <ul className="inbox-list">
          {waiting.map((handoff) => (
            <li key={handoff.handoffId} className="inbox-item">
              <Link
                className="inbox-link"
                href={`/dashboard/${org.id}/inbox/${handoff.conversationId}`}
              >
                <span className={`inbox-badge inbox-badge-${handoff.status}`}>
                  {handoff.status === "pending" ? "waiting" : "with an agent"}
                </span>
                <span className="inbox-preview">{handoff.preview ?? "(no messages yet)"}</span>
                <span className="inbox-meta">
                  {/* "user 42" when the tenant's server identified them
                      (M7.3): the id an agent can act on, and one a browser
                      cannot forge. */}
                  {describeVisitor(handoff.visitorId).noun}{" "}
                  {describeVisitor(handoff.visitorId).name}
                  {" · "}
                  {REASON_LABEL[handoff.reason] ?? handoff.reason}
                  {" · "}
                  waiting {waited(handoff.requestedAt, now)}
                  {handoff.claimedBy !== null &&
                    (handoff.claimedBy === user.id
                      ? " · claimed by you"
                      : " · claimed by a colleague")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
