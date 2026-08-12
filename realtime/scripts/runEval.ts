//#region Imports
// The retrieval evaluation harness (`npm run eval`) — the M1 deliverable
// that turns "retrieval works well" from a claim into a measurement, and
// the CI gate that fails the build when it regresses.
//
//   npm run eval                          score all strategies, enforce floor
//   npm run eval -- --ef-search 80        different HNSW candidate width
//   npm run eval -- --sweep-ef 10,20,40,80,120,200   recall-vs-ef curve (CSV)
//   npm run eval -- --target-tokens 800   chunk-size ablation (forces re-ingest)
//   npm run eval -- --no-floor            measure without gating (experiments)
//   npm run eval -- --sweep-threshold     refusal-threshold curve (M2.7): the
//                                         gate signal measured on the golden
//                                         set vs eval/noanswer.jsonl, swept
//                                         over candidate thresholds (CSV)
//
// What it does, in order:
//   1. Ingests eval/corpus/ (committed snapshot, PROVENANCE.md) into a
//      dedicated eval org — parse → chunk → embed → store, the same shape
//      as the worker's page path but reading files instead of crawling.
//      Unchanged files are skipped via content_hash, so repeat runs pay
//      only for retrieval.
//   2. Resolves every golden anchor (eval/golden.jsonl) to concrete chunk
//      ids: the chunks of the anchored document whose text contains the
//      anchor substring (whitespace-normalized). ANY anchor that resolves
//      to zero chunks fails the run — a silently shrunken relevant set
//      would inflate every score.
//   3. Runs dense-only, lexical-only, and hybrid retrieval for all
//      questions and scores them (eval/metrics.ts): recall@1/5/10, MRR@10,
//      nDCG@10 — the dense-vs-hybrid delta is the case for hybrid.
//   4. Enforces the committed floor (eval/floor.json) on hybrid recall@5.
//
// The embedder is ALWAYS the local model (bge-small-en-v1.5, keyless). The
// deterministic mock is refused by name: its vectors carry no semantics, so
// "quality" measured with it is noise — see providers/embedding/mock.ts.
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
//#endregion

//#region Env fallback
// Same fallback as the other CLIs, and the same constraint: this must run
// BEFORE @/db/pool loads (deferred imports in main — CLAUDE.md §3.11).
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

//#region Constants
const EVAL_ORG_NAME = "EVAL HARNESS (do not use)"
const EVAL_SOURCE_URL = "eval://corpus"
const CORPUS_DIR = resolve(__dirname, "../../eval/corpus")
const GOLDEN_PATH = resolve(__dirname, "../../eval/golden.jsonl")
const NOANSWER_PATH = resolve(__dirname, "../../eval/noanswer.jsonl")
const FLOOR_PATH = resolve(__dirname, "../../eval/floor.json")
const RESULTS_DIR = resolve(__dirname, "../../eval/results")
/** Maps a corpus file to the real public docs URL it snapshots, so eval
 *  citations deep-link to pages that exist (see corpus/PROVENANCE.md). */
const URL_BASE = "https://fastify.dev/docs/latest"
const K_REPORT = [1, 5, 10] as const
const RETRIEVE_K = 10
const EMBED_BATCH = 32
//#endregion

//#region Types
interface GoldenEntry {
  id: string
  style: "paraphrase" | "verbatim"
  question: string
  anchors: Array<{ url: string; mustContain: string }>
}

interface NoAnswerEntry {
  id: string
  /** Where refusal difficulty comes from: off_topic questions land far
   *  from the corpus in embedding space; adjacent ones are web-dev
   *  questions the corpus does NOT answer but retrieves plausibly for;
   *  absent_detail ones are Fastify-flavored facts these 31 pages simply
   *  don't contain. The threshold's failures cluster by category, and
   *  RESULTS.md needs to say WHICH kind fails. */
  category: "off_topic" | "adjacent" | "absent_detail"
  question: string
}

interface StrategyResult {
  score: ReturnType<typeof import("@eval/metrics").scoreRun>
  latencyP50Ms: number
  latencyP95Ms: number
}
//#endregion

//#region Helpers
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] as number
}

function parseArgs(argv: readonly string[]): {
  efSearch: number
  targetTokens: number
  sweepEf: number[] | null
  sweepThreshold: boolean
  enforceFloor: boolean
} {
  const num = (flag: string, dflt: number): number => {
    const i = argv.indexOf(flag)
    if (i === -1) return dflt
    const v = Number(argv[i + 1])
    if (!Number.isFinite(v)) throw new Error(`${flag} needs a numeric value`)
    return v
  }
  const sweepIdx = argv.indexOf("--sweep-ef")
  return {
    efSearch: num("--ef-search", 40),
    targetTokens: num("--target-tokens", 400),
    sweepEf: sweepIdx === -1 ? null : String(argv[sweepIdx + 1]).split(",").map(Number),
    sweepThreshold: argv.includes("--sweep-threshold"),
    enforceFloor: !argv.includes("--no-floor"),
  }
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // The refusal, by name, promised in providers/embedding/mock.ts: a
  // quality eval over semantics-free vectors measures nothing.
  if (process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_PROVIDER !== "local") {
    console.error(
      `EMBEDDING_PROVIDER=${process.env.EMBEDDING_PROVIDER} refused: the eval measures retrieval QUALITY, ` +
      "and only the local model (bge-small-en-v1.5) produces real semantics without an API key. " +
      "The mock exists for plumbing tests; its scores here would be noise.",
    )
    process.exit(1)
  }

  const { db } = await import("@/db/pool")
  const { migrateToLatest } = await import("@/db/migrate")
  const { denseSearch, lexicalSearch, hybridSearch } = await import("@/retrieval/search")
  const { parseMarkdown } = await import("@/ingest/parsers/markdown")
  const { chunkBlocks } = await import("@shared/chunking/chunker")
  const { newId } = await import("@shared/utils/ids")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")
  const { scoreRun } = await import("@eval/metrics")
  const { resolveAnchor } = await import("@eval/resolve")
  const { LocalEmbeddingProvider } = await import("@providers/embedding/local")

  await migrateToLatest(db) // idempotent; lets a fresh CI container self-prepare
  const embedder = new LocalEmbeddingProvider()

  //#region Ingest the corpus snapshot
  // Plain consts (not narrowed lets): the ids are captured by the retrieve
  // closures below, where TypeScript would not preserve a let's narrowing.
  const existingOrg = await db.selectFrom("organizations").select(["id"]).where("name", "=", EVAL_ORG_NAME).executeTakeFirst()
  const orgId = existingOrg?.id ?? newId("org")
  if (!existingOrg) {
    await db.insertInto("organizations").values({ id: orgId, name: EVAL_ORG_NAME }).execute()
  }
  const existingSource = await db.selectFrom("sources").select(["id"])
    .where("org_id", "=", orgId).where("location", "=", EVAL_SOURCE_URL).executeTakeFirst()
  const sourceId = existingSource?.id ?? newId("src")
  if (!existingSource) {
    await db.insertInto("sources").values({
      id: sourceId, org_id: orgId, kind: "url", location: EVAL_SOURCE_URL,
    }).execute()
  }

  const files: Array<{ relPath: string; url: string }> = []
  for (const section of ["Reference", "Guides"]) {
    for (const name of readdirSync(join(CORPUS_DIR, section)).sort()) {
      if (!name.endsWith(".md")) continue
      files.push({
        relPath: `${section}/${name}`,
        url: `${URL_BASE}/${section}/${name.replace(/\.md$/, "")}/`,
      })
    }
  }
  if (files.length === 0) throw new Error(`no corpus files found under ${CORPUS_DIR}`)

  let ingested = 0
  let skipped = 0
  for (const file of files) {
    // Same decode normalization as the ingest path: BOM and CRLF must never
    // influence offsets or hashes (parsers/index.ts does this for crawls).
    const raw = readFileSync(join(CORPUS_DIR, file.relPath), "utf8")
    const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n")
    // targetTokens participates in the hash: an ablation run re-chunks even
    // though the text itself is unchanged.
    const contentHash = createHash("sha256")
      .update(`${args.targetTokens}:`).update(text, "utf8").digest("hex")

    const existing = await db.selectFrom("documents").select(["id", "content_hash"])
      .where("source_id", "=", sourceId).where("url", "=", file.url)
      .where("deleted_at", "is", null).executeTakeFirst()
    if (existing && existing.content_hash === contentHash) {
      skipped++
      continue
    }

    const doc = parseMarkdown(text)
    const chunks = chunkBlocks(doc.blocks, { targetTokens: args.targetTokens })
    // Heading trail prepended for embedding, stored text trail-free — the
    // exact convention of the worker (DATAFLOW.md §3.3), because the eval
    // must measure the PRODUCTION representation, not a variant of it.
    const embedTexts = chunks.map((c) => (c.headingPath ? `${c.headingPath}\n${c.text}` : c.text))
    const vectors: string[] = []
    for (let i = 0; i < embedTexts.length; i += EMBED_BATCH) {
      const batch = await embedder.embed(embedTexts.slice(i, i + EMBED_BATCH))
      for (const v of batch) vectors.push(toPgvector(padVector(v)))
    }

    const documentId = existing?.id ?? newId("doc")
    await db.transaction().execute(async (trx) => {
      if (existing) {
        await trx.updateTable("documents")
          .set({ title: doc.title, content_hash: contentHash, fetched_at: new Date() })
          .where("id", "=", existing.id).execute()
        await trx.deleteFrom("chunks").where("document_id", "=", existing.id).execute()
      } else {
        await trx.insertInto("documents").values({
          id: documentId, org_id: orgId, source_id: sourceId,
          url: file.url, title: doc.title, content_hash: contentHash,
        }).execute()
      }
      const chunkRows = chunks.map((chunk) => ({
        id: newId("chk"), org_id: orgId, document_id: documentId,
        ord: chunk.ord, heading_path: chunk.headingPath, text: chunk.text,
        token_count: chunk.tokenCount, char_start: chunk.charStart, char_end: chunk.charEnd,
      }))
      const embeddingRows = chunkRows.map((row, i) => ({
        chunk_id: row.id, org_id: orgId, model: embedder.model,
        dim: embedder.dim, embedding: vectors[i] as string,
      }))
      for (let i = 0; i < chunkRows.length; i += 100) {
        await trx.insertInto("chunks").values(chunkRows.slice(i, i + 100)).execute()
        await trx.insertInto("chunk_embeddings").values(embeddingRows.slice(i, i + 100)).execute()
      }
    })
    ingested++
  }
  console.log(`corpus: ${files.length} files (${ingested} ingested, ${skipped} unchanged)`)
  //#endregion

  //#region Resolve golden anchors to chunk ids
  const golden: GoldenEntry[] = readFileSync(GOLDEN_PATH, "utf8")
    .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as GoldenEntry)

  const failures: string[] = []
  const relevantByQuery = new Map<string, Set<string>>()
  for (const entry of golden) {
    const relevant = new Set<string>()
    for (const anchor of entry.anchors) {
      const rows = await db.selectFrom("chunks")
        .innerJoin("documents", "documents.id", "chunks.document_id")
        .select(["chunks.id", "chunks.text"])
        .where("documents.url", "=", anchor.url)
        .where("documents.deleted_at", "is", null)
        .where("chunks.org_id", "=", orgId)
        .execute()
      if (rows.length === 0) {
        failures.push(`${entry.id}: no document at ${anchor.url}`)
        continue
      }
      const hits = resolveAnchor(rows, anchor.mustContain)
      if (hits.length === 0) {
        failures.push(`${entry.id}: anchor not found in ${anchor.url}: "${anchor.mustContain.slice(0, 60)}…"`)
      }
      for (const hit of hits) relevant.add(hit)
    }
    relevantByQuery.set(entry.id, relevant)
  }
  if (failures.length > 0) {
    // Loud, complete, and fatal: an unresolved anchor means the golden set
    // and the corpus/chunker have drifted apart, and every number scored
    // past this point would be quietly wrong.
    console.error(`\n${failures.length} golden anchors failed to resolve:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  const relevantSizes = [...relevantByQuery.values()].map((s) => s.size)
  console.log(`golden: ${golden.length} questions, ${relevantSizes.reduce((a, b) => a + b, 0)} relevant chunks (max ${Math.max(...relevantSizes)}/question)`)
  //#endregion

  //#region Embed all questions
  const queryVectors = new Map<string, number[]>()
  for (let i = 0; i < golden.length; i += EMBED_BATCH) {
    const batch = golden.slice(i, i + EMBED_BATCH)
    const vecs = await embedder.embed(batch.map((g) => g.question))
    batch.forEach((g, j) => queryVectors.set(g.id, vecs[j] as number[]))
  }
  //#endregion

  //#region Threshold sweep mode (M2.7)
  // The groundedness gate's operating point, chosen by measurement instead
  // of feel: for every candidate threshold t, the FALSE-refusal rate is the
  // share of golden questions (all answerable by construction) whose gate
  // signal exceeds t, and the CORRECT-refusal rate is the share of
  // eval/noanswer.jsonl questions refused at t. The signal is computed by
  // the REAL gate function on REAL hybrid retrievals — a sweep over a
  // reimplementation would calibrate a copy, not the production code path.
  if (args.sweepThreshold) {
    const { evaluateGroundedness } = await import("@/answer/gate")
    const noanswer: NoAnswerEntry[] = readFileSync(NOANSWER_PATH, "utf8")
      .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as NoAnswerEntry)

    async function gateSignal(question: string, vector: number[]): Promise<number> {
      const retrieved = await hybridSearch(db, {
        orgId, queryText: question, queryVector: vector,
        model: embedder.model, k: RETRIEVE_K, efSearch: args.efSearch,
      })
      // Infinity threshold: never refuse on distance, so .signal is the raw
      // min dense distance. A null signal (no dense evidence at all) is
      // refused at EVERY threshold — Infinity models that exactly.
      return evaluateGroundedness(retrieved, Infinity).signal ?? Infinity
    }

    const goldenSignals: number[] = []
    for (const entry of golden) {
      goldenSignals.push(await gateSignal(entry.question, queryVectors.get(entry.id) as number[]))
    }
    const noanswerSignals: Array<{ category: NoAnswerEntry["category"]; signal: number }> = []
    for (let i = 0; i < noanswer.length; i += EMBED_BATCH) {
      const batch = noanswer.slice(i, i + EMBED_BATCH)
      const vecs = await embedder.embed(batch.map((n) => n.question))
      for (const [j, entry] of batch.entries()) {
        noanswerSignals.push({ category: entry.category, signal: await gateSignal(entry.question, vecs[j] as number[]) })
      }
    }

    const stats = (values: readonly number[]): string => {
      const sorted = [...values].sort((a, b) => a - b)
      const pick = (p: number) => (percentile(sorted, p)).toFixed(3)
      return `min ${pick(0)}  p25 ${pick(25)}  median ${pick(50)}  p75 ${pick(75)}  max ${pick(100)}`
    }
    console.log(`\ngate signal (min dense cosine distance), model ${embedder.model}:`)
    console.log(`  golden   (${goldenSignals.length}, answerable)   ${stats(goldenSignals)}`)
    for (const category of ["off_topic", "adjacent", "absent_detail"] as const) {
      const subset = noanswerSignals.filter((n) => n.category === category).map((n) => n.signal)
      console.log(`  ${category.padEnd(13)} (${subset.length}, refuse)  ${stats(subset)}`)
    }

    const rate = (values: readonly number[], t: number): number =>
      values.filter((v) => v > t).length / values.length
    const lines = ["threshold,false_refusal,correct_refusal,cr_off_topic,cr_adjacent,cr_absent_detail"]
    for (let t = 0.30; t <= 1.0001; t += 0.01) {
      const th = Number(t.toFixed(2))
      const by = (category: NoAnswerEntry["category"]) =>
        rate(noanswerSignals.filter((n) => n.category === category).map((n) => n.signal), th)
      lines.push([
        th.toFixed(2),
        rate(goldenSignals, th).toFixed(4),
        rate(noanswerSignals.map((n) => n.signal), th).toFixed(4),
        by("off_topic").toFixed(4), by("adjacent").toFixed(4), by("absent_detail").toFixed(4),
      ].join(","))
    }
    mkdirSync(RESULTS_DIR, { recursive: true })
    const csvPath = join(RESULTS_DIR, "threshold-sweep.csv")
    writeFileSync(csvPath, lines.join("\n") + "\n")
    console.log(`\nsweep written to ${csvPath}`)

    // The two candidate operating points, printed with their trade: the
    // conservative point refuses NO answerable question; the aggressive one
    // spends one false refusal (1/80) to catch more unanswerables. The
    // CHOICE between them is a product judgment recorded in gate.ts and
    // RESULTS.md — this tool only surfaces the frontier.
    const sortedGolden = [...goldenSignals].sort((a, b) => a - b)
    const maxGolden = sortedGolden.at(-1) as number
    const secondMaxGolden = sortedGolden.at(-2) as number
    for (const [label, t] of [["FR=0 (conservative)", maxGolden + 0.005], ["FR=1/80 (aggressive)", secondMaxGolden + 0.005]] as const) {
      const all = rate(noanswerSignals.map((n) => n.signal), t)
      console.log(
        `${label}: threshold ${t.toFixed(3)} → correct-refusal ${(all * 100).toFixed(1)}% ` +
        `(off_topic ${(rate(noanswerSignals.filter((n) => n.category === "off_topic").map((n) => n.signal), t) * 100).toFixed(0)}%, ` +
        `adjacent ${(rate(noanswerSignals.filter((n) => n.category === "adjacent").map((n) => n.signal), t) * 100).toFixed(0)}%, ` +
        `absent_detail ${(rate(noanswerSignals.filter((n) => n.category === "absent_detail").map((n) => n.signal), t) * 100).toFixed(0)}%)`,
      )
    }
    await db.destroy()
    return
  }
  //#endregion

  //#region Score strategies
  async function runStrategy(
    name: string,
    retrieve: (entry: GoldenEntry) => Promise<string[]>,
  ): Promise<StrategyResult> {
    const judgments = []
    const latencies: number[] = []
    for (const entry of golden) {
      const started = performance.now()
      const ranked = await retrieve(entry)
      latencies.push(performance.now() - started)
      judgments.push({ relevant: relevantByQuery.get(entry.id) as Set<string>, ranked })
    }
    latencies.sort((a, b) => a - b)
    const result = {
      score: scoreRun(judgments, [...K_REPORT]),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
    }
    console.log(
      `${name.padEnd(8)} recall@1 ${fmt(result.score.recall[1])}  @5 ${fmt(result.score.recall[5])}  ` +
      `@10 ${fmt(result.score.recall[10])}  MRR@10 ${fmt(result.score.mrr10)}  nDCG@10 ${fmt(result.score.ndcg10)}  ` +
      `p50 ${result.latencyP50Ms.toFixed(0)}ms p95 ${result.latencyP95Ms.toFixed(0)}ms`,
    )
    return result
  }
  const fmt = (v: number | undefined): string => ((v ?? 0) * 100).toFixed(1).padStart(5)

  //#region ef sweep mode
  if (args.sweepEf) {
    console.log("\nef_search,dense_recall@5,dense_recall@10,hybrid_recall@5,hybrid_recall@10")
    for (const ef of args.sweepEf) {
      const dense = await runStrategy(`d ef=${ef}`, async (e) =>
        (await denseSearch(db, { orgId: orgId, model: embedder.model, queryVector: queryVectors.get(e.id) as number[], k: RETRIEVE_K, efSearch: ef })).map((h) => h.chunkId))
      const hybrid = await runStrategy(`h ef=${ef}`, async (e) =>
        (await hybridSearch(db, { orgId: orgId, queryText: e.question, queryVector: queryVectors.get(e.id) as number[], model: embedder.model, k: RETRIEVE_K, efSearch: ef })).map((r) => r.chunkId))
      console.log(`${ef},${fmt(dense.score.recall[5]).trim()},${fmt(dense.score.recall[10]).trim()},${fmt(hybrid.score.recall[5]).trim()},${fmt(hybrid.score.recall[10]).trim()}`)
    }
    await db.destroy()
    return
  }
  //#endregion

  console.log(`\nscoring ${golden.length} questions, k=${RETRIEVE_K}, ef_search=${args.efSearch}, targetTokens=${args.targetTokens}\n`)
  const dense = await runStrategy("dense", async (e) =>
    (await denseSearch(db, { orgId: orgId, model: embedder.model, queryVector: queryVectors.get(e.id) as number[], k: RETRIEVE_K, efSearch: args.efSearch })).map((h) => h.chunkId))
  const lexical = await runStrategy("lexical", async (e) =>
    (await lexicalSearch(db, { orgId: orgId, query: e.question, k: RETRIEVE_K })).map((h) => h.chunkId))
  const hybrid = await runStrategy("hybrid", async (e) =>
    (await hybridSearch(db, { orgId: orgId, queryText: e.question, queryVector: queryVectors.get(e.id) as number[], model: embedder.model, k: RETRIEVE_K, efSearch: args.efSearch })).map((r) => r.chunkId))
  //#endregion

  //#region Failure listing (for RESULTS.md analysis)
  const missed: string[] = []
  for (const entry of golden) {
    const results = await hybridSearch(db, {
      orgId: orgId, queryText: entry.question,
      queryVector: queryVectors.get(entry.id) as number[],
      model: embedder.model, k: RETRIEVE_K, efSearch: args.efSearch,
    })
    const relevant = relevantByQuery.get(entry.id) as Set<string>
    if (!results.some((r) => relevant.has(r.chunkId))) {
      missed.push(`${entry.id} [${entry.style}] "${entry.question}" → top hit: ${results[0]?.url ?? "(none)"}`)
    }
  }
  if (missed.length > 0) {
    console.log(`\nhybrid misses at k=${RETRIEVE_K} (${missed.length}/${golden.length}):`)
    for (const m of missed) console.log(`  - ${m}`)
  }
  //#endregion

  //#region Persist + floor
  mkdirSync(RESULTS_DIR, { recursive: true })
  const results = {
    corpus: { files: files.length, questions: golden.length },
    params: { efSearch: args.efSearch, targetTokens: args.targetTokens, k: RETRIEVE_K, model: embedder.model },
    dense, lexical, hybrid,
    missedAtK: missed,
  }
  const resultsPath = join(RESULTS_DIR, "latest.json")
  writeFileSync(resultsPath, JSON.stringify(results, null, 2))
  console.log(`\nresults written to ${resultsPath}`)

  if (args.enforceFloor) {
    let floor: { hybridRecallAt5: number } | null = null
    try {
      floor = JSON.parse(readFileSync(FLOOR_PATH, "utf8")) as { hybridRecallAt5: number }
    } catch {
      console.warn("no eval/floor.json — floor not enforced (bootstrap mode). Commit one to arm the CI gate.")
    }
    if (floor) {
      const measured = hybrid.score.recall[5] ?? 0
      if (measured < floor.hybridRecallAt5) {
        console.error(
          `\nFLOOR VIOLATION: hybrid recall@5 ${(measured * 100).toFixed(1)}% < floor ${(floor.hybridRecallAt5 * 100).toFixed(1)}%`,
        )
        process.exit(1)
      }
      console.log(`floor ok: hybrid recall@5 ${(measured * 100).toFixed(1)}% ≥ ${(floor.hybridRecallAt5 * 100).toFixed(1)}%`)
    }
  }
  //#endregion

  await db.destroy()
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
//#endregion
