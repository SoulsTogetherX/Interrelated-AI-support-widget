//#region Imports
import type { AnswerEvent } from "@shared/grounding/events"
import { QuotaError, RateLimitError } from "./api"
import type { WidgetClient } from "./api"
import type { HandoffConnection, HandoffHandlers, HandoffStatus } from "./handoff"
import { MAX_HANDOFF_MESSAGE_CHARS } from "@shared/handoff/protocol"
import type { HandoffHistoryMessage } from "@shared/handoff/protocol"
import { WIDGET_CSS } from "./styles"
//#endregion

//#region Type Defs
interface MountOptions {
  title?: string
  accent?: string
}
//#endregion

//#region Constants
/**
 * How long a page-load REJOIN (M7.4) may go unconfirmed before the widget
 * gives up on it for this page. The live handoff's reconnect loop is
 * unbounded on purpose (handoff.ts — a waiting visitor must never be left
 * with a dead panel), but a rejoin that the server has not yet confirmed
 * has shown the visitor nothing, so giving up costs nothing visible: the
 * bookmark is KEPT for the next page, and asking a question meanwhile still
 * catches up through the pipeline's `handoff` event. What the bound buys is
 * the case where the mint itself keeps failing — a signed-out user in
 * strong mode, say — which would otherwise poll the customer's endpoint at
 * the loop's ceiling for as long as the tab is open.
 */
const REJOIN_TIMEOUT_MS = 60_000
//#endregion

//#region DOM helpers
/**
 * The three-line element factory this UI is built from. Everything textual
 * goes through textContent — NEVER innerHTML: claim text is MODEL OUTPUT
 * relayed from crawled documents, i.e. attacker-reachable, and the widget
 * runs inside a customer's page. One innerHTML here would be a stored XSS
 * on someone else's site.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Citation links only ever carry http(s). Document urls are already
 *  scheme-vetted at crawl time (safeFetch), but this widget trusts NOTHING
 *  it did not compute — defense in depth costs one startsWith. */
function safeHref(url: string): string | null {
  return url.startsWith("https://") || url.startsWith("http://") ? url : null
}
//#endregion

//#region Widget
const FALLBACKS = {
  error: "Something went wrong — please try again.",
  quota: "The assistant has reached today's answer limit. Please check back tomorrow.",
  rate: "One moment — a lot of questions are coming in. Please try again shortly.",
  offline: "Couldn't reach the assistant. Please try again.",
  unsent: "Not connected — your message wasn't sent. Trying to reconnect…",
}

/**
 * The handoff status line, worded for someone waiting on another person
 * rather than on a system. "connecting" deliberately covers both the first
 * attempt and every reconnect: which one it is is our problem, not the
 * visitor's.
 */
const HANDOFF_STATUS: Record<HandoffStatus, string> = {
  connecting: "Connecting you to the team…",
  waiting: "Waiting for someone to join…",
  connected: "You're chatting with the support team.",
  ended: "The support chat has ended. The assistant is back.",
}

/**
 * Mounts the whole widget into `host`'s shadow root and returns nothing:
 * from here on the widget owns its subtree and talks only to `client`.
 * Shadow mode "open" on purpose — closed mode adds no security (the host
 * page owns the JS realm regardless) and breaks the customer's own
 * debugging.
 */
function mountWidget(host: HTMLElement, client: WidgetClient, options: MountOptions = {}): void {
  const shadow = host.attachShadow({ mode: "open" })

  // adoptedStyleSheets first: constructed sheets are exempt from style-src
  // CSP (the hostile fixture pins this path). The <style> fallback covers
  // engines without the API — and MAY be blocked by a strict CSP, which is
  // documented as "modern browser required under strict CSP".
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(WIDGET_CSS)
    shadow.adoptedStyleSheets = [sheet]
  } catch {
    shadow.append(el("style", undefined, WIDGET_CSS))
  }

  //#region Skeleton
  const root = el("div", "root")
  if (options.accent !== undefined) root.style.setProperty("--ir-accent", options.accent)

  const panel = el("div", "panel")
  const head = el("div", "head")
  head.append(el("b", undefined, options.title ?? "Support"))
  const closeButton = el("button", undefined, "×")
  closeButton.setAttribute("aria-label", "Close chat")
  head.append(closeButton)

  const log = el("div", "log")
  log.setAttribute("role", "log")
  log.setAttribute("aria-live", "polite")

  const foot = el("form", "foot")
  const input = el("input")
  input.type = "text"
  input.placeholder = "Ask a question…"
  input.maxLength = 2000
  input.setAttribute("aria-label", "Your question")
  const sendButton = el("button", undefined, "Send")
  sendButton.type = "submit"
  foot.append(input, sendButton)

  panel.append(head, log, foot)

  const bubble = el("button", "bubble")
  bubble.setAttribute("aria-label", "Open support chat")
  // Inline SVG markup is static (no interpolation), so this innerHTML is a
  // constant — the textContent-only rule above is about DATA.
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8.4L4 21.6A1 1 0 0 1 2.4 20.8V5a2 2 0 0 1 1.6-2Z"/></svg>'

  root.append(panel, bubble)
  shadow.append(root)
  //#endregion

  //#region State
  let conversationId: string | undefined
  let busy = false
  let greeted = false
  /** Non-null means a person owns this conversation: the composer talks to
   *  the socket, and the bot is not consulted at all (§3.23 keeps it quiet
   *  server-side too — this is the same rule enforced twice, on purpose). */
  let handoff: HandoffConnection | null = null
  /**
   * A stored handoff being REJOINED at page load (M7.4), until the server
   * confirms it still exists. While set, `handoff` is the probing socket
   * and NOTHING about it is rendered — no status line, no composer switch,
   * and the composer still talks to the bot — because a bookmark can be
   * stale (the agent closed the conversation while the visitor was away),
   * and "the support chat has ended" must not appear on a page the visitor
   * never escalated from. `panelOpen` is what to restore on confirmation;
   * `timer` is the give-up bound (REJOIN_TIMEOUT_MS).
   */
  let rejoining: { panelOpen: boolean; timer: ReturnType<typeof setTimeout> } | null = null
  /** The handoff status line above the log, when one is on screen. ONE at
   *  a time: a new handoff replaces the previous one's, or "the support
   *  chat has ended" from an earlier escalation would sit above "Waiting
   *  for someone to join…". */
  let statusBar: HTMLElement | null = null
  /** The live "Talk to a person" offer, if one is on screen. One at a time:
   *  a second refusal must not stack a second button. */
  let offer: HTMLElement | null = null
  /** The "…is typing" line, when one is on screen. */
  let composing: HTMLElement | null = null

  function scrolledAppend(node: HTMLElement): void {
    log.append(node)
    log.scrollTop = log.scrollHeight
  }

  function notice(text: string): void {
    scrolledAppend(el("div", "msg notice", text))
  }

  function isOpen(): boolean {
    return root.classList.contains("open")
  }
  //#endregion

  //#region Open / close
  /**
   * The one place the panel opens or closes, whether by the visitor's click
   * or by a rejoin restoring what they had. Opening clears the unread badge
   * and greets once — but NOT after a rejoin, which sets `greeted` itself:
   * the transcript replayed over the log is the greeting there, and a "Hi!
   * Ask me anything" appended under an agent's last message would read as
   * the bot interrupting.
   */
  function setOpen(open: boolean): void {
    root.classList.toggle("open", open)
    if (!open) return
    markUnread(false)
    if (!greeted) {
      greeted = true
      scrolledAppend(el("div", "msg assistant", "Hi! Ask me anything about the docs."))
    }
  }

  /** The bubble's badge: an agent wrote while the panel was closed. */
  function markUnread(unread: boolean): void {
    bubble.classList.toggle("unread", unread)
    bubble.setAttribute("aria-label", unread ? "Open support chat — new message" : "Open support chat")
  }

  bubble.addEventListener("click", () => {
    const open = !isOpen()
    setOpen(open)
    touchBookmark()
    if (!open) return
    input.focus()
    // Fire-and-forget: minting at open is the DB-warming handshake, and a
    // transient failure here must not block typing — ask() re-mints anyway.
    client.ensureSession().catch(() => {})
  })
  closeButton.addEventListener("click", () => {
    setOpen(false)
    touchBookmark()
  })
  //#endregion

  //#region Handoff
  /**
   * Offered after a refusal, which is the moment the product has admitted
   * it cannot help — the events protocol says so in as many words
   * (§2.4.4c). Never offered while a person already owns the thread, and
   * never twice at once.
   */
  function offerEscalation(): void {
    // A rejoin still probing does not count as a person owning the thread:
    // if it confirms, the replayed backlog wipes the offer with the rest of
    // the log; if it was stale, the visitor still has their button.
    if ((handoff !== null && rejoining === null) || offer !== null || conversationId === undefined) return
    const wrap = el("div", "offer")
    const button = el("button", "escalate", "Talk to a person")
    button.type = "button"
    button.addEventListener("click", () => {
      button.disabled = true
      void escalate(button)
    })
    wrap.append(button)
    offer = wrap
    scrolledAppend(wrap)
  }

  async function escalate(button: HTMLButtonElement): Promise<void> {
    if (conversationId === undefined) return
    try {
      const outcome = await client.escalate(conversationId)
      offer?.remove()
      offer = null
      // `created` false means this visitor was already queued — the server
      // is idempotent by schema (§3.3.4), so the second click is free and
      // the UI simply does not announce the queue twice.
      enterHandoff(outcome.status === "active" ? "connected" : "waiting")
    } catch (err) {
      button.disabled = false
      notice(err instanceof RateLimitError ? FALLBACKS.rate : FALLBACKS.offline)
    }
  }

  /**
   * Switches the panel from the bot to the socket. Reached two ways: the
   * button above, and a `handoff` answer event — which is how a tab that
   * did NOT click catches up (another tab escalated, or the visitor asked
   * again after a rejoin was abandoned). Both land here, which is why it is
   * idempotent — including against a rejoin still in flight, whose socket
   * is `handoff` already and will confirm on its own.
   */
  function enterHandoff(initial: HandoffStatus): void {
    if (handoff !== null || conversationId === undefined) return
    showHandoffChrome(initial)
    handoff = client.openHandoff(conversationId, socketHandlers())
    touchBookmark()
  }

  /** The visible half of a handoff: the status line and the socket's
   *  composer. Split from enterHandoff because a REJOIN shows it only once
   *  the server has confirmed there is a handoff to show (below). */
  function showHandoffChrome(initial: HandoffStatus): void {
    statusBar?.remove()
    const bar = el("div", "status", HANDOFF_STATUS[initial])
    bar.setAttribute("role", "status")
    // Above the log, not in it: a status that scrolls away is a status a
    // waiting visitor cannot check. It deliberately SURVIVES leaveHandoff,
    // so "the chat ended" stays readable.
    panel.insertBefore(bar, log)
    statusBar = bar
    // The socket's cap, mirrored in the input: a refusal the visitor can
    // see coming beats one the server delivers after they hit send.
    input.maxLength = MAX_HANDOFF_MESSAGE_CHARS
    input.placeholder = "Message the team…"
  }

  /**
   * The socket's callbacks — one set for a handoff entered here and for
   * one rejoined at page load, because after confirmation they ARE the same
   * handoff. The rejoin differs only in its first status: nothing is drawn
   * until the server says the handoff exists (`waiting` or `connected`,
   * which the socket derives from `ready`), and `ended` before that means
   * the bookmark was stale — forgotten silently, with the widget left
   * exactly as a page without a bookmark, since the visitor never saw a
   * handoff on this page to be told the end of.
   */
  function socketHandlers(): HandoffHandlers {
    return {
      onStatus: (status) => {
        if (rejoining !== null) {
          if (status === "connecting") return
          const { panelOpen, timer } = rejoining
          clearTimeout(timer)
          rejoining = null
          if (status === "ended") {
            handoff = null
            conversationId = undefined
            client.forgetHandoff()
            return
          }
          // Confirmed: draw what a page that never left would be showing.
          greeted = true
          showHandoffChrome(status)
          if (panelOpen) setOpen(true)
        }
        if (statusBar !== null) statusBar.textContent = HANDOFF_STATUS[status]
        if (status === "ended") {
          leaveHandoff()
          return
        }
        // Every attach and reconnect re-stamps the bookmark: its expiry is
        // measured from the last touch, so a long conversation with the
        // panel left alone never expires under the visitor.
        touchBookmark()
      },
      onHistory: renderTranscript,
      onMessage: (message) => {
        renderHandoffMessage(message)
        // A person wrote while the panel was closed — the one thing worth a
        // badge. The visitor's own echo (another tab) and the replayed
        // backlog are not news.
        if (!isOpen() && message.role !== "visitor") markUnread(true)
      },
      onTyping: showComposing,
    }
  }

  /** The bookmark's one writer: the live handoff and how the panel stands.
   *  A no-op outside a confirmed handoff, so the bot's conversations are
   *  never bookmarked (api.ts says why). */
  function touchBookmark(): void {
    if (handoff === null || rejoining !== null || conversationId === undefined) return
    client.rememberHandoff(conversationId, isOpen())
  }

  /** The handoff closed: the bot owns the conversation again — which is
   *  literally true server-side (§3.23's getOpenHandoff stops finding one,
   *  so the pipeline answers), so the composer goes back to asking, and the
   *  bookmark goes with it — the next page starts fresh. */
  function leaveHandoff(): void {
    handoff?.close()
    handoff = null
    client.forgetHandoff()
    showComposing(false)
    input.maxLength = 2000
    input.placeholder = "Ask a question…"
  }

  /**
   * Page load, with a bookmark (M7.4): open the socket for the stored
   * conversation and let its own ticket mint be the probe — a reconnect
   * loop with backoff is exactly the right thing to point at "is this
   * handoff still there?", since a transient failure retries and the
   * server's `null` is terminal. Nothing is drawn until `ready` (see
   * socketHandlers), and the attempt is bounded by REJOIN_TIMEOUT_MS. The
   * conversation id is adopted at once so a question typed during the
   * probe lands in the same thread — where the pipeline answers with the
   * `handoff` event if a person owns it, which enterHandoff turns into the
   * same confirmation.
   */
  function rejoinStoredHandoff(): void {
    const stored = client.storedHandoff()
    if (stored === null) return
    conversationId = stored.conversationId
    rejoining = {
      panelOpen: stored.panelOpen,
      timer: setTimeout(abandonRejoin, REJOIN_TIMEOUT_MS),
    }
    handoff = client.openHandoff(stored.conversationId, socketHandlers())
  }

  /**
   * The server never confirmed inside the window: stop probing on THIS
   * page and keep the bookmark for the next one. The conversation id is
   * kept too — deliberately the opposite of the stale case above, where the
   * server REFUSED it — so a question asked once the outage clears still
   * lands in the thread a person may own, and the `handoff` event catches
   * the visitor up on a fresh socket. (The price, stated: if the id was
   * never this visitor's — a shared computer where the previous user's
   * bookmark met an outage at load — their questions on this page get the
   * opaque error until a reload, whose probe then settles it. Two rare
   * things at once, against the common outage where a kept id is what
   * makes the recovery automatic.)
   */
  function abandonRejoin(): void {
    if (rejoining === null) return
    rejoining = null
    handoff?.close()
    handoff = null
  }

  /**
   * The backlog, rendered OVER the thread rather than appended to it: on
   * attach the server's transcript is the source of truth, and taking it
   * whole is what makes a reload — or a reconnect that missed messages —
   * land on exactly the conversation the server has, with no local dedupe.
   *
   * The cost, stated plainly: earlier bot answers come back as the text the
   * visitor SAW, without the citation links this widget drew the first time
   * (messages.content is the visitor-facing text; the per-claim verdicts
   * live in the dashboard, §9.10). Losing a link on scrollback is a smaller
   * price than a thread that disagrees with the agent's.
   */
  function renderTranscript(messages: HandoffHistoryMessage[]): void {
    log.textContent = ""
    offer = null
    composing = null
    for (const message of messages) renderHandoffMessage(message)
  }

  function renderHandoffMessage(message: HandoffHistoryMessage): void {
    // Roles are the class names: visitor, agent, assistant — the last
    // because the bot's turns are in the transcript too, and relabelling
    // them would misattribute them.
    const node = el("div", `msg ${message.role}`)
    node.append(el("p", undefined, message.text))
    scrolledAppend(node)
  }

  function showComposing(active: boolean): void {
    if (!active) {
      composing?.remove()
      composing = null
      return
    }
    if (composing !== null) return
    composing = el("div", "typing", "Support is typing…")
    scrolledAppend(composing)
  }
  //#endregion

  //#region Ask flow
  foot.addEventListener("submit", (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text.length === 0) return
    if (handoff !== null && rejoining === null) {
      // Nothing is rendered here: the server broadcasts every message back
      // to its sender (§2.4.7), so the echo is the render — one order from
      // one source of truth, and no local copy to reconcile with the
      // replay. A refused send keeps the text in the box. (During an
      // unconfirmed rejoin the question goes to the BOT under the stored
      // conversation id instead — where a person owning the thread answers
      // as the `handoff` event, and the question is persisted for them.)
      if (!handoff.send(text)) {
        notice(FALLBACKS.unsent)
        return
      }
      input.value = ""
      return
    }
    if (busy) return
    input.value = ""
    void ask(text)
  })

  // Composing hints, throttled inside the socket to the protocol's refresh
  // interval — the UI just reports keystrokes and never has to know that.
  input.addEventListener("input", () => handoff?.hintTyping())

  async function ask(question: string): Promise<void> {
    busy = true
    sendButton.disabled = true
    scrolledAppend(el("div", "msg visitor", question))
    const typing = el("div", "typing", "Thinking…")
    scrolledAppend(typing)

    // One assistant bubble per answer; claims append into it as they
    // arrive, each with its citation — the strip already happened server-
    // side, so everything that reaches this loop may be shown.
    let answer: HTMLDivElement | null = null
    const answerBubble = (): HTMLDivElement => {
      if (answer === null) {
        answer = el("div", "msg assistant")
        typing.remove()
        scrolledAppend(answer)
      }
      return answer
    }

    try {
      for await (const event of client.ask(question, conversationId)) {
        handle(event)
      }
    } catch (err) {
      typing.remove()
      if (err instanceof QuotaError) notice(FALLBACKS.quota)
      else if (err instanceof RateLimitError) notice(FALLBACKS.rate)
      else notice(FALLBACKS.offline)
    } finally {
      typing.remove()
      busy = false
      sendButton.disabled = false
      input.focus()
    }

    function handle(event: AnswerEvent): void {
      switch (event.type) {
        case "meta":
          conversationId = event.conversationId
          break
        case "claim": {
          const bubbleEl = answerBubble()
          bubbleEl.append(el("p", undefined, event.text))
          const href = event.url !== null ? safeHref(event.url) : null
          if (href !== null) {
            const cite = el("span", "cite")
            const link = el("a", undefined, event.headingPath ?? new URL(href).hostname)
            link.href = href
            link.target = "_blank"
            link.rel = "noopener noreferrer"
            cite.append(link)
            bubbleEl.append(cite)
          }
          break
        }
        case "refusal":
          answerBubble().append(el("p", undefined, event.text))
          // A refusal is the product saying it cannot help — the one moment
          // where offering a person is an answer rather than an upsell.
          offerEscalation()
          break
        case "handoff":
          // The bot stayed silent because a person owns this thread — which
          // can be news to THIS tab (another tab escalated, or the page was
          // reloaded). The visitor's question was still persisted for the
          // agent to read (§3.23), so nothing is lost; the widget just
          // catches up with where the conversation already is.
          typing.remove()
          enterHandoff(event.status === "active" ? "connected" : "waiting")
          break
        case "error":
          typing.remove()
          notice(FALLBACKS.error)
          break
        case "done":
          break
      }
    }
  }
  //#endregion

  // Last, once everything above is wired: a page that left mid-handoff
  // picks it back up. Fire-and-forget by construction — nothing here waits
  // on the network, and a page with no bookmark does not touch it.
  rejoinStoredHandoff()
}
//#endregion

//#region Exports
export { mountWidget }
export type { MountOptions }
//#endregion
