"use client"

//#region Why this component
// The agent's working surface (M4.5): the live half of a handed-off
// conversation. The transcript page (§9.10) stays the AUDIT view — claims,
// verdicts, what the verifier stripped — and this is where someone answers.
// Two surfaces because they have two jobs; the inbox links to the other.
//
// Rendering rule, identical to the widget's (§8.2): every piece of text
// goes through JSX children, never dangerouslySetInnerHTML. Visitor prose
// arrives over a socket from a stranger's browser, and an agent reading it
// in a session-authenticated dashboard is exactly who an XSS would want.
// React escapes by default; the rule here is simply never to opt out.
//#endregion

//#region Imports
import { useEffect, useRef, useState } from "react"

import { MAX_HANDOFF_MESSAGE_CHARS } from "@shared/handoff/protocol"

import { closeHandoffAction, requestHandoffTicketAction } from "@/lib/handoff/actions"
import { useHandoffSocket } from "./useHandoffSocket"
import "./styles.css"

import type { HandoffConnectionState } from "./useHandoffSocket"
//#endregion

//#region Copy
const STATE_LABEL: Record<HandoffConnectionState, string> = {
  connecting: "Connecting…",
  live: "Visitor is here",
  visitor_away: "Visitor is away — they'll see this when they return",
  ended: "This handoff is closed",
}

const ROLE_LABEL: Record<string, string> = {
  visitor: "Visitor",
  agent: "Agent",
  assistant: "Assistant",
}
//#endregion

//#region Component
export default function HandoffChat({
  orgId,
  conversationId,
  apiBase,
}: {
  orgId: string
  conversationId: string
  /** NEXT_PUBLIC_WIDGET_API_URL. Null renders the setup notice instead of
   *  a chat that could never connect. */
  apiBase: string | null
}) {
  if (!apiBase) {
    return (
      <p className="handoff-setup">
        This deployment has no <code>NEXT_PUBLIC_WIDGET_API_URL</code>, so the dashboard does not
        know where the realtime service is. Set it to the widget API&apos;s public URL and reload.
      </p>
    )
  }
  return <Chat orgId={orgId} conversationId={conversationId} apiBase={apiBase} />
}

function Chat({
  orgId,
  conversationId,
  apiBase,
}: {
  orgId: string
  conversationId: string
  apiBase: string
}) {
  const [draft, setDraft] = useState("")
  const [unsent, setUnsent] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const { state, messages, visitorTyping, error, send, hintTyping } = useHandoffSocket({
    apiBase,
    conversationId,
    mintTicket: () => requestHandoffTicketAction(orgId, conversationId),
  })

  // Follow the conversation, the way every chat does.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages, visitorTyping])

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0) return
    if (!send(text)) {
      // Keep the agent's words: a support reply that silently vanished is
      // worse than one that visibly did not send.
      setUnsent(true)
      return
    }
    // Nothing is appended here — the server broadcasts the message back to
    // its sender (§2.4.7), so the echo is the render, and both ends show
    // one order from one source of truth.
    setUnsent(false)
    setDraft("")
  }

  return (
    <section className="handoff" aria-label="Live conversation">
      <header className={`handoff-state handoff-state-${state}`}>
        <span>{STATE_LABEL[state]}</span>
        {state !== "ended" && (
          <button
            type="button"
            className="handoff-close"
            disabled={closing}
            onClick={() => {
              setClosing(true)
              setCloseError(null)
              // No confirmation dialog: closing is REVERSIBLE by the
              // product's own rules — the visitor can escalate again and
              // the partial index over open rows lets them (§3.3.4) — so
              // an "are you sure?" would be ceremony over a decision that
              // costs one more click to undo.
              void closeHandoffAction(orgId, conversationId).then((result) => {
                setClosing(false)
                // The socket's `closed` frame is what flips this panel to
                // ended; nothing is set here on success, so the UI can
                // never claim an ending the server did not perform.
                if (!result.ok) setCloseError(result.error)
              })
            }}
          >
            {closing ? "Closing…" : "Close conversation"}
          </button>
        )}
      </header>

      {error !== null && <p className="handoff-error">{error}</p>}
      {closeError !== null && <p className="handoff-error">{closeError}</p>}

      <div className="handoff-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 && state !== "connecting" && (
          <p className="handoff-empty">No messages in this conversation yet.</p>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`handoff-msg handoff-msg-${message.role}`}>
            <span className="handoff-who">{ROLE_LABEL[message.role] ?? message.role}</span>
            <p>{message.text}</p>
            <time dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time>
          </article>
        ))}
        {visitorTyping && <p className="handoff-typing">Visitor is typing…</p>}
      </div>

      <form className="handoff-compose" onSubmit={onSubmit}>
        <input
          type="text"
          value={draft}
          maxLength={MAX_HANDOFF_MESSAGE_CHARS}
          placeholder={state === "ended" ? "This handoff is closed" : "Reply to the visitor…"}
          aria-label="Your reply"
          disabled={state === "ended"}
          onChange={(event) => {
            setDraft(event.target.value)
            hintTyping()
          }}
        />
        <button type="submit" disabled={state === "ended" || draft.trim().length === 0}>
          Send
        </button>
      </form>
      {unsent && (
        <p className="handoff-unsent">
          Not connected — your reply wasn&apos;t sent. It is still in the box; try again in a
          moment.
        </p>
      )}
    </section>
  )
}
//#endregion
