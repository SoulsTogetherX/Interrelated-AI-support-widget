//#region Imports
import type { AnswerEvent } from "@shared/grounding/events"
import { QuotaError, RateLimitError } from "./api"
import type { WidgetClient } from "./api"
import { WIDGET_CSS } from "./styles"
//#endregion

//#region Type Defs
interface MountOptions {
  title?: string
  accent?: string
}
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

  function scrolledAppend(node: HTMLElement): void {
    log.append(node)
    log.scrollTop = log.scrollHeight
  }

  function notice(text: string): void {
    scrolledAppend(el("div", "msg notice", text))
  }
  //#endregion

  //#region Open / close
  bubble.addEventListener("click", () => {
    root.classList.toggle("open")
    if (!root.classList.contains("open")) return
    input.focus()
    if (!greeted) {
      greeted = true
      scrolledAppend(el("div", "msg assistant", "Hi! Ask me anything about the docs."))
    }
    // Fire-and-forget: minting at open is the DB-warming handshake, and a
    // transient failure here must not block typing — ask() re-mints anyway.
    client.ensureSession().catch(() => {})
  })
  closeButton.addEventListener("click", () => root.classList.remove("open"))
  //#endregion

  //#region Ask flow
  foot.addEventListener("submit", (event) => {
    event.preventDefault()
    const question = input.value.trim()
    if (question.length === 0 || busy) return
    input.value = ""
    void ask(question)
  })

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
}
//#endregion

//#region Exports
export { mountWidget }
export type { MountOptions }
//#endregion
