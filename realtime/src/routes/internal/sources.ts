//#region Imports

import { newId, isId } from "@shared/utils/ids"
import { planFor } from "@shared/billing/plans"

import express from "express"

import { db } from "@/db/pool"
import { assertPublicUrl } from "@/ingest/safeFetch"
import { parseResource, detectFormat } from "@/ingest/parsers"
import { PdfParseError } from "@/ingest/parsers/pdf"

import type { Kysely, Transaction } from "kysely"
import type { Express, Request, Response, NextFunction } from "express"
import type { Database } from "@/db/schema"
//#endregion

import type { InternalGuards, InternalRouteOptions } from "./types"

//#region Source limit (M8.5)
/**
 * The plan's source ceiling, enforced where sources are created (M8.5).
 * shared/billing/plans.ts had carried the number since M5.3 with a comment
 * admitting it was "not yet enforced — stating a limit we do not check
 * would be worse than stating none"; the billing page shows it to every
 * tenant, so from M5.4 to here the product was in exactly that worse state.
 *
 * Enforced HERE rather than in web for the daily cap's reason (§3.18):
 * realtime owns enforcement, and web is a caller, not a gate. The check
 * runs inside the create transaction with the ORG ROW LOCKED (`FOR
 * UPDATE`), because a cap held by count-then-insert races: two concurrent
 * creates would both count below the limit and both land. Locking the org
 * row serializes source creation per org — a queue of one row per tenant,
 * held for the milliseconds a count and two inserts take, on an operation a
 * tenant performs a handful of times ever. Every source row counts, failed
 * ones included: they hold a slot a tenant can see and can now delete,
 * which is why the delete route below lands in the same increment — a cap
 * on an add-only resource would spend a free tenant's single slot forever
 * on their first typo.
 */
class SourceLimitError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
    readonly planName: string,
  ) {
    super(`source limit reached: ${used}/${limit} on ${planName}`)
    this.name = "SourceLimitError"
  }
}

/** Counts inside the caller's transaction (locking) or bare (the upload
 *  route's cheap pre-parse check, where the transaction re-checks — the
 *  same both-halves shape as its 413-before-parse). */
async function assertSourceCapacity(
  db: Kysely<Database> | Transaction<Database>,
  orgId: string,
): Promise<void> {
  const org = await db
    .selectFrom("organizations")
    .select("plan")
    .where("id", "=", orgId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const plan = planFor(org.plan)
  const counted = await db
    .selectFrom("sources")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .executeTakeFirst()
  const used = Number(counted?.n ?? 0)
  if (used >= plan.sources) throw new SourceLimitError(used, plan.sources, plan.name)
}

/** The refusal a tenant reads. Names the plan, the count, and both ways
 *  out — a limit without its remedies is a dead end wearing a sentence. */
function sourceLimitSentence(err: SourceLimitError): string {
  const noun = err.limit === 1 ? "source" : "sources"
  return `Your ${err.planName} plan allows ${err.limit} ${noun} and you have ${err.used}. Delete a source or upgrade to connect another.`
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

//#region Routes
/** Sources: enqueue, upload, re-crawl, delete — §3.10.8/§3.22. Handler
 *  bodies are verbatim from the pre-split file. */
function registerSourceRoutes(
  app: Express,
  options: InternalRouteOptions,
  guards: InternalGuards,
): void {
  const vet = options.vetBaseUrl
  const { requireSecret, requireOrg } = guards

  app.post(
    "/internal/orgs/:orgId/sources",
    requireSecret,
    requireOrg,
    // eslint-disable-next-line complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
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
        if (
          typeof b.crawlDepth !== "number" ||
          !Number.isInteger(b.crawlDepth) ||
          b.crawlDepth < 0 ||
          b.crawlDepth > 3
        ) {
          res.status(422).json({ ok: false, error: "crawlDepth must be an integer from 0 to 3." })
          return
        }
        crawlDepth = b.crawlDepth
      }

      const sourceId = newId("src")
      const jobId = newId("job")
      try {
        await db.transaction().execute(async (trx) => {
          // The plan's ceiling, checked with the org row locked so two
          // concurrent creates cannot both count below it (M8.5 region
          // above). Throwing rolls the whole transaction back.
          await assertSourceCapacity(trx, res.locals.orgId as string)
          await trx
            .insertInto("sources")
            .values({
              id: sourceId,
              org_id: res.locals.orgId as string,
              kind: b.kind as "url" | "sitemap",
              location: parsed.href,
              ...(crawlDepth !== undefined ? { crawl_depth: crawlDepth } : {}),
            })
            .execute()
          await trx
            .insertInto("ingest_jobs")
            .values({
              id: jobId,
              org_id: res.locals.orgId as string,
              source_id: sourceId,
            })
            .execute()
        })
      } catch (err) {
        if (err instanceof SourceLimitError) {
          res.status(409).json({ ok: false, error: sourceLimitSentence(err) })
          return
        }
        throw err
      }
      options.onEnqueue?.()

      res.json({ ok: true, sourceId, jobId })
    },
  )
}

//#region Upload route
/** The one internal route that accepts MEGABYTES (§3.10.8) — its own
 *  registrar so the raw-body surface reads apart from the JSON ones. */
function registerUploadRoute(
  app: Express,
  options: InternalRouteOptions,
  guards: InternalGuards,
): void {
  const { requireSecret, requireOrg } = guards

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
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
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

      // The plan's source ceiling, checked BEFORE the parse for the
      // 413-before-parse reason: a PDF parser decompresses, and refusing a
      // full plan after seconds of CPU would have already done the
      // expensive thing. This half is advisory (unlocked, so two racing
      // uploads can both pass it); the transaction below re-checks with the
      // org row locked, which is the half that cannot be raced.
      try {
        await assertSourceCapacity(db, res.locals.orgId as string)
      } catch (err) {
        if (err instanceof SourceLimitError) {
          res.status(409).json({ ok: false, error: sourceLimitSentence(err) })
          return
        }
        throw err
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
        const message = err instanceof PdfParseError ? err.message : "The file could not be read."
        res
          .status(422)
          .json({ ok: false, error: message[0]?.toUpperCase() + message.slice(1) + "." })
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
      try {
        await db.transaction().execute(async (trx) => {
          // The authoritative half of the ceiling check above.
          await assertSourceCapacity(trx, res.locals.orgId as string)
          await trx
            .insertInto("sources")
            .values({
              id: sourceId,
              org_id: res.locals.orgId as string,
              kind: "upload",
              location: filename,
              // A file has no links to follow. The column defaults to 1, and a
              // depth on an upload would be a number that means nothing.
              crawl_depth: 0,
            })
            .execute()
          await trx
            .insertInto("source_uploads")
            .values({
              source_id: sourceId,
              filename,
              format: detectFormat(resource),
              byte_size: body.byteLength,
              title: parsed.title,
              text: parsed.text,
              // Spans only — the text is not stored twice (migration 009).
              blocks: JSON.stringify(
                parsed.blocks.map((b) => ({
                  kind: b.kind,
                  ...(b.level !== undefined ? { level: b.level } : {}),
                  charStart: b.charStart,
                  charEnd: b.charEnd,
                })),
              ),
            })
            .execute()
          await trx
            .insertInto("ingest_jobs")
            .values({
              id: jobId,
              org_id: res.locals.orgId as string,
              source_id: sourceId,
            })
            .execute()
        })
      } catch (err) {
        if (err instanceof SourceLimitError) {
          res.status(409).json({ ok: false, error: sourceLimitSentence(err) })
          return
        }
        throw err
      }
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
}
//#endregion

//#region Recrawl and delete
/** Re-crawl and delete share the per-source guard stance (§3.22). */
function registerSourceMaintenanceRoutes(
  app: Express,
  options: InternalRouteOptions,
  guards: InternalGuards,
): void {
  const { requireSecret, requireOrg } = guards

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
        .onConflict((oc) =>
          oc.column("source_id").where("state", "in", ["queued", "running"]).doNothing(),
        )
        .returning("id")
        .executeTakeFirst()
      if (inserted) options.onEnqueue?.()

      res.json(inserted ? { ok: true, queued: true, jobId } : { ok: true, queued: false })
    },
  )

  /**
   * Delete a source (M8.5) — the half that makes the plan's source ceiling
   * honest. Sources had been add-only since M3.6a (M7.5 added Re-crawl, not
   * removal), which was tolerable while nothing counted them; a cap on an
   * add-only resource would spend a free tenant's single slot forever on
   * their first typo'd URL.
   *
   * One DELETE takes the whole subtree — documents, chunks, embeddings, the
   * stored upload extraction, and job history all CASCADE from sources —
   * so retrieval stops seeing the content the moment this commits. What
   * deliberately SURVIVES is every transcript: message_citations snapshots
   * what it cites and carries no chunk FK (§3.3.2), precisely so mutable
   * pipeline state could be deleted without history rotting. This route is
   * the first caller to lean on that property outside a test.
   *
   * The job-queue interaction is the part that needs care, and the order
   * inside the transaction is the mechanism. A QUEUED job dies with its
   * source: deleting it takes the row lock, and the worker's claim is a
   * `FOR UPDATE SKIP LOCKED` update that skips locked rows, so a job cannot
   * be claimed mid-delete — the race resolves in Postgres, §3.23's playbook.
   * A RUNNING job refuses the delete instead (409): cascading it away would
   * yank the row out from under a worker mid-crawl, whose next progress
   * UPDATE would quietly write to nothing and whose page inserts would hit
   * a dead FK. The refusal is checked AFTER the queued-delete so a job that
   * was claimed a moment earlier is seen as the running job it now is; the
   * throw rolls the queued-delete back too, so a refused delete changes
   * nothing at all. Stale "running" rows cannot refuse forever — the
   * worker's reclaim pass requeues or fails them past the lease window.
   *
   * No wake: nothing was enqueued. 404 for a foreign org's source, an
   * unknown one, and a malformed id alike — the recrawl route's stance.
   */

  app.delete(
    "/internal/orgs/:orgId/sources/:sourceId",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const raw = req.params.sourceId
      const sourceId = typeof raw === "string" ? raw : ""
      if (!isId("src", sourceId)) {
        res.status(404).end()
        return
      }

      class SourceBusyError extends Error {}
      let found = false
      try {
        await db.transaction().execute(async (trx) => {
          const source = await trx
            .selectFrom("sources")
            .select("id")
            .where("id", "=", sourceId)
            .where("org_id", "=", res.locals.orgId as string)
            .forUpdate()
            .executeTakeFirst()
          if (!source) return
          found = true
          await trx
            .deleteFrom("ingest_jobs")
            .where("source_id", "=", sourceId)
            .where("state", "=", "queued")
            .execute()
          const running = await trx
            .selectFrom("ingest_jobs")
            .select("id")
            .where("source_id", "=", sourceId)
            .where("state", "=", "running")
            .executeTakeFirst()
          if (running) throw new SourceBusyError()
          await trx.deleteFrom("sources").where("id", "=", sourceId).execute()
        })
      } catch (err) {
        if (err instanceof SourceBusyError) {
          res.status(409).json({
            ok: false,
            error: "A crawl of this source is running — try again when it finishes.",
          })
          return
        }
        throw err
      }
      if (!found) {
        res.status(404).end()
        return
      }
      res.json({ ok: true })
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
}
//#endregion

//#region Exports
export { registerSourceRoutes, registerUploadRoute, registerSourceMaintenanceRoutes }
//#endregion

//#endregion
