//#region Imports
// Dev-only CLI: runs hybrid retrieval against ingested content, so the whole
// M1 pipeline — enqueue → crawl → embed → RETRIEVE — can be exercised by
// hand before any chat surface exists (that arrives in M2).
//
//   npm run search -- "how do refunds work" [--org "Name"] [--k 8] [--dense-only]
//
// Like enqueueSource.ts, this is glue over the same calls the integration
// tests make — no logic of its own to drift. The embedder comes from
// EMBEDDING_PROVIDER exactly as the ingest worker's does; querying with a
// different model than ingest used finds nothing (different vector spaces),
// which is why the model-coverage warning below exists.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
//#endregion

//#region Env fallback
// Same fallback as enqueueSource.ts: pull Postgres vars from the repo-root
// .env when unset. Must happen BEFORE @/db/pool loads (it reads env at
// module load), hence the require()s in main() below rather than top-level
// imports.
if (!process.env.POSTGRES_PASSWORD) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../../.env"), "utf8")
    for (const line of envFile.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1] as string] === undefined) {
        process.env[match[1] as string] = match[2] as string
      }
    }
  } catch {
    // No .env — the pool will fail to connect and say so below.
  }
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const query = args.find((a) => !a.startsWith("--"))
  if (!query) {
    console.error('usage: npm run search -- "<question>" [--org "Name"] [--k N] [--dense-only]')
    process.exit(1)
  }
  const orgName = args.includes("--org") ? (args[args.indexOf("--org") + 1] ?? "Local Dev Org") : "Local Dev Org"
  const k = args.includes("--k") ? Number(args[args.indexOf("--k") + 1]) : 8
  const denseOnly = args.includes("--dense-only")

  // Deferred imports: see the env-fallback note above.
  const { db } = await import("@/db/pool")
  const { denseSearch, hybridSearch } = await import("@/retrieval/search")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")

  const fallbackEmbedder = process.env.EMBEDDING_PROVIDER === "local"
    ? new (await import("@providers/embedding/local")).LocalEmbeddingProvider()
    : new MockEmbeddingProvider()

  const org = await db.selectFrom("organizations").select(["id"]).where("name", "=", orgName).executeTakeFirst()
  if (!org) {
    console.error(`no organization named "${orgName}" — run npm run enqueue first, or pass --org`)
    process.exit(1)
  }

  // An org with a BYO embedding credential is queried under ITS model —
  // the same resolution the chat route and the ingest worker do (§3.21),
  // because a CLI that quietly used a different model would report the
  // one failure this whole path exists to prevent.
  const { resolveEmbeddingProvider } = await import("@/credentials/resolve")
  const embedder = (await resolveEmbeddingProvider(db, org.id)) ?? fallbackEmbedder
  if (embedder !== fallbackEmbedder) {
    console.log(`using the org's saved embedding model: ${embedder.model}`)
  }

  // The most common dev-loop mistake: ingesting under one EMBEDDING_PROVIDER
  // and querying under another. Say so instead of printing zero results.
  const covered = await db
    .selectFrom("chunk_embeddings")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where("org_id", "=", org.id)
    .where("model", "=", embedder.model)
    .executeTakeFirst()
  if (Number(covered?.n ?? 0) === 0) {
    console.warn(`warning: org has no embeddings under model "${embedder.model}" — was the content ingested with a different EMBEDDING_PROVIDER?`)
  }

  const [queryVector] = await embedder.embed([query], { task: "query" })
  const started = Date.now()

  if (denseOnly) {
    const hits = await denseSearch(db, {
      orgId: org.id, model: embedder.model, queryVector: queryVector as number[], k,
    })
    console.log(`dense-only, ${hits.length} results in ${Date.now() - started}ms (model ${embedder.model})\n`)
    hits.forEach((h, i) => console.log(`  ${i + 1}. distance ${h.distance.toFixed(4)}  ${h.chunkId}`))
  } else {
    const results = await hybridSearch(db, {
      orgId: org.id, queryText: query, queryVector: queryVector as number[], model: embedder.model, k,
    })
    console.log(`hybrid, ${results.length} results in ${Date.now() - started}ms (model ${embedder.model})\n`)
    for (const [i, r] of results.entries()) {
      const arms = [
        r.denseRank ? `D#${r.denseRank} d=${r.denseDistance?.toFixed(4)}` : "D–",
        r.lexicalRank ? `L#${r.lexicalRank}` : "L–",
      ].join(" ")
      const preview = r.text.length > 100 ? `${r.text.slice(0, 100)}…` : r.text
      console.log(`  ${i + 1}. rrf=${r.score.toFixed(5)}  [${arms}]  ${r.headingPath ?? "(no heading)"}`)
      console.log(`     ${r.url}`)
      console.log(`     ${preview.replace(/\n/g, " ")}\n`)
    }
  }
  await db.destroy()
}

main().catch((err) => {
  console.error("search failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
