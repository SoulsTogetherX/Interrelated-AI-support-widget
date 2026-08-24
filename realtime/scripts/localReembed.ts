//#region Why this file (scratch-grade, but in realtime/ for the tsx paths)
// One-off M9 driver: run the demo org's Gemini re-index from THIS machine
// against the deployed Neon database, because Render's shared egress IP is
// throttled by Gemini's per-user(=IP) free-tier quota — measured 2026-08-23:
// the worker's 32-item batches 429'd 35/35 times over 90 minutes from
// Render while byte-identical requests succeeded from here, and even
// 1-item calls fail ~1/3 of the time there. Bulk embedding therefore runs
// off-box; the job is inserted DIRECTLY (no wake), so Render's wake-driven
// worker never claims it, and the REAL worker runs here with the REAL
// resolver (vault decrypt → the org's saved credential) and the REAL
// crawler under its secure defaults — fastify.dev is public, politeness
// intact. Rounds ratchet: pages already embedded under the target model
// short-circuit (§3.10.5), so each round makes forward progress even when
// this IP's own 100/min per-item quota trips mid-run.
//
// Usage (env must carry .env.neon's POSTGRES_* + POSTGRES_SSL=true and
// CREDENTIAL_MASTER_KEY before the pool loads — the caller exports them):
//   npx tsx --tsconfig tsconfig.json scripts/localReembed.ts
//#endregion

const ORG = "org_zqgayj3hwt2nfcrd3twmg0n5qwy7kyb1"
const SRC = "src_bz6t7wmcppdbp1mag0cmqm4r6e294j4d"
const MAX_ROUNDS = 12
const ROUND_WAIT_MS = 90_000

async function main(): Promise<void> {
  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")
  const { IngestWorker } = await import("@/ingest/worker")
  const { resolveEmbeddingProvider } = await import("@/credentials/resolve")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")

  const status = async () => {
    const gem = await db
      .selectFrom("chunk_embeddings")
      .select(db.fn.countAll().as("n"))
      .where("org_id", "=", ORG)
      .where("model", "=", "gemini-embedding-001")
      .executeTakeFirstOrThrow()
    const chunks = await db
      .selectFrom("chunks")
      .innerJoin("documents", "documents.id", "chunks.document_id")
      .select(db.fn.countAll().as("n"))
      .where("chunks.org_id", "=", ORG)
      .where("documents.deleted_at", "is", null)
      .executeTakeFirstOrThrow()
    return { gem: Number(gem.n), chunks: Number(chunks.n) }
  }

  const worker = new IngestWorker({
    db,
    // Fallback embedder — never used: the org HAS an embedding credential,
    // and a resolver failure must fail loudly, not silently mock-embed.
    embedder: new MockEmbeddingProvider(),
    resolveEmbedder: (orgId: string) => resolveEmbeddingProvider(db, orgId),
    // Small batches on purpose (default is 32): the free tier's DAILY item
    // bucket is 1,000/project, and whether a REFUSED batch bills it is
    // unproven — so the strategy is to minimize refused items, not to
    // burst. 8 items ≈ 3k tokens per call also stays far under any
    // per-minute window between the crawl's politeness-paced pages.
    embedBatchSize: 8,
  })

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // Ensure exactly one queued job for OUR source. Direct insert — no
      // wake — so the deployed worker never hears about it.
      const live = await db
        .selectFrom("ingest_jobs")
        .select(["id", "state"])
        .where("source_id", "=", SRC)
        .where("state", "in", ["queued", "running"])
        .executeTakeFirst()
      if (!live) {
        await db.insertInto("ingest_jobs").values({ id: newId("job"), org_id: ORG, source_id: SRC }).execute()
      }

      console.log(`[round ${round}] tick…`)
      await worker.tick()

      const job = await db
        .selectFrom("ingest_jobs")
        .select(["state", "docs_done", "skipped_count", "error"])
        .where("org_id", "=", ORG)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirstOrThrow()
      const s = await status()
      console.log(
        `[round ${round}] job=${job.state} docs=${job.docs_done} skipped=${job.skipped_count} ` +
          `gemini=${s.gem}/${s.chunks}` +
          (job.error ? ` err=${String(job.error).slice(0, 90)}` : ""),
      )

      if (job.state === "done") {
        console.log(`LOCAL REEMBED DONE: ${s.gem}/${s.chunks} chunks under gemini-embedding-001`)
        return
      }
      if (job.state === "failed" && !String(job.error ?? "").includes("429")) {
        throw new Error(`non-quota failure, stopping: ${job.error}`)
      }
      console.log(`  429 — waiting ${ROUND_WAIT_MS / 1000}s for this IP's per-minute window`)
      await new Promise((r) => setTimeout(r, ROUND_WAIT_MS))
    }
    throw new Error(`did not finish inside ${MAX_ROUNDS} rounds`)
  } finally {
    await db.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

// Every import here is dynamic (the env-before-pool rule), so without this
// the file is a global SCRIPT rather than a module and its `main` collides
// with every sibling that does the same.
export {}
