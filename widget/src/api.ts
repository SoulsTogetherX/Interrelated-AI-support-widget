//#region Imports
import type { AnswerEvent } from "@shared/grounding/events"
import { readAnswerEvents } from "./sse"
import { HandoffSocket } from "./handoff"
import type { HandoffConnection, HandoffHandlers, SocketFactory } from "./handoff"
//#endregion

//#region Type Defs
/**
 * The widget's network layer: session minting and the SSE ask stream,
 * speaking the M2.5 route contract (DATAFLOW §5.3). The UI consumes this
 * through the WidgetClient interface so DOM tests inject a scripted fake
 * — network behavior and rendering are tested separately, on purpose.
 */
interface WidgetClient {
  ensureSession(): Promise<void>
  ask(question: string, conversationId?: string): AsyncIterable<AnswerEvent>
  /** Hand this conversation to a person (M4.1). Idempotent server-side, so
   *  a double click costs a round-trip and nothing else; `created` false
   *  means the visitor was already in the queue and the UI should not
   *  announce it twice. */
  escalate(conversationId: string): Promise<{ status: string; created: boolean }>
  /**
   * A 60-second single-use ticket for the handoff socket (§3.24) — minted
   * once per connection ATTEMPT and never stored, which is what makes a
   * reconnect a fresh mint rather than a kept credential.
   *
   * NULL means there is no open handoff to connect to: the agent closed it,
   * or it was never this visitor's. That is the terminal answer, and it is
   * a return value rather than a thrown error precisely because it must be
   * distinguishable from a network failure — one stops handoff.ts's
   * reconnect loop, the other is what the loop is for.
   */
  handoffTicket(conversationId: string): Promise<string | null>
  /**
   * Opens the handoff socket for this conversation. On the CLIENT rather
   * than constructed in ui.ts so the UI keeps knowing nothing about network
   * configuration — the same split that lets DOM tests inject scripted
   * answers, now injecting a scripted socket too.
   */
  openHandoff(conversationId: string, handlers: HandoffHandlers): HandoffConnection
}

interface ApiClientOptions {
  apiBase: string
  publishableKey: string
  /** The fetch captured at script load (index.ts) — the host page may
   *  monkeypatch window.fetch after us, and the widget must not inherit
   *  whatever an analytics snippet did to it. */
  fetchImpl: typeof fetch
  /** WebSocket, captured at load for fetch's reason. */
  socketFactory: SocketFactory
}

/** The org's daily answer ceiling is spent — a terminal state for today,
 *  rendered differently from "slow down a second". */
class QuotaError extends Error {}
/** A token-bucket 429 — transient; the UI says "one moment". */
class RateLimitError extends Error {}
//#endregion

//#region Storage
/** localStorage guarded: Safari private mode and storage-blocked iframes
 *  throw on ACCESS. A visitor id that resets per page load is a degraded
 *  but working state — conversations just don't survive reloads. */
const VISITOR_KEY = "interrelated.visitor"

function loadVisitor(): string | null {
  try {
    return localStorage.getItem(VISITOR_KEY)
  } catch {
    return null
  }
}

function saveVisitor(id: string): void {
  try {
    localStorage.setItem(VISITOR_KEY, id)
  } catch {
    // Degraded mode — see above.
  }
}
//#endregion

//#region Client
class ApiClient implements WidgetClient {
  readonly #apiBase: string
  readonly #publishableKey: string
  readonly #fetch: typeof fetch
  readonly #socketFactory: SocketFactory
  #token: string | null = null
  #visitorId: string | null = loadVisitor()
  #minting: Promise<void> | null = null

  constructor(options: ApiClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/$/, "")
    this.#publishableKey = options.publishableKey
    this.#fetch = options.fetchImpl
    this.#socketFactory = options.socketFactory
  }

  /**
   * Mints the session, SINGLE-FLIGHT. Called fire-and-forget at
   * bubble-open (the DB-warming handshake) and awaited by ask() — and
   * those two race whenever a visitor submits within one mint round-trip
   * (fast typist, slow network; a scripted browser reliably). Without the
   * in-flight memo each caller mints its own session, the server
   * generates a DIFFERENT visitor id per mint (nothing was stored yet),
   * and whichever response lands last clobbers the token — after which
   * every conversation created under the other token's visitor is
   * unreachable ("conversation not found"). Found live in the M2.7
   * browser check, not by the unit tests, which is why one now pins it.
   */
  ensureSession(): Promise<void> {
    if (this.#token !== null) return Promise.resolve()
    this.#minting ??= this.#mint().finally(() => { this.#minting = null })
    return this.#minting
  }

  async #mint(): Promise<void> {
    const response = await this.#fetch(`${this.#apiBase}/v1/widget/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publishableKey: this.#publishableKey,
        ...(this.#visitorId !== null ? { visitorId: this.#visitorId } : {}),
      }),
    })
    if (response.status === 429) throw new RateLimitError("rate limited")
    if (!response.ok) throw new Error(`session mint failed (${response.status})`)
    const body = await response.json() as { token: string; visitorId: string }
    this.#token = body.token
    this.#visitorId = body.visitorId
    saveVisitor(body.visitorId)
  }

  /**
   * One question → the server's event stream. A 401 means the 30-minute
   * token expired mid-conversation; ONE silent re-mint and retry makes
   * expiry invisible to the visitor (a second 401 is a real failure and
   * surfaces). 429 splits by the server's error body: the daily quota is
   * terminal for today, a bucket limit is "try again in a moment".
   */
  async *ask(question: string, conversationId?: string): AsyncIterable<AnswerEvent> {
    const response = await this.#authed("/v1/widget/chat", {
      question,
      ...(conversationId !== undefined ? { conversationId } : {}),
    })
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (body?.error === "daily quota reached") throw new QuotaError(body.error)
      throw new RateLimitError(body?.error ?? "too many requests")
    }
    if (!response.ok || response.body === null) throw new Error(`chat failed (${response.status})`)
    yield* readAnswerEvents(response.body)
  }

  /**
   * Escalate to a person. The server is idempotent by SCHEMA (§3.3.4), so
   * this needs no local guard against a double click — it reports which
   * request actually created the handoff and lets the UI stay quiet on the
   * second.
   */
  async escalate(conversationId: string): Promise<{ status: string; created: boolean }> {
    const response = await this.#authed("/v1/widget/escalate", { conversationId })
    // Escalation shares the chat route's per-visitor bucket on purpose
    // (§3.23) — so its only 429 is that bucket, never the daily answer cap,
    // which no model call is being made against.
    if (response.status === 429) throw new RateLimitError("too many requests")
    if (!response.ok) throw new Error(`escalate failed (${response.status})`)
    return await response.json() as { status: string; created: boolean }
  }

  async handoffTicket(conversationId: string): Promise<string | null> {
    const response = await this.#authed("/v1/widget/handoff-ticket", { conversationId })
    // 404 is "no open handoff for this visitor" — which, after a successful
    // escalate, means it was CLOSED: the one answer worth not retrying.
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`handoff ticket failed (${response.status})`)
    const body = await response.json() as { ticket: string }
    return body.ticket
  }

  openHandoff(conversationId: string, handlers: HandoffHandlers): HandoffConnection {
    const socket = new HandoffSocket({
      apiBase: this.#apiBase,
      conversationId,
      client: this,
      handlers,
      socketFactory: this.#socketFactory,
    })
    socket.open()
    return socket
  }

  /**
   * Every authenticated call goes through here, which is what keeps the
   * silent-re-mint rule in ONE place: a 30-minute token expiring
   * mid-conversation must be invisible on the chat route, the escalate
   * button, and every ticket mint alike — and a second 401 is a real
   * failure that surfaces rather than a loop.
   */
  async #authed(path: string, body: Record<string, unknown>): Promise<Response> {
    await this.ensureSession()
    let response = await this.#post(path, body)
    if (response.status === 401) {
      this.#token = null
      await this.#mint()
      response = await this.#post(path, body)
    }
    return response
  }

  #post(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.#fetch(`${this.#apiBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify(body),
    })
  }
}
//#endregion

//#region Exports
export { ApiClient, QuotaError, RateLimitError }
export type { WidgetClient, ApiClientOptions }
//#endregion
