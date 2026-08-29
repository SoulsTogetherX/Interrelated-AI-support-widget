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
  /**
   * Remember that a person owns `conversationId`, so that a page RELOAD —
   * or a click to the next page of the customer's site, which is the same
   * event to a widget that lives one page at a time — rejoins the handoff
   * instead of starting a new conversation (M7.4). Until this existed the
   * conversation id lived in memory only, and a visitor who clicked a docs
   * link while waiting for an agent lost the thread; the agent's replies
   * then landed in a room the visitor was no longer in. `panelOpen` is
   * whatever the visitor last had, restored with it: a panel they left open
   * comes back open, one they closed stays closed (and badges).
   *
   * Only ever written while a handoff is LIVE — the bot's conversations are
   * deliberately not bookmarked. Rejoining a bot thread would continue a
   * conversation the widget has no way to show (the transcript arrives only
   * over the socket, on attach), and the bot's answers do not depend on
   * earlier turns; a handoff is the one state where a page change loses
   * something a person on the other end is waiting on.
   */
  rememberHandoff(conversationId: string, panelOpen: boolean): void
  /** The handoff ended, or the server said there is nothing to rejoin. */
  forgetHandoff(): void
  /**
   * The handoff to rejoin at page load, if a fresh bookmark exists. A
   * storage read and NOTHING else — no request is spent until the UI opens
   * the socket, and a page load without a bookmark costs nothing at all.
   * A bookmark past HANDOFF_BOOKMARK_TTL_MS is dropped here rather than
   * probed: the server is the truth about whether the handoff is open (a
   * ticket mint answers that), but a bookmark nobody has touched in a day
   * is not worth a mint on every page for the rest of time — that is the
   * "expiry" DATAFLOW §8.5 said this needed. The recovery path for a stale
   * bookmark INSIDE the window is the socket's own: its first ticket mint
   * comes back null and the UI forgets it (ui.ts).
   */
  storedHandoff(): StoredHandoff | null
}

/** What a page load finds to rejoin: the conversation, and whether the
 *  panel was open when the visitor last saw it. */
interface StoredHandoff {
  conversationId: string
  panelOpen: boolean
}

/**
 * Where the session comes from — the one thing the strong mode changes
 * (trust-model layer 6, M7.3). Either the widget mints it itself with the
 * PUBLISHABLE key (POST /v1/widget/session, the default), or it fetches it
 * from a URL on the CUSTOMER's own site, whose server minted it with the
 * SECRET key for a user it has signed in. Everything after the mint is
 * identical: same token, same routes, same 401 → re-mint dance — a
 * re-mint in strong mode is simply another fetch of that URL, so an expiring
 * token stays invisible there too.
 */
type SessionSource =
  { kind: "publishable"; publishableKey: string } | { kind: "url"; sessionUrl: string }

interface ApiClientOptions {
  apiBase: string
  /** Exactly one of the two: `publishableKey` (the default mode) or
   *  `sessionUrl` (strong mode). Given both, strong mode wins — the point of
   *  it is that the publishable key need not be on the page at all. */
  publishableKey?: string
  sessionUrl?: string
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

/**
 * The handoff bookmark (M7.4): the conversation a person currently owns,
 * kept beside the visitor id under the same guard, so the next page load
 * can rejoin it. `at` is the last time the widget touched it — written on
 * entering the handoff, on every attach, and on every panel toggle — and
 * is what the TTL below is measured from.
 *
 * Deliberately NOT in the bookmark: the visitor id. In the default mode it
 * is already stored beside this and travels with the mint; in strong mode
 * it is the customer's own user id, which api.ts refuses to persist (§8.1
 * — a stored copy would only be sent back on some later publishable-key
 * mint that refuses it). Ownership is the server's check anyway: a ticket
 * mint for a conversation that is not this visitor's answers 404, and the
 * bookmark is dropped — the same recovery path as a closed handoff, so
 * user B signing in on user A's browser gets nothing but one refused
 * probe. Nor the token: a session is re-minted on the next page as it
 * always was (one POST, the same handshake bubble-open makes), which is
 * what keeps strong mode's "only signed-in users" true across pages — a
 * cached token would outlive a sign-out by up to thirty minutes.
 */
const HANDOFF_KEY = "interrelated.handoff"
/** How long a bookmark stays worth a probe. A day: an escalation left
 *  overnight still rejoins in the morning; a page load a week later does
 *  not spend a mint asking. Measured from the last touch, not the first,
 *  so a long live conversation never expires under the visitor. */
const HANDOFF_BOOKMARK_TTL_MS = 24 * 60 * 60 * 1000

interface HandoffBookmark extends StoredHandoff {
  at: number
}

function loadHandoffBookmark(): HandoffBookmark | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY)
    if (raw === null) return null
    // Shape-checked, because this is storage on the customer's origin and
    // anything on that page can write it: a bookmark that is not ours is
    // no bookmark. The conversation id's own shape is the SERVER's to
    // judge (a malformed one gets a 400 and the socket treats that as
    // "nothing to rejoin" — see handoffTicket).
    const parsed = JSON.parse(raw) as Partial<HandoffBookmark> | null
    if (parsed === null || typeof parsed !== "object") return null
    if (typeof parsed.conversationId !== "string" || typeof parsed.at !== "number") return null
    return {
      conversationId: parsed.conversationId,
      panelOpen: parsed.panelOpen !== false,
      at: parsed.at,
    }
  } catch {
    return null
  }
}

function saveHandoffBookmark(bookmark: HandoffBookmark): void {
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(bookmark))
  } catch {
    // Degraded mode: the handoff works for this page load and is simply
    // not rejoined on the next — the same story as the visitor id.
  }
}

function clearHandoffBookmark(): void {
  try {
    localStorage.removeItem(HANDOFF_KEY)
  } catch {
    // Nothing to clear where nothing could be written.
  }
}
//#endregion

//#region Client
class ApiClient implements WidgetClient {
  readonly #apiBase: string
  readonly #source: SessionSource
  readonly #fetch: typeof fetch
  readonly #socketFactory: SocketFactory
  #token: string | null = null
  #visitorId: string | null = loadVisitor()
  #minting: Promise<void> | null = null

  constructor(options: ApiClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/$/, "")
    if (options.sessionUrl !== undefined) {
      this.#source = { kind: "url", sessionUrl: options.sessionUrl }
    } else if (options.publishableKey !== undefined) {
      this.#source = { kind: "publishable", publishableKey: options.publishableKey }
    } else {
      // index.ts refuses to mount without one of the two; this is the
      // programming-error case, and a loud one beats a widget that mints
      // against nothing.
      throw new Error("ApiClient needs a publishableKey or a sessionUrl")
    }
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
    this.#minting ??= this.#mint().finally(() => {
      this.#minting = null
    })
    return this.#minting
  }

  async #mint(): Promise<void> {
    const response =
      this.#source.kind === "url"
        ? await this.#fetchServerMintedSession(this.#source.sessionUrl)
        : await this.#fetch(`${this.#apiBase}/v1/widget/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              publishableKey: this.#source.publishableKey,
              ...(this.#visitorId !== null ? { visitorId: this.#visitorId } : {}),
            }),
          })
    if (response.status === 429) throw new RateLimitError("rate limited")
    if (!response.ok) throw new Error(`session mint failed (${response.status})`)
    // Both sources answer the same shape — the customer's endpoint proxies
    // realtime's response verbatim — so one parse serves both.
    const body = (await response.json()) as { token: string; visitorId?: string }
    this.#token = body.token
    if (this.#source.kind === "publishable" && typeof body.visitorId === "string") {
      // The anonymous handle is persisted so a reload keeps its thread. A
      // server-identified id is deliberately NOT: the customer's server
      // names the user on every mint, and a stored copy would only be sent
      // back on some later publishable-key mint — where the route refuses
      // anything but the anonymous shape, by design (it is how a browser is
      // kept from claiming a server-asserted identity).
      this.#visitorId = body.visitorId
      saveVisitor(body.visitorId)
    }
  }

  /**
   * Strong mode's mint: GET the customer's endpoint with the page's own
   * cookies, and let THEIR server decide who this is. GET rather than POST
   * so the endpoint sits outside every framework's CSRF check by default
   * (Rails, Django, and friends refuse an unadorned POST) — a token mint has
   * no state to protect from forgery, and a cross-origin page cannot read
   * the answer. `credentials: "include"` is what makes it same-origin-with-
   * cookies for the relative URL the snippet carries and still work for a
   * customer who points it at their API host with credentialed CORS.
   * `no-store` because a cached token is a token that expires mid-chat.
   */
  #fetchServerMintedSession(sessionUrl: string): Promise<Response> {
    return this.#fetch(sessionUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    })
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
      const body = (await response.json().catch(() => null)) as { error?: string } | null
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
    return (await response.json()) as { status: string; created: boolean }
  }

  async handoffTicket(conversationId: string): Promise<string | null> {
    const response = await this.#authed("/v1/widget/handoff-ticket", { conversationId })
    // 404 is "no open handoff for this visitor" — which, after a successful
    // escalate, means it was CLOSED: the one answer worth not retrying. 400
    // is "that is not even a conversation id", which can only come from a
    // tampered bookmark (M7.4 — the id from a `meta` event is well-formed by
    // construction); it is the same terminal answer, because no retry will
    // make the id well-formed and a reconnect loop arguing with a 400
    // forever would be the failure mode a bounded rejoin exists to avoid.
    if (response.status === 404 || response.status === 400) return null
    if (!response.ok) throw new Error(`handoff ticket failed (${response.status})`)
    const body = (await response.json()) as { ticket: string }
    return body.ticket
  }

  rememberHandoff(conversationId: string, panelOpen: boolean): void {
    saveHandoffBookmark({ conversationId, panelOpen, at: Date.now() })
  }

  forgetHandoff(): void {
    clearHandoffBookmark()
  }

  storedHandoff(): StoredHandoff | null {
    const bookmark = loadHandoffBookmark()
    if (bookmark === null) return null
    if (Date.now() - bookmark.at > HANDOFF_BOOKMARK_TTL_MS) {
      // Past the window: not probed, not kept. (A bookmark stamped in the
      // FUTURE by a clock that jumped reads as fresh here and is settled by
      // the server like any other — this check bounds cost, not truth.)
      clearHandoffBookmark()
      return null
    }
    return { conversationId: bookmark.conversationId, panelOpen: bookmark.panelOpen }
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
export { ApiClient, QuotaError, RateLimitError, HANDOFF_BOOKMARK_TTL_MS }
export type { WidgetClient, ApiClientOptions, StoredHandoff }
//#endregion
