//#region Imports
import type { AnswerEvent } from "@shared/grounding/events"
import { readAnswerEvents } from "./sse"
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
}

interface ApiClientOptions {
  apiBase: string
  publishableKey: string
  /** The fetch captured at script load (index.ts) — the host page may
   *  monkeypatch window.fetch after us, and the widget must not inherit
   *  whatever an analytics snippet did to it. */
  fetchImpl: typeof fetch
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
  #token: string | null = null
  #visitorId: string | null = loadVisitor()

  constructor(options: ApiClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/$/, "")
    this.#publishableKey = options.publishableKey
    this.#fetch = options.fetchImpl
  }

  /** Mints (or re-mints) the session. Called at bubble-open — which is
   *  also the handshake that warms the backend's database while the
   *  visitor types their first question (the free-tier design). */
  async ensureSession(): Promise<void> {
    if (this.#token !== null) return
    await this.#mint()
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
    await this.ensureSession()
    let response = await this.#post(question, conversationId)
    if (response.status === 401) {
      this.#token = null
      await this.#mint()
      response = await this.#post(question, conversationId)
    }
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (body?.error === "daily quota reached") throw new QuotaError(body.error)
      throw new RateLimitError(body?.error ?? "too many requests")
    }
    if (!response.ok || response.body === null) throw new Error(`chat failed (${response.status})`)
    yield* readAnswerEvents(response.body)
  }

  #post(question: string, conversationId?: string): Promise<Response> {
    return this.#fetch(`${this.#apiBase}/v1/widget/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify({
        question,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
    })
  }
}
//#endregion

//#region Exports
export { ApiClient, QuotaError, RateLimitError }
export type { WidgetClient, ApiClientOptions }
//#endregion
