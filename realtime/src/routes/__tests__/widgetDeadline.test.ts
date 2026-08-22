// The answer deadline at the ROUTE (M8.4): a provider that accepts the
// connection and goes quiet must become one opaque error event on the SSE
// stream at ANSWER_DEADLINE_MS — not an open stream held for as long as the
// provider likes, which is what M8.3 measured (a first token after 310 s,
// bounded by nothing but the visitor closing the tab).
//
// Its own file with its own app instance, the widgetByo precedent: the
// deadline under test is deliberately tiny (120 ms), and configuring it on
// the main widget suite's shared app would put every chat case in that
// suite under it.
import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { createApp } from "@/app"
import { RateLimiter } from "@/widget/rateLimit"
import { MockEmbeddingProvider } from "@providers/embedding/mock"
import type { AnswerEvent } from "@shared/grounding/events"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"

import type { Server } from "node:http"

const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

const SECRET = "widget-deadline-test-secret-0123456789"
const ORIGIN = "https://deadline.example"
const PK = "pk_live_deadline_org_test_key_0000"
const CHUNK_TEXT = "Deliveries arrive within three business days of dispatch."

const embedder = new MockEmbeddingProvider()

/** The provider M8.3 met: accepts the call, then silence. It resolves only
 *  when the request's signal aborts — exactly what a real fetch does when
 *  the far end quietly holds the socket. */
class HangingLLMProvider {
  readonly model = "hanging-llm"
  calls = 0
  // eslint-disable-next-line require-yield
  async *stream(request: { signal?: AbortSignal }): AsyncGenerator<never> {
    this.calls++
    await new Promise<never>((_, reject) => {
      const fail = () => reject(request.signal?.reason ?? new Error("aborted"))
      if (request.signal?.aborted) return fail()
      request.signal?.addEventListener("abort", fail, { once: true })
    })
  }
}

let server: Server
let baseUrl: string
let orgId: string
let llm: HangingLLMProvider

describe.skipIf(!DB_CONFIGURED)("widget chat under the answer deadline", () => {
  beforeAll(async () => {
    await migrateToLatest(db)

    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Deadline Org" }).execute()
    await db.insertInto("api_keys").values({
      id: newId("key"), org_id: orgId, kind: "public", public_id: PK, secret_hash: null, secret_suffix: null,
    }).execute()
    await db.insertInto("allowed_origins").values({ org_id: orgId, origin: ORIGIN }).execute()
    const sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "url", location: ORIGIN,
    }).execute()
    const documentId = newId("doc")
    await db.insertInto("documents").values({
      id: documentId, org_id: orgId, source_id: sourceId,
      url: `${ORIGIN}/shipping`, title: "Shipping", content_hash: "e".repeat(64),
    }).execute()
    const chunkId = newId("chk")
    const [vector] = await embedder.embed([CHUNK_TEXT])
    await db.insertInto("chunks").values({
      id: chunkId, org_id: orgId, document_id: documentId, ord: 0,
      heading_path: "Shipping", text: CHUNK_TEXT,
      token_count: Math.ceil(CHUNK_TEXT.length / 4), char_start: null, char_end: null,
    }).execute()
    await db.insertInto("chunk_embeddings").values({
      chunk_id: chunkId, org_id: orgId, model: embedder.model, dim: embedder.dim,
      embedding: toPgvector(padVector(vector!)),
    }).execute()

    llm = new HangingLLMProvider()
    const app = createApp({
      widget: {
        db, embedder, llm,
        tokenSecret: SECRET,
        answerDeadlineMs: 120,
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
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await pool.end()
  })

  it("ends a hung provider's stream with the one opaque error event at the deadline", async () => {
    const mint = await fetch(`${baseUrl}/v1/widget/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ publishableKey: PK }),
    })
    expect(mint.status).toBe(200)
    const { token } = (await mint.json()) as { token: string }

    // The question IS the chunk text — mock embeddings carry no semantics,
    // so only exact-text retrieval clears the gate and reaches the (hung)
    // model call.
    const startedAt = Date.now()
    const res = await fetch(`${baseUrl}/v1/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: CHUNK_TEXT }),
    })
    expect(res.status).toBe(200) // SSE had already started — failure is an event
    const text = await res.text() // resolves ONLY because the stream really ended
    const elapsedMs = Date.now() - startedAt

    // The stream CONCLUDED at the deadline, not at some provider's whim.
    // Generous ceiling so a loaded runner never flakes; the un-bounded
    // behavior this replaces would sit here until vitest's own timeout.
    expect(elapsedMs).toBeLessThan(5_000)
    expect(llm.calls).toBe(1)

    const events = text.split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as AnswerEvent)
    // meta went out before generation began; then the one terminal error —
    // opaque, exactly `{type:"error"}`: a deadline is a provider fact, and
    // provider facts on a public stream are reconnaissance (§3.18). The
    // widget renders its ordinary failure state and recovers the input.
    expect(events.map((e) => e.type)).toEqual(["meta", "error"])
    expect(Object.keys(events[1] as object)).toEqual(["type"])

    // The question is history; the answer that never arrived is not.
    const meta = events[0] as { conversationId: string }
    const messages = await db.selectFrom("messages")
      .select("role").where("conversation_id", "=", meta.conversationId).execute()
    expect(messages.map((m) => m.role)).toEqual(["visitor"])
  })
})

describe.skipIf(DB_CONFIGURED)("widget chat under the answer deadline (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})
