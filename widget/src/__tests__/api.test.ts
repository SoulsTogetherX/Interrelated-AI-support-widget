//#region Imports
import { beforeEach, describe, expect, it } from "vitest"

import { ApiClient, HANDOFF_BOOKMARK_TTL_MS, QuotaError, RateLimitError } from "../api"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Fake fetch
// A scripted fetch: each entry answers one call, and every request is
// recorded for assertions. The widget must work against the M2.5 route
// contract, so the fakes speak exactly that dialect.
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
  credentials: RequestCredentials | undefined
  cache: RequestCache | undefined
}

function sseResponse(events: object[]): Response {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

let calls: Call[]
let script: Response[]

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({
    url: input as string,
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>,
    credentials: init?.credentials,
    cache: init?.cache,
  })
  const next = script.shift()
  if (next === undefined) throw new Error("fake fetch script exhausted")
  return next
}) as typeof fetch

/** Never called by these tests — the socket has its own suite (handoff.test.ts)
 *  where a scripted fake stands in for a real connection. */
const noSocket = (): WebSocket => {
  throw new Error("no socket expected in the HTTP suite")
}

function makeClient(): ApiClient {
  return new ApiClient({
    apiBase: "https://api.test/",
    publishableKey: "pk_test",
    fetchImpl: fakeFetch,
    socketFactory: noSocket,
  })
}

const MINT_OK = () => jsonResponse(200, { token: "tok.sig", expiresAt: 9999999999999, visitorId: "vis_abc" })

async function collect(iterable: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
  const events: AnswerEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

beforeEach(() => {
  calls = []
  script = []
  localStorage.clear()
})
//#endregion

describe("ApiClient", () => {
  it("single-flights concurrent mints — open racing an ask must not fork the visitor", async () => {
    // The bug the live browser check caught: bubble-open's fire-and-forget
    // mint racing ask()'s awaited mint produced TWO sessions with TWO
    // different server-generated visitors, and the late response clobbered
    // the token that owned the conversation.
    script = [MINT_OK(), MINT_OK()] // a second mint WOULD succeed — the assertion is that it's never sent
    const client = makeClient()
    await Promise.all([client.ensureSession(), client.ensureSession(), client.ensureSession()])
    expect(calls).toHaveLength(1)
  })

  it("mints once at open, sends the pk, and persists the visitor id", async () => {
    script = [MINT_OK()]
    const client = makeClient()
    await client.ensureSession()
    await client.ensureSession() // second open: token cached, no second mint

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.test/v1/widget/session")
    expect(calls[0]!.body).toEqual({ publishableKey: "pk_test" })
    expect(localStorage.getItem("interrelated.visitor")).toBe("vis_abc")
  })

  it("reuses the stored visitor id on the next mint — conversations survive reloads", async () => {
    localStorage.setItem("interrelated.visitor", "vis_returning")
    script = [MINT_OK()]
    await makeClient().ensureSession()
    expect(calls[0]!.body["visitorId"]).toBe("vis_returning")
  })

  it("asks with the bearer token and streams the events back", async () => {
    const meta = { type: "meta", conversationId: "con_1", messageId: "msg_1" }
    const done = { type: "done", claimsTotal: 0, claimsShown: 0 }
    script = [MINT_OK(), sseResponse([meta, done])]
    const events = await collect(makeClient().ask("how do refunds work", "con_1"))

    expect(events).toEqual([meta, done])
    expect(calls[1]!.url).toBe("https://api.test/v1/widget/chat")
    expect(calls[1]!.headers["authorization"]).toBe("Bearer tok.sig")
    expect(calls[1]!.body).toEqual({ question: "how do refunds work", conversationId: "con_1" })
  })

  it("re-mints ONCE on a 401 and retries the question invisibly", async () => {
    const done = { type: "done", claimsTotal: 0, claimsShown: 0 }
    script = [
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
      MINT_OK(),
      sseResponse([done]),
    ]
    const events = await collect(makeClient().ask("q"))
    expect(events).toEqual([done])
    // mint, chat(401), mint, chat — and no more.
    expect(calls.map((c) => c.url.split("/").at(-1))).toEqual(["session", "chat", "session", "chat"])
  })

  it("maps the two 429 bodies to their distinct errors", async () => {
    script = [MINT_OK(), jsonResponse(429, { error: "daily quota reached" })]
    await expect(collect(makeClient().ask("q"))).rejects.toBeInstanceOf(QuotaError)

    script = [MINT_OK(), jsonResponse(429, { error: "too many requests" })]
    await expect(collect(makeClient().ask("q"))).rejects.toBeInstanceOf(RateLimitError)
  })

  it("escalates over the same authenticated path, reporting who created the handoff", async () => {
    script = [MINT_OK(), jsonResponse(200, { status: "pending", created: true })]
    const outcome = await makeClient().escalate("con_1")
    expect(outcome).toEqual({ status: "pending", created: true })
    expect(calls[1]!.url).toBe("https://api.test/v1/widget/escalate")
    expect(calls[1]!.headers["authorization"]).toBe("Bearer tok.sig")
    expect(calls[1]!.body).toEqual({ conversationId: "con_1" })
  })

  it("mints a socket ticket, and re-mints the SESSION once when it has expired", async () => {
    // The whole reason #authed is shared: a 30-minute session expiring
    // while a visitor waits for an agent must be as invisible on the ticket
    // route as it is on chat — otherwise the socket simply never reconnects.
    script = [
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
      MINT_OK(),
      jsonResponse(200, { ticket: "tkt.sig", expiresAt: 9999999999999 }),
    ]
    expect(await makeClient().handoffTicket("con_1")).toBe("tkt.sig")
    expect(calls.map((c) => c.url.split("/").at(-1)))
      .toEqual(["session", "handoff-ticket", "session", "handoff-ticket"])
  })

  it("reports a closed handoff as null, not as an error — only one of them stops retrying", async () => {
    script = [MINT_OK(), jsonResponse(404, { error: "conversation not found" })]
    expect(await makeClient().handoffTicket("con_gone")).toBeNull()

    // A server failure still throws: the reconnect loop must keep trying.
    script = [MINT_OK(), jsonResponse(500, { error: "internal error" })]
    await expect(makeClient().handoffTicket("con_1")).rejects.toThrow(/handoff ticket failed \(500\)/)
  })

  it("surfaces a second 401 as a real failure instead of looping", async () => {
    script = [
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
    ]
    await expect(collect(makeClient().ask("q"))).rejects.toThrow(/chat failed \(401\)/)
  })

  //#region The handoff bookmark (M7.4)
  it("bookmarks a live handoff in storage and hands it to the next page load — with no request spent", () => {
    // A page load with no bookmark: nothing to rejoin, and nothing fetched
    // to find that out.
    expect(makeClient().storedHandoff()).toBeNull()
    expect(calls).toHaveLength(0)

    makeClient().rememberHandoff("con_live", false)
    const raw = localStorage.getItem("interrelated.handoff")
    expect(raw).not.toBeNull()
    // The bookmark is the conversation, the panel, and a timestamp — not the
    // token (re-minted next page as always) and not the visitor id (stored
    // beside it in this mode, refused from storage in strong mode).
    expect(Object.keys(JSON.parse(raw as string) as object).sort()).toEqual(["at", "conversationId", "panelOpen"])

    // A fresh client — the next page — finds it, still without a request.
    expect(makeClient().storedHandoff()).toEqual({ conversationId: "con_live", panelOpen: false })
    expect(calls).toHaveLength(0)

    makeClient().forgetHandoff()
    expect(makeClient().storedHandoff()).toBeNull()
    expect(localStorage.getItem("interrelated.handoff")).toBeNull()
  })

  it("drops a bookmark past its TTL instead of probing it, and shrugs off one that is not ours", () => {
    const stale = { conversationId: "con_old", panelOpen: true, at: Date.now() - HANDOFF_BOOKMARK_TTL_MS - 1 }
    localStorage.setItem("interrelated.handoff", JSON.stringify(stale))
    expect(makeClient().storedHandoff()).toBeNull()
    expect(localStorage.getItem("interrelated.handoff")).toBeNull() // gone, not merely ignored
    expect(calls).toHaveLength(0)

    // Just inside the window it is still worth a probe.
    const fresh = { conversationId: "con_new", panelOpen: true, at: Date.now() - HANDOFF_BOOKMARK_TTL_MS + 1000 }
    localStorage.setItem("interrelated.handoff", JSON.stringify(fresh))
    expect(makeClient().storedHandoff()).toEqual({ conversationId: "con_new", panelOpen: true })

    // Storage on the customer's origin is writable by anything on the page:
    // shapes that are not a bookmark are no bookmark, never a throw.
    for (const junk of ["not json", "42", "null", JSON.stringify({ conversationId: 7, at: 1 }), JSON.stringify({ at: 1 })]) {
      localStorage.setItem("interrelated.handoff", junk)
      expect(makeClient().storedHandoff()).toBeNull()
    }
  })

  it("treats a 400 for the ticket as nothing-to-rejoin, not as an outage to retry", async () => {
    // Only a tampered bookmark can produce this (an id from `meta` is
    // well-formed by construction), and a reconnect loop arguing with a 400
    // forever is exactly what a bounded rejoin exists to avoid.
    script = [MINT_OK(), jsonResponse(400, { error: "invalid conversationId" })]
    expect(await makeClient().handoffTicket("con_garbage")).toBeNull()
  })
  //#endregion
})

describe("ApiClient in strong mode (data-session-url, M7.3)", () => {
  // The customer's server minted the session with the SECRET key; the widget
  // only fetches it from an endpoint on their site. The publishable key is
  // nowhere in the page — and so nowhere in these requests.
  const SERVER_MINT = () => jsonResponse(200, { token: "srv.sig", expiresAt: 9999999999999, visitorId: "user_42" })

  function makeStrongClient(): ApiClient {
    return new ApiClient({
      apiBase: "https://api.test/",
      sessionUrl: "/api/support-session",
      fetchImpl: fakeFetch,
      socketFactory: noSocket,
    })
  }

  it("fetches the session from the customer's URL — GET, with cookies, uncached, and no publishable key anywhere", async () => {
    script = [SERVER_MINT()]
    await makeStrongClient().ensureSession()
    expect(calls).toHaveLength(1)
    const [mint] = calls
    expect(mint!.url).toBe("/api/support-session")
    // GET keeps the endpoint outside every framework's CSRF check; the
    // cookies are what let the customer's server say WHO this is; no-store
    // because a cached token is one that expires mid-chat.
    expect(mint!.method).toBe("GET")
    expect(mint!.credentials).toBe("include")
    expect(mint!.cache).toBe("no-store")
    expect(JSON.stringify(mint)).not.toContain("pk_")
    expect(JSON.stringify(mint)).not.toContain("publishableKey")
  })

  it("uses the server-minted token on chat, and does NOT persist the identified visitor id", async () => {
    // The customer's server names the user on every mint. Storing the id
    // would only ever send it back on some later publishable-key mint on
    // another of the customer's pages — where realtime refuses anything but
    // the anonymous shape (that refusal is what keeps a browser from
    // claiming a server-asserted identity), and the widget would break.
    localStorage.setItem("interrelated.visitor", "vis_returning")
    const done = { type: "done", claimsTotal: 0, claimsShown: 0 }
    script = [SERVER_MINT(), sseResponse([done])]
    const events = await collect(makeStrongClient().ask("q"))
    expect(events).toEqual([done])
    expect(calls[1]!.url).toBe("https://api.test/v1/widget/chat")
    expect(calls[1]!.headers["authorization"]).toBe("Bearer srv.sig")
    expect(localStorage.getItem("interrelated.visitor")).toBe("vis_returning") // untouched
  })

  it("re-mints through the customer's URL on a 401 — expiry stays invisible in strong mode too", async () => {
    const done = { type: "done", claimsTotal: 0, claimsShown: 0 }
    script = [SERVER_MINT(), jsonResponse(401, { error: "invalid session" }), SERVER_MINT(), sseResponse([done])]
    const events = await collect(makeStrongClient().ask("q"))
    expect(events).toEqual([done])
    expect(calls.map((c) => c.url)).toEqual([
      "/api/support-session", "https://api.test/v1/widget/chat",
      "/api/support-session", "https://api.test/v1/widget/chat",
    ])
  })

  it("surfaces the customer's refusal (a signed-out user) as a mint failure, not a hang or a loop", async () => {
    script = [jsonResponse(401, { error: "sign in first" })]
    await expect(makeStrongClient().ensureSession()).rejects.toThrow(/session mint failed \(401\)/)
    expect(calls).toHaveLength(1)
  })

  it("prefers the session URL when both are configured, and refuses to construct with neither", () => {
    // Given both, strong mode wins: the point of it is that the publishable
    // key need not be on the page, so a leftover one must not be used.
    script = [SERVER_MINT()]
    const both = new ApiClient({
      apiBase: "https://api.test/", publishableKey: "pk_leftover", sessionUrl: "/api/support-session",
      fetchImpl: fakeFetch, socketFactory: noSocket,
    })
    void both.ensureSession()
    expect(calls[0]!.url).toBe("/api/support-session")
    expect(() => new ApiClient({ apiBase: "https://api.test/", fetchImpl: fakeFetch, socketFactory: noSocket }))
      .toThrow(/publishableKey or a sessionUrl/)
  })
})
