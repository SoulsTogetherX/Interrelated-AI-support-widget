// The internal credential API, driven over real HTTP against real Postgres
// (DB-gated like the widget suite) with a LOOPBACK OpenAI-compatible fake
// playing the tenant's provider — the same in-test upstream pattern as the
// provider suites. The security assertions are the point: uniform 401s,
// the read-back denial, encrypted-at-rest proof, and the SSRF default that
// REJECTS loopback (the tests that need to reach the fake inject a
// permissive vet through the same seam production leaves alone).
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { createApp } from "@/app"
import { decryptProviderKey } from "@/credentials/vault"
import { newId } from "@shared/utils/ids"

import type { Server } from "node:http"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const SECRET = "internal-test-secret-0123456789abcdef" // ≥32 chars
const TICKET_SECRET = "internal-test-ticket-secret-0123456789"
const TENANT_KEY = "sk-tenant-supersecret-abcd1234"

/** What the API's JSON bodies can carry — typed so assertions stay checked. */
interface ApiBody {
  ok?: boolean
  saved?: boolean
  model?: string
  latencyMs?: number
  dim?: number
  reindexed?: number
  suffix?: string | null
  error?: string
  credentials?: Array<Record<string, unknown>>
}

let appServer: Server
let base: string
let fakeProvider: Server
let fakeBase: string
let orgId: string
let requestsSeen: Array<{ url: string; auth: string | undefined }>

function post(path: string, body: unknown, secret?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-internal-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasDb)("internal credential API", () => {
  beforeAll(async () => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64")
    await migrateToLatest(db)

    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Internal Test Org" }).execute()

    // A minimal OpenAI-compatible upstream: SSE deltas then [DONE] for
    // chat, JSON vectors for embeddings. Records every request so tests can
    // assert what left the process. The "huge-embed" model returns 1536
    // dimensions — more than the storage column takes — so the refusal has
    // something real to refuse.
    requestsSeen = []
    fakeProvider = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        const body = (raw.length > 0 ? JSON.parse(raw) : {}) as { model?: string; input?: string[] }
        requestsSeen.push({ url: req.url ?? "", auth: req.headers.authorization })

        if ((req.url ?? "").endsWith("/embeddings")) {
          const dim = body.model === "huge-embed" ? 1536 : 8
          const input = body.input ?? []
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            data: input.map((_, i) => ({
              index: i,
              embedding: Array.from({ length: dim }, (_, j) => (j === i % dim ? 1 : 0)),
            })),
          }))
          return
        }

        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise<void>((r) => fakeProvider.listen(0, "127.0.0.1", r))
    const fp = fakeProvider.address() as { port: number }
    fakeBase = `http://127.0.0.1:${fp.port}/v1`

    // vetBaseUrl: allow loopback so the fake is reachable; the production
    // default's fail-closed behavior gets its own dedicated app below.
    const app = createApp({
      internal: { secret: SECRET, ticketSecret: TICKET_SECRET, vetBaseUrl: async () => {}, testTimeoutMs: 3000 },
    })
    appServer = createServer(app)
    await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r))
    const ap = appServer.address() as { port: number }
    base = `http://127.0.0.1:${ap.port}`
  })

  afterAll(async () => {
    appServer?.close()
    fakeProvider?.close()
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await pool.end()
    delete process.env.CREDENTIAL_MASTER_KEY
  })

  it("rejects a missing or wrong secret with one uniform empty 401", async () => {
    const missing = await post(`/internal/orgs/${orgId}/credentials`, {})
    const wrong = await post(`/internal/orgs/${orgId}/credentials`, {}, "x".repeat(36))
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await missing.text()).toBe("")
    expect(await wrong.text()).toBe("")
  })

  it("404s unknown and malformed org ids alike", async () => {
    const fabricated = await post(`/internal/orgs/${newId("org")}/credentials`, {}, SECRET)
    const malformed = await post("/internal/orgs/not-an-org/credentials", {}, SECRET)
    expect(fabricated.status).toBe(404)
    expect(malformed.status).toBe(404)
  })

  it("tests without saving when save:false — the Test button path", async () => {
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "generation",
        provider: "openai_compatible",
        apiKey: TENANT_KEY,
        baseUrl: fakeBase,
        model: "test-model",
        save: false,
      },
      SECRET,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiBody
    expect(body.saved).toBe(false)
    expect(body.model).toBe("test-model")
    expect(typeof body.latencyMs).toBe("number")

    const rows = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .execute()
    expect(rows).toHaveLength(0)
    // The round-trip really happened, carrying the tenant's key upstream.
    expect(requestsSeen.at(-1)?.auth).toBe(`Bearer ${TENANT_KEY}`)
  })

  it("saves a credential encrypted at rest after a live round-trip", async () => {
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "generation",
        provider: "openai_compatible",
        apiKey: TENANT_KEY,
        baseUrl: fakeBase,
        model: "test-model",
      },
      SECRET,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiBody
    expect(body.saved).toBe(true)
    expect(body.suffix).toBe("1234")

    const row = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow()
    // At rest: no plaintext anywhere in the row, and the ciphertext
    // decrypts back only under this row's id.
    expect(row.key_ciphertext).not.toBeNull()
    expect(row.key_ciphertext).not.toContain(TENANT_KEY)
    expect(row.key_suffix).toBe("1234")
    expect(decryptProviderKey(row.key_ciphertext!, row.id)).toBe(TENANT_KEY)
    expect(row.last_validation).toContain("test-model")
  })

  it("replaces on re-save: the superseded ciphertext ceases to exist", async () => {
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "generation",
        provider: "openai_compatible",
        apiKey: "sk-tenant-replacement-key-9999",
        baseUrl: fakeBase,
        model: "test-model",
      },
      SECRET,
    )
    expect(res.status).toBe(200)
    const rows = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].key_suffix).toBe("9999")
  })

  it("status read-back returns NO key material — the denial test", async () => {
    const res = await fetch(`${base}/internal/orgs/${orgId}/credentials`, {
      headers: { "x-internal-secret": SECRET },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // Not the current key, not the replaced one, not any ciphertext.
    expect(text).not.toContain("replacement")
    expect(text).not.toContain(TENANT_KEY)
    expect(text).not.toContain("v1.")
    const body = JSON.parse(text)
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]).toMatchObject({
      role: "generation",
      provider: "openai_compatible",
      key_suffix: "9999",
    })
    expect("key_ciphertext" in body.credentials[0]).toBe(false)
  })

  it("refuses Groq for the embedding role by name — it has no such endpoint", async () => {
    const before = requestsSeen.length
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      { role: "embedding", provider: "groq", apiKey: "gsk-embedding-key" },
      SECRET,
    )
    expect(res.status).toBe(422)
    expect(((await res.json()) as ApiBody).error).toContain("does not serve embeddings")
    expect(requestsSeen.length).toBe(before)
  })

  it("rejects shape violations without any upstream call", async () => {
    const before = requestsSeen.length
    const cases: Array<Record<string, unknown>> = [
      { role: "generation", provider: "groq" }, // key required
      { role: "generation", provider: "ollama", baseUrl: fakeBase, model: "m", apiKey: "k".repeat(10) }, // ollama+key
      { role: "generation", provider: "openai_compatible", model: "m" }, // base required
      { role: "generation", provider: "groq", apiKey: "k".repeat(10), baseUrl: fakeBase }, // fixed endpoint
      { role: "generation", provider: "openai_compatible", baseUrl: fakeBase, apiKey: "k".repeat(10) }, // model required
      { role: "generation", provider: "openai_compatible", baseUrl: "ftp://x/", model: "m" },
      { role: "generation", provider: "openai_compatible", baseUrl: "http://user:pw@host/v1", model: "m" },
    ]
    for (const body of cases) {
      const res = await post(`/internal/orgs/${orgId}/credentials`, body, SECRET)
      expect(res.status).toBe(422)
    }
    expect(requestsSeen.length).toBe(before)
  })

  it("a failing upstream fails the save and stores nothing", async () => {
    const dead = createServer((_req, res) => {
      res.writeHead(500)
      res.end("upstream exploded")
    })
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r))
    const dp = dead.address() as { port: number }
    try {
      const res = await post(
        `/internal/orgs/${orgId}/credentials`,
        {
          role: "generation",
          provider: "openai_compatible",
          apiKey: "sk-should-never-persist-0000",
          baseUrl: `http://127.0.0.1:${dp.port}/v1`,
          model: "test-model",
        },
        SECRET,
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as ApiBody
      // The failure message must never carry the tenant's key.
      expect(JSON.stringify(body)).not.toContain("should-never-persist")
      const rows = await db
        .selectFrom("org_provider_credentials")
        .selectAll()
        .where("org_id", "=", orgId)
        .execute()
      expect(rows.every((r) => r.key_suffix !== "0000")).toBe(true)
    } finally {
      dead.close()
    }
  })

  it("DELETE removes the role's credential", async () => {
    const res = await fetch(`${base}/internal/orgs/${orgId}/credentials/generation`, {
      method: "DELETE",
      headers: { "x-internal-secret": SECRET },
    })
    expect(res.status).toBe(200)
    const rows = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .execute()
    expect(rows).toHaveLength(0)
  })

  //#region Embedding credentials (M3.6b)
  it("saves an embedding credential with the dimension the provider actually returned", async () => {
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "embedding",
        provider: "openai_compatible",
        apiKey: "sk-embed-tenant-key-5678",
        baseUrl: fakeBase,
        model: "test-embed",
      },
      SECRET,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiBody
    expect(body.saved).toBe(true)
    // Measured, not declared: the form never asked for a dimension.
    expect(body.dim).toBe(8)

    const row = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("role", "=", "embedding")
      .executeTakeFirstOrThrow()
    expect(row.dim).toBe(8)
    expect(row.key_ciphertext).not.toContain("sk-embed")
    expect(decryptProviderKey(row.key_ciphertext!, row.id)).toBe("sk-embed-tenant-key-5678")
    expect(row.last_validation).toContain("8-d")
    // The embedding endpoint was really called, with the tenant's key.
    expect(requestsSeen.at(-1)?.url).toBe("/v1/embeddings")
    expect(requestsSeen.at(-1)?.auth).toBe("Bearer sk-embed-tenant-key-5678")
  })

  it("refuses a model whose vectors do not fit the storage column, storing nothing", async () => {
    const res = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "embedding",
        provider: "openai_compatible",
        apiKey: "sk-embed-too-big-0000",
        baseUrl: fakeBase,
        model: "huge-embed",
      },
      SECRET,
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as ApiBody
    // The sentence has to name both numbers and the fix — this is the one
    // rejection a tenant cannot diagnose from their provider's docs.
    expect(body.error).toContain("1536")
    expect(body.error).toContain("1024")
    // The previous, valid credential is untouched.
    const row = await db
      .selectFrom("org_provider_credentials")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("role", "=", "embedding")
      .executeTakeFirstOrThrow()
    expect(row.model).toBe("test-embed")
  })

  it("queues a re-index when the embedding model changes, and not when it doesn't", async () => {
    // A source to re-index. (No job yet: enqueueReindex skips sources with
    // work already queued, which is the behavior the second half asserts.)
    const sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "url", location: "https://docs.example.com/", crawl_depth: 0,
    }).execute()

    const changed = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "embedding", provider: "openai_compatible", apiKey: "sk-embed-tenant-key-5678",
        baseUrl: fakeBase, model: "second-embed",
      },
      SECRET,
    )
    expect(((await changed.json()) as ApiBody).reindexed).toBe(1)
    const queued = await db
      .selectFrom("ingest_jobs").selectAll()
      .where("source_id", "=", sourceId).where("state", "=", "queued").execute()
    expect(queued).toHaveLength(1)

    // Re-pasting a rotated key for the SAME model changes nothing about the
    // vector space, so it must not re-crawl the tenant's site.
    const same = await post(
      `/internal/orgs/${orgId}/credentials`,
      {
        role: "embedding", provider: "openai_compatible", apiKey: "sk-embed-rotated-key-4321",
        baseUrl: fakeBase, model: "second-embed",
      },
      SECRET,
    )
    expect(((await same.json()) as ApiBody).reindexed).toBe(0)
    expect(await db.selectFrom("ingest_jobs").selectAll().where("source_id", "=", sourceId).execute())
      .toHaveLength(1)
  })

  it("re-indexes on removal too — the org reverts to the platform model", async () => {
    // Clear the queued job first, or the skip-already-queued rule (rightly)
    // suppresses the new one.
    await db.deleteFrom("ingest_jobs").where("org_id", "=", orgId).execute()
    const res = await fetch(`${base}/internal/orgs/${orgId}/credentials/embedding`, {
      method: "DELETE",
      headers: { "x-internal-secret": SECRET },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as ApiBody).reindexed).toBe(1)
    expect(await db.selectFrom("ingest_jobs").selectAll().where("org_id", "=", orgId).execute()).toHaveLength(1)

    // A second DELETE removes nothing, so it must queue nothing.
    await db.deleteFrom("ingest_jobs").where("org_id", "=", orgId).execute()
    const again = await fetch(`${base}/internal/orgs/${orgId}/credentials/embedding`, {
      method: "DELETE",
      headers: { "x-internal-secret": SECRET },
    })
    expect(((await again.json()) as ApiBody).reindexed).toBe(0)
    expect(await db.selectFrom("ingest_jobs").selectAll().where("org_id", "=", orgId).execute()).toHaveLength(0)
  })
  //#endregion

  //#region Agent handoff tickets (M4.2)
  it("mints an agent socket ticket only for a member and an open handoff", async () => {
    const userId = newId("usr")
    const outsiderId = newId("usr")
    const conversationId = newId("con")
    await db.insertInto("users").values([
      { id: userId, email_index: `idx_${userId}`, email_ciphertext: "x", password_hash: "x" },
      { id: outsiderId, email_index: `idx_${outsiderId}`, email_ciphertext: "x", password_hash: "x" },
    ]).execute()
    await db.insertInto("org_members").values({ org_id: orgId, user_id: userId, role: "agent" }).execute()
    await db.insertInto("conversations")
      .values({ id: conversationId, org_id: orgId, visitor_id: "vis_ticket" })
      .execute()

    const ask = (body: unknown) => post(`/internal/orgs/${orgId}/handoff-tickets`, body, SECRET)

    // No handoff open yet: a ticket would admit an agent to a conversation
    // nobody asked for help with.
    expect((await ask({ conversationId, userId })).status).toBe(404)

    await db.insertInto("handoff_sessions").values({
      id: newId("hnd"), org_id: orgId, conversation_id: conversationId, reason: "visitor_request",
    }).execute()

    const granted = await ask({ conversationId, userId })
    expect(granted.status).toBe(200)
    const body = (await granted.json()) as { ticket?: string; expiresAt?: number }
    expect(body.ticket).toContain(".")
    expect((body.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(60_000)

    // A signed-in user who is NOT a member of this org gets nothing — the
    // dashboard checks too, but this route is the only thing that can mint
    // an agent ticket, so it re-establishes the claim rather than trusting it.
    expect((await ask({ conversationId, userId: outsiderId })).status).toBe(404)
    expect((await ask({ conversationId, userId: "not-an-id" })).status).toBe(422)
    expect((await ask({ conversationId: newId("con"), userId })).status).toBe(404)
    // And the surface still refuses an unauthenticated caller.
    expect((await post(`/internal/orgs/${orgId}/handoff-tickets`, { conversationId, userId })).status).toBe(401)

    await db.deleteFrom("conversations").where("id", "=", conversationId).execute()
    await db.deleteFrom("users").where("id", "in", [userId, outsiderId]).execute()
  })
  //#endregion

  it("the PRODUCTION url vet rejects private/loopback base URLs", async () => {
    // A second app WITHOUT the injected vet: the default must refuse our
    // loopback fake — this is the SSRF boundary doing its job, and it is
    // exactly why the other tests had to inject a permissive one.
    const prodApp = createApp({ internal: { secret: SECRET, ticketSecret: TICKET_SECRET } })
    const prodServer = createServer(prodApp)
    await new Promise<void>((r) => prodServer.listen(0, "127.0.0.1", r))
    const pp = prodServer.address() as { port: number }
    try {
      const res = await fetch(`http://127.0.0.1:${pp.port}/internal/orgs/${orgId}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": SECRET },
        body: JSON.stringify({
          role: "generation",
          provider: "openai_compatible",
          apiKey: "k".repeat(10),
          baseUrl: fakeBase,
          model: "test-model",
        }),
      })
      expect(res.status).toBe(422)
      expect(((await res.json()) as ApiBody).error).toContain("public address")
    } finally {
      prodServer.close()
    }
  })

  it("stays absent (404) when no secret is configured", async () => {
    const bareApp = createApp({})
    const bareServer = createServer(bareApp)
    await new Promise<void>((r) => bareServer.listen(0, "127.0.0.1", r))
    const bp = bareServer.address() as { port: number }
    try {
      const res = await fetch(`http://127.0.0.1:${bp.port}/internal/orgs/${orgId}/credentials`, {
        headers: { "x-internal-secret": SECRET },
      })
      expect(res.status).toBe(404)
    } finally {
      bareServer.close()
    }
  })
})
