//#region Imports
import { createHash } from "node:crypto"

import { sql } from "kysely"
import type { Kysely } from "kysely"

import { MAX_RECORDED_SKIPPED_PAGES } from "@/db/schema"
import type { Database, SkippedPage } from "@/db/schema"
import { withRetry } from "@/answer/retry"
import { crawl, CrawlError } from "@/ingest/crawler"
import type { CrawlEvent, CrawlSource } from "@/ingest/crawler"
import { chunkBlocks } from "@shared/chunking/chunker"
import { newId } from "@shared/utils/ids"
import { padVector, toPgvector } from "@shared/utils/vectors"
import type { EmbeddingProvider } from "@providers/embedding/types"
//#endregion

//#region Type Defs
/**
 * The ingest worker: consumes ingest_jobs and drives the whole pipeline —
 * source → crawl → parse → chunk → embed → store (DATAFLOW.md §3). Runs
 * IN-PROCESS in the realtime service on a poll loop: a separate worker
 * service was rejected because Render's free tier funds exactly one
 * always-on instance, and the queue's real throughput ceiling is embedding
 * API rate limits, not CPU. A second worker is a deploy, not a rewrite —
 * the claim query is already contention-safe.
 *
 * Queue semantics (the reason the queue is Postgres and not Redis):
 *   - CLAIM is one atomic UPDATE over a FOR UPDATE SKIP LOCKED subquery:
 *     concurrent workers skip each other's locked rows instead of blocking,
 *     and a claim can never be half-taken.
 *   - A crashed worker leaves state='running' with a stale locked_at; the
 *     RECLAIM pass requeues those under the attempts cap and fails the rest.
 *     Work is lost only by exhausting attempts, never silently. Since M7.5
 *     the lease is RENEWED with every page (and every failed fetch): a crawl
 *     honoring a robots.txt Crawl-delay can legitimately outlast the stale
 *     window, and "slow but making progress" must never read as "crashed" to
 *     a second worker — the property that keeps "a second worker is a
 *     deploy, not a rewrite" true.
 *   - stop() requeues the in-flight job between pages, so deploys don't
 *     burn an attempt on healthy work.
 *
 * Ordering inside a page: embed FIRST, then one short transaction for
 * document + chunks + embeddings. The embedding call is seconds of external
 * network — holding a transaction open across it would pin a connection
 * (Neon free tier: pool of 5) for no atomicity gain, since a failed embed
 * simply leaves the previous document version in place.
 *
 * What a crawl did NOT take is recorded too (M7.5): every `skipped` and
 * `error` event lands in the job's skipped_pages list (capped — §3.3.10) with
 * skipped_count as the true total, so the dashboard can say "97 pages
 * indexed · 3 skipped" and show which and why. Until then those events were
 * console.warn lines a tenant could never see.
 */
interface IngestWorkerOptions {
  db: Kysely<Database>
  /** The app-level embedder — the fallback for orgs with no BYO embedding
   *  credential, and what keeps every keyless stack (dev compose, CI, the
   *  demo org) ingesting without an API key. */
  embedder: EmbeddingProvider
  /** Per-org embedder lookup (M3.6b), injected rather than imported so the
   *  worker stays testable without the credential vault. server.ts wires it
   *  to credentials/resolve.ts. Resolved once per JOB: a rotation mid-crawl
   *  would otherwise split one document set across two vector spaces. */
  resolveEmbedder?: (orgId: string) => Promise<EmbeddingProvider | null>
  /** Poll interval when the queue is empty. */
  pollMs?: number
  workerId?: string
  /** Crawler factory — the seam tests use to point ingestion at loopback
   *  fixtures or scripted event streams. The default is the real crawler
   *  under its secure defaults. */
  crawler?: (source: CrawlSource) => AsyncGenerator<CrawlEvent>
  /** A running job whose lease is older than this is presumed crashed. */
  staleLockMs?: number
  maxAttempts?: number
  embedBatchSize?: number
}

/** The claimed queue row, as returned by the claim UPDATE. */
interface ClaimedJob {
  id: string
  org_id: string
  source_id: string
  attempts: number
}
//#endregion

//#region Constants
const DEFAULT_POLL_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
// 32 texts per embed call: large enough to amortize per-request rate limits
// (the batch-first rationale in providers/embedding/types.ts), small enough
// that one failed call wastes little work.
const DEFAULT_EMBED_BATCH = 32
/** Chunk insert batching keeps parameter counts far from pg's 65535 cap. */
const INSERT_BATCH = 100
/**
 * §3.10.5a — the PATIENT retry policy for embed calls, and why it is not
 * the answer path's.
 *
 * §3.15.5 sets the interactive policy from a product judgment: three
 * attempts inside 8 seconds, because that is how long someone watches a
 * chat bubble. Ingest is BACKGROUND work with nobody watching, and its
 * failure mode is the opposite — abandoning a run that a 30-second wait
 * would have finished. So this mirrors the eval harness's policy (§3.14),
 * which was written against the same measured problem from the other side
 * of the same provider: 8 attempts inside a 5-minute waiting budget, with
 * a ceiling high enough to sit out a per-minute quota window.
 *
 * The budget is what keeps it honest: a page that cannot embed inside five
 * minutes of waiting fails loudly, with the provider's own error, rather
 * than holding the queue's single worker forever.
 */
const INGEST_EMBED_RETRY = {
  maxAttempts: 8,
  budgetMs: 300_000,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
}
//#endregion

//#region Worker
class IngestWorker {
  readonly #db: Kysely<Database>
  readonly #embedder: EmbeddingProvider
  readonly #resolveEmbedder: ((orgId: string) => Promise<EmbeddingProvider | null>) | undefined
  readonly #pollMs: number
  readonly #workerId: string
  readonly #crawler: (source: CrawlSource) => AsyncGenerator<CrawlEvent>
  readonly #staleLockMs: number
  readonly #maxAttempts: number
  readonly #embedBatchSize: number

  #stopping = false
  #timer: NodeJS.Timeout | null = null
  #inflight: Promise<unknown> | null = null
  #wakePending = false

  constructor(options: IngestWorkerOptions) {
    this.#db = options.db
    this.#embedder = options.embedder
    this.#resolveEmbedder = options.resolveEmbedder
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#workerId = options.workerId ?? `worker-${process.pid}-${newId("job").slice(-6)}`
    this.#crawler = options.crawler ?? ((source) => crawl(source))
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#embedBatchSize = options.embedBatchSize ?? DEFAULT_EMBED_BATCH
  }

  //#region Lifecycle
  /** Starts the loop. Chained setTimeout rather than setInterval so a long
   *  job can never overlap the next tick. Since M3.6 `pollMs: 0` means
   *  WAKE-DRIVEN: tick once at start (catches jobs stranded by a deploy),
   *  then never on a timer — only wake() (the enqueue path) triggers work.
   *  That is the production mode on Neon, where a poll every few seconds
   *  would hold compute awake against the ~100 CU-hour budget; polling
   *  remains the dev-compose fallback where Postgres is free. */
  start(): void {
    this.#loop()
  }

  /** Immediate-tick request — wake-on-enqueue. If a tick is already in
   *  flight the wake is REMEMBERED, not dropped: the enqueue that arrived
   *  mid-tick would otherwise wait for a poll fallback that wake-driven
   *  mode doesn't have. Stopped workers ignore wakes. */
  wake(): void {
    if (this.#stopping) return
    if (this.#inflight) {
      this.#wakePending = true
      return
    }
    if (this.#timer) clearTimeout(this.#timer)
    this.#loop()
  }

  #loop(): void {
    if (this.#stopping) return
    this.#inflight = this.tick()
      .catch((err) => console.error("[ingest] tick failed:", err))
      .finally(() => {
        this.#inflight = null
        if (this.#stopping) return
        if (this.#wakePending) {
          // An enqueue landed while this tick ran — service it now.
          this.#wakePending = false
          this.#timer = setTimeout(() => this.#loop(), 0)
        } else if (this.#pollMs > 0) {
          this.#timer = setTimeout(() => this.#loop(), this.#pollMs)
        }
        // pollMs 0 + no pending wake: go idle until the next wake().
      })
  }

  /** Stops accepting work and waits for the current tick to wind down (a
   *  mid-crawl job is requeued between pages — see the stop check in
   *  #runJob). Bounded: the longest wait is one page's fetch + embed. */
  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#inflight) await this.#inflight
  }
  //#endregion

  //#region Queue operations
  /**
   * One scheduling round: reclaim stale leases, then claim and run at most
   * one job. Public and directly awaitable — tests drive the worker through
   * tick() instead of racing the poll timer. Returns whether a job ran.
   */
  async tick(): Promise<boolean> {
    await this.#reclaimStale()
    const job = await this.#claim()
    if (!job) return false
    await this.#runJob(job)
    return true
  }

  /** Requeue crashed-looking jobs that still have attempts left… */
  async #reclaimStale(): Promise<void> {
    const cutoff = sql<Date>`NOW() - make_interval(secs => ${this.#staleLockMs / 1000})`
    await this.#db
      .updateTable("ingest_jobs")
      .set({ state: "queued", locked_by: null, locked_at: null })
      .where("state", "=", "running")
      .where("locked_at", "<", cutoff)
      .where("attempts", "<", this.#maxAttempts)
      .execute()
    // …and fail the ones that exhausted theirs — visibly, not by vanishing.
    await this.#db
      .updateTable("ingest_jobs")
      .set({
        state: "failed",
        locked_by: null,
        error: `lease expired after ${this.#maxAttempts} attempts`,
      })
      .where("state", "=", "running")
      .where("locked_at", "<", cutoff)
      .where("attempts", ">=", this.#maxAttempts)
      .execute()
  }

  /** The claim: atomic hand-off of the oldest queued job to this worker.
   *  SKIP LOCKED is the entire multi-worker story — a second worker's
   *  subquery skips the row this one has locked instead of waiting on it. */
  async #claim(): Promise<ClaimedJob | null> {
    const { rows } = await sql<ClaimedJob>`
      UPDATE ingest_jobs
      SET state = 'running', locked_by = ${this.#workerId}, locked_at = NOW(),
          attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ingest_jobs
        WHERE state = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id, source_id, attempts
    `.execute(this.#db)
    return rows[0] ?? null
  }
  //#endregion

  //#region Job execution
  async #runJob(job: ClaimedJob): Promise<void> {
    const source = await this.#db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", job.source_id)
      .executeTakeFirst()

    if (!source) {
      await this.#finishJob(job.id, "failed", "source row no longer exists")
      return
    }
    await this.#setSourceStatus(source.id, "crawling")
    const seenDocIds: string[] = []
    let docsDone = 0
    // What the crawl left out, for the dashboard: the count is exact, the
    // list stops at the schema's cap (skipped_count keeps counting).
    let skippedCount = 0
    const skippedPages: SkippedPage[] = []
    const noteSkipped = (url: string, reason: string): void => {
      skippedCount++
      if (skippedPages.length < MAX_RECORDED_SKIPPED_PAGES) skippedPages.push({ url, reason })
    }
    // One UPDATE per fetch that produced something to say — a page or a
    // failed page. It carries the progress counters AND renews the lease
    // (locked_at = NOW()), so a crawl that is slow because it is polite is
    // never reclaimed as one that died.
    const recordProgress = (): Promise<unknown> =>
      this.#db
        .updateTable("ingest_jobs")
        .set({
          docs_done: docsDone,
          skipped_count: skippedCount,
          skipped_pages: JSON.stringify(skippedPages),
          locked_at: sql`NOW()`,
        })
        .where("id", "=", job.id)
        .execute()

    try {
      // The org's own embedding model, resolved ONCE for the whole job
      // (M3.6b): a rotation landing mid-crawl would otherwise leave one
      // source's pages split across two vector spaces, half of them
      // invisible to retrieval. A decrypt failure throws into the catch
      // below and fails the job visibly — silently ingesting under the
      // wrong model is the outcome worth avoiding.
      const embedder = (await this.#resolveEmbedder?.(job.org_id)) ?? this.#embedder

      // An UPLOAD is a crawl of exactly one page whose fetch is a database
      // read (M7.6b). Producing the same event stream a crawler does is what
      // lets everything below this line stay unchanged: progress and lease
      // renewal, the vanished-document sweep, the status transitions, and the
      // failure path all work on an upload for free, and there is no second
      // ingest path to keep in step with this one.
      const events =
        source.kind === "upload"
          ? this.#uploadEvents(source.id)
          : this.#crawler({
              kind: source.kind,
              location: source.location,
              crawlDepth: source.crawl_depth,
            })
      for await (const event of events) {
        // Deploy-time stop: hand the job back between pages. attempts was
        // already incremented by the claim, which is correct — a job that
        // only ever gets half-crawled will still hit the attempts cap
        // instead of cycling forever.
        if (this.#stopping) {
          await this.#db
            .updateTable("ingest_jobs")
            .set({ state: "queued", locked_by: null, locked_at: null })
            .where("id", "=", job.id)
            .execute()
          await this.#setSourceStatus(source.id, "pending")
          return
        }
        if (event.kind === "plan") {
          await this.#db
            .updateTable("ingest_jobs")
            .set({ docs_total: event.total })
            .where("id", "=", job.id)
            .execute()
        } else if (event.kind === "error") {
          // Page-level failures don't fail the job (one dead link in a
          // 100-page crawl). Recorded for the tenant, and still logged for
          // the operator because a burst of them is an operational signal.
          console.warn(`[ingest] ${job.id} page error: ${event.url}: ${event.message}`)
          noteSkipped(event.url, event.message)
          await recordProgress() // this cost a fetch: renew the lease too
        } else if (event.kind === "skipped") {
          // The site asked (robots.txt) and the crawler listened. Nothing was
          // fetched, so nothing to log; the record is for the tenant.
          noteSkipped(event.url, event.reason)
        } else {
          const docId = await this.#processPage(job, embedder, event.url, event.doc)
          seenDocIds.push(docId)
          docsDone++
          await recordProgress()
        }
      }

      // Pages that were live last crawl but absent from this one are gone
      // from the site — soft-deleted so retrieval stops seeing them while
      // history survives until a cleanup pass. A page robots.txt now closes
      // is absent by the same rule: the site said not to keep it.
      let vanished = this.#db
        .updateTable("documents")
        .set({ deleted_at: new Date() })
        .where("source_id", "=", source.id)
        .where("deleted_at", "is", null)
      if (seenDocIds.length > 0) vanished = vanished.where("id", "not in", seenDocIds)
      await vanished.execute()

      await this.#db
        .updateTable("ingest_jobs")
        .set({
          docs_total: docsDone,
          skipped_count: skippedCount,
          skipped_pages: JSON.stringify(skippedPages),
        })
        .where("id", "=", job.id)
        .execute()
      await this.#finishJob(job.id, "done", null)
      await this.#db
        .updateTable("sources")
        .set({ status: "ready", last_crawled_at: new Date() })
        .where("id", "=", source.id)
        .execute()
    } catch (err) {
      const message = err instanceof CrawlError || err instanceof Error ? err.message : String(err)
      await this.#finishJob(job.id, "failed", message.slice(0, 500))
      await this.#setSourceStatus(source.id, "failed")
    }
  }

  /**
   * An upload source's single "page", read back from what the upload route
   * extracted (migration 009). The file's bytes are long gone — they were
   * parsed in the request and never stored — so this is the only thing an
   * upload can be re-ingested from, which is exactly why the text is kept:
   * an embedding-model change re-queues every source (§3.22), and a crawl
   * source answers that by being fetched again while an upload has nothing
   * to re-fetch.
   *
   * Blocks are stored as SPANS and their text is sliced back out here, so
   * the parser contract — block.text === text.slice(charStart, charEnd) —
   * holds by construction rather than by two copies agreeing.
   *
   * A missing row throws rather than yielding nothing: an upload source with
   * no extraction is a broken invariant (the route writes both in one
   * transaction), and a crawl of zero pages that "succeeded" would soft-delete
   * the document and leave a tenant with a source that reads ready and
   * answers nothing.
   */
  async *#uploadEvents(sourceId: string): AsyncGenerator<CrawlEvent> {
    const upload = await this.#db
      .selectFrom("source_uploads")
      .select(["filename", "title", "text", "blocks"])
      .where("source_id", "=", sourceId)
      .executeTakeFirst()
    if (!upload) throw new CrawlError("uploaded file is missing its extracted text")

    yield { kind: "plan", total: 1 }
    yield {
      kind: "page",
      // documents.url is the filename for an upload: it is what a citation
      // shows, and what the recrawl short-circuit matches a page on.
      url: upload.filename,
      doc: {
        title: upload.title,
        text: upload.text,
        blocks: upload.blocks.map((b) => ({
          kind: b.kind,
          ...(b.level !== undefined ? { level: b.level } : {}),
          text: upload.text.slice(b.charStart, b.charEnd),
          charStart: b.charStart,
          charEnd: b.charEnd,
        })),
        links: [],
      },
    }
  }

  /**
   * One page through parse-hash-chunk-embed-store. Returns the document id
   * (existing or new) so the caller can compute the vanished set.
   */
  async #processPage(
    job: ClaimedJob,
    embedder: EmbeddingProvider,
    url: string,
    doc: { title: string | null; text: string; blocks: Parameters<typeof chunkBlocks>[0] },
  ): Promise<string> {
    const contentHash = createHash("sha256").update(doc.text, "utf8").digest("hex")
    const existing = await this.#db
      .selectFrom("documents")
      .select(["id", "content_hash"])
      .where("source_id", "=", job.source_id)
      .where("url", "=", url)
      .where("deleted_at", "is", null)
      .executeTakeFirst()

    // The recrawl short-circuit: identical normalized text means chunks and
    // embeddings are already right — refresh the bookkeeping and spend
    // nothing. This single branch is what makes recrawls nearly free on
    // embedding quota (the scarcest resource in the pipeline).
    //
    // "Already right" gained a second half in M3.6b: unchanged text is only
    // enough if the chunks also carry vectors under the model THIS job is
    // embedding with. When a tenant switches embedding providers, every
    // page's text is identical and every page's vectors are in the wrong
    // space — short-circuiting on the hash alone would make a re-index a
    // no-op and leave the corpus permanently invisible to the dense arm.
    // One indexed EXISTS per unchanged page is what that costs.
    if (existing && existing.content_hash === contentHash) {
      const embedded = await this.#db
        .selectFrom("chunk_embeddings")
        .innerJoin("chunks", "chunks.id", "chunk_embeddings.chunk_id")
        .select("chunk_embeddings.chunk_id")
        .where("chunks.document_id", "=", existing.id)
        .where("chunk_embeddings.model", "=", embedder.model)
        .limit(1)
        .executeTakeFirst()
      if (embedded) {
        await this.#db
          .updateTable("documents")
          .set({ title: doc.title, fetched_at: new Date() })
          .where("id", "=", existing.id)
          .execute()
        return existing.id
      }
    }

    const chunks = chunkBlocks(doc.blocks)

    // Embed with the heading trail prepended: "Billing > Refunds" carries
    // the section context the chunk text alone lacks (§3.3.1's
    // heading_path rationale). The STORED text stays trail-free — the trail
    // is retrieval context, not quotable content.
    const embedTexts = chunks.map((c) => (c.headingPath ? `${c.headingPath}\n${c.text}` : c.text))
    const vectors: string[] = []
    for (let i = 0; i < embedTexts.length; i += this.#embedBatchSize) {
      // task "document" — the asymmetric-model half that matters here; the
      // query path passes "query" (providers/embedding/types.ts).
      //
      // Retried PATIENTLY, and the policy is the whole point (§3.10.5a).
      // A hosted free tier meters embeddings per ITEM per minute, and one
      // page can hold more chunks than that minute allows — so without a
      // retry the batch that crosses the line throws, the page fails, the
      // JOB fails, and the next attempt re-embeds that same page from its
      // first chunk and dies at the same place. That is not a slow ingest,
      // it is a page that can never be ingested at all; it was measured on
      // the deployed demo (three rounds, byte-identical failure, zero
      // progress) before this existed. Resuming from the batch that failed
      // is what makes each attempt cheaper than the last.
      const batch = await withRetry(
        () => embedder.embed(embedTexts.slice(i, i + this.#embedBatchSize), { task: "document" }),
        {
          onRetry: ({ attempt, delayMs, error }) => {
            const why = error instanceof Error ? error.message.slice(0, 100) : String(error)
            console.warn(
              `[ingest] embed retry ${attempt} in ${Math.round(delayMs / 1000)}s (${url}) — ${why}`,
            )
          },
        },
        INGEST_EMBED_RETRY,
      )
      for (const vector of batch) vectors.push(toPgvector(padVector(vector)))
    }

    const documentId = existing?.id ?? newId("doc")
    const tokenCount = chunks.reduce((acc, c) => acc + c.tokenCount, 0)

    await this.#db.transaction().execute(async (trx) => {
      if (existing) {
        await trx
          .updateTable("documents")
          .set({
            title: doc.title,
            content_hash: contentHash,
            token_count: tokenCount,
            fetched_at: new Date(),
          })
          .where("id", "=", existing.id)
          .execute()
        // Chunk deletion cascades to chunk_embeddings (FK ON DELETE CASCADE)
        // — the old version disappears atomically with the new one landing.
        await trx.deleteFrom("chunks").where("document_id", "=", existing.id).execute()
      } else {
        await trx
          .insertInto("documents")
          .values({
            id: documentId,
            org_id: job.org_id,
            source_id: job.source_id,
            url,
            title: doc.title,
            content_hash: contentHash,
            token_count: tokenCount,
          })
          .execute()
      }

      const chunkRows = chunks.map((chunk) => ({
        id: newId("chk"),
        org_id: job.org_id,
        document_id: documentId,
        ord: chunk.ord,
        heading_path: chunk.headingPath,
        text: chunk.text,
        token_count: chunk.tokenCount,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
      }))
      const embeddingRows = chunkRows.map((row, i) => ({
        chunk_id: row.id,
        org_id: job.org_id,
        model: embedder.model,
        // Post-embed, so this is the dimension the provider actually
        // returned (a remote adapter discovers its own on first response).
        dim: embedder.dim,
        embedding: vectors[i],
      }))
      for (let i = 0; i < chunkRows.length; i += INSERT_BATCH) {
        await trx
          .insertInto("chunks")
          .values(chunkRows.slice(i, i + INSERT_BATCH))
          .execute()
        await trx
          .insertInto("chunk_embeddings")
          .values(embeddingRows.slice(i, i + INSERT_BATCH))
          .execute()
      }
    })
    return documentId
  }

  //#region Small state transitions
  async #finishJob(jobId: string, state: "done" | "failed", error: string | null): Promise<void> {
    // locked_by must clear with the terminal state — the schema CHECK
    // (running ⇔ locked) makes forgetting this an insert error, on purpose.
    await this.#db
      .updateTable("ingest_jobs")
      .set({ state, locked_by: null, error })
      .where("id", "=", jobId)
      .execute()
  }

  async #setSourceStatus(
    sourceId: string,
    status: "pending" | "crawling" | "ready" | "failed",
  ): Promise<void> {
    await this.#db.updateTable("sources").set({ status }).where("id", "=", sourceId).execute()
  }
  //#endregion
  //#endregion
}
//#endregion

//#region Exports
export { IngestWorker }
export type { IngestWorkerOptions }
//#endregion
