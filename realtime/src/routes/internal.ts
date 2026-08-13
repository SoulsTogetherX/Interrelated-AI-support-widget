//#region Why this surface
// The server-to-server API the dashboard proxies through — the ONLY surface
// that ever handles a tenant provider key in plaintext, and only in
// transit: web POSTs the pasted key over TLS, this file tests it against
// the real provider, encrypts it (credentials/vault.ts), and stores it.
// Browsers never call these routes; there is deliberately no CORS here, so
// a browser cannot even read a response cross-origin.
//
// Auth is ONE shared secret (INTERNAL_API_SECRET, set identically on
// Render and Vercel), compared in constant time. A shared secret rather
// than signed requests because both ends are our own servers over TLS —
// the ticket ceremony (M4's socket auth) buys nothing between two
// backends holding the same env var. Every failure is a uniform 401 with
// an empty body: which part was wrong is not information this surface
// shares.
//
// The whole surface MOUNTS ONLY when the secret is configured (app.ts):
// a deployment that has not opted in has these routes 404 like any other
// unknown path — indistinguishable from not existing, which is exactly the
// posture an admin surface should have. The smoke probe asserts the 404-
// when-unconfigured state.
//#endregion

//#region Imports
import { timingSafeEqual } from "node:crypto"

import { newId, isId } from "@shared/utils/ids"

import { sql } from "kysely"

import { db } from "@/db/pool"
import { assertPublicUrl } from "@/ingest/safeFetch"
import {
  buildEmbeddingProvider,
  buildGenerationProvider,
  checkCredentialInput,
  effectiveEmbeddingModel,
  testEmbeddingRoundTrip,
  testGenerationRoundTrip,
} from "@/credentials/validate"
import { encryptProviderKey, keySuffix } from "@/credentials/vault"
import { mintHandoffTicket } from "@/handoff/ticket"
import { closeHandoff } from "@/handoff/escalate"

import type { Transaction } from "kysely"
import type { Express, Request, Response, NextFunction } from "express"
import type { Database } from "@/db/schema"
import type { UrlVet } from "@/credentials/validate"
//#endregion

//#region Types
interface InternalRouteOptions {
  /** The shared secret. app.ts only mounts this surface when present;
   *  server.ts refuses a secret shorter than 32 chars at boot. */
  secret: string
  /** The widget token secret, from which handoff-ticket keys are derived
   *  (M4.2). Same value the socket verifies with — passed rather than read
   *  from env here so tests can drive both ends deterministically. */
  ticketSecret: string
  /** Injectable URL vet, applied to credential base URLs AND source
   *  locations alike (tests reach loopback fakes; production default
   *  rejects anything non-public). */
  vetBaseUrl?: UrlVet
  /** Round-trip timeout override for tests. */
  testTimeoutMs?: number
  /** Called after a source is enqueued — server.ts wires this to the
   *  ingest worker's wake(), which is the whole production scheduling
   *  mechanism (wake-driven mode has no poll to fall back on). */
  onEnqueue?: () => void
  /** Called after a handoff is closed — server.ts wires this to the socket
   *  server's endRoom(), so the two people in the conversation are TOLD it
   *  ended rather than left to infer it from a dropped connection (M4.6).
   *  Optional for the same reason onEnqueue is: a stack without a socket
   *  server still has a working close. */
  onHandoffClosed?: (conversationId: string) => void
}
//#endregion

//#region Auth
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  // Length inequality returns early, which leaks only the LENGTH of the
  // secret — 32+ random chars make that worthless.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
//#endregion

//#region Re-indexing
/**
 * Queues a fresh crawl of every source an org has, and returns how many.
 *
 * Why an embedding-credential change MUST do this: chunk vectors are stored
 * per (chunk, model), and retrieval's dense arm filters `model = …`. Change
 * the embedding model and the existing corpus does not become wrong — it
 * becomes INVISIBLE, and the groundedness gate then refuses every question
 * because no dense evidence exists (answer/gate.ts fails closed on
 * lexical-only retrievals, by design). That reads to a tenant as "the
 * widget stopped working", which is the worst way to learn about a
 * consequence the product could simply handle.
 *
 * The re-crawl is what pays for it, together with the worker's short-circuit
 * fix (§3.10.5): unchanged pages are re-embedded — and ONLY re-embedded —
 * when their chunks have no vectors under the current model.
 *
 * Sources that already have work queued are skipped (a second job would
 * crawl the same site twice for one outcome), and uploads are skipped
 * because the worker fails them by design — manufacturing a job that is
 * guaranteed to fail is not progress.
 */
async function enqueueReindex(
  trx: Transaction<Database>,
  orgId: string,
): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    SELECT s.id FROM sources s
    WHERE s.org_id = ${orgId}
      AND s.kind <> 'upload'
      AND NOT EXISTS (
        SELECT 1 FROM ingest_jobs j
        WHERE j.source_id = s.id AND j.state IN ('queued', 'running')
      )
  `.execute(trx)
  if (rows.length === 0) return 0
  await trx
    .insertInto("ingest_jobs")
    .values(rows.map((row) => ({ id: newId("job"), org_id: orgId, source_id: row.id })))
    .execute()
  return rows.length
}
//#endregion

//#region Routes
function configureInternalRoutes(app: Express, options: InternalRouteOptions): void {
  const vet = options.vetBaseUrl

  const requireSecret = (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.header("x-internal-secret")
    if (typeof supplied !== "string" || !constantTimeEquals(supplied, options.secret)) {
      res.status(401).end()
      return
    }
    next()
  }

  // Resolve + guard the org param once for every route below; the verified
  // id rides res.locals so handlers never re-read (or re-trust) req.params.
  const requireOrg = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.params.orgId
    const orgId = typeof raw === "string" ? raw : ""
    if (!isId("org", orgId)) {
      res.status(404).end()
      return
    }
    const org = await db
      .selectFrom("organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst()
    if (!org) {
      res.status(404).end()
      return
    }
    res.locals.orgId = orgId
    next()
  }

  /** Save (or test) a credential. `save: false` runs the identical
   *  validation + live round-trip and stores NOTHING — the dashboard's
   *  Test button, sharing one code path with Save so the two can never
   *  drift on what "valid" means. */
  app.post(
    "/internal/orgs/:orgId/credentials",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const checked = await checkCredentialInput(body, vet)
      if (!checked.ok) {
        res.status(422).json({ ok: false, error: checked.error })
        return
      }

      const input = checked.value
      // One branch, two roles: both build an adapter from the same checked
      // input and both spend one real call on the tenant's provider before
      // anything is stored. The embedding trip additionally reports the
      // dimension it observed — see testEmbeddingRoundTrip for why that
      // number is worth a column.
      const trip =
        input.role === "generation"
          ? await testGenerationRoundTrip(buildGenerationProvider(input), options.testTimeoutMs)
          : await testEmbeddingRoundTrip(buildEmbeddingProvider(input), options.testTimeoutMs)
      if (!trip.ok) {
        res.status(422).json({ ok: false, error: trip.error })
        return
      }

      const summary =
        trip.dim !== undefined
          ? `${trip.model}, ${trip.dim}-d, ${trip.latencyMs}ms`
          : `${trip.model}, ${trip.latencyMs}ms`
      if (body.save === false) {
        res.json({
          ok: true, saved: false, model: trip.model, latencyMs: trip.latencyMs,
          ...(trip.dim !== undefined ? { dim: trip.dim } : {}),
        })
        return
      }

      const id = newId("prv")
      let reindexed = 0
      // Replace-by-delete inside one transaction: the UNIQUE(org_id, role)
      // row simply ceases to exist for the old key (§3.3.3 explains
      // why superseded ciphertexts are not retained).
      await db.transaction().execute(async (trx) => {
        const previous = await trx
          .selectFrom("org_provider_credentials")
          .select(["provider", "model"])
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", input.role)
          .executeTakeFirst()
        await trx
          .deleteFrom("org_provider_credentials")
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", input.role)
          .execute()
        await trx
          .insertInto("org_provider_credentials")
          .values({
            id,
            org_id: res.locals.orgId as string,
            role: input.role,
            provider: input.provider,
            model: input.model ?? null,
            base_url: input.baseUrl ?? null,
            dim: trip.dim ?? null,
            key_ciphertext: input.apiKey !== undefined ? encryptProviderKey(input.apiKey, id) : null,
            key_suffix: input.apiKey !== undefined ? keySuffix(input.apiKey) : null,
            last_validated_at: new Date(),
            last_validation: summary,
          })
          .execute()

        // A new embedding MODEL orphans everything already indexed (the
        // dense arm filters on model), so the corpus is re-queued in the
        // same transaction that changed the credential — never one without
        // the other. An unchanged model (re-pasting a rotated key for the
        // same model) costs nothing.
        if (input.role === "embedding") {
          const previousModel =
            previous !== undefined && previous.provider !== "anthropic"
              ? effectiveEmbeddingModel(previous.provider, previous.model)
              : null
          if (previousModel !== trip.model) {
            reindexed = await enqueueReindex(trx, res.locals.orgId as string)
          }
        }
      })
      if (reindexed > 0) options.onEnqueue?.()

      res.json({
        ok: true,
        saved: true,
        model: trip.model,
        latencyMs: trip.latencyMs,
        ...(trip.dim !== undefined ? { dim: trip.dim } : {}),
        reindexed,
        suffix: input.apiKey !== undefined ? keySuffix(input.apiKey) : null,
      })
    },
  )

  /** Credential status for the dashboard. Returns EVERYTHING EXCEPT key
   *  material — no ciphertext, no plaintext, only the stored display
   *  suffix. The read-back denial test lives on this route. */
  app.get(
    "/internal/orgs/:orgId/credentials",
    requireSecret,
    requireOrg,
    async (_req: Request, res: Response) => {
      const rows = await db
        .selectFrom("org_provider_credentials")
        .select([
          "role",
          "provider",
          "model",
          "base_url",
          "dim",
          "key_suffix",
          "last_validated_at",
          "last_validation",
        ])
        .where("org_id", "=", res.locals.orgId as string)
        .orderBy("role")
        .execute()
      res.json({ ok: true, credentials: rows })
    },
  )

  /** Connect a source and enqueue its first crawl (M3.6). The location is
   *  a tenant-typed URL this server will fetch — the same SSRF shape as
   *  credential base URLs, vetted with the same seam (and re-vetted at
   *  every actual fetch by safeFetch, which owns the connect-time layer).
   *  After the transaction commits, onEnqueue wakes the worker: in
   *  production the enqueue IS the scheduler. */
  app.post(
    "/internal/orgs/:orgId/sources",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Record<string, unknown>

      if (b.kind !== "url" && b.kind !== "sitemap") {
        res.status(422).json({ ok: false, error: "kind must be 'url' or 'sitemap'." })
        return
      }
      const location = typeof b.location === "string" ? b.location.trim() : ""
      let parsed: URL
      try {
        parsed = new URL(location)
      } catch {
        res.status(422).json({ ok: false, error: "location is not a valid URL." })
        return
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(422).json({ ok: false, error: "location must be http(s)." })
        return
      }
      if (parsed.username !== "" || parsed.password !== "") {
        res.status(422).json({ ok: false, error: "location must not embed credentials." })
        return
      }
      try {
        await (vet ?? ((url: URL) => assertPublicUrl(url)))(parsed)
      } catch {
        res.status(422).json({ ok: false, error: "location must resolve to a public address." })
        return
      }

      let crawlDepth: number | undefined
      if (b.crawlDepth !== undefined) {
        // Mirrors the schema CHECK (≤ 3) so the tenant sees a sentence, not
        // a constraint violation.
        if (typeof b.crawlDepth !== "number" || !Number.isInteger(b.crawlDepth) || b.crawlDepth < 0 || b.crawlDepth > 3) {
          res.status(422).json({ ok: false, error: "crawlDepth must be an integer from 0 to 3." })
          return
        }
        crawlDepth = b.crawlDepth
      }

      const sourceId = newId("src")
      const jobId = newId("job")
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("sources").values({
          id: sourceId,
          org_id: res.locals.orgId as string,
          kind: b.kind as "url" | "sitemap",
          location: parsed.href,
          ...(crawlDepth !== undefined ? { crawl_depth: crawlDepth } : {}),
        }).execute()
        await trx.insertInto("ingest_jobs").values({
          id: jobId,
          org_id: res.locals.orgId as string,
          source_id: sourceId,
        }).execute()
      })
      options.onEnqueue?.()

      res.json({ ok: true, sourceId, jobId })
    },
  )

  /**
   * Close a handoff (M4.6) — the agent is done, and the conversation goes
   * back to the bot.
   *
   * Through realtime rather than written straight from web (which is what
   * §9.11's allowlist does, holding no secret and needing no process state)
   * because this change has an in-process consequence: the socket rooms
   * live HERE, so closing and telling the two people in the room have to
   * happen in the same place. The same argument as the source enqueue
   * waking the worker.
   *
   * Membership is re-established the way the ticket route does it: web
   * already checked, and this route does not take web's word for it.
   */
  app.post(
    "/internal/orgs/:orgId/handoffs/:conversationId/close",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      // Same stance as the role param below: a path segment is untrusted
      // input until isId has looked at it, and Express 5 types it wide.
      const conversationId = typeof req.params.conversationId === "string"
        ? req.params.conversationId
        : ""
      const b = (req.body ?? {}) as Record<string, unknown>
      const userId = typeof b.userId === "string" ? b.userId : ""
      if (!isId("con", conversationId) || !isId("usr", userId)) {
        res.status(422).json({ ok: false, error: "conversationId and userId are required." })
        return
      }

      const member = await db
        .selectFrom("org_members")
        .select("user_id")
        .where("org_id", "=", res.locals.orgId as string)
        .where("user_id", "=", userId)
        .executeTakeFirst()
      if (!member) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const outcome = await closeHandoff(db, {
        orgId: res.locals.orgId as string,
        conversationId,
        closedBy: userId,
      })
      if (!outcome.ok) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }
      // Only when a row actually changed: a second close must not hang up
      // on a room that a LATER escalation of the same conversation has
      // since filled.
      if (outcome.closed) options.onHandoffClosed?.(conversationId)
      res.json({ ok: true, closed: outcome.closed })
    },
  )

  /**
   * Mint an AGENT's handoff-socket ticket (M4.2). The dashboard cannot sign
   * one itself — the ticket key is derived from realtime's token secret,
   * which web has no business holding — so a Server Action asks for one
   * here, having already established the user's session.
   *
   * This route is the only thing in the system that can mint an agent
   * ticket, so it re-establishes what web claims rather than trusting it:
   * the user must be a MEMBER of the org (either role — reading and
   * answering conversations is the agent job), and the conversation must
   * belong to that org and have a handoff still open. The socket's upgrade
   * check repeats the last part; this one keeps a ticket from existing at
   * all for a conversation nobody is waiting on.
   */
  app.post(
    "/internal/orgs/:orgId/handoff-tickets",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const conversationId = typeof b.conversationId === "string" ? b.conversationId : ""
      const userId = typeof b.userId === "string" ? b.userId : ""
      if (!isId("con", conversationId) || !isId("usr", userId)) {
        res.status(422).json({ ok: false, error: "conversationId and userId are required." })
        return
      }

      const member = await db
        .selectFrom("org_members")
        .select("user_id")
        .where("org_id", "=", res.locals.orgId as string)
        .where("user_id", "=", userId)
        .executeTakeFirst()
      if (!member) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const open = await db
        .selectFrom("handoff_sessions")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("org_id", "=", res.locals.orgId as string)
        .where("status", "!=", "closed")
        .executeTakeFirst()
      if (!open) {
        res.status(404).json({ ok: false, error: "not found" })
        return
      }

      const minted = mintHandoffTicket(
        { con: conversationId, org: res.locals.orgId as string, role: "agent", sub: userId },
        options.ticketSecret,
      )
      res.json({ ok: true, ticket: minted.ticket, expiresAt: minted.expiresAt })
    },
  )

  /** Remove a role's credential. Hard delete — see §3.3.3. */
  app.delete(
    "/internal/orgs/:orgId/credentials/:role",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const role = typeof req.params.role === "string" ? req.params.role : ""
      if (role !== "generation" && role !== "embedding") {
        res.status(404).end()
        return
      }
      let reindexed = 0
      await db.transaction().execute(async (trx) => {
        const removed = await trx
          .deleteFrom("org_provider_credentials")
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", role)
          .executeTakeFirst()
        // Removing an embedding credential reverts the org to the
        // app-level model, which is a model CHANGE like any other — the
        // corpus has to follow it or the widget goes quiet. Only when a row
        // was actually deleted: a no-op delete must not queue crawls.
        if (role === "embedding" && Number(removed.numDeletedRows) > 0) {
          reindexed = await enqueueReindex(trx, res.locals.orgId as string)
        }
      })
      if (reindexed > 0) options.onEnqueue?.()
      res.json({ ok: true, reindexed })
    },
  )
}
//#endregion

//#region Exports
export { configureInternalRoutes }
export type { InternalRouteOptions }
//#endregion
