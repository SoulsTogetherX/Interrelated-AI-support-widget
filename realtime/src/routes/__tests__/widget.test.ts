//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { createApp } from "@/app"
import { RateLimiter } from "@/widget/rateLimit"
import { mintSessionToken } from "@/widget/sessionToken"
import { groundedMockResponder } from "@/answer/mockResponder"
import { utcDay } from "@/usage/daily"
import { PLANS } from "@shared/billing/plans"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { MockLLMProvider } from "@providers/llm/mock"
import type { AnswerEvent } from "@shared/grounding/events"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"
//#endregion

//#region Test Setup
// The widget surface end to end over a REAL http listener: origin
// allowlist, session tokens, rate limits, the daily ceiling, and the SSE
// chat stream — the trust model's layers 1–3 as observable behavior, with
// the context-quoting mock LLM proving the whole loop runs keylessly.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

const SECRET = "widget-route-test-secret-0123456789abcdef"
const GOOD_ORIGIN = "https://customer.example"
const EVIL_ORIGIN = "https://thief.example"
const PK = "pk_live_widget_route_test"
const CHUNK_TEXT = "Refunds are processed within five business days of the request."

const embedder = new MockEmbeddingProvider()

let server: Server
let baseUrl: string
let orgId: string

/** High-capacity limiters so ordinary tests never trip them; the flood
 *  tests construct their own app with tiny ones. */
function buildApp(overrides: Record<string, unknown> = {}) {
  return createApp({
    widget: {
      db, embedder,
      llm: new MockLLMProvider(groundedMockResponder()),
      tokenSecret: SECRET,
      mintLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
      chatIpLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
      chatVisitorLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
      ...overrides,
    },
  })
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const httpServer = createServer(app)
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return { server: httpServer, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function mintSession(extra: Record<string, unknown> = {}, origin = GOOD_ORIGIN) {
  const response = await fetch(`${baseUrl}/v1/widget/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ publishableKey: PK, ...extra }),
  })
  return response
}

async function chat(
  token: string,
  body: Record<string, unknown>,
  origin = GOOD_ORIGIN,
): Promise<{ status: number; events: AnswerEvent[]; json: unknown }> {
  const response = await fetch(`${baseUrl}/v1/widget/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await response.text()
    const events = text.split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as AnswerEvent)
    return { status: response.status, events, json: null }
  }
  return { status: response.status, events: [], json: await response.json().catch(() => null) }
}

/** A session token for the allowlisted origin — every token-authenticated
 *  route's starting point. */
async function freshToken(): Promise<string> {
  const response = await mintSession()
  return ((await response.json()) as { token: string }).token
}
//#endregion

describe.skipIf(!DB_CONFIGURED)("widget routes", () => {
  beforeAll(async () => {
    await migrateToLatest(db)

    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Widget Route Co" }).execute()
    await db.insertInto("api_keys").values({
      id: newId("key"), org_id: orgId, kind: "public", public_id: PK, secret_hash: null,
    }).execute()
    await db.insertInto("allowed_origins").values({ org_id: orgId, origin: GOOD_ORIGIN }).execute()

    const sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "url", location: "https://customer.example",
    }).execute()
    const documentId = newId("doc")
    await db.insertInto("documents").values({
      id: documentId, org_id: orgId, source_id: sourceId,
      url: "https://customer.example/refunds", title: "Refunds", content_hash: "e".repeat(64),
    }).execute()
    const chunkId = newId("chk")
    const [vector] = await embedder.embed([CHUNK_TEXT])
    await db.insertInto("chunks").values({
      id: chunkId, org_id: orgId, document_id: documentId, ord: 0,
      heading_path: "Refunds", text: CHUNK_TEXT,
      token_count: Math.ceil(CHUNK_TEXT.length / 4), char_start: null, char_end: null,
    }).execute()
    await db.insertInto("chunk_embeddings").values({
      chunk_id: chunkId, org_id: orgId, model: embedder.model, dim: embedder.dim,
      embedding: toPgvector(padVector(vector!)),
    }).execute()

    const started = await listen(buildApp())
    server = started.server
    baseUrl = started.baseUrl
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.destroy()
  })

  describe("session mint", () => {
    it("mints a token for an allowlisted origin and echoes CORS", async () => {
      const response = await mintSession()
      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(GOOD_ORIGIN)
      const body = await response.json() as { token: string; expiresAt: number; visitorId: string }
      expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      expect(body.expiresAt).toBeGreaterThan(Date.now())
      expect(body.visitorId).toMatch(/^vis_[0-9a-f]{32}$/)
    })

    it("honors a caller-supplied visitorId and rejects malformed ones", async () => {
      const good = await mintSession({ visitorId: "my-stable-visitor" })
      expect(((await good.json()) as { visitorId: string }).visitorId).toBe("my-stable-visitor")
      const bad = await mintSession({ visitorId: "spaces are invalid" })
      expect(bad.status).toBe(400)
    })

    it("rejects an unlisted origin WITHOUT CORS headers — the browser can't even read it", async () => {
      const response = await mintSession({}, EVIL_ORIGIN)
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    })

    it("rejects a missing Origin header", async () => {
      const response = await fetch(`${baseUrl}/v1/widget/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishableKey: PK }),
      })
      expect(response.status).toBe(403)
    })

    it("collapses unknown and revoked keys into one uniform 401", async () => {
      const unknown = await mintSession({ publishableKey: "pk_live_never_existed" })
      expect(unknown.status).toBe(401)

      const revokedPk = "pk_live_revoked_key"
      await db.insertInto("api_keys").values({
        id: newId("key"), org_id: orgId, kind: "public", public_id: revokedPk,
        secret_hash: null,
      }).execute()
      // Revoked on the DATABASE's clock, which is the clock the route
      // compares against. `new Date()` here would be this process's clock,
      // and a Docker Desktop container that has drifted behind the host
      // would still see the key as live for the width of the drift.
      await db.updateTable("api_keys").set({ revoked_at: sql`NOW()` })
        .where("public_id", "=", revokedPk).execute()
      const revoked = await mintSession({ publishableKey: revokedPk })
      expect(revoked.status).toBe(401)
      expect(await revoked.json()).toEqual(await unknown.json())
    })

    it("keeps a rotated-out key live through its grace window, then refuses it like an unknown one", async () => {
      // Rotation (web/src/lib/keys) does not revoke the old key on the
      // click: it schedules revoked_at at the END of a grace window so a
      // snippet the customer has not updated yet keeps working. The route
      // treats a future revoked_at as live and a past one as gone — both
      // decided by Postgres's NOW(), the clock the dashboard wrote with.
      const retiringPk = "pk_live_retiring_key"
      const retiringRowId = newId("key")
      await db.insertInto("api_keys").values({
        id: retiringRowId, org_id: orgId, kind: "public", public_id: retiringPk, secret_hash: null,
      }).execute()
      await db.updateTable("api_keys").set({ revoked_at: sql`NOW() + interval '1 hour'` })
        .where("id", "=", retiringRowId).execute()

      // Inside the window: mints, and the token is a real session — it chats.
      const minted = await mintSession({ publishableKey: retiringPk })
      expect(minted.status).toBe(200)
      const { token } = (await minted.json()) as { token: string }
      const answer = await chat(token, { question: CHUNK_TEXT })
      expect(answer.status).toBe(200)
      expect(answer.events.some((e) => e.type === "claim")).toBe(true)
      // The mint still stamps last_used_at: that is how the dashboard can
      // tell a customer their OLD snippet is still out there.
      const row = await db.selectFrom("api_keys").select("last_used_at")
        .where("id", "=", retiringRowId).executeTakeFirstOrThrow()
      expect(row.last_used_at).not.toBeNull()

      // The window closes: byte-identical to a key that never existed.
      await db.updateTable("api_keys").set({ revoked_at: sql`NOW() - interval '1 second'` })
        .where("id", "=", retiringRowId).execute()
      const afterGrace = await mintSession({ publishableKey: retiringPk })
      const unknown = await mintSession({ publishableKey: "pk_live_never_existed" })
      expect(afterGrace.status).toBe(401)
      expect(await afterGrace.json()).toEqual(await unknown.json())
      // …and the token minted DURING the window is untouched: it is a
      // 30-minute session bound to the org, not to the key that opened it.
      // Ending a grace window stops NEW sessions; it does not cut off a
      // visitor mid-conversation. Rotation is hygiene, not an eviction.
      const stillChats = await chat(token, { question: CHUNK_TEXT })
      expect(stillChats.status).toBe(200)
    })

    it("answers preflight with the CORS grant", async () => {
      const response = await fetch(`${baseUrl}/v1/widget/session`, {
        method: "OPTIONS",
        headers: { origin: GOOD_ORIGIN, "access-control-request-method": "POST" },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(GOOD_ORIGIN)
      expect(response.headers.get("access-control-allow-headers")).toContain("authorization")
    })

    it("rate limits session minting per IP", async () => {
      const { server: floodServer, baseUrl: floodUrl } = await listen(buildApp({
        mintLimiter: new RateLimiter({ capacity: 2, refillPerSecond: 0.001 }),
      }))
      try {
        const statuses: number[] = []
        for (let i = 0; i < 3; i++) {
          const response = await fetch(`${floodUrl}/v1/widget/session`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
            body: JSON.stringify({ publishableKey: PK }),
          })
          statuses.push(response.status)
        }
        expect(statuses).toEqual([200, 200, 429])
      } finally {
        await new Promise((resolve) => floodServer.close(resolve))
      }
    })
  })

  describe("chat", () => {
    it("streams a grounded answer end to end — meta, claim with citation, done", async () => {
      const token = await freshToken()
      const { status, events } = await chat(token, { question: CHUNK_TEXT })
      expect(status).toBe(200)
      expect(events.map((e) => e.type)).toEqual(["meta", "claim", "done"])
      const claim = events[1] as Extract<AnswerEvent, { type: "claim" }>
      expect(claim.url).toBe("https://customer.example/refunds")
      expect(claim.text).toContain("Refunds are processed")
      // And the answer persisted under the token's visitor.
      const meta = events[0] as Extract<AnswerEvent, { type: "meta" }>
      const row = await db.selectFrom("messages")
        .select(["role", "model"]).where("id", "=", meta.messageId).executeTakeFirstOrThrow()
      expect(row).toEqual({ role: "assistant", model: "mock-llm" })
    })

    it("rejects a missing, tampered, expired, or wrong-secret token uniformly", async () => {
      const good = await freshToken()
      const expired = mintSessionToken(
        { org: orgId, origin: GOOD_ORIGIN, visitor: "vis_x" }, SECRET,
        Date.now() - 31 * 60 * 1000,
      ).token
      const foreign = mintSessionToken(
        { org: orgId, origin: GOOD_ORIGIN, visitor: "vis_x" }, "some-other-secret-0123456789abcdef",
      ).token
      for (const bad of ["", good.slice(0, -2) + "xx", expired, foreign]) {
        const { status } = await chat(bad, { question: "hi" })
        expect(status).toBe(401)
      }
    })

    it("rejects a valid token replayed from a different origin", async () => {
      const token = await freshToken()
      const { status } = await chat(token, { question: "hi" }, EVIL_ORIGIN)
      expect(status).toBe(403)
    })

    it("validates the question length at both edges", async () => {
      const token = await freshToken()
      expect((await chat(token, { question: "   " })).status).toBe(400)
      expect((await chat(token, { question: "x".repeat(2001) })).status).toBe(400)
      expect((await chat(token, {})).status).toBe(400)
    })

    it("continues its own conversation but cannot continue another visitor's", async () => {
      const token = await freshToken()
      const first = await chat(token, { question: CHUNK_TEXT })
      const conversationId = (first.events[0] as Extract<AnswerEvent, { type: "meta" }>).conversationId

      const continued = await chat(token, { question: CHUNK_TEXT, conversationId })
      expect(continued.status).toBe(200)
      expect(continued.events.map((e) => e.type)).toEqual(["meta", "claim", "done"])
      expect((continued.events[0] as Extract<AnswerEvent, { type: "meta" }>).conversationId).toBe(conversationId)

      // A DIFFERENT visitor of the same org probes the conversation id: the
      // stream opens (SSE starts before the pipeline runs) but yields only
      // an opaque error — no meta, no claims, nothing to learn from.
      const intruder = await freshToken()
      const hijack = await chat(intruder, { question: "what did they ask?", conversationId })
      expect(hijack.status).toBe(200)
      expect(hijack.events.map((e) => e.type)).toEqual(["error"])
    })

    it("rejects a malformed conversationId before any work", async () => {
      const token = await freshToken()
      const { status } = await chat(token, { question: "hi", conversationId: "not-a-con-id" })
      expect(status).toBe(400)
    })

    it("enforces the per-org daily answer cap BEFORE the model call", async () => {
      // Since M5.3 the check reads usage_daily, and that counter is written
      // by the answer path itself — earlier tests in this file answered
      // questions, so it is already non-zero. Asserting that first is what
      // makes the 429 below evidence about the counter rather than about
      // some other coincidence.
      const counter = await db.selectFrom("usage_daily")
        .select("answers").where("org_id", "=", orgId).executeTakeFirst()
      expect(Number(counter?.answers ?? 0)).toBeGreaterThan(0)

      const { server: cappedServer, baseUrl: cappedUrl } = await listen(buildApp({ dailyAnswerCap: 1 }))
      const previousBase = baseUrl
      baseUrl = cappedUrl
      try {
        const token = await freshToken()
        const { status, json } = await chat(token, { question: CHUNK_TEXT })
        expect(status).toBe(429)
        expect(json).toEqual({ error: "daily quota reached" })
      } finally {
        baseUrl = previousBase
        await new Promise((resolve) => cappedServer.close(resolve))
      }
    })

    it("takes the ceiling from the org's PLAN when no override is configured", async () => {
      // No dailyAnswerCap anywhere in this test: the only number in play is
      // the one the plan catalog states. Fill today's counter to the free
      // tier's ceiling and the widget must stop; upgrade the org and the
      // same traffic is under the new ceiling — a plan change taking effect
      // on the very next question, with no cache to serve it stale.
      const token = await freshToken()
      await db.insertInto("usage_daily")
        .values({ org_id: orgId, day: utcDay(), answers: PLANS.free.dailyAnswers })
        .onConflict((oc) => oc.columns(["org_id", "day"])
          .doUpdateSet({ answers: PLANS.free.dailyAnswers }))
        .execute()
      try {
        const capped = await chat(token, { question: CHUNK_TEXT })
        expect(capped.status).toBe(429)
        expect(capped.json).toEqual({ error: "daily quota reached" })

        await db.updateTable("organizations").set({ plan: "starter" })
          .where("id", "=", orgId).execute()
        const upgraded = await chat(token, { question: CHUNK_TEXT })
        expect(upgraded.status).toBe(200)
        expect(upgraded.events.at(-1)?.type).toBe("done")
      } finally {
        await db.updateTable("organizations").set({ plan: "free" })
          .where("id", "=", orgId).execute()
        // Drop the day's counter so the rest of the suite is not capped by
        // the number this test invented. The next answer recreates it.
        await db.deleteFrom("usage_daily").where("org_id", "=", orgId).execute()
      }
    })

    it("rate limits chat per visitor with CORS headers intact — the widget can render it", async () => {
      const { server: limitedServer, baseUrl: limitedUrl } = await listen(buildApp({
        chatVisitorLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0.001 }),
      }))
      const previousBase = baseUrl
      baseUrl = limitedUrl
      try {
        const token = await freshToken()
        expect((await chat(token, { question: CHUNK_TEXT })).status).toBe(200)
        const limited = await fetch(`${limitedUrl}/v1/widget/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: GOOD_ORIGIN, authorization: `Bearer ${token}` },
          body: JSON.stringify({ question: "again" }),
        })
        expect(limited.status).toBe(429)
        expect(limited.headers.get("access-control-allow-origin")).toBe(GOOD_ORIGIN)
      } finally {
        baseUrl = previousBase
        await new Promise((resolve) => limitedServer.close(resolve))
      }
    })
  })

  describe("escalate", () => {
    const escalate = (token: string, body: Record<string, unknown>, origin = GOOD_ORIGIN) =>
      fetch(`${baseUrl}/v1/widget/escalate`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })

    it("queues the visitor for a human, idempotently, and stops the bot answering", async () => {
      const token = await freshToken()
      const opened = await chat(token, { question: CHUNK_TEXT })
      const meta = opened.events.find((e) => e.type === "meta")
      const conversationId = meta?.type === "meta" ? meta.conversationId : ""
      expect(conversationId).not.toBe("")

      const first = await escalate(token, { conversationId })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ status: "pending", created: true })
      // CORS on the real response, not just preflight — the widget has to
      // read this to render the waiting state.
      expect(first.headers.get("access-control-allow-origin")).toBe(GOOD_ORIGIN)

      // A visitor mashing the button gets the same queue place, not a second.
      const second = await escalate(token, { conversationId })
      expect(await second.json()).toEqual({ status: "pending", created: false })
      expect(await db.selectFrom("handoff_sessions").selectAll()
        .where("conversation_id", "=", conversationId).execute()).toHaveLength(1)

      // And the next question is kept for the agent rather than answered.
      const after = await chat(token, { question: CHUNK_TEXT, conversationId })
      expect(after.events.map((e) => e.type)).toEqual(["meta", "handoff", "done"])
      expect(await db.selectFrom("conversations").select("status")
        .where("id", "=", conversationId).executeTakeFirstOrThrow()).toEqual({ status: "escalated" })
    })

    it("cannot escalate another visitor's conversation, or a fabricated one", async () => {
      const mine = await freshToken()
      const opened = await chat(mine, { question: CHUNK_TEXT })
      const meta = opened.events.find((e) => e.type === "meta")
      const conversationId = meta?.type === "meta" ? meta.conversationId : ""

      const intruder = await freshToken()
      const hijack = await escalate(intruder, { conversationId })
      const fabricated = await escalate(mine, { conversationId: newId("con") })

      // One answer for both: which it was is not information this surface
      // shares, and nothing was queued either way.
      expect(hijack.status).toBe(404)
      expect(fabricated.status).toBe(404)
      expect(await db.selectFrom("handoff_sessions").selectAll()
        .where("conversation_id", "=", conversationId).execute()).toHaveLength(0)
    })

    it("issues a socket ticket only for an escalated conversation the visitor owns", async () => {
      const token = await freshToken()
      const opened = await chat(token, { question: CHUNK_TEXT })
      const meta = opened.events.find((e) => e.type === "meta")
      const conversationId = meta?.type === "meta" ? meta.conversationId : ""

      const ticketUrl = `${baseUrl}/v1/widget/handoff-ticket`
      const ask = (body: unknown, auth = token) => fetch(ticketUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: GOOD_ORIGIN, authorization: `Bearer ${auth}` },
        body: JSON.stringify(body),
      })

      // No handoff yet — there is nothing to connect to, so no ticket.
      expect((await ask({ conversationId })).status).toBe(404)

      await fetch(`${baseUrl}/v1/widget/escalate`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: GOOD_ORIGIN, authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId }),
      })

      const granted = await ask({ conversationId })
      expect(granted.status).toBe(200)
      const body = (await granted.json()) as { ticket: string; expiresAt: number }
      expect(body.ticket).toContain(".")
      // 60 seconds, not the session token's 30 minutes: it rides in a URL.
      expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(60_000)
      // The long-lived credential is NOT what gets handed over.
      expect(body.ticket).not.toBe(token)

      // Another visitor cannot get a ticket to this conversation.
      expect((await ask({ conversationId }, await freshToken())).status).toBe(404)
      expect((await ask({ conversationId: "nope" })).status).toBe(400)
    })

    it("rejects a bad token and a malformed conversationId before any write", async () => {
      const token = await freshToken()
      expect((await escalate("not-a-token", { conversationId: newId("con") })).status).toBe(401)
      expect((await escalate(token, { conversationId: "con_nope" })).status).toBe(400)
      expect((await escalate(token, {})).status).toBe(400)
      // A valid token replayed from another site dies on the origin binding.
      expect((await escalate(token, { conversationId: newId("con") }, EVIL_ORIGIN)).status).toBe(403)
    })
  })
})

describe.skipIf(DB_CONFIGURED)("widget routes (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})

void pool
//#endregion
