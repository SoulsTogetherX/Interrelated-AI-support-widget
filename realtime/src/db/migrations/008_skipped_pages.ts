//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 008 — what a crawl did NOT ingest, and why; and one live job per
// source (M7.5). First, two columns on ingest_jobs:
//
//   skipped_count  — every page the crawl decided against or could not take:
//                    disallowed by robots.txt, HTTP 404, redirected
//                    off-origin, unparseable. The TRUE total.
//   skipped_pages  — the first MAX_RECORDED_SKIPPED_PAGES of them as
//                    [{url, reason}], in the order they were met, so the
//                    dashboard can show a tenant WHY a page is missing —
//                    the plan's own reason for building robots.txt support
//                    "where a customer can see why a page was skipped".
//
// Until now those events were console.warn lines an operator might read
// and a tenant never could; a crawl that skipped forty pages under a
// `Disallow: /docs/` looked identical to one that found forty fewer links.
//
// Columns on the job rather than a table of skipped pages, for the reason
// 003 put token counts on messages: they are facts about ONE crawl at its
// own grain, read with the job by the page that shows the job. A per-page
// table would need its own key and a join, to answer a question that has one
// consumer. The list is CAPPED — a docs site with an API reference under
// `Disallow: /api/` can discover thousands of disallowed links, and a JSONB
// value that grows with a site's link count is a row that grows with the
// customer's success — while the count stays true past the cap, so "and 1,240
// more" is honest arithmetic rather than a guess. The cap is enforced by
// CHECK as well as by the worker (the api_keys stance): a second writer that
// forgot it fails loudly instead of quietly growing the row.
//
// jsonb, not text: the dashboard reads it as data, and jsonb_typeof lets the
// schema insist on the shape. Both columns default so every existing job row
// — and every insert that knows nothing of them (the enqueue routes) — reads
// as "nothing skipped", which for a job that predates this migration is the
// honest answer: nothing was recorded.
//
// The cap is the literal 50 here and MAX_RECORDED_SKIPPED_PAGES in
// shared/db/schema.ts — the PADDED_DIM / halfvec(1024) arrangement: a
// migration is frozen once applied, so the schema constant mirrors this
// number rather than this file importing one that could move under it. The
// worker test yields more than the cap and asserts what the row holds, and
// the migrate test inserts one past it, so the two cannot drift silently.
//
// The same migration adds the index the Re-crawl button needs: AT MOST ONE
// LIVE JOB (queued or running) PER SOURCE. Two owners clicking Re-crawl
// together, or a click racing the re-index a credential change queues, would
// otherwise insert two jobs that crawl one site twice for one outcome. A
// check-then-insert cannot close that window; a partial unique index does,
// and lets both writers say ON CONFLICT DO NOTHING — the handoff table's
// argument (002), applied to the queue. Partial, so history is untouched: a
// source accumulates one done/failed row per crawl, and only the live one is
// unique. Every existing writer already respected this by construction (the
// enqueue route creates a fresh source; the re-index skips busy sources; the
// worker's requeue moves the SAME row), which is what makes the index safe
// to add to a deployed database.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ingest_jobs
      ADD COLUMN skipped_count INT NOT NULL DEFAULT 0,
      ADD COLUMN skipped_pages JSONB NOT NULL DEFAULT '[]'::jsonb
  `.execute(db)

  await sql`
    ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_skipped_count_nonnegative
      CHECK (skipped_count >= 0)
  `.execute(db)

  await sql`
    ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_skipped_pages_shape CHECK (
      jsonb_typeof(skipped_pages) = 'array'
      AND jsonb_array_length(skipped_pages) <= 50
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX ingest_jobs_one_live_per_source
      ON ingest_jobs (source_id) WHERE state IN ('queued', 'running')
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS ingest_jobs_one_live_per_source`.execute(db)
  await sql`ALTER TABLE ingest_jobs DROP CONSTRAINT IF EXISTS ingest_jobs_skipped_pages_shape`.execute(
    db,
  )
  await sql`ALTER TABLE ingest_jobs DROP CONSTRAINT IF EXISTS ingest_jobs_skipped_count_nonnegative`.execute(
    db,
  )
  await sql`ALTER TABLE ingest_jobs DROP COLUMN IF EXISTS skipped_pages, DROP COLUMN IF EXISTS skipped_count`.execute(
    db,
  )
}
//#endregion

//#region Exports
export { up, down }
//#endregion
