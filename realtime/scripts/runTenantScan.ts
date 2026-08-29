//#region Why this file
// The tenant-filtering measurement's runner (M7.11) — `npm run tenant-scan`.
// Lives in realtime/ for runEval.ts's reason: it drives realtime's retrieval
// code and needs its dependencies, while the scoring half (eval/tenantScan.ts)
// stays a package-less module the root runner typechecks and unit-tests.
//
// WHAT IT MEASURES, and why the plan asks for it. The schema's third
// load-bearing decision is that `org_id` is denormalized onto
// chunk_embeddings and pgvector's iterative scans are on, because HNSW
// searches the index and THEN applies the filter: a small tenant inside a
// large shared index silently gets fewer than k rows — or none — while
// every query still returns 200 and every single-tenant test still passes.
// The multi-tenant regression test (§3.8) proves the bug bites. This
// produces the NUMBER: how many tenants starve, how much of their own
// corpus they lose, and what the fix costs in latency, as the shared index
// grows.
//
// Three things make the measurement trustworthy, and each is a way it could
// have been wrong:
//
//   1. ONE CONNECTION, with enable_seqscan and enable_sort both off. The
//      pgvector knobs are transaction-local, and on a pooled connection the
//      SET and the search can land on different backends. Worse, a seqscan
//      is not the only exact route: every non-HNSW plan has to SORT by
//      distance, and at fixture sizes those plans sit at the planner's
//      break-even, so autoanalyze timing would decide what was measured.
//      That cost the M7.1 ladder a red run before it was understood
//      (§3.8), and a measurement that silently drifted onto an exact plan
//      would report "iterative scans change nothing" — the exact opposite
//      of the truth.
//   2. MOCK embeddings, deliberately, where the quality eval refuses them
//      by name. What is under test is the FILTER, not which chunk answers
//      better: uniform random directions make the discard rate depend on
//      tenant count alone, while real embeddings cluster by topic and would
//      confound it.
//   3. Own-tenant rows only are counted. A foreign row coming back would be
//      a filtering BUG rather than starvation, so the harness asserts their
//      absence and would fail loudly rather than folding them into recall.
//
// Everything it creates is deleted at the end, including on Ctrl-C.
//
// Usage:
//   npm run tenant-scan                       the default sweep
//   npm run tenant-scan -- --tenants 2,8,32   custom sweep points
//   npm run tenant-scan -- --k 5 --chunks 30 --ef 40
//#endregion

//#region Imports
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { summarizeScan } from "@eval/tenantScan"
import type { ScanSummary, TenantOutcome } from "@eval/tenantScan"
//#endregion

//#region Env fallback
// The block every sibling CLI carries (§3.11): already-set env always wins,
// and it must run BEFORE @/db/pool loads, since the pool reads env at module
// load — which is why main() defers every import that touches it.
if (!process.env.POSTGRES_PASSWORD) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../../.env"), "utf8")
    for (const line of envFile.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]
      }
    }
  } catch {
    // No .env — the check below says exactly what is missing.
  }
}

if (!process.env.POSTGRES_PASSWORD) {
  console.error(
    "tenant-scan needs a database: set POSTGRES_PASSWORD (or fill .env) and start the compose database.",
  )
  process.exit(1)
}
//#endregion

//#region Arguments
const argv = process.argv.slice(2)

function flag(name: string, fallback: number): number {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  const value = Number(argv[idx + 1])
  if (!Number.isFinite(value) || value < 1) {
    console.error(`--${name} needs a positive number`)
    process.exit(1)
  }
  return value
}

function listFlag(name: string, fallback: readonly number[]): number[] {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return [...fallback]
  const parsed = (argv[idx + 1] ?? "").split(",").map((n) => Number(n.trim()))
  if (parsed.length === 0 || parsed.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(`--${name} needs a comma-separated list of positive integers`)
    process.exit(1)
  }
  return parsed
}

/** The sweep brackets the knee rather than sampling around it. At
 *  ef_search = 40, each tenant's share of the candidate list is roughly
 *  40/N, so a k of 5 should be satisfiable up to about 8 tenants and fail
 *  progressively past it — the shape the table is supposed to show. */
const TENANT_COUNTS = listFlag("tenants", [2, 4, 8, 16, 32])
const K = flag("k", 5)
const CHUNKS_PER_TENANT = flag("chunks", 30)
const EF_SEARCH = flag("ef", 40)
//#endregion

//#region Runner
async function main(): Promise<void> {
  // Deferred so the env fallback above lands before the pool constructs.
  const { createHash } = await import("node:crypto")
  const { Pool } = await import("pg")
  const { Kysely, PostgresDialect, sql } = await import("kysely")
  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")
  const { denseSearch } = await import("@/retrieval/search")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")
  const { migrateToLatest } = await import("@/db/migrate")

  type Database = import("@/db/schema").Database

  await migrateToLatest(db)

  const embedder = new MockEmbeddingProvider()
  const createdOrgs: string[] = []

  const cleanup = async (): Promise<void> => {
    if (createdOrgs.length === 0) return
    await db.deleteFrom("organizations").where("id", "in", createdOrgs).execute()
    createdOrgs.length = 0
  }
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130))
  })

  // The single connection the whole measurement runs on. Pooled queries
  // would scatter the transaction-local pgvector settings across backends,
  // and without both planner knobs an exact plan can win on cost and quietly
  // replace what is being measured (see the header).
  const singlePool = new Pool({
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? "interrelated",
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB ?? "interrelated",
    max: 1,
  })
  const conn = new Kysely<Database>({ dialect: new PostgresDialect({ pool: singlePool }) })

  try {
    await sql`SET enable_seqscan = off`.execute(conn)
    await sql`SET enable_sort = off`.execute(conn)

    // Confirm the plan really is the HNSW one before believing any number
    // below it. A measurement that drifted onto an exact scan would report
    // that iterative scans change nothing, which is the opposite of true.
    console.log(`tenant-scan — k=${K}, ${CHUNKS_PER_TENANT} chunks/tenant, ef_search=${EF_SEARCH}`)
    console.log("mock embeddings (the filter is what is measured, not answer quality)\n")

    /**
     * Is the planner actually using the HNSW index for this fixture?
     *
     * This is not decoration. An exact plan cannot starve — it sorts every
     * matching row — so a sweep point that quietly fell off the index would
     * report "iterative scans change nothing", which is the exact opposite
     * of the truth and the most damaging way this measurement could be
     * wrong. The first run of this harness produced precisely that: 5 of 8
     * tenants starved at 240 vectors while 0 of 32 starved at 960, which is
     * impossible if both rows measured the same plan. So every sweep point
     * is checked and LABELLED, and a row that did not run on HNSW is
     * reported as unmeasured rather than published as a finding.
     */
    const usesHnsw = async (queryVector: readonly number[]): Promise<boolean> => {
      const explain = await sql<{ "QUERY PLAN": string }>`
        EXPLAIN SELECT chunk_id FROM chunk_embeddings
        WHERE model = ${embedder.model}
        ORDER BY embedding <=> ${toPgvector(padVector([...queryVector]))}::halfvec(1024)
        LIMIT ${K}
      `.execute(conn)
      return explain.rows
        .map((r) => r["QUERY PLAN"])
        .join(" ")
        .includes("hnsw")
    }

    const rows: Array<{ tenants: number; on: ScanSummary; off: ScanSummary; hnsw: boolean }> = []

    for (const tenants of TENANT_COUNTS) {
      // A fresh fixture per sweep point: tenants accumulating across points
      // would make each row's index a different size from its label.
      await cleanup()

      const tenantChunks = new Map<string, Set<string>>()
      for (let t = 0; t < tenants; t++) {
        const orgId = newId("org")
        createdOrgs.push(orgId)
        await db
          .insertInto("organizations")
          .values({ id: orgId, name: `Scan Tenant ${t}` })
          .execute()
        const sourceId = newId("src")
        await db
          .insertInto("sources")
          .values({
            id: sourceId,
            org_id: orgId,
            kind: "url",
            location: `https://tenant-${t}.example`,
          })
          .execute()
        const documentId = newId("doc")
        await db
          .insertInto("documents")
          .values({
            id: documentId,
            org_id: orgId,
            source_id: sourceId,
            url: `https://tenant-${t}.example/docs`,
            title: `Tenant ${t}`,
            // A real sha256 hex: the column CHECKs char_length = 64, because a
            // content hash that is not one would break the recrawl
            // short-circuit that compares them (§3.10.5). The harness has no
            // recrawl, but the schema is the schema.
            content_hash: createHash("sha256").update(orgId).digest("hex"),
          })
          .execute()

        const texts = Array.from(
          { length: CHUNKS_PER_TENANT },
          (_, j) => `Tenant ${t} article ${j}: assorted product documentation prose.`,
        )
        const vectors = await embedder.embed(texts)
        const ids = new Set<string>()
        for (let j = 0; j < texts.length; j++) {
          const chunkId = newId("chk")
          ids.add(chunkId)
          await db
            .insertInto("chunks")
            .values({
              id: chunkId,
              document_id: documentId,
              org_id: orgId,
              ord: j,
              text: texts[j],
              token_count: 12,
              char_start: 0,
              char_end: texts[j].length,
            })
            .execute()
          await db
            .insertInto("chunk_embeddings")
            .values({
              chunk_id: chunkId,
              org_id: orgId,
              model: embedder.model,
              dim: embedder.dim,
              embedding: toPgvector(padVector(vectors[j])),
            })
            .execute()
        }
        tenantChunks.set(orgId, ids)
      }

      // The mock takes no task hint: its vectors are hash-derived, so a
      // document/query distinction would be meaningless — and that sameness is
      // exactly what makes the geometry uniform enough to measure filtering.
      const [queryVector] = await embedder.embed(["how do I configure the product?"])

      const measure = async (iterativeScan: "relaxed_order" | "off"): Promise<ScanSummary> => {
        const outcomes: TenantOutcome[] = []
        for (const [orgId, ownIds] of tenantChunks) {
          const startedAt = Date.now()
          const hits = await denseSearch(conn, {
            orgId,
            model: embedder.model,
            queryVector: queryVector,
            k: K,
            efSearch: EF_SEARCH,
            iterativeScan,
          })
          const latencyMs = Date.now() - startedAt
          // A foreign row would be a filtering bug, not starvation. Loudly,
          // because folding it into recall would hide a tenant leak behind a
          // healthy-looking number.
          for (const hit of hits) {
            if (!ownIds.has(hit.chunkId)) {
              throw new Error(
                `tenant ${orgId} received foreign chunk ${hit.chunkId} — filtering is broken`,
              )
            }
          }
          outcomes.push({ orgId, returned: hits.length, latencyMs })
        }
        return summarizeScan(outcomes, K)
      }

      // Relaxed order first: if the index is healthy it should satisfy every
      // tenant, which is the control for the "off" run that follows.
      const hnsw = await usesHnsw(queryVector)
      const on = await measure("relaxed_order")
      const off = await measure("off")
      rows.push({ tenants, on, off, hnsw })

      console.log(
        `  ${String(tenants).padStart(3)} tenants  ` +
          `(${tenants * CHUNKS_PER_TENANT} vectors)  ` +
          `on: ${on.starved}/${tenants} starved, recall ${(on.recall * 100).toFixed(1)}%  |  ` +
          `off: ${off.starved}/${tenants} starved, recall ${(off.recall * 100).toFixed(1)}%` +
          (hnsw ? "" : "   [NOT HNSW — unmeasured]"),
      )
    }

    // The table, in the shape eval/RESULTS.md publishes it.
    console.log(
      "\n| tenants | vectors | plan | starved (on) | recall (on) | starved (off) | recall (off) | p50 on | p50 off |",
    )
    console.log("|---|---|---|---|---|---|---|---|---|")
    for (const { tenants, on, off, hnsw } of rows) {
      console.log(
        `| ${tenants} | ${tenants * CHUNKS_PER_TENANT} | ${hnsw ? "HNSW" : "exact (unmeasured)"} | ` +
          `${on.starved}/${tenants} | ${(on.recall * 100).toFixed(1)}% | ` +
          `${off.starved}/${tenants} | ${(off.recall * 100).toFixed(1)}% | ` +
          `${on.latencyP50Ms} ms | ${off.latencyP50Ms} ms |`,
      )
    }

    // Only rows that actually ran on the index say anything about the index.
    const measured = rows.filter((r) => r.hnsw)
    const skipped = rows.length - measured.length
    if (skipped > 0) {
      console.log(
        `\n${skipped} of ${rows.length} sweep points did not run on the HNSW index and are ` +
          "reported as unmeasured: an exact plan sorts every matching row, so it cannot starve, " +
          "and publishing its 100% as a finding would say iterative scans are unnecessary.",
      )
    }
    // The WORST measured point, not the last one: the sweep is not monotonic
    // in tenant count once the planner starts changing its mind, so "the
    // biggest fixture" and "the hardest case" are different rows.
    const worst = measured.reduce<(typeof measured)[number] | undefined>(
      (acc, r) => (acc === undefined || r.off.recall < acc.off.recall ? r : acc),
      undefined,
    )
    if (worst !== undefined) {
      console.log(
        `\nWorst measured point: at ${worst.tenants} tenants ` +
          `(${worst.tenants * CHUNKS_PER_TENANT} vectors), turning iterative scans off costs ` +
          `${((worst.on.recall - worst.off.recall) * 100).toFixed(1)} points of recall ` +
          `and starves ${worst.off.starved} of ${worst.tenants} tenants.`,
      )
    }
  } finally {
    await conn.destroy()
    await cleanup()
    await db.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
//#endregion
