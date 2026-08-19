//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// Chat-schema integration suite — the persistence constraints at their
// boundaries, same gating pattern as migrate.test.ts.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

describe.skipIf(!DB_CONFIGURED)("chat persistence (conversations, messages, citations)", () => {
  let orgId: string
  let conversationId: string

  beforeAll(async () => {
    await migrateToLatest(db)
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Chat Co" }).execute()
    conversationId = newId("con")
    await db.insertInto("conversations")
      .values({ id: conversationId, org_id: orgId, visitor_id: "vis_test_1" })
      .execute()
  })

  afterAll(async () => {
    // Cascade wipes conversations → messages → citations with it.
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.destroy()
  })

  //#region Helpers
  async function insertAssistantMessage(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = newId("msg")
    await db.insertInto("messages").values({
      id,
      conversation_id: conversationId,
      org_id: orgId,
      role: "assistant",
      content: "Fastify supports HTTP/2.",
      model: "mock-llm",
      // Paired with `model` by CHECK since migration 010: a row that names
      // a model must say how many times that model broke the contract.
      schema_violations: 0,
      retrieval_score: 0.032,
      ttft_ms: 180,
      total_ms: 900,
      ...overrides,
    } as never).execute()
    return id
  }
  //#endregion

  describe("conversations", () => {
    it("defaults to open and rejects invented statuses", async () => {
      const row = await db.selectFrom("conversations")
        .select(["status"]).where("id", "=", conversationId).executeTakeFirstOrThrow()
      expect(row.status).toBe("open")
      await expect(
        db.insertInto("conversations")
          .values({ id: newId("con"), org_id: orgId, visitor_id: "v", status: "archived" as never })
          .execute(),
      ).rejects.toThrow(/check/i)
    })

    it("accepts the escalated status M4 will use — provisioned, not dead", async () => {
      const id = newId("con")
      await db.insertInto("conversations")
        .values({ id, org_id: orgId, visitor_id: "v2", status: "escalated" }).execute()
      await db.deleteFrom("conversations").where("id", "=", id).execute()
    })

    it("rejects a blank visitor_id and one past the 100-char cap", async () => {
      for (const bad of ["", "v".repeat(101)]) {
        await expect(
          db.insertInto("conversations")
            .values({ id: newId("con"), org_id: orgId, visitor_id: bad }).execute(),
        ).rejects.toThrow(/check/i)
      }
      // Exactly at the cap is legal — the boundary the CHECK must not overreach.
      const id = newId("con")
      await db.insertInto("conversations")
        .values({ id, org_id: orgId, visitor_id: "v".repeat(100) }).execute()
      await db.deleteFrom("conversations").where("id", "=", id).execute()
    })
  })

  describe("messages role consistency", () => {
    it("accepts a full assistant row and a bare visitor row", async () => {
      await insertAssistantMessage()
      await db.insertInto("messages").values({
        id: newId("msg"),
        conversation_id: conversationId,
        org_id: orgId,
        role: "visitor",
        content: "Does Fastify support HTTP/2?",
      }).execute()
    })

    it("rejects a visitor message carrying a model", async () => {
      await expect(
        insertAssistantMessage({ role: "visitor", model: "mock-llm", retrieval_score: null, ttft_ms: null, total_ms: null }),
      ).rejects.toThrow(/check/i)
    })

    it("rejects a refused visitor message — refusal is an assistant verdict", async () => {
      await expect(
        insertAssistantMessage({ role: "visitor", model: null, refused: true, retrieval_score: null, ttft_ms: null, total_ms: null }),
      ).rejects.toThrow(/check/i)
    })

    it("rejects latency and score columns on non-assistant roles", async () => {
      await expect(
        insertAssistantMessage({ role: "agent", model: null, retrieval_score: null, ttft_ms: 50, total_ms: null }),
      ).rejects.toThrow(/check/i)
    })

    it("rejects empty content and negative latency", async () => {
      await expect(insertAssistantMessage({ content: "" })).rejects.toThrow(/check/i)
      await expect(insertAssistantMessage({ ttft_ms: -1 })).rejects.toThrow(/check/i)
    })
  })

  describe("message_citations", () => {
    it("stores verified and stripped claims side by side — the strip rate's raw data", async () => {
      const messageId = await insertAssistantMessage()
      await db.insertInto("message_citations").values([
        {
          message_id: messageId, ord: 0, chunk_id: newId("chk"),
          claim_text: "Shown to the visitor.", quote: "experimental support for HTTP/2",
          verdict: "verified", span_start: 15, span_end: 46,
          url: "https://fastify.dev/docs/latest/Reference/HTTP2/", heading_path: "HTTP2",
        },
        {
          message_id: messageId, ord: 1, chunk_id: newId("chk"),
          claim_text: "Stripped before display.", quote: "an invented sentence",
          verdict: "quote_not_found", span_start: null, span_end: null,
          url: null, heading_path: null,
        },
      ]).execute()
      const rows = await db.selectFrom("message_citations")
        .select(["ord", "verdict"]).where("message_id", "=", messageId)
        .orderBy("ord").execute()
      expect(rows.map((r) => r.verdict)).toEqual(["verified", "quote_not_found"])
    })

    it("accepts a citation whose chunk_id matches no chunks row — the FK is deliberately absent", async () => {
      // Chunks are re-chunked away; transcripts are history. This insert
      // FAILING would mean someone added the FK and re-coupled them.
      const messageId = await insertAssistantMessage()
      await db.insertInto("message_citations").values({
        message_id: messageId, ord: 0, chunk_id: "chk_00000000000000000000000000000000",
        claim_text: "Cites a chunk that never existed.", quote: "whatever",
        verdict: "unknown_chunk", span_start: null, span_end: null, url: null, heading_path: null,
      }).execute()
    })

    it("ties spans to the verified verdict exactly — neither side may exist alone", async () => {
      const messageId = await insertAssistantMessage()
      const base = {
        message_id: messageId, ord: 0, chunk_id: newId("chk"),
        claim_text: "Boundary probe.", quote: "q", url: null, heading_path: null,
      }
      // verified without offsets: unrepresentable.
      await expect(
        db.insertInto("message_citations")
          .values({ ...base, verdict: "verified", span_start: null, span_end: null }).execute(),
      ).rejects.toThrow(/check/i)
      // unverified WITH offsets: equally unrepresentable.
      await expect(
        db.insertInto("message_citations")
          .values({ ...base, verdict: "quote_not_found", span_start: 0, span_end: 5 }).execute(),
      ).rejects.toThrow(/check/i)
      // half a span: caught by the pairing CHECK.
      await expect(
        db.insertInto("message_citations")
          .values({ ...base, verdict: "verified", span_start: 3, span_end: null }).execute(),
      ).rejects.toThrow(/check/i)
    })

    it("rejects inverted and empty spans, accepts the 1-char minimum", async () => {
      const messageId = await insertAssistantMessage()
      const base = {
        message_id: messageId, chunk_id: newId("chk"),
        claim_text: "Span shapes.", quote: "q", verdict: "verified" as const,
        url: null, heading_path: null,
      }
      await expect(
        db.insertInto("message_citations")
          .values({ ...base, ord: 0, span_start: 10, span_end: 5 }).execute(),
      ).rejects.toThrow(/check/i)
      await expect(
        db.insertInto("message_citations")
          .values({ ...base, ord: 0, span_start: 7, span_end: 7 }).execute(),
      ).rejects.toThrow(/check/i)
      // start < end by exactly one — the smallest legal span.
      await db.insertInto("message_citations")
        .values({ ...base, ord: 0, span_start: 7, span_end: 8 }).execute()
    })

    it("rejects a duplicate (message_id, ord) — a buggy double-write must be loud", async () => {
      const messageId = await insertAssistantMessage()
      const row = {
        message_id: messageId, ord: 0, chunk_id: newId("chk"),
        claim_text: "First.", quote: "q", verdict: "unknown_chunk" as const,
        span_start: null, span_end: null, url: null, heading_path: null,
      }
      await db.insertInto("message_citations").values(row).execute()
      await expect(
        db.insertInto("message_citations").values({ ...row, claim_text: "Second." }).execute(),
      ).rejects.toThrow(/duplicate key|pkey/i)
    })
  })

  describe("cascade", () => {
    it("deleting a conversation removes its messages and their citations", async () => {
      const convId = newId("con")
      await db.insertInto("conversations")
        .values({ id: convId, org_id: orgId, visitor_id: "cascade-vis" }).execute()
      const msgId = newId("msg")
      await db.insertInto("messages").values({
        id: msgId, conversation_id: convId, org_id: orgId,
        role: "assistant", content: "Doomed.", model: "mock-llm", schema_violations: 0,
      }).execute()
      await db.insertInto("message_citations").values({
        message_id: msgId, ord: 0, chunk_id: newId("chk"),
        claim_text: "Doomed too.", quote: "q", verdict: "unknown_chunk",
        span_start: null, span_end: null, url: null, heading_path: null,
      }).execute()

      await db.deleteFrom("conversations").where("id", "=", convId).execute()
      const messages = await db.selectFrom("messages")
        .select("id").where("conversation_id", "=", convId).execute()
      const citations = await db.selectFrom("message_citations")
        .select("ord").where("message_id", "=", msgId).execute()
      expect(messages).toEqual([])
      expect(citations).toEqual([])
    })
  })
})

describe.skipIf(DB_CONFIGURED)("chat persistence (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})

void pool
//#endregion
