// The transcript — where the verification thesis faces the tenant. Every
// claim's verdict renders, VERIFIED AND STRIPPED ALIKE: `content` is what
// the visitor actually saw, and the stripped rows underneath are what the
// verifier refused to show them (with the reason split the schema
// stores: fabricated chunk id vs real chunk, quote not found). Assistant
// rows also carry the model and latency — per-answer observability the
// metrics milestone (M5) aggregates later.
import { notFound } from "next/navigation"

import { requireOrgMember } from "@/lib/orgs"
import { getConversation } from "@/lib/conversations/queries"
import { IDENTIFIED_SUFFIX, describeVisitor } from "@/lib/conversations/visitors"
import "./page.css"

import type { CitationView } from "@/lib/conversations/queries"

export const metadata = { title: "Conversation — Interrelated" }

const VERDICT_LABEL: Record<CitationView["verdict"], string> = {
  verified: "verified",
  quote_not_found: "stripped — quote not found in the cited source",
  unknown_chunk: "stripped — cited a chunk that was never retrieved",
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ orgId: string; conversationId: string }>
}) {
  const { orgId, conversationId } = await params
  const { org } = await requireOrgMember(orgId)
  const conversation = await getConversation(org.id, conversationId)
  if (!conversation) {
    notFound()
  }
  // An identified visitor is named in full with the reason the name can be
  // trusted (M7.3): only the tenant's own server, holding the secret key,
  // can put a non-anonymous id in a session.
  const visitor = describeVisitor(conversation.visitorId)

  return (
    <div className="transcript">
      <h1 className="transcript-title">
        Conversation with {visitor.noun} {visitor.name}
        {visitor.identified ? IDENTIFIED_SUFFIX : null}
      </h1>
      <p className="transcript-status">status: {conversation.status}</p>

      <ol className="transcript-messages">
        {conversation.messages.map((m) => (
          <li className={`transcript-message transcript-message-${m.role}`} key={m.id}>
            <div className="transcript-head">
              <span className="transcript-role">{m.role}</span>
              {m.model ? <span className="transcript-model">{m.model}</span> : null}
              {m.refused ? <span className="transcript-refused">refused</span> : null}
              {m.totalMs !== null ? (
                <span className="transcript-latency">
                  {m.ttftMs !== null ? `${m.ttftMs}ms to first token · ` : ""}
                  {m.totalMs}ms total
                </span>
              ) : null}
            </div>
            <p className="transcript-content">{m.content}</p>
            {m.citations.length > 0 ? (
              <ul className="transcript-citations">
                {m.citations.map((c) => (
                  <li
                    className={`transcript-citation transcript-citation-${c.verdict}`}
                    key={c.ord}
                  >
                    <span className="transcript-verdict">{VERDICT_LABEL[c.verdict]}</span>
                    <span className="transcript-claim">{c.claimText}</span>
                    <blockquote className="transcript-quote">
                      “{c.quote}”
                      {c.url ? (
                        <>
                          {" — "}
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {c.headingPath ?? c.url}
                          </a>
                        </>
                      ) : null}
                    </blockquote>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
