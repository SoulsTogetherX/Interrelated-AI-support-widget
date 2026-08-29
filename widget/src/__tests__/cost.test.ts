//#region Why this file
// What the widget COSTS a host page (M7.9) — the second of the three
// widget metrics the plan names as CI-enforced, beside the gzipped size
// budget (scripts/widget-size.mjs) that has been enforced since M2.6.
//
// The byte half is static and lives in that script. The REQUEST half is
// behavioral and lives here, because "how many requests does this snippet
// add to my page?" is a question about what the code does at runtime, and
// a customer's performance audit measures exactly that. So this suite
// drives the REAL ApiClient and the REAL mountWidget against a counting
// fetch — no fake client, unlike ui.test.ts, because a fake client is
// precisely the thing that would hide a request.
//
// The claim being pinned, which is also the product promise: **a page that
// nobody chats on pays for one request, the bundle, and nothing else.** The
// session mint is deferred to bubble-open (which is also the Neon-warming
// handshake, §3.18), so a widget sitting unopened on a docs page all day
// costs its host zero further bytes and its tenant zero quota.
//
// The one deliberate exception is asserted rather than hidden: a page
// loaded mid-handoff spends a mint and a ticket at once, because a person
// is waiting on the other end and the rejoin IS the probe (§8.1c).
//#endregion

//#region Imports
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiClient } from "../api"
import { mountWidget } from "../ui"
//#endregion

//#region Harness
interface Recorded {
  url: string
  method: string
}

let requests: Recorded[]
let sockets: string[]
let host: HTMLElement

/** Answers the two routes this suite reaches, and records every call. A
 *  request the widget makes that this does not expect shows up as a
 *  recorded URL the assertions do not allow, which is the point. */
const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input as string // the real ApiClient only ever fetches string URLs
  requests.push({ url, method: init?.method ?? "GET" })
  if (url.endsWith("/v1/widget/session")) {
    return new Response(JSON.stringify({ token: "tok_cost", visitorId: "vis_" + "a".repeat(32) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (url.endsWith("/v1/widget/chat")) {
    const events = [
      { type: "meta", conversationId: "con_cost", messageId: "msg_cost" },
      { type: "refusal", text: "I don't know that one." },
      { type: "done", claimsTotal: 0, claimsShown: 0 },
    ]
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  if (url.endsWith("/v1/widget/handoff-ticket")) {
    return new Response(JSON.stringify({ ticket: "tkt_cost" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  throw new Error(`unexpected request: ${url}`)
}) as typeof fetch

/** Records that a socket was opened without opening one. A WebSocket is
 *  not a fetch, so it would not show in `requests` — and an unopened page
 *  that quietly holds a socket open would be a cost this suite exists to
 *  catch. */
const countingSocketFactory = (url: string): WebSocket => {
  sockets.push(url)
  return {
    readyState: 0,
    send: () => {},
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as WebSocket
}

function makeClient(): ApiClient {
  return new ApiClient({
    apiBase: "https://api.test",
    publishableKey: "pk_cost",
    fetchImpl: countingFetch,
    socketFactory: countingSocketFactory,
  })
}

function shadow(): ShadowRoot {
  return host.shadowRoot as ShadowRoot
}

function query<T extends Element>(selector: string): T {
  const node = shadow().querySelector<T>(selector)
  if (node === null) throw new Error(`missing ${selector} in shadow root`)
  return node
}

beforeEach(() => {
  requests = []
  sockets = []
  localStorage.clear()
  document.body.innerHTML = ""
  host = document.createElement("div")
  document.body.append(host)
})
//#endregion

describe("what the widget costs a host page", () => {
  it("adds ZERO requests at mount — a page nobody chats on pays only for the bundle", async () => {
    mountWidget(host, makeClient())
    // The bubble is rendered and interactive…
    expect(query(".bubble")).toBeTruthy()
    // …and nothing has gone over the wire. Flush the microtask queue first,
    // so a mount that fired a request without awaiting it still fails.
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toEqual([])
    expect(sockets).toEqual([])
  })

  it("spends exactly ONE request when the visitor opens the bubble — the session mint", async () => {
    mountWidget(host, makeClient())
    query<HTMLButtonElement>(".bubble").click()
    await vi.waitFor(() => {
      if (requests.length === 0) throw new Error("no mint yet")
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.test/v1/widget/session")
    expect(requests[0]!.method).toBe("POST")
    // Opening again must not re-mint: the session is cached for its life,
    // so a visitor who fidgets with the panel costs nothing more.
    query<HTMLButtonElement>(".bubble").click()
    query<HTMLButtonElement>(".bubble").click()
    await Promise.resolve()
    expect(requests).toHaveLength(1)
  })

  it("spends exactly ONE more request per question asked", async () => {
    mountWidget(host, makeClient())
    query<HTMLButtonElement>(".bubble").click()
    await vi.waitFor(() => {
      if (requests.length === 0) throw new Error("no mint yet")
    })

    const input = query<HTMLInputElement>(".foot input")
    input.value = "how do refunds work"
    query<HTMLFormElement>("form.foot").dispatchEvent(new Event("submit", { cancelable: true }))
    await vi.waitFor(() => {
      if (query<HTMLButtonElement>(".foot button").disabled) throw new Error("still streaming")
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe("https://api.test/v1/widget/chat")
    expect(requests[1]!.method).toBe("POST")
  })

  it("spends a mint and a ticket at mount ONLY when a handoff is live — the deliberate exception", async () => {
    // A page loaded while a person owns the conversation rejoins at once
    // (§8.1c): the visitor is waiting on someone, so the cost is the
    // feature. Everything above is what a page WITHOUT a bookmark pays.
    const client = makeClient()
    client.rememberHandoff("con_live", true)
    requests = []

    mountWidget(host, client)
    await vi.waitFor(() => {
      if (sockets.length === 0) throw new Error("no rejoin yet")
    })
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.test/v1/widget/session",
      "https://api.test/v1/widget/handoff-ticket",
    ])
    expect(sockets).toHaveLength(1)
  })
})
