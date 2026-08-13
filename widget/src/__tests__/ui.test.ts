//#region Imports
import { beforeEach, describe, expect, it, vi } from "vitest"

import { mountWidget } from "../ui"
import { QuotaError, RateLimitError } from "../api"
import type { WidgetClient } from "../api"
import type { HandoffHandlers } from "../handoff"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Fake client
/** A WidgetClient whose ask() replays scripted event lists (or throws a
 *  scripted error), recording every call — rendering is tested against
 *  the wire protocol, with the network layer out of the picture. Since
 *  M4.4 it also stands in for the handoff socket: openHandoff hands back a
 *  fake connection and keeps the handlers, so a test can play the server. */
function fakeClient(script: Array<AnswerEvent[] | Error>) {
  const askCalls: Array<{ question: string; conversationId?: string }> = []
  const escalateCalls: string[] = []
  const sent: string[] = []
  let sessionCalls = 0
  let hints = 0
  let handlers: HandoffHandlers | null = null
  let closed = false
  let escalateResult: { status: string; created: boolean } | Error = { status: "pending", created: true }
  /** What send() answers — false is "not attached", the case where the UI
   *  must keep the visitor's text. */
  let sendable = true

  const client: WidgetClient = {
    ensureSession: () => {
      sessionCalls += 1
      return Promise.resolve()
    },
    async *ask(question, conversationId) {
      askCalls.push({ question, ...(conversationId !== undefined ? { conversationId } : {}) })
      const next = script.shift()
      if (next === undefined) throw new Error("fake client script exhausted")
      if (next instanceof Error) throw next
      yield* next
    },
    escalate: (conversationId) => {
      escalateCalls.push(conversationId)
      return escalateResult instanceof Error
        ? Promise.reject(escalateResult)
        : Promise.resolve(escalateResult)
    },
    handoffTicket: () => Promise.resolve("tkt_ui"),
    openHandoff: (_conversationId, given) => {
      handlers = given
      return {
        send: (text: string) => {
          if (!sendable) return false
          sent.push(text)
          return true
        },
        hintTyping: () => { hints += 1 },
        close: () => { closed = true },
      }
    },
  }

  return {
    client, askCalls, escalateCalls, sent,
    sessionCalls: () => sessionCalls,
    hints: () => hints,
    closed: () => closed,
    /** The server end of the fake socket. */
    server: () => {
      if (handlers === null) throw new Error("handoff was never opened")
      return handlers
    },
    setEscalateResult: (result: { status: string; created: boolean } | Error) => { escalateResult = result },
    setSendable: (value: boolean) => { sendable = value },
  }
}

let host: HTMLElement
beforeEach(() => {
  document.body.textContent = ""
  host = document.createElement("div")
  document.body.append(host)
})

function shadow(): ShadowRoot {
  return host.shadowRoot as ShadowRoot
}

function query<T extends Element>(selector: string): T {
  const node = shadow().querySelector<T>(selector)
  if (node === null) throw new Error(`missing ${selector} in shadow root`)
  return node
}

async function askThrough(question: string): Promise<void> {
  const input = query<HTMLInputElement>(".foot input")
  input.value = question
  query<HTMLFormElement>("form.foot").dispatchEvent(new Event("submit", { cancelable: true }))
  // The ask flow is a chain of microtasks; two settled timer turns flush it.
  await vi.waitFor(() => {
    if (query<HTMLButtonElement>(".foot button").disabled) throw new Error("still streaming")
  })
}

/** A bare submit — the handoff composer does not stream, so there is no
 *  disabled button to wait on. */
function submit(text: string): void {
  const input = query<HTMLInputElement>(".foot input")
  input.value = text
  query<HTMLFormElement>("form.foot").dispatchEvent(new Event("submit", { cancelable: true }))
}

const META: AnswerEvent = { type: "meta", conversationId: "con_ui", messageId: "msg_ui" }
const DONE: AnswerEvent = { type: "done", claimsTotal: 1, claimsShown: 1 }
const REFUSAL: AnswerEvent = { type: "refusal", text: "I don't know that one." }
const NO_CLAIMS: AnswerEvent = { type: "done", claimsTotal: 0, claimsShown: 0 }

/** Drives the widget to the state where a person owns the conversation:
 *  ask → refusal → "Talk to a person" → the socket is open. */
async function escalateThrough(fake: ReturnType<typeof fakeClient>): Promise<void> {
  query<HTMLButtonElement>(".bubble").click()
  await askThrough("something obscure")
  query<HTMLButtonElement>(".escalate").click()
  await vi.waitFor(() => {
    if (shadow().querySelector(".status") === null) throw new Error("not in handoff yet")
  })
  fake.server() // throws unless the socket was actually opened
}
//#endregion

describe("mountWidget", () => {
  it("renders in a shadow root: bubble visible, panel closed, host page untouched", () => {
    const { client } = fakeClient([])
    mountWidget(host, client)
    expect(query(".bubble")).toBeTruthy()
    expect(shadow().querySelector(".root.open")).toBeNull()
    // Nothing leaks into the light DOM beyond the host element itself.
    expect(host.childNodes).toHaveLength(0)
  })

  it("opens on bubble click, greets once, and mints the session at open", () => {
    const { client, sessionCalls } = fakeClient([])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    expect(shadow().querySelector(".root.open")).not.toBeNull()
    expect(sessionCalls()).toBe(1)

    // Close and reopen: no second greeting, but each open re-warms.
    query<HTMLButtonElement>(".head button").click()
    query<HTMLButtonElement>(".bubble").click()
    expect(shadow().querySelectorAll(".msg.assistant")).toHaveLength(1)
    expect(sessionCalls()).toBe(2)
  })

  it("renders the visitor question, then claims with citation links", async () => {
    const claim: AnswerEvent = {
      type: "claim", ord: 0,
      text: "Refunds take five business days.",
      url: "https://docs.example.com/refunds",
      headingPath: "Billing > Refunds",
    }
    const { client } = fakeClient([[META, claim, DONE]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("how long do refunds take?")

    const visitor = query(".msg.visitor")
    expect(visitor.textContent).toBe("how long do refunds take?")
    const link = query<HTMLAnchorElement>(".cite a")
    expect(link.href).toBe("https://docs.example.com/refunds")
    expect(link.textContent).toBe("Billing > Refunds")
    expect(link.rel).toContain("noopener")
    expect(shadow().textContent).toContain("Refunds take five business days.")
  })

  it("threads the conversation id from meta into the NEXT question", async () => {
    const { client, askCalls } = fakeClient([[META, DONE], [META, DONE]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("first")
    await askThrough("second")
    expect(askCalls[0]).toEqual({ question: "first" })
    expect(askCalls[1]).toEqual({ question: "second", conversationId: "con_ui" })
  })

  it("never uses claim text as markup — the XSS probe renders inert", async () => {
    const hostile: AnswerEvent = {
      type: "claim", ord: 0,
      text: '<img src=x onerror="window.__pwned=1"> <b>bold?</b>',
      url: null, headingPath: null,
    }
    const { client } = fakeClient([[META, hostile, DONE]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("hostile")

    expect(shadow().querySelector(".msg.assistant img")).toBeNull()
    expect(shadow().querySelector(".msg.assistant b")).toBeNull()
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined()
    expect(shadow().textContent).toContain("<img src=x")
  })

  it("drops citation links with non-http(s) schemes but keeps the claim text", async () => {
    const sneaky: AnswerEvent = {
      // eslint-disable-next-line no-script-url
      type: "claim", ord: 0, text: "Click here.", url: "javascript:alert(1)", headingPath: "Docs",
    }
    const { client } = fakeClient([[META, sneaky, DONE]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("sneaky")
    expect(shadow().querySelector(".cite")).toBeNull()
    expect(shadow().textContent).toContain("Click here.")
  })

  it("renders refusal text as an ordinary assistant message", async () => {
    const { client } = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("mystery")
    // The last assistant BUBBLE, found by class rather than by position:
    // since M4.4 a refusal is followed by the escalation offer, and a
    // positional selector would be asserting the offer's absence by
    // accident.
    const bubbles = shadow().querySelectorAll(".msg.assistant")
    expect(bubbles[bubbles.length - 1]!.textContent).toContain("I don't know that one.")
  })

  it("renders the three failure shapes distinctly: error event, quota, rate limit", async () => {
    const { client } = fakeClient([
      [META, { type: "error" }],
      new QuotaError("daily quota reached"),
      new RateLimitError("too many requests"),
    ])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()

    await askThrough("boom")
    expect(shadow().textContent).toContain("Something went wrong")
    await askThrough("more")
    expect(shadow().textContent).toContain("answer limit")
    await askThrough("again")
    expect(shadow().textContent).toContain("One moment")
    // Input recovered after every failure — the widget never bricks.
    expect(query<HTMLButtonElement>(".foot button").disabled).toBe(false)
  })

  //#region Handoff (M4.4)
  it("offers a person only after a refusal, and only one offer at a time", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS], [META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    query<HTMLButtonElement>(".bubble").click()

    await askThrough("first")
    expect(query(".escalate").textContent).toBe("Talk to a person")
    // A second refusal must not stack a second button.
    await askThrough("second")
    expect(shadow().querySelectorAll(".escalate")).toHaveLength(1)
  })

  it("escalates on click and switches the panel to the socket", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    expect(fake.escalateCalls).toEqual(["con_ui"])
    expect(query(".status").textContent).toContain("Waiting for someone")
    // The offer is consumed, not left sitting there as a second queue place.
    expect(shadow().querySelector(".escalate")).toBeNull()
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Message the team…")
  })

  it("renders the socket's turns — the bot's included — and the composing hint", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    // The backlog replaces the thread: on attach the server's transcript is
    // the source of truth, and the bot's own turns are part of it.
    fake.server().onHistory([
      { id: "msg_1", role: "visitor", text: "something obscure", at: "2026-01-01T00:00:00.000Z" },
      { id: "msg_2", role: "assistant", text: "I don't know that one.", at: "2026-01-01T00:00:01.000Z" },
    ])
    expect(shadow().querySelectorAll(".msg")).toHaveLength(2)
    expect(query(".msg.assistant").textContent).toContain("I don't know that one.")

    fake.server().onMessage({ id: "msg_3", role: "agent", text: "Hi, I can help.", at: "2026-01-01T00:00:02.000Z" })
    expect(query(".msg.agent").textContent).toContain("Hi, I can help.")

    fake.server().onTyping(true)
    expect(shadow().textContent).toContain("Support is typing…")
    fake.server().onTyping(false)
    expect(shadow().textContent).not.toContain("Support is typing…")
  })

  it("sends over the socket instead of the bot, and keeps text that could not be sent", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    submit("my order is #4021")
    expect(fake.sent).toEqual(["my order is #4021"])
    expect(query<HTMLInputElement>(".foot input").value).toBe("")
    // The bot is not consulted while a person owns the thread — one ask,
    // the one that got refused.
    expect(fake.askCalls).toHaveLength(1)
    // Nothing is rendered locally: the server echoes every message back to
    // its sender, and THAT is the render.
    expect(shadow().querySelectorAll(".msg.visitor")).toHaveLength(1)

    // A send that could not go keeps the visitor's words in the box.
    fake.setSendable(false)
    submit("are you still there?")
    expect(query<HTMLInputElement>(".foot input").value).toBe("are you still there?")
    expect(shadow().textContent).toContain("wasn't sent")

    // And typing is reported to the socket, not to the bot.
    query<HTMLInputElement>(".foot input").dispatchEvent(new Event("input"))
    expect(fake.hints()).toBeGreaterThan(0)
  })

  it("catches up when the BOT reports a handoff this tab did not start", async () => {
    // Another tab escalated, or the page was reloaded mid-handoff: the
    // pipeline answers with {type:"handoff"} instead of claims (§3.23).
    const fake = fakeClient([[META, { type: "handoff", status: "active" }]])
    mountWidget(host, fake.client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("hello?")

    expect(query(".status").textContent).toContain("chatting with the support team")
    expect(fake.escalateCalls).toEqual([]) // nothing was requested — it already was
    submit("still me")
    expect(fake.sent).toEqual(["still me"])
  })

  it("hands the conversation back to the assistant when the handoff ends", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS], [META, DONE]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    fake.server().onStatus("ended")
    expect(fake.closed()).toBe(true)
    expect(query(".status").textContent).toContain("assistant is back")
    // The composer goes back to asking — which is literally what the server
    // does too, since the pipeline stops finding an open handoff.
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Ask a question…")
    await askThrough("are you back?")
    expect(fake.askCalls.at(-1)).toEqual({ question: "are you back?", conversationId: "con_ui" })
  })

  it("never renders socket text as markup either — the same XSS rule as claims", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    fake.server().onMessage({
      id: "msg_x", role: "agent",
      text: '<img src=x onerror="window.__pwned_socket=1">',
      at: "2026-01-01T00:00:03.000Z",
    })
    expect(shadow().querySelector(".msg.agent img")).toBeNull()
    expect((window as unknown as Record<string, unknown>)["__pwned_socket"]).toBeUndefined()
    expect(shadow().textContent).toContain("<img src=x")
  })
  //#endregion
})
