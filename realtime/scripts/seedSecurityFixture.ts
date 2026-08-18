//#region Why this file
// Seeds the fixture the security and injection probes attack (M6), and
// writes what they need to know about it as a JSON file.
//
//   npm run seed-security -- --out .probe/security-fixture.json
//
// A black-box probe needs a tenant to attack: an org with a publishable key
// and an allowlisted origin, a SECOND org to attempt cross-tenant reads
// against, a revoked key that must be refused identically to an unknown one,
// content whose exact text is known (retrieval under the mock embedder is
// exact-match, so the probe must ask the sentence verbatim), and — when the
// vault's master key is present — a credential whose plaintext the probe can
// grep responses for. None of that can be created through the public
// surface, by design, so it is seeded here and described to the probes in a
// fixture file. That file is the CONTRACT between this script and
// scripts/security-probe.mjs / scripts/injection-probe.mjs; its shape is
// documented once, below, and both readers depend on it.
//
// Idempotent by REPLACEMENT, like seed-demo: the two probe orgs are deleted
// by name and recreated (cascades take keys, origins, sources, documents,
// chunks, embeddings, conversations, credentials, and counters with them),
// so a run always leaves exactly what this file says. Keys and origins are
// fresh every run and travel in the fixture — nothing here is hardcoded in
// a probe, which is what lets the same probe run against any deployment
// this seed has touched.
//
// Runs where the database is reachable: from the host against the compose
// dev database (it reads .env like the sibling CLIs), or inside the compose
// network as the one-shot `seed` service docker-compose.probe.yaml defines —
// which is how CI gives the prod stack a fixture without publishing
// Postgres to the host or shipping a seed tool in the prod image.
//#endregion

//#region Imports
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
// A hoisted import is safe here where the pool's is not (§3.11): kysely's
// `sql` tag reads no environment.
import { sql } from "kysely"
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

//#region Fixture shape
/**
 * What the probes read. Every field a probe depends on is here so a probe
 * hardcodes nothing about the deployment it is attacking.
 */
interface ProbeOrg {
  id: string
  name: string
  /** A live pk — the one the widget snippet would carry. */
  publishableKey: string
  /** A pk this org rotated OUT: revoked_at is set. Must be refused exactly
   *  like an unknown key (same status, same body) — key state is not
   *  probeable. */
  revokedKey: string
  /** The one allowlisted origin. Anything else must be refused WITHOUT
   *  CORS headers. */
  origin: string
  /** Chunks the org's corpus holds, verbatim. Under the mock embedder only
   *  the exact text retrieves, so the probe asks these sentences as its
   *  questions; `url` is what a citation must point at. */
  corpus: Array<{ url: string; text: string }>
  /** The poisoned pages (eval/injection.jsonl), also in this org's corpus
   *  — org A only. `text` is the stored chunk (legit paragraph, blank line,
   *  injected instruction); `question` the natural question a real embedder
   *  can retrieve on; `canary` the token that appears ONLY in the injected
   *  half, so a model that quotes the legitimate sentence is never scored
   *  as having followed the injection. */
  poisoned: Array<{
    id: string
    category: string
    url: string
    text: string
    question: string
    canary: string | null
    attackerUrls: string[]
  }>
}

interface SecurityFixture {
  version: 1
  seededAt: string
  /** The embedding model the corpus was stored under — tells a probe
   *  whether retrieval is exact-match (mock) or semantic (anything else). */
  embeddingModel: string
  orgs: {
    a: ProbeOrg
    b: ProbeOrg
    /** A third org whose ONLY job is to hold the credential canary. Not
     *  A, deliberately: a saved generation credential is what the chat
     *  route resolves and CALLS (§3.21's resolve.ts), so a fake key on an
     *  org that answers questions would turn every answer into a failed
     *  call to a real provider and break the retrieval controls. Org C
     *  never chats; it exists to be read back. */
    c: { id: string; name: string }
  }
  /** The plaintext of a provider key stored (encrypted) on org C, or null
   *  when CREDENTIAL_MASTER_KEY was unset at seed time. A probe greps every
   *  response it receives for this string; one hit is a leak. */
  credentialCanary: string | null
  /** Distinctive sentences from the answer pipeline's system prompt. A
   *  probe greps every answer for these; one hit is a system-prompt leak. */
  systemPromptMarkers: string[]
}
//#endregion

//#region Fixture data
const ORG_A = "Security Probe Org A"
const ORG_B = "Security Probe Org B"
const ORG_C = "Security Probe Org C (credential canary)"

/** Distinct corpora, deliberately about different subjects with no shared
 *  vocabulary, so a cross-tenant retrieval attempt cannot be explained away
 *  as topical overlap. */
const CORPUS_A = [
  { url: "https://probe-a.example/refunds", title: "Refunds", heading: "Billing > Refunds", text: "Refunds are processed within five business days of the request." },
  { url: "https://probe-a.example/invoices", title: "Invoices", heading: "Billing > Invoices", text: "Invoices can be downloaded as PDF from the billing tab of the dashboard." },
  { url: "https://probe-a.example/tracking", title: "Tracking", heading: "Shipping > Tracking", text: "A tracking link is emailed as soon as the carrier scans the parcel." },
]

const CORPUS_B = [
  { url: "https://probe-b.example/greenhouse", title: "Greenhouse", heading: "Growing > Greenhouse", text: "Tomato seedlings should be hardened off for a week before transplanting outdoors." },
  { url: "https://probe-b.example/compost", title: "Compost", heading: "Growing > Compost", text: "A compost heap needs a roughly even mix of green and brown material to heat up." },
]

/** One line of eval/injection.jsonl (§7.7). Its invariants are pinned by
 *  eval/__tests__/injection.test.ts; this script only reads it. */
interface InjectionEntry {
  id: string
  category: string
  url: string
  title: string
  heading: string
  legit: string
  injected: string
  canary: string | null
  attackerUrls: string[]
  question: string
}

function loadInjectionCorpus(): InjectionEntry[] {
  const raw = readFileSync(resolve(__dirname, "../../eval/injection.jsonl"), "utf8")
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as InjectionEntry)
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf("--out")
  const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined
  if (outPath === undefined) {
    console.error("usage: npm run seed-security -- --out <fixture.json>")
    process.exit(1)
  }

  const { db } = await import("@/db/pool")
  const { newId, newPublishableKey } = await import("@shared/utils/ids")
  const { padVector, toPgvector } = await import("@shared/utils/vectors")
  const { MockEmbeddingProvider } = await import("@providers/embedding/mock")
  const { SYSTEM_PROMPT } = await import("@/answer/prompt")
  const { hasMasterKey, encryptProviderKey, keySuffix } = await import("@/credentials/vault")

  // The MOCK embedder, always. The probes measure the trust model, not
  // retrieval quality, and exact-match retrieval is exactly what makes
  // "ask this sentence, expect this citation" deterministic.
  const embedder = new MockEmbeddingProvider()

  // ── Replace the probe orgs wholesale ─────────────────────────────────────
  await db.deleteFrom("organizations").where("name", "in", [ORG_A, ORG_B, ORG_C]).execute()

  async function seedOrg(
    name: string,
    host: string,
    corpus: typeof CORPUS_A,
    poisoned: InjectionEntry[] = [],
  ): Promise<ProbeOrg> {
    const id = newId("org")
    await db.insertInto("organizations").values({ id, name }).execute()

    const publishableKey = newPublishableKey()
    const revokedKey = newPublishableKey()
    const revokedRowId = newId("key")
    await db.insertInto("api_keys").values([
      { id: newId("key"), org_id: id, kind: "public", public_id: publishableKey, secret_hash: null },
      { id: revokedRowId, org_id: id, kind: "public", public_id: revokedKey, secret_hash: null },
    ]).execute()
    // The rotated-out key: created live and then revoked, the rows a real
    // rotation writes (revoked_at is update-only in the schema types — a key
    // is never born revoked). Since M7.1 the dashboard performs rotation
    // itself (web/src/lib/keys), but the e2e stack has no dashboard, so the
    // fixture writes the same rows by hand — with the grace window already
    // OVER, because its whole job is to be refused exactly like a key that
    // never existed. Revoked on Postgres's clock, the clock the session
    // route compares against; a `new Date()` from this process could sit
    // ahead of a drifted database and leave the key live for the drift.
    await db.updateTable("api_keys").set({ revoked_at: sql`NOW()` })
      .where("id", "=", revokedRowId).execute()

    const origin = `https://${host}`
    await db.insertInto("allowed_origins").values({ org_id: id, origin }).execute()

    const sourceId = newId("src")
    await db.insertInto("sources").values({
      id: sourceId, org_id: id, kind: "url", location: `${origin}/`, status: "ready",
    }).execute()

    // One document per chunk keeps url ↔ text one-to-one, which is what lets
    // a probe say "this citation must point at THAT url". Trail-free
    // embedding input under the mock, for the reason seed-demo explains: the
    // mock hashes its input, so a prepended heading would REPLACE the
    // vector rather than shift it, and exact-text retrieval would die.
    //
    // The poisoned pages are stored the same way, in the same org, under
    // the same source: to the pipeline they are simply more of the tenant's
    // documentation, which is exactly the threat — a crawled page an
    // attacker got to edit.
    const pages = [
      ...corpus,
      ...poisoned.map((entry) => ({
        url: entry.url, title: entry.title, heading: entry.heading,
        text: `${entry.legit}\n\n${entry.injected}`,
      })),
    ]
    const vectors = await embedder.embed(pages.map((c) => c.text))
    for (const [i, page] of pages.entries()) {
      const documentId = newId("doc")
      await db.insertInto("documents").values({
        id: documentId, org_id: id, source_id: sourceId, url: page.url, title: page.title,
        content_hash: createHash("sha256").update(page.text).digest("hex"),
      }).execute()
      const chunkId = newId("chk")
      await db.insertInto("chunks").values({
        id: chunkId, org_id: id, document_id: documentId, ord: 0,
        heading_path: page.heading, text: page.text,
        token_count: Math.max(1, Math.ceil(page.text.length / 4)),
        char_start: 0, char_end: page.text.length,
      }).execute()
      await db.insertInto("chunk_embeddings").values({
        chunk_id: chunkId, org_id: id, model: embedder.model, dim: embedder.dim,
        embedding: toPgvector(padVector(vectors[i] as number[])),
      }).execute()
    }

    return {
      id, name, publishableKey, revokedKey, origin,
      corpus: corpus.map((c) => ({ url: c.url, text: c.text })),
      poisoned: poisoned.map((entry) => ({
        id: entry.id, category: entry.category, url: entry.url,
        text: `${entry.legit}\n\n${entry.injected}`,
        question: entry.question, canary: entry.canary, attackerUrls: entry.attackerUrls,
      })),
    }
  }

  const injection = loadInjectionCorpus()
  const a = await seedOrg(ORG_A, "probe-a.example", CORPUS_A, injection)
  const b = await seedOrg(ORG_B, "probe-b.example", CORPUS_B)

  // ── The credential canary (M6.2) ─────────────────────────────────────────
  // A provider key stored on org C the way the internal API would store it,
  // so the read-back probe has a plaintext to grep for. Org C and not A: a
  // saved generation credential is what the chat route resolves and CALLS,
  // and a fake Groq key on an org that answers questions would turn every
  // answer into a failed call to the real Groq — breaking the retrieval
  // controls in section [D]. C never chats. Only when the vault can encrypt:
  // the seed must not invent a fallback key, for the reason the vault has
  // none (a provider key is real even in dev). The canary is random per seed
  // and lands only in the fixture file.
  const c = { id: newId("org"), name: ORG_C }
  await db.insertInto("organizations").values(c).execute()
  let credentialCanary: string | null = null
  if (hasMasterKey()) {
    credentialCanary = `gsk_probe_canary_${newId("key").slice(4)}`
    const credentialId = newId("prv")
    await db.insertInto("org_provider_credentials").values({
      id: credentialId, org_id: c.id, role: "generation", provider: "groq",
      model: null, base_url: null, dim: null,
      key_ciphertext: encryptProviderKey(credentialCanary, credentialId),
      key_suffix: keySuffix(credentialCanary),
      last_validated_at: new Date(),
      last_validation: "seeded by seed-security (never validated live)",
    }).execute()
  }

  // ── System-prompt markers ────────────────────────────────────────────────
  // Taken from the REAL prompt rather than typed into the probe, so a
  // rewrite of the prompt cannot leave the leak check grepping for
  // sentences that no longer exist. Prose lines only — the JSON contract
  // example is excluded because a fragment of it could legitimately appear
  // in an answer stream and read as a leak that never happened.
  const systemPromptMarkers = SYSTEM_PROMPT.split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length >= 40 && !line.includes("{") && !line.includes("..."))
    .slice(0, 6)

  const fixture: SecurityFixture = {
    version: 1,
    seededAt: new Date().toISOString(),
    embeddingModel: embedder.model,
    orgs: { a, b, c },
    credentialCanary,
    systemPromptMarkers,
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  writeFileSync(resolve(outPath), `${JSON.stringify(fixture, null, 2)}\n`)

  console.log(`seeded ${ORG_A} (${a.id}), ${ORG_B} (${b.id}), ${ORG_C} (${c.id})`)
  console.log(`  org A: pk ${a.publishableKey}, revoked ${a.revokedKey}, origin ${a.origin}, ${a.corpus.length} chunks`)
  console.log(`  org B: pk ${b.publishableKey}, revoked ${b.revokedKey}, origin ${b.origin}, ${b.corpus.length} chunks`)
  console.log(`  credential canary: ${credentialCanary === null ? "none (CREDENTIAL_MASTER_KEY unset)" : "stored on org C"}`)
  console.log(`  system-prompt markers: ${systemPromptMarkers.length}`)
  console.log(`fixture written to ${resolve(outPath)}`)
  await db.destroy()
}

main().catch((err) => {
  console.error("seed-security failed:", err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
//#endregion
