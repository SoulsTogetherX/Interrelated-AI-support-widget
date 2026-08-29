//#region Why this file (M9, scratch-grade — generalize or delete at closeout)
// Embeds an org's EXISTING chunks under its saved embedding credential,
// without crawling anything. It exists because the deployed demo needs its
// corpus in the same vector space as its queries, and the two obvious
// routes both fail on a metered free tier:
//
//   - The re-index route (credential save → §3.22 queues a crawl) RE-CRAWLS
//     the live site. That re-chunks every page, drags in pages the curated
//     corpus never had (fastify.dev/ecosystem/), and spends quota on
//     content the demo does not want.
//   - The worker's own retry (§3.10.5a) is the right fix for a TRANSIENT
//     429, but it cannot help a page whose chunk count exceeds a whole
//     per-minute allowance: one page here holds 117 chunks against a
//     ~100-item minute, so the page needs more than a minute no matter how
//     patiently each batch is retried.
//
// So this PACES ITSELF UNDER the limit instead of discovering it: batches
// of 8 with a deliberate wait between them, targeting ~80 items/minute
// against the free tier's ~100, with the patient retry still underneath as
// the safety net. Deterministic, and it spends exactly one item per chunk —
// 688 chunks against a 1,000/day bucket, once.
//
// Resumable by construction: it only embeds chunks with no row under the
// target model, so an interrupted run continues where it stopped, and a
// finished run is a no-op.
//
// Usage (env carries .env.neon's POSTGRES_* + POSTGRES_SSL=true and
// CREDENTIAL_MASTER_KEY, as the sibling scripts document):
//   npx tsx --tsconfig tsconfig.json scripts/embedExistingChunks.ts <orgId>
//#endregion

const BATCH = 8
/** ~80 items/minute against the free tier's ~100 — deliberately under, so
 *  the retry underneath is a safety net rather than the mechanism. */
const PAUSE_MS = 6_000

async function main(): Promise<void> {
  const orgId = process.argv[2]
  if (orgId === undefined || !orgId.startsWith("org_")) {
    console.error("usage: embedExistingChunks.ts <orgId>")
    process.exit(1)
  }

  const { db } = await import("@/db/pool")
  const { resolveEmbeddingProvider } = await import("@/credentials/resolve")
  const { withRetry } = await import("@/answer/retry")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")

  try {
    const embedder = await resolveEmbeddingProvider(db, orgId)
    if (embedder === null) throw new Error(`org ${orgId} has no embedding credential`)
    console.log(`embedder: ${embedder.model} (${embedder.dim}-d)`)

    // Only chunks missing a vector under THIS model — the resume property.
    // heading_path is prepended exactly as the worker does (§3.10.5), or the
    // demo's vectors would not match what production would have written.
    const pending = await db
      .selectFrom("chunks")
      .innerJoin("documents", "documents.id", "chunks.document_id")
      .select(["chunks.id", "chunks.text", "chunks.heading_path"])
      .where("chunks.org_id", "=", orgId)
      .where("documents.deleted_at", "is", null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("chunk_embeddings")
              .select("chunk_embeddings.chunk_id")
              .whereRef("chunk_embeddings.chunk_id", "=", "chunks.id")
              .where("chunk_embeddings.model", "=", embedder.model),
          ),
        ),
      )
      .orderBy("chunks.id")
      .execute()

    console.log(
      `${pending.length} chunks to embed, ${BATCH} per call, ~${PAUSE_MS / 1000}s between calls`,
    )
    if (pending.length === 0) {
      console.log("nothing to do — the corpus is already embedded under this model")
      return
    }
    const started = Date.now()

    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH)
      const texts = batch.map((c) => (c.heading_path ? `${c.heading_path}\n${c.text}` : c.text))

      const vectors = await withRetry(
        () => embedder.embed(texts, { task: "document" }),
        {
          onRetry: ({ attempt, delayMs, error }) => {
            const why = error instanceof Error ? error.message.slice(0, 70) : String(error)
            console.log(`    retry ${attempt} in ${Math.round(delayMs / 1000)}s — ${why}`)
          },
        },
        // Longer base than the worker's: what is being absorbed here is a
        // per-MINUTE window, and a 2s first wait just spends an attempt.
        { maxAttempts: 8, budgetMs: 420_000, baseDelayMs: 15_000, maxDelayMs: 90_000 },
      )

      await db
        .insertInto("chunk_embeddings")
        .values(
          batch.map((c, j) => ({
            chunk_id: c.id,
            org_id: orgId,
            model: embedder.model,
            dim: embedder.dim,
            embedding: toPgvector(padVector(vectors[j])),
          })),
        )
        .onConflict((oc) => oc.columns(["chunk_id", "model"]).doNothing())
        .execute()

      const done = Math.min(i + BATCH, pending.length)
      const rate = done / ((Date.now() - started) / 60_000)
      console.log(`  ${done}/${pending.length} embedded (${rate.toFixed(0)}/min)`)
      if (done < pending.length) await new Promise((r) => setTimeout(r, PAUSE_MS))
    }

    console.log(`DONE: ${pending.length} chunks embedded under ${embedder.model}`)
  } finally {
    await db.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

export {}
