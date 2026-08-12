//#region Imports
import { beforeEach, describe, expect, it } from "vitest"

import { ApiClient, QuotaError, RateLimitError } from "../api"
import type { AnswerEvent } from "@shared/grounding/events"
//#endregion

//#region Fake fetch
// A scripted fetch: each entry answers one call, and every request is
// recorded for assertions. The widget must work against the M2.5 route
// contract, so the fakes speak exactly that dialect.
interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
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
    url: String(input),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
  })
  const next = script.shift()
  if (next === undefined) throw new Error("fake fetch script exhausted")
  return next
}) as typeof fetch

function makeClient(): ApiClient {
  return new ApiClient({ apiBase: "https://api.test/", publishableKey: "pk_test", fetchImpl: fakeFetch })
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

  it("surfaces a second 401 as a real failure instead of looping", async () => {
    script = [
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
      MINT_OK(),
      jsonResponse(401, { error: "invalid session" }),
    ]
    await expect(collect(makeClient().ask("q"))).rejects.toThrow(/chat failed \(401\)/)
  })
})
