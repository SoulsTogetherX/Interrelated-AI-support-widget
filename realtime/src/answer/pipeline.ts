//#region Imports
import type { Kysely } from "kysely"

import { newId } from "@shared/utils/ids"
import { parseAnswerText, ANSWER_JSON_SCHEMA } from "@shared/grounding/claims"
import { verifyClaims, displayableClaims } from "@shared/grounding/verify"
import type { VerifiedClaim } from "@shared/grounding/verify"
import type { AnswerEvent } from "@shared/grounding/events"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { LLMProvider } from "@providers/llm/types"

import type { Database } from "@/db/schema"
import { hybridSearch } from "@/retrieval/search"
import type { RetrievedChunk } from "@/retrieval/search"
import { evaluateGroundedness, DEFAULT_MAX_DISTANCE } from "@/answer/gate"
import { buildAnswerMessages, buildRetryMessages } from "@/answer/prompt"
//#endregion

//#region Type Defs
/**
 * The grounded answer pipeline (DATAFLOW.md §5) — the orchestration M2
 * exists for: retrieve → gate → prompt → stream → parse (one retry) →
 * verify → strip → persist → emit. Today it is driven by tests and the
 * `npm run ask` CLI; the SSE route (M2.5) becomes the production caller,
 * deliberately AFTER widget session auth exists, so an unauthenticated
 * LLM-spending route never reaches the auto-deploying dev branch.
 *
 * Events are emitted through `onEvent` in the order the SSE stream will
 * send them (meta → claims/refusal → done); the route will serialize each
 * one as-is. Verification currently happens after the full response is
 * collected — the claim-granular protocol (shared/grounding/events.ts)
 * is what lets an incremental parser later move each claim's emission
 * earlier without any protocol change.
 */
interface AnswerPipelineOptions {
  db: Kysely<Database>
  embedder: EmbeddingProvider
  llm: LLMProvider
  orgId: string
  /** Widget-generated anonymous visitor id — becomes conversations.visitor_id. */
  visitorId: string
  /** Continue an existing thread; omitted → a new conversation is created.
   *  Must belong to orgId — a mismatch throws rather than cross-pollinating
   *  tenants. */
  conversationId?: string
  question: string
  /** Groundedness threshold override (see gate.ts for the default's story). */
  maxDistance?: number
  k?: number
  signal?: AbortSignal
  onEvent?: (event: AnswerEvent) => void
}

interface AnswerResult {
  conversationId: string
  /** Null exactly when the pipeline threw before persisting an answer —
   *  callers see this only in error paths. */
  messageId: string
  refused: boolean
  /** What the visitor sees: verified claims joined, or a fallback text. */
  content: string
  /** Every claim with its verdict — including the stripped ones. */
  claims: VerifiedClaim[]
  ttftMs: number | null
  totalMs: number
}

/** Thrown when the model failed the JSON contract twice (initial + the one
 *  retry). The visitor message is already persisted; no assistant row is
 *  written — a transient model failure is not conversation history. */
class AnswerSchemaError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`model failed the answer contract after retry: ${errors.join("; ")}`)
    this.name = "AnswerSchemaError"
  }
}
//#endregion

//#region Constants
/** Fallback texts, constants until orgs can customize them (M3). Two, not
 *  one, because they mean different things in the metrics: REFUSAL_TEXT is
 *  the gate declining BEFORE the model ran (refused = true);
 *  NOTHING_VERIFIED_TEXT is the model answering and verification stripping
 *  everything (refused = false, strip rate 100%). */
const REFUSAL_TEXT = "I don't have enough information in the documentation to answer that confidently."
const NOTHING_VERIFIED_TEXT = "I couldn't verify an answer to that from the documentation."

/** Cap on generated tokens. Answers are a handful of claims (~50–100 tokens
 *  each in JSON); 1024 gives headroom without letting a runaway generation
 *  spend a tenant's quota on one question. length-cutoffs surface as parse
 *  failures and are counted by the schema-violation metric. */
const MAX_ANSWER_TOKENS = 1024
//#endregion

//#region Helpers
/** Collects a provider stream into its full text, recording time-to-first-
 *  delta. TTFT is measured HERE (not in providers) so every provider is
 *  measured identically — it is a headline metric and must be comparable. */
async function collectStream(
  llm: LLMProvider,
  request: Parameters<LLMProvider["stream"]>[0],
  startedAt: number,
): Promise<{ text: string; ttftMs: number | null }> {
  let text = ""
  let ttftMs: number | null = null
  for await (const event of llm.stream(request)) {
    if (event.type === "delta") {
      if (ttftMs === null && event.text.length > 0) ttftMs = Date.now() - startedAt
      text += event.text
    }
  }
  return { text, ttftMs }
}
//#endregion

//#region Pipeline
async function answerQuestion(options: AnswerPipelineOptions): Promise<AnswerResult> {
  const { db, embedder, llm, orgId, question } = options
  const emit = options.onEvent ?? (() => {})
  const startedAt = Date.now()

  if (question.trim().length === 0) throw new Error("question must not be blank")

  // ── Conversation ─────────────────────────────────────────────────────────
  // Validated against the org BEFORE anything is written: a conversation id
  // is client-supplied input, and accepting a foreign org's id here would be
  // a cross-tenant write.
  let conversationId = options.conversationId
  if (conversationId !== undefined) {
    const existing = await db.selectFrom("conversations")
      .select(["id"]).where("id", "=", conversationId).where("org_id", "=", orgId)
      .executeTakeFirst()
    if (!existing) throw new Error("conversation not found for this organization")
  } else {
    conversationId = newId("con")
    await db.insertInto("conversations")
      .values({ id: conversationId, org_id: orgId, visitor_id: options.visitorId })
      .execute()
  }

  // The visitor's message is history the moment it is asked — persisted
  // before retrieval so a model failure never erases the question. The
  // recency bump rides along here (not only with the answer) so a thread
  // whose answer FAILED still surfaces at the top of the dashboard list —
  // that is precisely the conversation a human should look at.
  await db.insertInto("messages").values({
    id: newId("msg"),
    conversation_id: conversationId,
    org_id: orgId,
    role: "visitor",
    content: question,
  }).execute()
  await db.updateTable("conversations")
    .set({ last_message_at: new Date() })
    .where("id", "=", conversationId)
    .execute()

  const messageId = newId("msg")
  emit({ type: "meta", conversationId, messageId })

  // ── Retrieve and gate ────────────────────────────────────────────────────
  const [queryVector] = await embedder.embed([question])
  const retrieved = await hybridSearch(db, {
    orgId,
    queryText: question,
    queryVector: queryVector!,
    model: embedder.model,
    ...(options.k !== undefined ? { k: options.k } : {}),
  })
  const gate = evaluateGroundedness(retrieved, options.maxDistance ?? DEFAULT_MAX_DISTANCE)

  if (gate.refuse) {
    // Refusal is an ANSWER (the honest one), so it persists like one:
    // refused = true, the gate signal recorded, model NULL because no model
    // ran — zero tokens is the point of gating before the call.
    const totalMs = Date.now() - startedAt
    await persistAssistantMessage(db, {
      messageId, conversationId, orgId,
      content: REFUSAL_TEXT, model: null, refused: true,
      retrievalScore: gate.signal, ttftMs: null, totalMs,
      citations: [], retrieved,
    })
    emit({ type: "refusal", text: REFUSAL_TEXT })
    emit({ type: "done", claimsTotal: 0, claimsShown: 0 })
    return {
      conversationId, messageId, refused: true,
      content: REFUSAL_TEXT, claims: [], ttftMs: null, totalMs,
    }
  }

  // ── Generate, parse, one retry ───────────────────────────────────────────
  const persona = await db.selectFrom("organizations")
    .select("system_persona").where("id", "=", orgId).executeTakeFirstOrThrow()
  const messages = buildAnswerMessages({
    question, retrieved, persona: persona.system_persona,
  })
  const baseRequest = {
    temperature: 0,
    maxTokens: MAX_ANSWER_TOKENS,
    responseSchema: ANSWER_JSON_SCHEMA,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }

  const first = await collectStream(llm, { ...baseRequest, messages }, startedAt)
  let ttftMs = first.ttftMs
  let parsed = parseAnswerText(first.text)
  if (!parsed.ok) {
    // One retry with the full error list (see prompt.ts for why exactly
    // one). TTFT keeps the FIRST attempt's value: the visitor has been
    // waiting since the original question, and that is the honest number.
    const retry = await collectStream(
      llm,
      { ...baseRequest, messages: buildRetryMessages(messages, first.text, parsed.errors) },
      startedAt,
    )
    ttftMs = ttftMs ?? retry.ttftMs
    parsed = parseAnswerText(retry.text)
    if (!parsed.ok) throw new AnswerSchemaError(parsed.errors)
  }

  // ── Verify, strip, persist ───────────────────────────────────────────────
  const verified = verifyClaims(
    parsed.payload.claims,
    retrieved.map((chunk) => ({ id: chunk.chunkId, text: chunk.text })),
  )
  const shown = displayableClaims(verified)
  const content = shown.length > 0
    ? shown.map((claim) => claim.text).join("\n\n")
    : NOTHING_VERIFIED_TEXT

  const totalMs = Date.now() - startedAt
  await persistAssistantMessage(db, {
    messageId, conversationId, orgId,
    content, model: llm.model, refused: false,
    retrievalScore: gate.signal, ttftMs, totalMs,
    citations: verified, retrieved,
  })

  if (shown.length === 0) {
    emit({ type: "refusal", text: NOTHING_VERIFIED_TEXT })
  } else {
    const retrievedById = new Map(retrieved.map((chunk) => [chunk.chunkId, chunk]))
    shown.forEach((claim, ord) => {
      const source = retrievedById.get(claim.chunkId)
      emit({
        type: "claim", ord, text: claim.text,
        url: source?.url ?? null, headingPath: source?.headingPath ?? null,
      })
    })
  }
  emit({ type: "done", claimsTotal: verified.length, claimsShown: shown.length })

  return {
    conversationId, messageId, refused: false,
    content, claims: verified, ttftMs, totalMs,
  }
}

/** One transaction for the assistant message, ALL its citation verdicts
 *  (stripped ones included — they are the strip-rate's raw data), and the
 *  conversation's recency bump. Atomic so a crash can never persist an
 *  answer without its verdicts — the verdicts are the audit trail that
 *  makes the answer trustworthy. */
async function persistAssistantMessage(db: Kysely<Database>, row: {
  messageId: string
  conversationId: string
  orgId: string
  content: string
  model: string | null
  refused: boolean
  retrievalScore: number | null
  ttftMs: number | null
  totalMs: number
  citations: readonly VerifiedClaim[]
  retrieved: readonly RetrievedChunk[]
}): Promise<void> {
  const retrievedById = new Map(row.retrieved.map((chunk) => [chunk.chunkId, chunk]))
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("messages").values({
      id: row.messageId,
      conversation_id: row.conversationId,
      org_id: row.orgId,
      role: "assistant",
      content: row.content,
      model: row.model,
      refused: row.refused,
      retrieval_score: row.retrievalScore,
      ttft_ms: row.ttftMs,
      total_ms: row.totalMs,
    }).execute()

    if (row.citations.length > 0) {
      await trx.insertInto("message_citations").values(
        row.citations.map((entry, ord) => {
          const source = retrievedById.get(entry.claim.chunkId)
          const verifiedSpan = entry.verdict.status === "verified" ? entry.verdict : null
          return {
            message_id: row.messageId,
            ord,
            chunk_id: entry.claim.chunkId,
            claim_text: entry.claim.text,
            quote: entry.claim.quote,
            verdict: entry.verdict.status,
            span_start: verifiedSpan ? verifiedSpan.start : null,
            span_end: verifiedSpan ? verifiedSpan.end : null,
            // Snapshots — the citation must outlive the chunk (§3.3.2).
            // unknown_chunk claims have no source to snapshot; nulls are
            // the honest value.
            url: source?.url ?? null,
            heading_path: source?.headingPath ?? null,
          }
        }),
      ).execute()
    }

    await trx.updateTable("conversations")
      .set({ last_message_at: new Date() })
      .where("id", "=", row.conversationId)
      .execute()
  })
}
//#endregion

//#region Exports
export { answerQuestion, AnswerSchemaError, REFUSAL_TEXT, NOTHING_VERIFIED_TEXT }
export type { AnswerPipelineOptions, AnswerResult }
//#endregion
