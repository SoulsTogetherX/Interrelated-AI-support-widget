//#region Imports
// Dev-only CLI: registers a source and queues an ingest job, so the worker
// can be watched end to end before any dashboard exists (that arrives in
// M3 — this script is the manual stand-in for its "connect a source" flow).
//
//   npm run enqueue -- https://docs.example.com/ [--depth 2] [--sitemap] [--org "Name"]
//
// Run it against the compose database (worker running via
// `docker compose up`) or a host `npm run dev` with INGEST_WORKER=1. It is
// glue over the same inserts the integration tests make — deliberately no
// logic of its own, so there is nothing here to drift out of sync.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
//#endregion

//#region Env fallback
// Convenience for the dev loop: when the Postgres env vars are absent, pull
// them from the repo-root .env (the same file compose reads) instead of
// demanding a manual `export` dance. Env already set always wins — this is
// a fallback, not a config system.
//
// This block must run BEFORE @/db/pool loads — the pool reads env at module
// load, and a hoisted top-level import would construct it first, silently
// capturing the wrong host/port/password. Hence the deferred imports in
// main() rather than top-level ones (CLAUDE.md §3.11).
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
    // No .env — the pool will fail to connect and say so below.
  }
}
//#endregion

//#region Main
async function main(): Promise<void> {
  const { db } = await import("@/db/pool")
  const { newId } = await import("@shared/utils/ids")

  const args = process.argv.slice(2)
  const location = args.find((a) => !a.startsWith("--"))
  if (!location) {
    console.error('usage: npm run enqueue -- <url> [--depth N] [--sitemap] [--org "Name"]')
    process.exit(1)
  }
  const kind = args.includes("--sitemap") ? ("sitemap" as const) : ("url" as const)
  const depthArg = args[args.indexOf("--depth") + 1]
  const crawlDepth = args.includes("--depth") ? Number(depthArg) : 1
  const orgName = args.includes("--org")
    ? (args[args.indexOf("--org") + 1] ?? "Local Dev Org")
    : "Local Dev Org"

  // Find-or-create keeps repeated runs landing in one org, which is what a
  // dev machine wants (and what makes cleanup a single delete).
  let org = await db
    .selectFrom("organizations")
    .select(["id"])
    .where("name", "=", orgName)
    .executeTakeFirst()
  if (!org) {
    org = { id: newId("org") }
    await db.insertInto("organizations").values({ id: org.id, name: orgName }).execute()
    console.log(`created organization ${org.id} (${orgName})`)
  }

  const sourceId = newId("src")
  await db
    .insertInto("sources")
    .values({
      id: sourceId,
      org_id: org.id,
      kind,
      location,
      crawl_depth: crawlDepth,
    })
    .execute()
  const jobId = newId("job")
  await db
    .insertInto("ingest_jobs")
    .values({ id: jobId, org_id: org.id, source_id: sourceId })
    .execute()

  console.log(`queued ${jobId}`)
  console.log(`  source ${sourceId} (${kind}, depth ${crawlDepth}): ${location}`)
  console.log("a running worker (INGEST_WORKER=1) will pick it up within one poll interval")
  await db.destroy()
}

main().catch((err) => {
  console.error("enqueue failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
//#endregion
