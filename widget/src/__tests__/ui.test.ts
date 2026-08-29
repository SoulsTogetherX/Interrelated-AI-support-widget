//#region Imports
import { beforeEach, describe, expect, it, vi } from "vitest"

import { mountWidget } from "../ui"
import { QuotaError, RateLimitError } from "../api"
import type { StoredHandoff, WidgetClient } from "../api"
import type { HandoffHandlers } from "../handoff"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Fake client
/** A WidgetClient whose ask() replays scripted event lists (or throws a
 *  scripted error), recording every call — rendering is tested against
 *  the wire protocol, with the network layer out of the picture. Since
 *  M4.4 it also stands in for the handoff socket: openHandoff hands back a
 *  fake connection and keeps the handlers, so a test can play the server.
 *  Since M7.4 it also stands in for the bookmark: `stored` is what a page
 *  load finds, and every remember/forget is recorded. */
function fakeClient(script: Array<AnswerEvent[] | Error>, stored: StoredHandoff | null = null) {
  const askCalls: Array<{ question: string; conversationId?: string }> = []
  const escalateCalls: string[] = []
  const sent: string[] = []
  const opened: string[] = []
  const bookmarks: Array<{ conversationId: string; panelOpen: boolean } | null> = []
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
    openHandoff: (conversationId, given) => {
      opened.push(conversationId)
      handlers = given
      closed = false
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
    rememberHandoff: (conversationId, panelOpen) => { bookmarks.push({ conversationId, panelOpen }) },
    forgetHandoff: () => { bookmarks.push(null) },
    storedHandoff: () => stored,
  }

  return {
    client, askCalls, escalateCalls, sent, opened,
    /** Every bookmark write in order — an object for remember, null for
     *  forget — so a test can assert what the NEXT page load will find. */
    bookmarks,
    lastBookmark: () => bookmarks.at(-1),
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

  it("returns the conversation to the assistant when the agent closes it", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS], [META, DONE]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)

    // What the socket does on a `closed` frame (handoff.test.ts pins that
    // half); here it is what the PANEL does with it.
    fake.server().onStatus("ended")
    expect(fake.closed()).toBe(true)
    expect(query(".status").textContent).toContain("assistant is back")
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Ask a question…")

    // And the bot answers again — which is literally true server-side once
    // the handoff is closed.
    await askThrough("is anyone there?")
    expect(fake.askCalls.at(-1)).toEqual({ question: "is anyone there?", conversationId: "con_ui" })
    expect(fake.sent).toEqual([])
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

  //#region Rejoin across a page load (M7.4)
  const STORED: StoredHandoff = { conversationId: "con_stored", panelOpen: true }
  const AGENT_HELLO = { id: "msg_a1", role: "agent" as const, text: "Hello, still here?", at: "2026-01-01T00:00:05.000Z" }

  it("bookmarks a handoff on entering, follows the panel, and forgets it on ending — never the bot's thread", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("something obscure")
    // A bot conversation is not bookmarked: rejoining one would continue a
    // thread the widget cannot show, and nobody is waiting on it.
    expect(fake.bookmarks).toEqual([])

    query<HTMLButtonElement>(".escalate").click()
    await vi.waitFor(() => {
      if (shadow().querySelector(".status") === null) throw new Error("not in handoff yet")
    })
    expect(fake.lastBookmark()).toEqual({ conversationId: "con_ui", panelOpen: true })

    // The bookmark records how the visitor left the panel, so the next
    // page restores it rather than guessing.
    query<HTMLButtonElement>(".head button").click()
    expect(fake.lastBookmark()).toEqual({ conversationId: "con_ui", panelOpen: false })
    query<HTMLButtonElement>(".bubble").click()
    expect(fake.lastBookmark()).toEqual({ conversationId: "con_ui", panelOpen: true })

    // Ended: forgotten, so the next page starts fresh instead of probing.
    fake.server().onStatus("ended")
    expect(fake.lastBookmark()).toBeNull()
  })

  it("rejoins a stored handoff at mount — nothing drawn until the server confirms, then the panel comes back as it was", () => {
    const fake = fakeClient([], STORED)
    mountWidget(host, fake.client)

    // The socket is opened for the stored conversation at once (its ticket
    // mint IS the probe), and no bubble-open mint is spent by the UI.
    expect(fake.opened).toEqual(["con_stored"])
    expect(fake.sessionCalls()).toBe(0)
    // ...but a visitor looking at the page sees no handoff yet: no status
    // line, panel closed, composer still the bot's, log untouched.
    fake.server().onStatus("connecting")
    expect(shadow().querySelector(".status")).toBeNull()
    expect(shadow().querySelector(".root.open")).toBeNull()
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Ask a question…")
    expect(shadow().querySelectorAll(".msg")).toHaveLength(0)

    // Confirmed by `ready`: the panel returns open, as the visitor left it,
    // with the socket's composer and NO greeting — the transcript that
    // follows is the greeting.
    fake.server().onStatus("waiting")
    expect(query(".status").textContent).toContain("Waiting for someone")
    expect(shadow().querySelector(".root.open")).not.toBeNull()
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Message the team…")
    expect(shadow().querySelectorAll(".msg.assistant")).toHaveLength(0)
    expect(fake.lastBookmark()).toEqual({ conversationId: "con_stored", panelOpen: true })

    fake.server().onHistory([
      { id: "msg_1", role: "visitor", text: "my invoice is wrong", at: "2026-01-01T00:00:00.000Z" },
      { id: "msg_2", role: "assistant", text: "I don't know that one.", at: "2026-01-01T00:00:01.000Z" },
      AGENT_HELLO,
    ])
    expect(shadow().querySelectorAll(".msg")).toHaveLength(3)
    expect(query(".msg.agent").textContent).toContain("Hello, still here?")

    // And it is a live handoff from here: sends go to the socket.
    submit("yes — sorry, I clicked a link")
    expect(fake.sent).toEqual(["yes — sorry, I clicked a link"])
    expect(fake.askCalls).toEqual([])
  })

  it("keeps a rejoined panel closed when the visitor had closed it, and badges the bubble when the team writes", () => {
    const fake = fakeClient([], { conversationId: "con_stored", panelOpen: false })
    mountWidget(host, fake.client)
    fake.server().onStatus("connected")

    // Confirmed, but the visitor had closed the panel: it stays closed —
    // the socket is live behind it, so the agent sees the visitor present.
    expect(query(".status").textContent).toContain("chatting with the support team")
    expect(shadow().querySelector(".root.open")).toBeNull()
    expect(query(".bubble").classList.contains("unread")).toBe(false)

    // The replayed backlog is not news, and neither is the visitor's own
    // echo from another tab.
    fake.server().onHistory([AGENT_HELLO])
    fake.server().onMessage({ id: "msg_v", role: "visitor", text: "one sec", at: "2026-01-01T00:00:06.000Z" })
    expect(query(".bubble").classList.contains("unread")).toBe(false)

    // A person writing while the panel is closed is.
    fake.server().onMessage({ id: "msg_a2", role: "agent", text: "Take your time.", at: "2026-01-01T00:00:07.000Z" })
    expect(query(".bubble").classList.contains("unread")).toBe(true)
    expect(query(".bubble").getAttribute("aria-label")).toContain("new message")

    // Opening clears the badge and does NOT greet over the transcript.
    query<HTMLButtonElement>(".bubble").click()
    expect(query(".bubble").classList.contains("unread")).toBe(false)
    expect(query(".bubble").getAttribute("aria-label")).toBe("Open support chat")
    expect(shadow().textContent).not.toContain("Ask me anything")
    expect(shadow().querySelectorAll(".msg.agent")).toHaveLength(2)
    expect(shadow().querySelectorAll(".msg.visitor")).toHaveLength(1)
    expect(fake.lastBookmark()).toEqual({ conversationId: "con_stored", panelOpen: true })
  })

  it("forgets a stale bookmark silently — the page is left as one that had no bookmark", async () => {
    // The agent closed the conversation while the visitor was away: the
    // socket's first ticket mint answers null, which it reports as `ended`.
    const fake = fakeClient([[META, DONE]], { conversationId: "con_stale", panelOpen: true })
    mountWidget(host, fake.client)
    fake.server().onStatus("connecting")
    fake.server().onStatus("ended")

    // Nothing was drawn — no "the support chat has ended" on a page the
    // visitor never escalated from — and the bookmark is gone.
    expect(shadow().querySelector(".status")).toBeNull()
    expect(shadow().querySelector(".root.open")).toBeNull()
    expect(fake.lastBookmark()).toBeNull()

    // From here the widget is exactly a fresh one: it greets on open, and
    // the next question starts a NEW conversation rather than appending to
    // one the server said was not this visitor's to rejoin.
    query<HTMLButtonElement>(".bubble").click()
    expect(shadow().textContent).toContain("Ask me anything")
    await askThrough("fresh start")
    expect(fake.askCalls).toEqual([{ question: "fresh start" }])
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Ask a question…")
  })

  it("gives up on an unconfirmed rejoin after the timeout and KEEPS the bookmark for the next page", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient([[
        { type: "meta", conversationId: "con_stored", messageId: "msg_q" },
        { type: "handoff", status: "pending" },
      ]], STORED)
      mountWidget(host, fake.client)
      fake.server().onStatus("connecting")
      // The server never answers (an outage at load, or a mint that keeps
      // failing): just short of the bound the probe still runs...
      vi.advanceTimersByTime(59_999)
      expect(fake.closed()).toBe(false)
      // ...at the bound it stops, quietly — no forget, so the next page
      // load tries again.
      vi.advanceTimersByTime(1)
      expect(fake.closed()).toBe(true)
      expect(fake.bookmarks).toEqual([])
      expect(shadow().querySelector(".status")).toBeNull()

      // And the visitor is not stranded: the stored id was KEPT, so asking
      // again lands in the thread a person owns and catches up through the
      // pipeline's `handoff` event, on a fresh socket.
      vi.useRealTimers()
      query<HTMLButtonElement>(".bubble").click()
      await askThrough("anyone?")
      expect(fake.askCalls).toEqual([{ question: "anyone?", conversationId: "con_stored" }])
      expect(fake.opened).toEqual(["con_stored", "con_stored"])
      expect(query(".status").textContent).toContain("Waiting for someone")
    } finally {
      vi.useRealTimers()
    }
  })

  it("routes a question typed during an unconfirmed rejoin to the bot, and the confirmation still lands", async () => {
    // The stored id is adopted at once, so the question joins the same
    // thread — where a person owning it answers as `handoff` (§3.23), which
    // enterHandoff leaves to the socket already probing.
    const fake = fakeClient([[
      { type: "meta", conversationId: "con_stored", messageId: "msg_q" },
      { type: "handoff", status: "active" },
    ]], STORED)
    mountWidget(host, fake.client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("hello?")
    expect(fake.askCalls).toEqual([{ question: "hello?", conversationId: "con_stored" }])
    expect(fake.sent).toEqual([])
    // Not two sockets: the rejoin's is the handoff's.
    expect(fake.opened).toEqual(["con_stored"])
    expect(shadow().querySelector(".status")).toBeNull()

    fake.server().onStatus("connected")
    expect(query(".status").textContent).toContain("chatting with the support team")
    expect(query<HTMLInputElement>(".foot input").placeholder).toBe("Message the team…")
  })

  it("does not stack status lines: a handoff after the last one ended replaces the line", async () => {
    const fake = fakeClient([[META, REFUSAL, NO_CLAIMS], [META, REFUSAL, NO_CLAIMS]])
    mountWidget(host, fake.client)
    await escalateThrough(fake)
    fake.server().onStatus("ended")
    expect(query(".status").textContent).toContain("assistant is back")

    await askThrough("one more thing")
    query<HTMLButtonElement>(".escalate").click()
    await vi.waitFor(() => {
      if (!query(".status").textContent?.includes("Waiting")) throw new Error("not in handoff yet")
    })
    expect(shadow().querySelectorAll(".status")).toHaveLength(1)
  })
  //#endregion
})
