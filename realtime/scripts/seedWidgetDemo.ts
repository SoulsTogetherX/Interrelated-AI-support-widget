//#region Imports
// Dev-only CLI: seeds the fixture/demo organization the widget's host
// pages talk to — org, publishable key, allowlisted origins, and content,
// embedded under EMBEDDING_PROVIDER exactly like the worker would (mock by
// default; local for a semantic demo).
//
//   npm run seed-demo                          six-chunk toy corpus (fixtures)
//   npm run seed-demo -- --corpus fastify      the REAL demo: eval/corpus/
//                                              (31 Fastify pages; pair with
//                                              EMBEDDING_PROVIDER=local or
//                                              paraphrase retrieval is dead)
//   npm run seed-demo -- --origin https://x.onrender.com   allowlist an
//                                              extra origin (the deployed
//                                              demo page's own origin)
//
// Idempotent by REPLACEMENT: the demo source is deleted and re-seeded on
// every run (cascades wipe old documents/chunks/embeddings), so the seed
// is always exactly what this file says — no drift, no stale chunks from
// a previous version of the corpus. Same glue-only rule as the sibling
// CLIs.
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
//#endregion

//#region Env fallback
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

//#region Fixture data
const ORG_NAME = "Widget Demo Org"
/** Fixed, obviously-local pk (36 chars, matching the id CHECK shape used
 *  for real keys' public_id column has no such CHECK — but a stable value
 *  the fixture pages can hardcode is the point). NOT a secret: pk values
 *  are public by design (trust model layer, CLAUDE.md). */
const PUBLISHABLE_KEY = "pk_local_demo_widget_fixture_key0"
const FIXTURE_ORIGINS = ["http://localhost:4400", "http://127.0.0.1:4400"]

/** A tiny support corpus. With mock embeddings only EXACT chunk text
 *  retrieves densely (ask the refunds sentence verbatim); run with
 *  EMBEDDING_PROVIDER=local for paraphrase-friendly retrieval. */
const PAGES: ReadonlyArray<{ url: string; title: string; chunks: ReadonlyArray<{ heading: string; text: string }> }> = [
  {
    url: "https://demo.interrelated.example/billing",
    title: "Billing",
    chunks: [
      { heading: "Billing > Refunds", text: "Refunds are processed within five business days of the request." },
      { heading: "Billing > Invoices", text: "Invoices can be downloaded as PDF from the billing tab of the dashboard." },
    ],
  },
  {
    url: "https://demo.interrelated.example/shipping",
    title: "Shipping",
    chunks: [
      { heading: "Shipping > International", text: "International shipping takes up to two weeks after dispatch." },
      { heading: "Shipping > Tracking", text: "A tracking link is emailed as soon as the carrier scans the parcel." },
    ],
  },
  {
    url: "https://demo.interrelated.example/account",
    title: "Account",
    chunks: [
      { heading: "Account > Password", text: "Reset your password from the account settings page." },
      { heading: "Account > Deletion", text: "Account deletion is permanent and completes within thirty days." },
    ],
  },
]
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const corpus = args.includes("--corpus") ? args[args.indexOf("--corpus") + 1] : "toy"
  const extraOrigin = args.includes("--origin") ? args[args.indexOf("--origin") + 1] : undefined
  if (corpus !== "toy" && corpus !== "fastify") {
    console.error(`unknown --corpus "${corpus}" (toy | fastify)`)
    process.exit(1)
  }

  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")

  const embedder = process.env.EMBEDDING_PROVIDER === "local"
    ? new (await import("@providers/embedding/local")).LocalEmbeddingProvider()
    : new MockEmbeddingProvider()

  if (corpus === "fastify" && embedder.model === "mock-384") {
    // Not refused (unlike the eval — this seeds a dev loop, not a
    // measurement), but said loudly: paraphrase retrieval needs semantics.
    console.warn("warning: --corpus fastify with MOCK embeddings — only questions that exactly match chunk text will retrieve. Use EMBEDDING_PROVIDER=local.")
  }

  // ── Org ──────────────────────────────────────────────────────────────────
  let org = await db.selectFrom("organizations").select(["id"]).where("name", "=", ORG_NAME).executeTakeFirst()
  if (!org) {
    org = { id: newId("org") }
    await db.insertInto("organizations").values({ id: org.id, name: ORG_NAME, plan: "pro" }).execute()
    console.log(`created ${ORG_NAME} (${org.id})`)
  }
  // Pro, asserted on every seed rather than only at creation, because the
  // demo org predates the plan being enforced anywhere: since M8.5 the
  // source ceiling is checked at the create routes, free's ceiling is ONE,
  // and this seed already spends a slot on the demo corpus — the
  // playground's guided tour then says "crawl nodejs.org", which on a free
  // demo org would answer 409 at its first step.
  await db.updateTable("organizations").set({ plan: "pro" }).where("id", "=", org.id).execute()

  // ── Publishable key ──────────────────────────────────────────────────────
  const key = await db.selectFrom("api_keys").select(["org_id"])
    .where("kind", "=", "public").where("public_id", "=", PUBLISHABLE_KEY)
    .where("revoked_at", "is", null).executeTakeFirst()
  if (key && key.org_id !== org.id) {
    console.error(`FATAL: ${PUBLISHABLE_KEY} exists under a different org — refusing to reassign`)
    process.exit(1)
  }
  if (!key) {
    await db.insertInto("api_keys").values({
      id: newId("key"), org_id: org.id, kind: "public",
      public_id: PUBLISHABLE_KEY, secret_hash: null, secret_suffix: null,
    }).execute()
    console.log(`created publishable key ${PUBLISHABLE_KEY}`)
  }

  // ── Fixture origins (+ optional deployment origin) ──────────────────────
  const origins = extraOrigin !== undefined ? [...FIXTURE_ORIGINS, extraOrigin] : FIXTURE_ORIGINS
  for (const origin of origins) {
    const existing = await db.selectFrom("allowed_origins").select("origin")
      .where("org_id", "=", org.id).where("origin", "=", origin).executeTakeFirst()
    if (!existing) {
      await db.insertInto("allowed_origins").values({ org_id: org.id, origin }).execute()
      console.log(`allowlisted ${origin}`)
    }
  }

  // ── Corpus: replace wholesale ────────────────────────────────────────────
  await db.deleteFrom("sources").where("org_id", "=", org.id).execute() // cascades docs → chunks → embeddings
  const sourceId = newId("src")
  await db.insertInto("sources").values({
    id: sourceId, org_id: org.id, kind: "url",
    location: corpus === "fastify" ? "https://fastify.dev/docs/latest" : "https://demo.interrelated.example",
    status: "ready",
  }).execute()

  //#region Fastify corpus mode
  // The real demo content: eval/corpus/ through parse → chunk → embed, the
  // same stage-1 shape as the eval harness (runEval.ts §3.14) with real
  // fastify.dev URLs, so demo citations deep-link to live pages. Duplicated
  // glue rather than a shared module: both callers are dev CLIs, and the
  // ~30 lines beat a third place for the ingest shape to live.
  if (corpus === "fastify") {
    const { parseMarkdown } = await import("@/ingest/parsers/markdown")
    const { chunkBlocks } = await import("@shared/chunking/chunker")
    const corpusDir = resolve(__dirname, "../../eval/corpus")
    const urlBase = "https://fastify.dev/docs/latest"

    let totalChunks = 0
    for (const section of ["Reference", "Guides"]) {
      for (const name of readdirSync(join(corpusDir, section)).sort()) {
        if (!name.endsWith(".md")) continue
        const raw = readFileSync(join(corpusDir, section, name), "utf8")
        const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n")
        const doc = parseMarkdown(text)
        const chunks = chunkBlocks(doc.blocks)
        const documentId = newId("doc")
        await db.insertInto("documents").values({
          id: documentId, org_id: org.id, source_id: sourceId,
          url: `${urlBase}/${section}/${name.replace(/\.md$/, "")}/`,
          title: doc.title, content_hash: createHash("sha256").update(text, "utf8").digest("hex"),
        }).execute()

        // Real embedders get the production representation (trail
        // prepended); the mock stays trail-free for the reason in the toy
        // path below.
        const embedTexts = chunks.map((c) =>
          embedder.model === "mock-384" || !c.headingPath ? c.text : `${c.headingPath}\n${c.text}`)
        for (let i = 0; i < chunks.length; i += 32) {
          const vectors = await embedder.embed(embedTexts.slice(i, i + 32))
          for (const [j, chunk] of chunks.slice(i, i + 32).entries()) {
            const chunkId = newId("chk")
            await db.insertInto("chunks").values({
              id: chunkId, org_id: org.id, document_id: documentId, ord: chunk.ord,
              heading_path: chunk.headingPath, text: chunk.text, token_count: chunk.tokenCount,
              char_start: chunk.charStart, char_end: chunk.charEnd,
            }).execute()
            await db.insertInto("chunk_embeddings").values({
              chunk_id: chunkId, org_id: org.id, model: embedder.model, dim: embedder.dim,
              embedding: toPgvector(padVector(vectors[j] as number[])),
            }).execute()
            totalChunks++
          }
        }
      }
    }
    console.log(`seeded the Fastify corpus: ${totalChunks} chunks under model ${embedder.model}`)
    console.log(`\ndemo page: set DEMO_PUBLISHABLE_KEY=${PUBLISHABLE_KEY} and open /demo`)
    await db.destroy()
    return
  }
  //#endregion

  for (const page of PAGES) {
    const documentId = newId("doc")
    const fullText = page.chunks.map((c) => c.text).join("\n\n")
    await db.insertInto("documents").values({
      id: documentId, org_id: org.id, source_id: sourceId, url: page.url, title: page.title,
      content_hash: createHash("sha256").update(fullText).digest("hex"),
    }).execute()

    // Embedding input depends on the provider, and the difference is the
    // mock's whole nature. LOCAL (real) embeddings get the heading trail
    // prepended — the worker's production representation (§3.10.5), where
    // the trail adds context and shifts the vector only slightly. The MOCK
    // hashes its input: prepending the trail doesn't shift the vector, it
    // REPLACES it, and the mock's one retrieval mode — a question that
    // exactly matches stored text — silently dies (the gate then refuses
    // everything, which looks like a widget bug and is not). Trail-free
    // under mock keeps "ask the sentence verbatim" true.
    const embedInput = (c: { heading: string; text: string }) =>
      embedder.model === "mock-384" ? c.text : `${c.heading}\n${c.text}`
    const vectors = await embedder.embed(page.chunks.map(embedInput))
    for (const [i, chunk] of page.chunks.entries()) {
      const chunkId = newId("chk")
      await db.insertInto("chunks").values({
        id: chunkId, org_id: org.id, document_id: documentId, ord: i,
        heading_path: chunk.heading, text: chunk.text,
        token_count: Math.max(1, Math.ceil(chunk.text.length / 4)),
        char_start: null, char_end: null,
      }).execute()
      await db.insertInto("chunk_embeddings").values({
        chunk_id: chunkId, org_id: org.id, model: embedder.model, dim: embedder.dim,
        embedding: toPgvector(padVector(vectors[i] as number[])),
      }).execute()
    }
  }
  console.log(`seeded ${PAGES.length} documents / ${PAGES.reduce((n, p) => n + p.chunks.length, 0)} chunks under model ${embedder.model}`)
  console.log(`\nsnippet:\n<script src="http://localhost:4400/dist/widget.js" async`)
  console.log(`        data-key="${PUBLISHABLE_KEY}" data-api="http://localhost:3000"></script>`)
  await db.destroy()
}

main().catch((err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
