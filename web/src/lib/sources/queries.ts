//#region Why this file
// The dashboard's read side for sources and their ingest progress —
// straight from Postgres like every dashboard read (a realtime outage must
// not blank the page). Progress comes from each source's LATEST ingest job:
// jobs are append-per-crawl, so "the newest row per source" is the current
// truth and older rows are history the dashboard doesn't show yet.
//#endregion

//#region Imports
import { db } from "@/lib/db"

import type { SkippedPage } from "@shared/db/schema"
//#endregion

//#region Types
export interface SourceWithProgress {
  id: string
  kind: "url" | "sitemap" | "upload"
  location: string
  crawlDepth: number
  status: "pending" | "crawling" | "ready" | "failed"
  lastCrawledAt: Date | null
  documentCount: number
  job: {
    state: "queued" | "running" | "done" | "failed"
    docsDone: number | null
    docsTotal: number | null
    error: string | null
    /** Pages this crawl did not take — the TRUE count (M7.5, §3.3.10). */
    skippedCount: number
    /** …and the first MAX_RECORDED_SKIPPED_PAGES of them with their reasons:
     *  "disallowed by robots.txt (User-agent: *, Disallow: /private/)",
     *  "HTTP 404". What the page shows under "N skipped — why". */
    skippedPages: SkippedPage[]
  } | null
}
//#endregion

//#region Queries
export async function listSourcesWithProgress(orgId: string): Promise<SourceWithProgress[]> {
  const sources = await db
    .selectFrom("sources")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("created_at", "desc")
    .execute()
  if (sources.length === 0) {
    return []
  }
  const sourceIds = sources.map((s) => s.id)

  // Two straight queries + a JS pick beat a DISTINCT ON at dashboard scale
  // (a tenant has a handful of sources; jobs per source stay small).
  const jobs = await db
    .selectFrom("ingest_jobs")
    .select(["source_id", "state", "docs_done", "docs_total", "error", "skipped_count", "skipped_pages", "created_at"])
    .where("source_id", "in", sourceIds)
    .orderBy("created_at", "desc")
    .execute()
  const latestJob = new Map<string, (typeof jobs)[number]>()
  for (const job of jobs) {
    if (!latestJob.has(job.source_id)) latestJob.set(job.source_id, job)
  }

  const counts = await db
    .selectFrom("documents")
    .select(({ fn }) => ["source_id", fn.countAll<string>().as("n")])
    .where("source_id", "in", sourceIds)
    .where("deleted_at", "is", null)
    .groupBy("source_id")
    .execute()
  const docCount = new Map(counts.map((c) => [c.source_id, Number(c.n)]))

  return sources.map((s) => {
    const job = latestJob.get(s.id) ?? null
    return {
      id: s.id,
      kind: s.kind,
      location: s.location,
      crawlDepth: s.crawl_depth,
      status: s.status,
      lastCrawledAt: s.last_crawled_at,
      documentCount: docCount.get(s.id) ?? 0,
      job: job
        ? {
            state: job.state,
            docsDone: job.docs_done,
            docsTotal: job.docs_total,
            error: job.error,
            skippedCount: job.skipped_count,
            skippedPages: job.skipped_pages,
          }
        : null,
    }
  })
}

/** True while any of the org's jobs are still moving — what the page's
 *  auto-refresh keys on. */
export function hasActiveJob(sources: SourceWithProgress[]): boolean {
  return sources.some((s) => s.job?.state === "queued" || s.job?.state === "running")
}
//#endregion
