//#region Imports
import { beforeEach, describe, expect, it, vi } from "vitest"

import { mountWidget } from "../ui"
import { QuotaError, RateLimitError } from "../api"
import type { WidgetClient } from "../api"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Fake client
/** A WidgetClient whose ask() replays scripted event lists (or throws a
 *  scripted error), recording every call — rendering is tested against
 *  the wire protocol, with the network layer out of the picture. */
function fakeClient(script: Array<AnswerEvent[] | Error>) {
  const askCalls: Array<{ question: string; conversationId?: string }> = []
  let sessionCalls = 0
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
  }
  return { client, askCalls, sessionCalls: () => sessionCalls }
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

const META: AnswerEvent = { type: "meta", conversationId: "con_ui", messageId: "msg_ui" }
const DONE: AnswerEvent = { type: "done", claimsTotal: 1, claimsShown: 1 }
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
    const refusal: AnswerEvent = { type: "refusal", text: "I don't know that one." }
    const { client } = fakeClient([[META, refusal, { type: "done", claimsTotal: 0, claimsShown: 0 }]])
    mountWidget(host, client)
    query<HTMLButtonElement>(".bubble").click()
    await askThrough("mystery")
    expect(query(".msg.assistant:last-of-type").textContent).toContain("I don't know that one.")
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
})
