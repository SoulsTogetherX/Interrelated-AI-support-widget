// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; schema
// must already be migrated — the same prerequisite as the other web suites).
// Rows are inserted directly: writing jobs is the worker's business and is
// tested in realtime; this suite is about what the sources page READS —
// each source's latest job, with what that crawl skipped and why (M7.5).
import { createHash } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { hasActiveJob, listSourcesWithProgress } from "../queries"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)

let orgA: string
let orgB: string
let docsSource: string
let quietSource: string

describe.skipIf(!hasDb)("sources with progress (integration)", () => {
  beforeAll(async () => {
    orgA = newId("org")
    orgB = newId("org")
    await db.insertInto("organizations").values([
      { id: orgA, name: "Sources Co" },
      { id: orgB, name: "Other Tenant" },
    ]).execute()

    // A source crawled twice: the older run took everything; the LATEST
    // run met a robots.txt and a dead link, and is what the page must show.
    docsSource = newId("src")
    await db.insertInto("sources").values({ id: docsSource, org_id: orgA, kind: "url", location: "https://docs.acme.example/" }).execute()
    await db.insertInto("ingest_jobs").values({
      id: newId("job"), org_id: orgA, source_id: docsSource, state: "done", docs_done: 12, docs_total: 12,
      created_at: new Date(Date.now() - 60_000),
    }).execute()
    await db.insertInto("ingest_jobs").values({
      id: newId("job"), org_id: orgA, source_id: docsSource, state: "done", docs_done: 10, docs_total: 10,
      skipped_count: 3,
      skipped_pages: JSON.stringify([
        { url: "https://docs.acme.example/private/a", reason: "disallowed by robots.txt (User-agent: *, Disallow: /private/)" },
        { url: "https://docs.acme.example/old", reason: "HTTP 404" },
      ]),
    }).execute()
    for (let i = 0; i < 10; i++) {
      await db.insertInto("documents").values({
        id: newId("doc"), org_id: orgA, source_id: docsSource,
        url: `https://docs.acme.example/p${i}`, title: `P${i}`,
        content_hash: createHash("sha256").update(`page ${i}`).digest("hex"),
      }).execute()
    }

    // A source with a crawl still running: nothing skipped yet.
    quietSource = newId("src")
    await db.insertInto("sources").values({ id: quietSource, org_id: orgA, kind: "sitemap", location: "https://quiet.acme.example/sitemap.xml" }).execute()
    await db.insertInto("ingest_jobs").values({
      id: newId("job"), org_id: orgA, source_id: quietSource, state: "running", locked_by: "w", locked_at: new Date(), docs_done: 1, docs_total: 5,
    }).execute()

    // Another tenant's source, with a job that skipped plenty: invisible to A.
    const theirs = newId("src")
    await db.insertInto("sources").values({ id: theirs, org_id: orgB, kind: "url", location: "https://theirs.example/" }).execute()
    await db.insertInto("ingest_jobs").values({
      id: newId("job"), org_id: orgB, source_id: theirs, state: "done", skipped_count: 99,
      skipped_pages: JSON.stringify([{ url: "https://theirs.example/x", reason: "HTTP 500" }]),
    }).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgA, orgB]).execute()
  })

  it("carries the LATEST job's skipped record with each source, newest source first", async () => {
    const list = await listSourcesWithProgress(orgA)
    expect(list.map((s) => s.id)).toEqual([quietSource, docsSource])

    const docs = list.find((s) => s.id === docsSource)!
    expect(docs.documentCount).toBe(10)
    expect(docs.job).toEqual({
      state: "done",
      docsDone: 10,
      docsTotal: 10,
      error: null,
      skippedCount: 3, // the count is the truth…
      skippedPages: [ // …the list is what was kept
        { url: "https://docs.acme.example/private/a", reason: "disallowed by robots.txt (User-agent: *, Disallow: /private/)" },
        { url: "https://docs.acme.example/old", reason: "HTTP 404" },
      ],
    })

    const quiet = list.find((s) => s.id === quietSource)!
    expect(quiet.job).toMatchObject({ state: "running", docsDone: 1, docsTotal: 5, skippedCount: 0, skippedPages: [] })
    expect(hasActiveJob(list)).toBe(true)
  })

  it("shows one tenant nothing of another's", async () => {
    const list = await listSourcesWithProgress(orgB)
    expect(list).toHaveLength(1)
    expect(list[0]?.job?.skippedCount).toBe(99)
    expect((await listSourcesWithProgress(orgA)).some((s) => s.job?.skippedCount === 99)).toBe(false)
  })
})

describe.skipIf(hasDb)("sources with progress (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(hasDb).toBe(false)
  })
})
