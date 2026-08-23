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
import { hashSecretKey, newId, newSecretKey, secretKeySuffix } from "@shared/utils/ids"
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
      id: newId("key"), org_id: orgId, kind: "public", public_id: PK, secret_hash: null, secret_suffix: null,
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

    it("honors a stored ANONYMOUS visitorId, and refuses malformed and identified ones alike", async () => {
      // The widget hands back the vis_<hex> id the server gave it, so a
      // reload keeps its thread.
      const returning = `vis_${"7".repeat(32)}`
      const good = await mintSession({ visitorId: returning })
      expect(((await good.json()) as { visitorId: string }).visitorId).toBe(returning)
      const bad = await mintSession({ visitorId: "spaces are invalid" })
      expect(bad.status).toBe(400)
      // An IDENTIFIED id — a customer's user id — is refused on THIS route
      // (M7.3): only the customer's own server may mint one, through
      // POST /v1/sessions with the secret key. Otherwise anyone on the
      // allowlisted origin could mint a session as "user 42" and be user
      // 42 to the agent reading the inbox. Same status as malformed: a
      // browser has no business telling the two apart.
      const impersonation = await mintSession({ visitorId: "42" })
      expect(impersonation.status).toBe(400)
      expect(await impersonation.json()).toEqual(await bad.json())
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
        secret_hash: null, secret_suffix: null,
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
        id: retiringRowId, org_id: orgId, kind: "public", public_id: retiringPk, secret_hash: null, secret_suffix: null,
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

    it("counts every mint that names an org per origin — minted for the allowlisted, refused for the copy (layer 4)", async () => {
      // Layer 1 refuses an unlisted origin; layer 4 makes the refusal
      // VISIBLE to the tenant as a name and a number. The counter row is
      // there the moment the response is (the route awaits it), which is
      // what lets a dashboard say "that copy is still out there" truthfully.
      const counters = async () => db.selectFrom("origin_daily")
        .select(["origin", "minted", "refused"])
        .where("org_id", "=", orgId).where("day", "=", utcDay())
        .orderBy("origin").execute()
      const before = await counters()
      const at = (rowsNow: Awaited<ReturnType<typeof counters>>, origin: string) =>
        rowsNow.find((r) => r.origin === origin) ?? { origin, minted: 0, refused: 0 }

      expect((await mintSession()).status).toBe(200)                    // allowlisted → minted
      expect((await mintSession({}, EVIL_ORIGIN)).status).toBe(403)     // unlisted → refused
      expect((await mintSession({}, EVIL_ORIGIN)).status).toBe(403)
      // A missing Origin and a bad key are refused BEFORE anything names
      // an org, so they add nothing anywhere — the route spends no lookup
      // on requests it will refuse for free.
      const noOrigin = await fetch(`${baseUrl}/v1/widget/session`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishableKey: PK }),
      })
      expect(noOrigin.status).toBe(403)
      expect((await mintSession({ publishableKey: "pk_live_never_existed" }, EVIL_ORIGIN)).status).toBe(401)

      const after = await counters()
      expect(at(after, GOOD_ORIGIN).minted - at(before, GOOD_ORIGIN).minted).toBe(1)
      expect(at(after, GOOD_ORIGIN).refused - at(before, GOOD_ORIGIN).refused).toBe(0)
      expect(at(after, EVIL_ORIGIN).refused - at(before, EVIL_ORIGIN).refused).toBe(2)
      expect(at(after, EVIL_ORIGIN).minted).toBe(0)
      // The total number of rows grew by at most the one new origin — the
      // no-Origin and bad-key refusals left no trace.
      expect(after.length - before.length).toBeLessThanOrEqual(1)
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

  describe("server-side session mint — POST /v1/sessions (layer 6)", () => {
    // The customer's BACKEND mints here with the secret key; the browser
    // never does. Seeded like the dashboard seeds it (web/src/lib/keys):
    // the plaintext exists only in this process, the row holds its hash and
    // its four-character suffix. Three keys, written in the order real
    // history writes them — a revoked one, a retiring one, then the current
    // one — because 007's one-current-secret-per-org index refuses a second
    // current row, so an older key has to be rotated OUT before a newer one
    // is issued, exactly as the dashboard's rotation does it.
    const SK = newSecretKey()
    const REVOKED_SK = newSecretKey()
    const RETIRING_SK = newSecretKey()
    let secretRowId: string
    let retiringRowId: string

    async function serverMint(
      body: Record<string, unknown>,
      bearer: string | null = SK,
      base: string = baseUrl,
    ): Promise<Response> {
      return fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      })
    }

    beforeAll(async () => {
      const secretRow = (key: string, id: string) => ({
        id, org_id: orgId, kind: "secret" as const, public_id: null,
        secret_hash: hashSecretKey(key), secret_suffix: secretKeySuffix(key),
      })
      // Revoked: created live, then revoked — on Postgres's clock, the clock
      // the route compares against.
      const revokedRowId = newId("key")
      await db.insertInto("api_keys").values(secretRow(REVOKED_SK, revokedRowId)).execute()
      await db.updateTable("api_keys").set({ revoked_at: sql`NOW()` }).where("id", "=", revokedRowId).execute()
      // Retiring: the state rotation leaves the old key in — revoked_at in
      // the future, still accepted until then.
      retiringRowId = newId("key")
      await db.insertInto("api_keys").values(secretRow(RETIRING_SK, retiringRowId)).execute()
      await db.updateTable("api_keys").set({ revoked_at: sql`NOW() + interval '1 hour'` })
        .where("id", "=", retiringRowId).execute()
      // Current: the newest, and the only one with revoked_at NULL.
      secretRowId = newId("key")
      await db.insertInto("api_keys").values(secretRow(SK, secretRowId)).execute()
    })

    it("mints a session for an identified user of an allowlisted origin — and that token chats", async () => {
      const response = await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_42" })
      expect(response.status).toBe(200)
      // No CORS on this route, ever: a browser page cannot use a secret key
      // even by mistake — the browser refuses to read this response.
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      const body = await response.json() as { token: string; expiresAt: number; visitorId: string }
      expect(body.visitorId).toBe("user_42")
      expect(body.expiresAt).toBeGreaterThan(Date.now())

      // The token is an ordinary session, bound to the origin the server
      // named: it chats from that origin …
      const answer = await chat(body.token, { question: CHUNK_TEXT })
      expect(answer.status).toBe(200)
      expect(answer.events.some((e) => e.type === "claim")).toBe(true)
      // … under the identity the server asserted …
      const meta = answer.events[0] as Extract<AnswerEvent, { type: "meta" }>
      const conversation = await db.selectFrom("conversations").select("visitor_id")
        .where("id", "=", meta.conversationId).executeTakeFirstOrThrow()
      expect(conversation.visitor_id).toBe("user_42")
      // … and dies when replayed from anywhere else, exactly like a
      // browser-minted token.
      const replayed = await chat(body.token, { question: CHUNK_TEXT }, EVIL_ORIGIN)
      expect(replayed.status).toBe(403)

      // The mint stamped the key (the "last used" the dashboard shows) and
      // counted the origin (layer 4 — a server mint is a widget load too).
      const row = await db.selectFrom("api_keys").select("last_used_at")
        .where("id", "=", secretRowId).executeTakeFirstOrThrow()
      expect(row.last_used_at).not.toBeNull()
      const counter = await db.selectFrom("origin_daily").select("minted")
        .where("org_id", "=", orgId).where("day", "=", utcDay()).where("origin", "=", GOOD_ORIGIN)
        .executeTakeFirstOrThrow()
      expect(counter.minted).toBeGreaterThan(0)
    })

    it("refuses a missing, malformed, unknown, revoked, and publishable-key bearer with ONE 401", async () => {
      // Every refusal here happens BEFORE anything is minted or counted, and
      // every body is byte-identical: which kind of wrong key was presented
      // is not information this route shares (the same posture as the
      // publishable key's route).
      const cases: Array<[string, string | null]> = [
        ["missing", null],
        ["garbage", "not-a-key"],
        ["the PUBLISHABLE key", PK],
        ["unknown", newSecretKey()],
        ["revoked", REVOKED_SK],
      ]
      const bodies = new Set<string>()
      for (const [label, bearer] of cases) {
        const response = await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_42" }, bearer)
        expect(response.status, label).toBe(401)
        expect(response.headers.get("access-control-allow-origin"), label).toBeNull()
        bodies.add(await response.text())
      }
      expect(bodies.size).toBe(1)
      // …and the revoked key was one row the org's own secret should have
      // outlived: the live one still mints.
      expect((await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_42" })).status).toBe(200)
    })

    it("keeps a rotated-out secret key live through its grace window, on the database's clock", async () => {
      // The same rule as the publishable key (M7.1): rotation schedules the
      // old key's revocation rather than performing it, so a backend the
      // customer has not redeployed keeps minting until the window closes.
      const inside = await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_7" }, RETIRING_SK)
      expect(inside.status).toBe(200)
      const { token } = (await inside.json()) as { token: string }
      // …and the mint stamped the retiring row, which is how the owner learns
      // the OLD backend config is still deployed somewhere.
      const stamped = await db.selectFrom("api_keys").select("last_used_at")
        .where("id", "=", retiringRowId).executeTakeFirstOrThrow()
      expect(stamped.last_used_at).not.toBeNull()

      await db.updateTable("api_keys").set({ revoked_at: sql`NOW() - interval '1 second'` })
        .where("id", "=", retiringRowId).execute()
      const after = await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_7" }, RETIRING_SK)
      const unknown = await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_7" }, newSecretKey())
      expect(after.status).toBe(401)
      expect(await after.text()).toBe(await unknown.text())
      // The session minted inside the window is bound to the org, not the
      // key: it keeps chatting for its 30 minutes.
      expect((await chat(token, { question: CHUNK_TEXT })).status).toBe(200)
    })

    it("refuses an unlisted origin with 403 (counted, no CORS) and tells the tenant's server why", async () => {
      // A server naming an origin the org never allowlisted: refused like a
      // copied snippet would be, and COUNTED like one, so the dashboard's
      // traffic table shows the origin with its Allow button. Unlike the
      // browser route the body carries a sentence — the caller has proven
      // it is the tenant, and this is its own configuration to fix.
      const before = await db.selectFrom("origin_daily").select("refused")
        .where("org_id", "=", orgId).where("day", "=", utcDay()).where("origin", "=", EVIL_ORIGIN)
        .executeTakeFirst()
      const unlisted = await serverMint({ origin: EVIL_ORIGIN, visitorId: "user_42" })
      expect(unlisted.status).toBe(403)
      expect(unlisted.headers.get("access-control-allow-origin")).toBeNull()
      const unlistedBody = await unlisted.json() as { error: string; detail: string }
      expect(unlistedBody.error).toBe("origin not allowed")
      expect(unlistedBody.detail).toMatch(/not on the organization's allowlist/)
      const after = await db.selectFrom("origin_daily").select("refused")
        .where("org_id", "=", orgId).where("day", "=", utcDay()).where("origin", "=", EVIL_ORIGIN)
        .executeTakeFirstOrThrow()
      expect(after.refused - (before?.refused ?? 0)).toBe(1)

      // A value that is not an origin at all (a trailing slash, the commonest
      // typo) gets the SHAPE sentence instead — and no row of its own: it is
      // counted under the malformed sentinel like any other refused
      // non-origin (§3.28).
      const malformed = await serverMint({ origin: `${GOOD_ORIGIN}/`, visitorId: "user_42" })
      expect(malformed.status).toBe(403)
      expect(((await malformed.json()) as { detail: string }).detail).toMatch(/scheme:\/\/host/)
      // Missing entirely: a 400 that says what to send.
      const missing = await serverMint({ visitorId: "user_42" })
      expect(missing.status).toBe(400)
    })

    it("refuses an anonymous-shaped, malformed, or missing visitorId with 400 and mints nothing", async () => {
      // The anonymous namespace (vis_<hex>) is the browser route's; a server
      // asserting an identity must use its own id, or the two namespaces
      // could overlap and "identified by your server" would stop being true.
      for (const visitorId of [`vis_${"a".repeat(32)}`, "spaces are invalid", "alice@example.com", undefined]) {
        const response = await serverMint({ origin: GOOD_ORIGIN, ...(visitorId !== undefined ? { visitorId } : {}) })
        expect(response.status, String(visitorId)).toBe(400)
        const body = await response.json() as { error: string; token?: string }
        expect(body.error).toBe("invalid visitorId")
        expect(body.token).toBeUndefined()
      }
    })

    it("grants nothing to a browser preflight — no CORS headers on OPTIONS or on the answer", async () => {
      // A page that tried to call this route with a secret key would send a
      // preflight first; without an allow-origin header the browser stops
      // there. Express answers OPTIONS on a route with an Allow header of its
      // own, which is fine — it is the ABSENCE of CORS that matters.
      const preflight = await fetch(`${baseUrl}/v1/sessions`, {
        method: "OPTIONS",
        headers: { origin: GOOD_ORIGIN, "access-control-request-method": "POST" },
      })
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
      const withOrigin = await fetch(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: GOOD_ORIGIN, authorization: `Bearer ${SK}` },
        body: JSON.stringify({ origin: GOOD_ORIGIN, visitorId: "user_42" }),
      })
      expect(withOrigin.status).toBe(200)
      expect(withOrigin.headers.get("access-control-allow-origin")).toBeNull()
    })

    it("rate limits server-side minting per IP, before the key is even looked at", async () => {
      const { server: floodServer, baseUrl: floodUrl } = await listen(buildApp({
        serverMintLimiter: new RateLimiter({ capacity: 2, refillPerSecond: 0.001 }),
      }))
      try {
        const statuses: number[] = []
        for (let i = 0; i < 3; i++) {
          statuses.push((await serverMint({ origin: GOOD_ORIGIN, visitorId: "user_42" }, "sk_live_guess", floodUrl)).status)
        }
        // Two guesses cost two lookups and are refused as unknown; the third
        // is refused as a flood — the bucket bounds guessing at a secret.
        expect(statuses).toEqual([401, 401, 429])
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
