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

import express from "express"
import { sql } from "kysely"

import { db } from "@/db/pool"
import { assertPublicUrl } from "@/ingest/safeFetch"
import { parseResource, detectFormat } from "@/ingest/parsers"
import { PdfParseError } from "@/ingest/parsers/pdf"
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

//#region Upload body
/**
 * The largest file this surface accepts, and the same number the PDF parser
 * backstops at (§3.10.7) — one cap across the system rather than two that
 * could disagree about which one a tenant hit.
 *
 * It bounds two different things, and only one of them completely. Bytes in
 * flight, yes. Storage, no: migration 009 keeps the EXTRACTED TEXT, which for
 * a PDF is a small fraction of the file and for a plain-text upload is the
 * whole of it — so the honest ceiling on what an upload costs Neon's 0.5 GB
 * is this number, and it is stated in the README rather than implied.
 */
const UPLOAD_MAX_MB = 10
const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024

/** Every content type, because the browser's claim is an input to detection
 *  rather than a gate — magic bytes decide (parsers/index.ts), and a type
 *  allowlist here would refuse the PDF a misconfigured client sends as
 *  octet-stream while admitting nothing it could not already read. */
const uploadBody = express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES })
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
 * guaranteed to fail is not progress. The skip is decided by the read below
 * AND enforced by 008's one-live-job-per-source index with ON CONFLICT DO
 * NOTHING: a Re-crawl click landing between the read and the insert must not
 * turn a unique violation into a rolled-back credential save.
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
  const inserted = await trx
    .insertInto("ingest_jobs")
    .values(rows.map((row) => ({ id: newId("job"), org_id: orgId, source_id: row.id })))
    .onConflict((oc) => oc.column("source_id").where("state", "in", ["queued", "running"]).doNothing())
    .returning("id")
    .execute()
  return inserted.length
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
   * Upload a file as a source (M7.6b) — the surface the crawler was never
   * going to provide, and the last thing the README listed as not built.
   *
   * RAW BYTES, not multipart. The dashboard has already parsed the browser's
   * FormData (Next does it for a Server Action), so what it has is a buffer
   * and a name; asking it to re-encode that as multipart so this side could
   * decode it again would add a body-parser dependency to a service with
   * three, each of which earned its place — to move one string. The filename
   * rides a header, percent-encoded because HTTP header values are latin-1
   * and filenames are not.
   *
   * The parse happens HERE, in the request, and that is the decision worth
   * defending. It could have been the worker's job, one more thing the queue
   * does. But a parser's refusals are the most useful thing this route
   * produces — "this PDF is a scan, its content is pixels, run OCR first",
   * "it is password-protected" — and they are worth the most at the moment
   * the tenant pressed Upload with the file still in front of them, not
   * minutes later on a row that says failed. Parsing is also the cheap half:
   * CPU, bounded by the size cap. What the queue keeps is EMBEDDING, which is
   * external network measured in minutes for a large file — and the dashboard
   * runs on Vercel, whose functions cannot hold a request open that long.
   * So the split falls exactly where the control-plane/data-plane split
   * already falls: parse now, answer, embed in the worker.
   *
   * The bytes are never stored (migration 009 explains what is, and why the
   * text must be). Everything after this route is the ordinary ingest path:
   * source + job in one transaction, then the wake that IS the scheduler.
   */
  app.post(
    "/internal/orgs/:orgId/sources/upload",
    requireSecret,
    requireOrg,
    // The body parser is invoked by hand so its 413 is JSON like every other
    // refusal here, instead of Express's default HTML error page.
    (req: Request, res: Response, next: NextFunction) => {
      uploadBody(req, res, (err: unknown) => {
        if (err) {
          res.status(413).json({ ok: false, error: `The file is larger than ${UPLOAD_MAX_MB} MB.` })
          return
        }
        next()
      })
    },
    async (req: Request, res: Response) => {
      const rawName = req.header("x-upload-filename") ?? ""
      let filename = ""
      try {
        filename = decodeURIComponent(rawName).trim()
      } catch {
        // Malformed percent-encoding: treated as no name at all.
      }
      // Mirrors the schema CHECK so the tenant sees a sentence rather than a
      // constraint violation, and strips any path the browser sent with it —
      // a name is a label here, never a filesystem location.
      filename = filename.replace(/^.*[\\/]/, "")
      if (filename === "" || filename.length > 255) {
        res.status(422).json({ ok: false, error: "A file name of 1–255 characters is required." })
        return
      }

      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      if (body.byteLength === 0) {
        res.status(422).json({ ok: false, error: "The file is empty." })
        return
      }

      // The browser's claim about the type, which detection treats as one
      // input among several — magic bytes lead, so a PDF sent as text/plain
      // is still parsed as a PDF (parsers/index.ts).
      //
      // It rides its OWN header because the body's content-type is always
      // application/octet-stream on this hop: app.ts mounts express.json at
      // 64 KB for every route, and a customer uploading a .json file — an API
      // schema, an exported FAQ — would otherwise have it claimed and refused
      // by the JSON parser before this route ever ran. To this hop the file is
      // opaque bytes, which is what it is; what the browser called it is
      // metadata, and metadata travels beside the filename.
      const declared = (req.header("x-upload-content-type") ?? "").toLowerCase()
      const [bareType = "", ...params] = declared.split(";").map((p) => p.trim())
      const charsetParam = params.find((p) => p.startsWith("charset="))
      const resource = {
        url: filename,
        contentType: bareType === "application/octet-stream" ? "" : bareType,
        charset: charsetParam ? charsetParam.slice("charset=".length) : null,
        body,
      }

      let parsed
      try {
        parsed = await parseResource(resource)
      } catch (err) {
        // A parser that throws has a reason a tenant can act on — every
        // PdfParseError message is written to be read by one. Anything else
        // is a bug, and says only that.
        const message = err instanceof PdfParseError
          ? err.message
          : "The file could not be read."
        res.status(422).json({ ok: false, error: message[0]?.toUpperCase() + message.slice(1) + "." })
        return
      }

      // A file that parsed but holds nothing is refused rather than stored:
      // a source that is "ready" and answers nothing is the state a tenant
      // cannot debug. (A scanned PDF never reaches here — the parser refuses
      // it by name, with OCR in the sentence.)
      if (parsed.text.trim() === "" || parsed.blocks.length === 0) {
        res.status(422).json({ ok: false, error: "No text could be read from the file." })
        return
      }

      const sourceId = newId("src")
      const jobId = newId("job")
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("sources").values({
          id: sourceId,
          org_id: res.locals.orgId as string,
          kind: "upload",
          location: filename,
          // A file has no links to follow. The column defaults to 1, and a
          // depth on an upload would be a number that means nothing.
          crawl_depth: 0,
        }).execute()
        await trx.insertInto("source_uploads").values({
          source_id: sourceId,
          filename,
          format: detectFormat(resource),
          byte_size: body.byteLength,
          title: parsed.title,
          text: parsed.text,
          // Spans only — the text is not stored twice (migration 009).
          blocks: JSON.stringify(parsed.blocks.map((b) => ({
            kind: b.kind,
            ...(b.level !== undefined ? { level: b.level } : {}),
            charStart: b.charStart,
            charEnd: b.charEnd,
          }))),
        }).execute()
        await trx.insertInto("ingest_jobs").values({
          id: jobId,
          org_id: res.locals.orgId as string,
          source_id: sourceId,
        }).execute()
      })
      options.onEnqueue?.()

      res.json({
        ok: true,
        sourceId,
        jobId,
        filename,
        format: detectFormat(resource),
        title: parsed.title,
        // What the tenant gets to see about a file we no longer hold: how
        // much text came out of it, which is the only honest answer to "did
        // that work?" before the embedding has run.
        charCount: parsed.text.length,
      })
    },
  )

  /**
   * Re-crawl one source (M7.5) — the action the sources page's new visibility
   * exists for. Until now a source was crawled once, when connected, and
   * again only when the org's embedding model changed; a tenant who saw
   * "failed: nothing crawlable — disallowed by robots.txt" and fixed their
   * robots.txt, or whose docs simply changed, had nowhere to click.
   *
   * Through realtime rather than an INSERT from web for the enqueue route's
   * reason: the row is not the whole effect. The wake is, and the worker
   * lives here. Idempotent the cheap way — a source with a job already
   * queued or running answers `queued: false` and writes nothing, since a
   * second job would crawl the same site twice for one outcome (the
   * re-index helper above makes the same call). A source that is not this
   * org's, or does not exist, or is not even an id, is one 404 — the org
   * guard's stance, one level down.
   *
   * UPLOADS were refused here with a sentence until M7.6b, because the worker
   * failed them by design and manufacturing a job guaranteed to fail is not a
   * re-crawl. Migration 009 keeps an upload's extracted text, so re-ingesting
   * one is now both possible and worth having: an upload whose FIRST ingest
   * failed — a wrong embedding credential, a provider outage — otherwise left
   * the tenant nothing to click but "upload the file again". Nothing here
   * needs to know the difference; the worker reads the stored text where a
   * crawl would fetch. The dashboard calls the button "Re-index" for a file.
   */
  app.post(
    "/internal/orgs/:orgId/sources/:sourceId/recrawl",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const raw = req.params.sourceId
      const sourceId = typeof raw === "string" ? raw : ""
      if (!isId("src", sourceId)) {
        res.status(404).end()
        return
      }
      const source = await db
        .selectFrom("sources")
        .select("id")
        .where("id", "=", sourceId)
        .where("org_id", "=", res.locals.orgId as string)
        .executeTakeFirst()
      if (!source) {
        res.status(404).end()
        return
      }

      // One statement, no read before it: 008's partial unique index (one
      // live job per source) turns a concurrent second click into a
      // no-op the row count reports, instead of a second crawl.
      const jobId = newId("job")
      const inserted = await db
        .insertInto("ingest_jobs")
        .values({ id: jobId, org_id: res.locals.orgId as string, source_id: source.id })
        .onConflict((oc) => oc.column("source_id").where("state", "in", ["queued", "running"]).doNothing())
        .returning("id")
        .executeTakeFirst()
      if (inserted) options.onEnqueue?.()

      res.json(inserted ? { ok: true, queued: true, jobId } : { ok: true, queued: false })
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
