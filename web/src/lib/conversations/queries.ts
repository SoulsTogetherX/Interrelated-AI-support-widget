//#region Why this file
// The dashboard's read side for conversations — the surface where the
// verification thesis becomes VISIBLE to the tenant: every claim's verdict
// is stored (§3.3.2 keeps verified and stripped alike), so the
// transcript view can show exactly what the visitor saw AND what the
// verifier refused to show them. Straight-from-Postgres like every
// dashboard read; every query is org-scoped in the WHERE, so a
// conversation id from another tenant behaves like one that never existed.
//#endregion

//#region Imports
import { isId } from "@shared/utils/ids"

import { db } from "@/lib/db"
//#endregion

//#region Types
export interface ConversationSummary {
  id: string
  visitorId: string
  status: "open" | "escalated" | "closed"
  lastMessageAt: Date
  messageCount: number
  /** The newest message's text, for the list's one-line preview. */
  preview: string | null
}

export interface CitationView {
  ord: number
  claimText: string
  quote: string
  verdict: "verified" | "unknown_chunk" | "quote_not_found"
  url: string | null
  headingPath: string | null
}

export interface MessageView {
  id: string
  role: "visitor" | "assistant" | "agent"
  content: string
  model: string | null
  refused: boolean
  ttftMs: number | null
  totalMs: number | null
  createdAt: Date
  citations: CitationView[]
}

export interface ConversationView {
  id: string
  visitorId: string
  status: "open" | "escalated" | "closed"
  messages: MessageView[]
}
//#endregion

//#region Queries
export async function listConversations(
  orgId: string,
  limit = 50,
): Promise<ConversationSummary[]> {
  // The (org_id, last_message_at DESC) index from §3.3.2 IS this
  // list — the schema was shaped for exactly this query.
  const conversations = await db
    .selectFrom("conversations")
    .select(["id", "visitor_id", "status", "last_message_at"])
    .where("org_id", "=", orgId)
    .orderBy("last_message_at", "desc")
    .limit(limit)
    .execute()
  if (conversations.length === 0) {
    return []
  }
  const ids = conversations.map((c) => c.id)

  const messages = await db
    .selectFrom("messages")
    .select(["conversation_id", "content", "created_at"])
    .where("conversation_id", "in", ids)
    .orderBy("created_at", "desc")
    .execute()
  const newest = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const m of messages) {
    if (!newest.has(m.conversation_id)) newest.set(m.conversation_id, m.content)
    counts.set(m.conversation_id, (counts.get(m.conversation_id) ?? 0) + 1)
  }

  return conversations.map((c) => ({
    id: c.id,
    visitorId: c.visitor_id,
    status: c.status,
    lastMessageAt: c.last_message_at,
    messageCount: counts.get(c.id) ?? 0,
    preview: newest.get(c.id) ?? null,
  }))
}

export async function getConversation(
  orgId: string,
  conversationId: string,
): Promise<ConversationView | null> {
  if (!isId("con", conversationId)) {
    return null
  }
  const conversation = await db
    .selectFrom("conversations")
    .select(["id", "visitor_id", "status"])
    .where("id", "=", conversationId)
    .where("org_id", "=", orgId) // the tenant boundary — not an afterthought
    .executeTakeFirst()
  if (!conversation) {
    return null
  }

  const messages = await db
    .selectFrom("messages")
    .select(["id", "role", "content", "model", "refused", "ttft_ms", "total_ms", "created_at"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "asc")
    .execute()

  const citations = messages.length > 0
    ? await db
        .selectFrom("message_citations")
        .select(["message_id", "ord", "claim_text", "quote", "verdict", "url", "heading_path"])
        .where("message_id", "in", messages.map((m) => m.id))
        .orderBy("ord", "asc")
        .execute()
    : []
  const byMessage = new Map<string, CitationView[]>()
  for (const c of citations) {
    const list = byMessage.get(c.message_id) ?? []
    list.push({
      ord: c.ord,
      claimText: c.claim_text,
      quote: c.quote,
      verdict: c.verdict,
      url: c.url,
      headingPath: c.heading_path,
    })
    byMessage.set(c.message_id, list)
  }

  return {
    id: conversation.id,
    visitorId: conversation.visitor_id,
    status: conversation.status,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      model: m.model,
      refused: m.refused,
      ttftMs: m.ttft_ms,
      totalMs: m.total_ms,
      createdAt: m.created_at,
      citations: byMessage.get(m.id) ?? [],
    })),
  }
}
//#endregion
