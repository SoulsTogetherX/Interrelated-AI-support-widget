"use client"

//#region Why this file
// The agent's end of the handoff socket (M4.5), as a hook: connection,
// backoff, and the frame reducer, with rendering left to index.tsx.
//
// Reimplemented rather than shared with widget/src/handoff.ts, for the
// reason widget/src/sse.ts is not shared with realtime's SSE parser: the
// PROTOCOL is the contract (both files import the same frame types from
// @shared/handoff/protocol, so a change breaks both at compile time), the
// transport code is not. The widget's copy is framework-free and lives
// under a 15 KB byte budget; this one is React state and has no budget at
// all. Forcing one implementation to serve both would mean a hook the
// widget must not import, or a class React has to be taught to observe.
//
// What IS identical, because the protocol says so: a ticket is spent per
// connection ATTEMPT (§3.24), so reconnecting re-mints rather than
// replaying; backoff resets on the `ready` FRAME, not on the socket
// opening; and an incoming typing hint expires on this side after
// TYPING_TTL_MS, which is why the server keeps no timer.
//#endregion

//#region Imports
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { TYPING_HINT_INTERVAL_MS, TYPING_TTL_MS } from "@shared/handoff/protocol"
import type { HandoffHistoryMessage, HandoffServerFrame } from "@shared/handoff/protocol"

import type { TicketResult } from "@/lib/handoff/actions"
//#endregion

//#region Types
export type HandoffConnectionState =
  /** No socket yet, or one being re-established. */
  | "connecting"
  /** Attached, and the visitor's browser is attached too. */
  | "live"
  /** Attached, but the visitor has closed their tab or lost signal. */
  | "visitor_away"
  /** The handoff is closed, or this account may not open it. Terminal. */
  | "ended"

export interface HandoffChatState {
  state: HandoffConnectionState
  messages: HandoffHistoryMessage[]
  /** The visitor is composing. Expires on its own — see TYPING_TTL_MS. */
  visitorTyping: boolean
  /** Set when the ticket mint failed for a reason worth showing an
   *  operator (a misconfigured internal secret, mostly). */
  error: string | null
  send: (text: string) => boolean
  hintTyping: () => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000
//#endregion

//#region Helpers
/** http(s) base → ws(s) upgrade URL. The dashboard and the socket are on
 *  different hosts (Vercel and Render), so this base is CONFIG
 *  (NEXT_PUBLIC_WIDGET_API_URL) rather than anything derivable from
 *  location — the same argument the install page makes (§9.11). */
function socketUrl(apiBase: string, ticket: string): string {
  const url = new URL(apiBase)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/handoff`
  url.search = `?ticket=${encodeURIComponent(ticket)}`
  return url.toString()
}
//#endregion

//#region Hook
export function useHandoffSocket(options: {
  apiBase: string
  conversationId: string
  mintTicket: () => Promise<TicketResult>
}): HandoffChatState {
  const { apiBase, conversationId, mintTicket } = options

  const [state, setState] = useState<HandoffConnectionState>("connecting")
  const [messages, setMessages] = useState<HandoffHistoryMessage[]>([])
  const [visitorTyping, setVisitorTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Everything the connection needs to survive a re-render without
  // restarting: React state is for what the UI draws, refs are for what the
  // socket owns.
  const socketRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)
  const stoppedRef = useRef(false)
  const attemptRef = useRef(0)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHintRef = useRef(0)
  // The action identity changes on every render of the parent; capturing it
  // in a ref keeps the connect effect from tearing the socket down and
  // rebuilding it (which would burn a ticket per render).
  const mintRef = useRef(mintTicket)
  mintRef.current = mintTicket

  useEffect(() => {
    stoppedRef.current = false

    const clearTypingTimer = (): void => {
      if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }

    const onFrame = (frame: HandoffServerFrame): void => {
      switch (frame.type) {
        case "ready":
          // Reset the backoff on the FRAME: a socket that opens and dies
          // before authenticating has made no progress, and counting it as
          // success is how a reconnect loop becomes a hot loop.
          attemptRef.current = 0
          readyRef.current = true
          setError(null)
          setState("visitor_away")
          break
        case "history":
          // The backlog REPLACES what is rendered: on attach the server's
          // transcript is the truth, and it carries the bot's turns too —
          // which is most of what an arriving agent needs to read.
          setMessages(frame.messages)
          break
        case "message":
          setMessages((current) =>
            // The server echoes to senders as well, so a message can arrive
            // that the backlog already carried; ids make that idempotent.
            current.some((m) => m.id === frame.id)
              ? current
              : [...current, { id: frame.id, role: frame.role, text: frame.text, at: frame.at }],
          )
          break
        case "presence":
          // Presence is a COUNT, never names (§2.4.7). Here it answers the
          // one question an agent actually has: is the person still there?
          setState(frame.visitors > 0 ? "live" : "visitor_away")
          break
        case "typing":
          clearTypingTimer()
          setVisitorTyping(frame.active)
          if (frame.active) {
            typingTimerRef.current = setTimeout(() => setVisitorTyping(false), TYPING_TTL_MS)
          }
          break
        case "closed":
          // Terminal (M4.6). Said out loud rather than inferred from the
          // disconnect that follows, so this stops the loop instead of
          // spending a reconnect to be told the same thing.
          stoppedRef.current = true
          readyRef.current = false
          setState("ended")
          break
        case "error":
          // Per-frame refusals; the socket stays open (§3.25).
          break
      }
    }

    const scheduleReconnect = (): void => {
      if (stoppedRef.current || reconnectRef.current !== null) return
      const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** attemptRef.current, RECONNECT_MAX_MS)
      attemptRef.current += 1
      const delay = ceiling / 2 + Math.random() * (ceiling / 2)
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (stoppedRef.current) return
      setState((current) => (current === "ended" ? current : "connecting"))

      let result: TicketResult
      try {
        result = await mintRef.current()
      } catch {
        // A Server Action that failed to reach the server at all.
        scheduleReconnect()
        return
      }
      if (stoppedRef.current) return
      if (!result.ok) {
        // The mint is the authorization check, so its refusal is terminal:
        // the handoff closed, or this account may not open it. Retrying
        // would be arguing with a decision.
        setError(result.error)
        setState("ended")
        stoppedRef.current = true
        return
      }

      let socket: WebSocket
      try {
        socket = new WebSocket(socketUrl(apiBase, result.ticket))
      } catch {
        scheduleReconnect()
        return
      }
      socketRef.current = socket

      socket.onmessage = (event: MessageEvent): void => {
        if (typeof event.data !== "string") return
        try {
          onFrame(JSON.parse(event.data) as HandoffServerFrame)
        } catch {
          // Not our frame; nothing to render and nothing to fix.
        }
      }
      socket.onclose = (): void => {
        if (socketRef.current !== socket) return
        socketRef.current = null
        readyRef.current = false
        clearTypingTimer()
        setVisitorTyping(false)
        scheduleReconnect()
      }
    }

    void connect()

    return () => {
      // Strict Mode double-invokes effects in development, and a closed tab
      // must not leave a phantom agent in the room — so teardown is total.
      stoppedRef.current = true
      readyRef.current = false
      if (reconnectRef.current !== null) clearTimeout(reconnectRef.current)
      reconnectRef.current = null
      clearTypingTimer()
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [apiBase, conversationId])

  const send = useCallback((text: string): boolean => {
    const socket = socketRef.current
    if (socket === null || !readyRef.current) return false
    try {
      socket.send(JSON.stringify({ type: "message", text }))
      // Sending ends composing server-side; reset the throttle so the next
      // sentence announces itself immediately.
      lastHintRef.current = 0
      return true
    } catch {
      return false
    }
  }, [])

  const hintTyping = useCallback((): void => {
    const socket = socketRef.current
    if (socket === null || !readyRef.current) return
    const now = Date.now()
    if (now - lastHintRef.current < TYPING_HINT_INTERVAL_MS) return
    lastHintRef.current = now
    try {
      socket.send(JSON.stringify({ type: "typing", active: true }))
    } catch {
      // A socket closing between the check and the send.
    }
  }, [])

  return useMemo(
    () => ({ state, messages, visitorTyping, error, send, hintTyping }),
    [state, messages, visitorTyping, error, send, hintTyping],
  )
}
//#endregion
