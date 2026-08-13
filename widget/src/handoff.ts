//#region Imports
import type { WidgetClient } from "./api"
import { TYPING_HINT_INTERVAL_MS, TYPING_TTL_MS } from "@shared/handoff/protocol"
import type { HandoffHistoryMessage, HandoffServerFrame } from "@shared/handoff/protocol"
//#endregion

//#region Type Defs
/**
 * The visitor's end of the handoff socket (§2.4.7, DATAFLOW §8.3–§8.4) —
 * the browser twin of realtime/src/handoff/socket.ts, in the same spirit as
 * sse.ts: the wire protocol is shared, the transport code is not.
 *
 * Note what IS imported from shared/ here: the two typing constants. The
 * widget's no-runtime-imports rule (§8.1) is about BEHAVIOR — an SSE parser
 * reimplemented for browser streams rather than lifted from the server. A
 * TTL and a refresh interval are contract, not behavior: the invariant that
 * makes them correct (TTL > 2× interval) is a property of the pair, so
 * copying the numbers into this file is precisely the drift shared/ exists
 * to prevent. esbuild inlines them; the bundle carries no module.
 *
 * This class owns exactly one thing the UI should not have to: the fact
 * that a socket is not a durable connection. Tickets are single-use and
 * expire in 60 seconds (§3.24), so a reconnect is a fresh MINT plus a fresh
 * upgrade — there is no credential to keep around and nothing to refresh.
 */
interface HandoffHandlers {
  /** Connection state, worded for a person waiting on another person.
   *  "connecting" covers the first attempt AND every reconnect: a visitor
   *  does not need to know which. */
  onStatus(status: HandoffStatus): void
  /** The backlog, once per attach. The UI renders it OVER its thread — the
   *  reason this is a distinct callback and not N onMessage calls. */
  onHistory(messages: HandoffHistoryMessage[]): void
  onMessage(message: HandoffHistoryMessage): void
  /** Somebody else started or stopped composing. Already TTL-guarded — the
   *  UI just shows and hides. */
  onTyping(active: boolean): void
}

type HandoffStatus =
  /** No socket yet, or one being re-established. */
  | "connecting"
  /** Attached, but nobody has picked the conversation up. */
  | "waiting"
  /** A person is on the other end. */
  | "connected"
  /** The handoff is closed — terminal, and the only state that stops the
   *  reconnect loop on its own. */
  | "ended"

interface HandoffSocketOptions {
  apiBase: string
  conversationId: string
  client: WidgetClient
  handlers: HandoffHandlers
  /** Captured at script load like fetch (index.ts), and injectable so DOM
   *  tests drive a scripted fake instead of a real connection. */
  socketFactory: SocketFactory
}

/** Kept as the DOM type rather than a hand-rolled interface: the widget
 *  uses four members of it, and a fake in a test can say so with one cast
 *  at the seam instead of implementing EventTarget. */
type SocketFactory = (url: string) => WebSocket

/** What the UI is handed: three verbs, no transport. Everything about
 *  tickets, backoff, and frame shapes stays on this side of the seam. */
interface HandoffConnection {
  /** False means "not attached" — the UI keeps the visitor's text. */
  send(text: string): boolean
  hintTyping(): void
  close(): void
}
//#endregion

//#region Constants
/** Reconnect backoff. Capped low because the thing on the other end is a
 *  person waiting for a reply, and unbounded because giving up would leave
 *  a visitor staring at a dead panel with no way back short of a reload —
 *  the tab closing is what ends this loop, or a closed handoff (terminal,
 *  see #connect). Jitter keeps a page full of widgets from reconnecting in
 *  lockstep after a deploy. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000
//#endregion

//#region Helpers
/**
 * The socket URL for a ticket. `data-api=""` (the demo's same-origin
 * setting, §3.20) has to work here as it does for fetch, so the base is
 * resolved against the page before its scheme is swapped — http→ws and
 * https→wss, never a guess.
 */
function socketUrl(apiBase: string, ticket: string): string {
  const url = new URL(apiBase === "" ? "/" : apiBase, location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/handoff`
  // The ticket rides the URL because a browser cannot set a header on a
  // handshake — which is the whole reason it is disposable (§3.24).
  url.search = `?ticket=${encodeURIComponent(ticket)}`
  return url.toString()
}
//#endregion

//#region Socket
class HandoffSocket implements HandoffConnection {
  readonly #options: HandoffSocketOptions
  #socket: WebSocket | null = null
  /** Set by close(): the difference between "the connection dropped" and
   *  "we are done", which is the difference between reconnecting and not. */
  #stopped = false
  #ready = false
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #typingTimer: ReturnType<typeof setTimeout> | null = null
  #lastHintAt = 0

  constructor(options: HandoffSocketOptions) {
    this.#options = options
  }

  /** Starts connecting. Safe to call once; the class owns every retry after
   *  that. */
  open(): void {
    void this.#connect()
  }

  /**
   * Sends a message, reporting whether it went. False means "not attached"
   * — the UI keeps the visitor's text in the box rather than pretending it
   * was delivered, because a support message that silently vanished is
   * worse than one that visibly did not send.
   *
   * Nothing is rendered optimistically: the server broadcasts every message
   * back to its sender (§2.4.7), so the echo IS the render. One order, one
   * source of truth, and no local dedupe against the replay.
   */
  send(text: string): boolean {
    if (!this.#send({ type: "message", text })) return false
    // The server clears composing on a message; reset the local throttle so
    // the NEXT sentence announces itself immediately rather than waiting
    // out an interval that started before the send.
    this.#lastHintAt = 0
    return true
  }

  /** Called per keystroke by the UI, throttled to the protocol's refresh
   *  interval here rather than there — the server floors it again at 250 ms,
   *  and a client that respects the contract never meets that floor. */
  hintTyping(): void {
    const now = Date.now()
    if (now - this.#lastHintAt < TYPING_HINT_INTERVAL_MS) return
    this.#lastHintAt = now
    this.#send({ type: "typing", active: true })
  }

  /** Deliberate teardown: stops the reconnect loop, drops timers, closes. */
  close(): void {
    this.#stopped = true
    this.#ready = false
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer)
    if (this.#typingTimer !== null) clearTimeout(this.#typingTimer)
    this.#socket?.close()
    this.#socket = null
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return
    this.#options.handlers.onStatus("connecting")

    let ticket: string | null
    try {
      ticket = await this.#options.client.handoffTicket(this.#options.conversationId)
    } catch {
      // A throw is a network or server failure — exactly what the loop is
      // for.
      this.#scheduleReconnect()
      return
    }
    // Null is the one terminal answer: the conversation went back to being
    // the bot's (or was resolved), and retrying forever would be a widget
    // arguing with a decision an agent already made.
    if (ticket === null) {
      this.#stopped = true
      this.#options.handlers.onStatus("ended")
      return
    }
    if (this.#stopped) return

    let socket: WebSocket
    try {
      socket = this.#options.socketFactory(socketUrl(this.#options.apiBase, ticket))
    } catch {
      // A blocked or malformed URL (a CSP connect-src the customer forgot —
      // §9.11 prints the directive) must not throw out of a timer.
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket

    socket.onmessage = (event: MessageEvent): void => {
      // Frames are JSON text; anything else is not ours to interpret.
      if (typeof event.data !== "string") return
      let frame: HandoffServerFrame
      try {
        frame = JSON.parse(event.data) as HandoffServerFrame
      } catch {
        return
      }
      this.#onFrame(frame)
    }
    socket.onclose = (): void => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#ready = false
      this.#clearTyping()
      this.#scheduleReconnect()
    }
    // No onerror handling beyond what close does: a WebSocket error is
    // always followed by a close, and the two paths would be one policy.
  }

  #onFrame(frame: HandoffServerFrame): void {
    switch (frame.type) {
      case "ready":
        // Reset the backoff HERE, not on the socket opening: a connection
        // that opens and dies before authenticating has not made progress,
        // and treating it as success is how a reconnect loop turns into a
        // hot loop.
        this.#attempt = 0
        this.#ready = true
        this.#options.handlers.onStatus(frame.status === "active" ? "connected" : "waiting")
        break
      case "history":
        this.#options.handlers.onHistory(frame.messages)
        break
      case "message":
        this.#options.handlers.onMessage({
          id: frame.id, role: frame.role, text: frame.text, at: frame.at,
        })
        break
      case "presence":
        // Presence is the product meaning of "someone is here" — an agent
        // attaching IS the claim (§3.25), so this is what flips the wait.
        this.#options.handlers.onStatus(frame.agents > 0 ? "connected" : "waiting")
        break
      case "typing":
        this.#onTyping(frame.active)
        break
      case "error":
        // Server errors on this socket are per-frame, not fatal (§3.25
        // refuses frames without dropping the connection), so there is
        // nothing to tear down and nothing a visitor could act on.
        break
    }
  }

  /**
   * The receiver's half of the typing contract: hold the indicator for at
   * most TYPING_TTL_MS without a refresh. This timer is why the SERVER
   * needs none — a socket that dies mid-sentence cannot leave "typing…" on
   * screen, because the thing displaying it is the thing expiring it.
   */
  #onTyping(active: boolean): void {
    if (this.#typingTimer !== null) clearTimeout(this.#typingTimer)
    this.#typingTimer = null
    this.#options.handlers.onTyping(active)
    if (!active) return
    this.#typingTimer = setTimeout(() => {
      this.#typingTimer = null
      this.#options.handlers.onTyping(false)
    }, TYPING_TTL_MS)
  }

  #clearTyping(): void {
    if (this.#typingTimer === null) return
    clearTimeout(this.#typingTimer)
    this.#typingTimer = null
    this.#options.handlers.onTyping(false)
  }

  #send(frame: { type: "message"; text: string } | { type: "typing"; active: boolean }): boolean {
    const socket = this.#socket
    if (socket === null || !this.#ready) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      // A socket closing between the readiness check and the send.
      return false
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempt, RECONNECT_MAX_MS)
    this.#attempt += 1
    // Half the ceiling plus jitter, so a fleet of widgets that lost the
    // server together do not all come back in the same millisecond.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delay)
  }
}
//#endregion

//#region Exports
export { HandoffSocket }
export type {
  HandoffConnection,
  HandoffHandlers,
  HandoffSocketOptions,
  HandoffStatus,
  SocketFactory,
}
//#endregion
