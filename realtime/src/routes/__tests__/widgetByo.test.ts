// Per-org BYO generation in the LIVE chat path (M3.5): an org with a saved
// credential gets its answers from ITS provider — proven with a loopback
// OpenAI-compatible fake that wraps the same context-quoting responder the
// mock uses, so the full grounded loop (retrieve → gate → REAL HTTP hop →
// parse → verify → strip) runs against a provider the test controls. The
// isolation case is the one that matters in a multi-tenant system: a
// SECOND org with no credential must fall back to the app-level mock and
// never touch the first org's provider.
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { createApp } from "@/app"
import { RateLimiter } from "@/widget/rateLimit"
import { groundedMockResponder } from "@/answer/mockResponder"
import { encryptProviderKey, keySuffix } from "@/credentials/vault"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import { MockLLMProvider } from "@providers/llm/mock"
import type { AnswerEvent } from "@shared/grounding/events"
import type { ChatMessage } from "@providers/llm/types"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"

import type { Server } from "node:http"

const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

const SECRET = "widget-byo-test-secret-0123456789abcdef"
const ORIGIN = "https://byo.example"
const PK_BYO = "pk_live_byo_org_test_key_000000000"
const PK_PLAIN = "pk_live_plain_org_test_key_0000000"
const CHUNK_TEXT = "Exchanges are accepted within thirty days with the original receipt."
const TENANT_KEY = "sk-byo-tenant-key-xyz987"

const embedder = new MockEmbeddingProvider()

let server: Server
let baseUrl: string
let fake: Server
let fakeHits: Array<{ auth: string | undefined }>
let byoOrgId: string
let plainOrgId: string

async function seedOrg(name: string, pk: string): Promise<string> {
  const orgId = newId("org")
  await db.insertInto("organizations").values({ id: orgId, name }).execute()
  await db.insertInto("api_keys").values({
    id: newId("key"), org_id: orgId, kind: "public", public_id: pk, secret_hash: null,
  }).execute()
  await db.insertInto("allowed_origins").values({ org_id: orgId, origin: ORIGIN }).execute()
  const sourceId = newId("src")
  await db.insertInto("sources").values({
    id: sourceId, org_id: orgId, kind: "url", location: ORIGIN,
  }).execute()
  const documentId = newId("doc")
  await db.insertInto("documents").values({
    id: documentId, org_id: orgId, source_id: sourceId,
    url: `${ORIGIN}/exchanges`, title: "Exchanges", content_hash: "f".repeat(64),
  }).execute()
  const chunkId = newId("chk")
  const [vector] = await embedder.embed([CHUNK_TEXT])
  await db.insertInto("chunks").values({
    id: chunkId, org_id: orgId, document_id: documentId, ord: 0,
    heading_path: "Exchanges", text: CHUNK_TEXT,
    token_count: Math.ceil(CHUNK_TEXT.length / 4), char_start: null, char_end: null,
  }).execute()
  await db.insertInto("chunk_embeddings").values({
    chunk_id: chunkId, org_id: orgId, model: embedder.model, dim: embedder.dim,
    embedding: toPgvector(padVector(vector)),
  }).execute()
  return orgId
}

async function mintAndChat(pk: string, question: string): Promise<AnswerEvent[]> {
  const mint = await fetch(`${baseUrl}/v1/widget/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ publishableKey: pk }),
  })
  expect(mint.status).toBe(200)
  const { token } = (await mint.json()) as { token: string }
  const res = await fetch(`${baseUrl}/v1/widget/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` },
    body: JSON.stringify({ question }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  return text.split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as AnswerEvent)
}

describe.skipIf(!DB_CONFIGURED)("widget chat with per-org BYO generation", () => {
  beforeAll(async () => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64")
    await migrateToLatest(db)

    byoOrgId = await seedOrg("BYO Org", PK_BYO)
    plainOrgId = await seedOrg("Plain Org", PK_PLAIN)

    // The tenant's "provider": an OpenAI-compatible loopback that answers
    // through the SAME context-quoting responder the mock uses — grounded
    // by construction, but reached over a real HTTP hop through the real
    // OpenAICompatibleProvider adapter with the DECRYPTED tenant key.
    const respond = groundedMockResponder()
    fakeHits = []
    fake = createServer((req, res) => {
      fakeHits.push({ auth: req.headers.authorization })
      let raw = ""
      req.on("data", (c: Buffer) => (raw += c.toString()))
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: ChatMessage[] }
        const answer = respond({ messages: body.messages })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.text } }] })}\n\n`)
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r))
    const fp = fake.address() as { port: number }

    // The BYO org's credential, encrypted exactly as the internal API
    // would store it.
    const credId = newId("prv")
    await db.insertInto("org_provider_credentials").values({
      id: credId,
      org_id: byoOrgId,
      role: "generation",
      provider: "openai_compatible",
      model: "byo-test-model",
      base_url: `http://127.0.0.1:${fp.port}/v1`,
      key_ciphertext: encryptProviderKey(TENANT_KEY, credId),
      key_suffix: keySuffix(TENANT_KEY),
      last_validated_at: new Date(),
      last_validation: "byo-test-model, 1ms",
    }).execute()

    const app = createApp({
      widget: {
        db, embedder,
        llm: new MockLLMProvider(groundedMockResponder()),
        tokenSecret: SECRET,
        mintLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
        chatIpLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
        chatVisitorLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 1000 }),
      },
    })
    server = createServer(app)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    server?.close()
    fake?.close()
    await db.deleteFrom("organizations").where("id", "in", [byoOrgId, plainOrgId]).execute()
    await pool.end()
    delete process.env.CREDENTIAL_MASTER_KEY
  })

  it("answers the BYO org through ITS provider with the decrypted key", async () => {
    // The question IS the chunk text: mock embeddings carry no semantics,
    // so only exact-text retrieval clears the groundedness gate (the same
    // constraint §3.19 documents for the seeded demo).
    const events = await mintAndChat(PK_BYO, CHUNK_TEXT)
    const meta = events.find((e) => e.type === "meta")
    const claims = events.filter((e) => e.type === "claim")
    expect(meta).toBeDefined()
    expect(claims.length).toBeGreaterThan(0)
    // The whole grounded loop survived the real HTTP hop: the claim quotes
    // the seeded chunk and passed the deterministic verifier.
    expect(JSON.stringify(claims)).toContain("thirty days")
    // The upstream saw exactly one call, carrying the DECRYPTED tenant key.
    expect(fakeHits).toHaveLength(1)
    expect(fakeHits[0].auth).toBe(`Bearer ${TENANT_KEY}`)
    // And the persisted answer names the tenant's model, not the mock.
    const message = await db
      .selectFrom("messages")
      .select("model")
      .where("org_id", "=", byoOrgId)
      .where("role", "=", "assistant")
      .executeTakeFirstOrThrow()
    expect(message.model).toBe("byo-test-model")
  })

  it("keeps the credential-less org on the fallback — tenant isolation", async () => {
    const before = fakeHits.length
    const events = await mintAndChat(PK_PLAIN, CHUNK_TEXT)
    expect(events.some((e) => e.type === "claim")).toBe(true)
    // The other tenant's provider was NEVER touched.
    expect(fakeHits.length).toBe(before)
    const message = await db
      .selectFrom("messages")
      .select("model")
      .where("org_id", "=", plainOrgId)
      .where("role", "=", "assistant")
      .executeTakeFirstOrThrow()
    expect(message.model).toBe("mock-llm")
  })

  it("returns to the fallback the moment the credential is removed", async () => {
    await db.deleteFrom("org_provider_credentials").where("org_id", "=", byoOrgId).execute()
    const before = fakeHits.length
    const events = await mintAndChat(PK_BYO, CHUNK_TEXT)
    expect(events.some((e) => e.type === "claim")).toBe(true)
    // No cache to serve the dead credential: zero new upstream hits.
    expect(fakeHits.length).toBe(before)
  })
})
