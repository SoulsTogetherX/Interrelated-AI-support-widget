//#region Imports
import type { Express, Request, Response } from "express"

import { isId } from "@shared/utils/ids"
import { answerQuestion } from "@/answer/pipeline"
import { resolveEmbeddingProvider, resolveGenerationProvider } from "@/credentials/resolve"
import { getDailyQuota } from "@/usage/daily"
//#endregion

import { MAX_QUESTION_CHARS, sseWrite } from "./shared"
import type { WidgetContext, WidgetRouteOptions } from "./types"

//#region Route
/** The grounded-answer SSE route (§3.18, DATAFLOW §5). Handler body
 *  verbatim from the pre-split file. */
function registerChatRoute(app: Express, options: WidgetRouteOptions, ctx: WidgetContext): void {
  const { chatIpLimiter, chatVisitorLimiter, authenticate } = ctx

  // ── Chat: token-authenticated SSE ────────────────────────────────────────
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
  app.post("/v1/widget/chat", async (req: Request, res: Response) => {
    try {
      const session = authenticate(req, res)
      if (session === null) return
      const origin = session.origin

      // Rate limits AFTER auth (so their 429s carry CORS headers and the
      // widget can render a "one moment" state) and BEFORE any real work.
      if (
        !chatIpLimiter.take(req.ip ?? "unknown") ||
        !chatVisitorLimiter.take(`${session.org}:${session.visitor}`)
      ) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      // The daily ceiling, checked BEFORE the model call — the plan's
      // promise that the worst case is a stopped widget, never a surprise
      // bill. Since M5.3 the number comes from the org's PLAN and the count
      // from usage_daily, so this is one primary-key-shaped read whose cost
      // does not grow with the tenant's traffic (it used to scan the day's
      // messages, which ran before EVERY question and got slower the more
      // successful the customer became).
      //
      // The env override can only TIGHTEN the plan's cap, never widen it:
      // one mistyped variable that handed every tenant an unlimited
      // allowance is precisely the failure a quota exists to prevent.
      const quota = await getDailyQuota(options.db, session.org, {
        overrideLimit: options.dailyAnswerCap,
      })
      if (quota?.exceeded) {
        res.status(429).json({ error: "daily quota reached" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const question = typeof body["question"] === "string" ? body["question"].trim() : ""
      if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
        res.status(400).json({ error: `question must be 1-${MAX_QUESTION_CHARS} characters` })
        return
      }
      const conversationId = body["conversationId"]
      if (
        conversationId !== undefined &&
        (typeof conversationId !== "string" || !isId("con", conversationId))
      ) {
        res.status(400).json({ error: "invalid conversationId" })
        return
      }

      // SSE begins — headers flush NOW so time-to-first-byte is paid
      // before retrieval, not after. Every failure past this point is an
      // in-stream {type:"error"} event, not a status code.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        // Render sits us behind a proxy; without this hint it may buffer
        // the stream and turn token-by-token into all-at-once.
        "x-accel-buffering": "no",
        "access-control-allow-origin": origin,
        vary: "origin",
      })

      // A closed tab must stop the token spend mid-generation. Kept as the
      // route's OWN controller rather than folded into the pipeline's
      // deadline signal, because the catch below needs to tell the two
      // apart: a visitor who left gets silence (nobody is listening), while
      // a deadline that fired mid-answer leaves a visitor still staring at
      // the stream — they get the terminal error event like any other
      // failure, so the widget can recover their input.
      const aborter = new AbortController()
      req.on("close", () => aborter.abort())

      try {
        // Per-org BYO generation (M3.5): the org's saved credential decides
        // which model answers — decrypted here, inside realtime, for the
        // lifetime of this request only. The app-level llm (the env-selected
        // mock in every keyless stack) is the FALLBACK for orgs without a
        // credential, which is what keeps the demo org and CI keyless. A
        // resolve failure lands in the catch below: one opaque error event,
        // the truth in the server log.
        //
        // The embedding credential resolves the same way and for a
        // stricter reason (M3.6b): the question must be embedded by the
        // model that embedded the org's CHUNKS, or the dense arm searches
        // an empty space and the gate refuses everything. The ingest worker
        // resolves the identical row, so that agreement holds by
        // construction rather than by two settings matching.
        const [orgLLM, orgEmbedder] = await Promise.all([
          resolveGenerationProvider(options.db, session.org),
          resolveEmbeddingProvider(options.db, session.org),
        ])
        await answerQuestion({
          db: options.db,
          embedder: orgEmbedder ?? options.embedder,
          llm: orgLLM ?? options.llm,
          // Only when the org has NO credential of its own — see the option's
          // comment. A tenant's provider failing is the tenant's to see.
          ...(orgLLM === null && options.llmFallback !== undefined
            ? { llmFallback: options.llmFallback }
            : {}),
          orgId: session.org,
          visitorId: session.visitor,
          question,
          ...(conversationId !== undefined ? { conversationId: conversationId } : {}),
          ...(options.maxDistance !== undefined ? { maxDistance: options.maxDistance } : {}),
          ...(options.answerDeadlineMs !== undefined
            ? { deadlineMs: options.answerDeadlineMs }
            : {}),
          signal: aborter.signal,
          onEvent: (event) => sseWrite(res, event),
        })
      } catch (err) {
        if (!aborter.signal.aborted) {
          // Model contract failure, provider outage, hijacked-conversation
          // probe — the stream gets one opaque error event (details on a
          // public stream are reconnaissance) and the log gets the truth.
          console.error("[widget] answer failed:", err instanceof Error ? err.message : err)
          sseWrite(res, { type: "error" })
        }
      }
      res.end()
    } catch (err) {
      console.error("[widget] chat route failed:", err)
      if (!res.headersSent) res.status(500).json({ error: "internal error" })
      else res.end()
    }
  })
}
//#endregion

//#region Exports
export { registerChatRoute }
//#endregion
