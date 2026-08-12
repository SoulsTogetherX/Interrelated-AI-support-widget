//#region Imports
// Dev-only CLI: seeds the fixture/demo organization the widget's host
// pages talk to — org, publishable key, allowlisted fixture origins, and a
// small documentation corpus, embedded under EMBEDDING_PROVIDER exactly
// like the worker would (mock by default; local for a semantic demo).
//
//   npm run seed-demo
//
// Idempotent by REPLACEMENT: the demo source is deleted and re-seeded on
// every run (cascades wipe old documents/chunks/embeddings), so the seed
// is always exactly what this file says — no drift, no stale chunks from
// a previous version of the corpus. Same glue-only rule as the sibling
// CLIs.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
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
  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")

  const embedder = process.env.EMBEDDING_PROVIDER === "local"
    ? new (await import("@providers/embedding/local")).LocalEmbeddingProvider()
    : new MockEmbeddingProvider()

  // ── Org ──────────────────────────────────────────────────────────────────
  let org = await db.selectFrom("organizations").select(["id"]).where("name", "=", ORG_NAME).executeTakeFirst()
  if (!org) {
    org = { id: newId("org") }
    await db.insertInto("organizations").values({ id: org.id, name: ORG_NAME }).execute()
    console.log(`created ${ORG_NAME} (${org.id})`)
  }

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
      public_id: PUBLISHABLE_KEY, secret_hash: null,
    }).execute()
    console.log(`created publishable key ${PUBLISHABLE_KEY}`)
  }

  // ── Fixture origins ──────────────────────────────────────────────────────
  for (const origin of FIXTURE_ORIGINS) {
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
    location: "https://demo.interrelated.example", status: "ready",
  }).execute()

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
