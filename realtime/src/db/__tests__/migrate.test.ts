//#region Imports
import { randomBytes } from "node:crypto"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { MIGRATIONS, migrateToLatest } from "@/db/migrate"
import { MAX_RECORDED_SKIPPED_PAGES } from "@/db/schema"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// Integration tests against a REAL Postgres (the pgvector image in compose /
// CI's service container). Self-gated on POSTGRES_PASSWORD exactly like the
// whiteboard's: `npm test` stays green on a machine with no database, and
// the suite lights up automatically where one exists.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

describe.skipIf(!DB_CONFIGURED)("migrateToLatest", () => {
  beforeAll(async () => {
    // Reset to a virgin schema so this file owns its whole world. DROP
    // SCHEMA CASCADE is brutal and correct FOR A DEDICATED TEST DATABASE —
    // the compose file provisions one; never point POSTGRES_DB at anything
    // you care about.
    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    await migrateToLatest(db)
  })

  afterAll(async () => {
    await db.destroy() // destroys the Kysely instance AND ends `pool`
  })

  it("creates every table the schema types declare", async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `.execute(db)
    const names = rows.map((r) => r.table_name)
    for (const expected of [
      "organizations", "users", "org_members",
      "sessions", "api_keys", "allowed_origins",
    ]) {
      expect(names).toContain(expected)
    }
  })

  it("installs the pgvector extension", async () => {
    // The reason the extension is created before any table needs it: this
    // assertion failing means the Postgres image is wrong, and we want to
    // learn that at deploy time, not at first ingest.
    const { rows } = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `.execute(db)
    expect(rows).toHaveLength(1)
  })

  it("is idempotent — a second run applies nothing", async () => {
    const second = await migrateToLatest(db)
    expect(second.results ?? []).toHaveLength(0)
  })

  it("has bookkeeping rows for every registered migration", async () => {
    // Guards the ExplicitMigrationProvider registry: writing a migration
    // file but forgetting to register it in MIGRATIONS is invisible at
    // compile time — this count is where it becomes visible.
    const { rows } = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name
    `.execute(db)
    expect(rows.map((r) => r.name)).toEqual(Object.keys(MIGRATIONS).sort())
  })

  describe("constraints reject invalid rows", () => {
    /** A crawl source of `orgId` with nothing queued for it yet. */
    async function freshSource(orgId: string): Promise<string> {
      const id = newId("src")
      await db.insertInto("sources").values({ id, org_id: orgId, kind: "url", location: `https://${id}.example/` }).execute()
      return id
    }

    it("allows exactly one owner per organization", async () => {
      const orgId = newId("org")
      await db.insertInto("organizations").values({ id: orgId, name: "Constraint Co" }).execute()

      const mkUser = async () => {
        const id = newId("usr")
        await db.insertInto("users").values({
          id,
          email_index: `idx_${id}`,        // uniqueness stand-ins; real HMAC in M3
          email_ciphertext: "ct_stub",
          password_hash: "hash_stub",
        }).execute()
        return id
      }

      const owner = await mkUser()
      const usurper = await mkUser()
      await db.insertInto("org_members")
        .values({ org_id: orgId, user_id: owner, role: "owner" }).execute()
      // Second owner must violate the partial unique index …
      await expect(
        db.insertInto("org_members")
          .values({ org_id: orgId, user_id: usurper, role: "owner" }).execute(),
      ).rejects.toThrow(/org_members_one_owner/)
      // … while a second AGENT is fine (the boundary the index must not overreach).
      await db.insertInto("org_members")
        .values({ org_id: orgId, user_id: usurper, role: "agent" }).execute()
    })

    it("rejects api_keys whose kind and columns disagree", async () => {
      const orgId = newId("org")
      await db.insertInto("organizations").values({ id: orgId, name: "Key Co" }).execute()
      // A "public" key carrying a secret_hash is the exact confusion the
      // trust model forbids (a secret masquerading as publishable data).
      await expect(
        db.insertInto("api_keys").values({
          id: newId("key"),
          org_id: orgId,
          kind: "public",
          public_id: "pk_test_mismatch",
          secret_hash: "a".repeat(64),
          secret_suffix: null,
        }).execute(),
      ).rejects.toThrow(/check/i)
    })

    it("pairs the secret suffix with the kind exactly, and keys a secret's hash uniquely (007)", async () => {
      const orgId = newId("org")
      const otherOrg = newId("org")
      await db.insertInto("organizations").values([
        { id: orgId, name: "Secret Key Co" }, { id: otherOrg, name: "Other Secret Co" },
      ]).execute()
      // Fresh hashes rather than fixed strings: the hash index is GLOBAL, so
      // a literal reused by any other suite against the same database would
      // collide and fail this test for the wrong reason.
      const hashA = randomBytes(32).toString("hex")
      const hashB = randomBytes(32).toString("hex")
      const secretRow = (hash: string, suffix: string | null) => ({
        id: newId("key"), org_id: orgId, kind: "secret" as const,
        public_id: null, secret_hash: hash, secret_suffix: suffix,
      })
      try {
        // A secret key without its display suffix, or with one of the wrong
        // length, and a public key CARRYING one: each is the pairing CHECK
        // refusing a row that would mean the dashboard and the schema disagree
        // about what a secret key looks like.
        await expect(db.insertInto("api_keys").values(secretRow(hashA, null)).execute()).rejects.toThrow(/check/i)
        await expect(db.insertInto("api_keys").values(secretRow(hashA, "abcde")).execute()).rejects.toThrow(/check/i)
        await expect(
          db.insertInto("api_keys").values({
            id: newId("key"), org_id: orgId, kind: "public",
            public_id: `pk_test_with_suffix_${hashA.slice(0, 8)}`, secret_hash: null, secret_suffix: "k3p9",
          }).execute(),
        ).rejects.toThrow(/check/i)
        // The well-formed row is accepted …
        await db.insertInto("api_keys").values(secretRow(hashA, "k3p9")).execute()
        // … a second CURRENT secret for the same org is refused (the index that
        // makes two simultaneous "Generate" clicks yield one key) …
        await expect(
          db.insertInto("api_keys").values(secretRow(hashB, "m2q4")).execute(),
        ).rejects.toThrow(/api_keys_one_current_secret_per_org/)
        // … while the same HASH is refused even under another org — a secret
        // value exists once, ever.
        await expect(
          db.insertInto("api_keys").values({ ...secretRow(hashA, "k3p9"), org_id: otherOrg }).execute(),
        ).rejects.toThrow(/api_keys_secret_hash/)
      } finally {
        await db.deleteFrom("organizations").where("id", "in", [orgId, otherOrg]).execute()
      }
    })

    it("bounds a job's skipped-page record by shape and by size (008)", async () => {
      const orgId = newId("org")
      await db.insertInto("organizations").values({ id: orgId, name: "Skipped Co" }).execute()
      // Each row on its own source: every insert here is a queued job, and
      // the same migration allows one live job per source (next case).
      const insertJob = async (extra: Record<string, unknown>) =>
        db.insertInto("ingest_jobs")
          .values({ id: newId("job"), org_id: orgId, source_id: await freshSource(orgId), ...extra } as never)
          .execute()

      // A job that knows nothing of the columns reads as "nothing skipped".
      const plainId = newId("job")
      await db.insertInto("ingest_jobs").values({ id: plainId, org_id: orgId, source_id: await freshSource(orgId) }).execute()
      const plain = await db.selectFrom("ingest_jobs").selectAll().where("id", "=", plainId).executeTakeFirstOrThrow()
      expect(plain.skipped_count).toBe(0)
      expect(plain.skipped_pages).toEqual([])

      // Exactly the cap is fine; one past it is refused; so is a non-array
      // and a negative count — a second writer that forgot the rules fails
      // loudly instead of growing the row.
      const page = (i: number) => ({ url: `https://skipped.example/p${i}`, reason: "HTTP 404" })
      const atCap = Array.from({ length: MAX_RECORDED_SKIPPED_PAGES }, (_, i) => page(i))
      try {
        await insertJob({ skipped_count: 500, skipped_pages: JSON.stringify(atCap) })
        await expect(insertJob({ skipped_count: 51, skipped_pages: JSON.stringify([...atCap, page(50)]) })).rejects.toThrow(/check/i)
        await expect(insertJob({ skipped_pages: JSON.stringify({ url: "x" }) })).rejects.toThrow(/check/i)
        await expect(insertJob({ skipped_count: -1 })).rejects.toThrow(/check/i)
      } finally {
        // The rows that inserted are QUEUED jobs; a later suite's worker
        // would claim and crawl them. Cascade them away with the org.
        await db.deleteFrom("organizations").where("id", "=", orgId).execute()
      }
    })

    it("allows at most one LIVE job per source (008)", async () => {
      const orgId = newId("org")
      await db.insertInto("organizations").values({ id: orgId, name: "One Job Co" }).execute()
      try {
        const sourceId = await freshSource(orgId)
        const jobFor = (state: "queued" | "running" | "done" | "failed") =>
          db.insertInto("ingest_jobs").values({
            id: newId("job"), org_id: orgId, source_id: sourceId, state,
            ...(state === "running" ? { locked_by: "w", locked_at: new Date() } : {}),
          }).execute()
        // History accumulates freely…
        await jobFor("done")
        await jobFor("failed")
        // …one live job is fine…
        await jobFor("queued")
        // …a second live one (queued or running) is not.
        await expect(jobFor("queued")).rejects.toThrow(/unique|duplicate/i)
        await expect(jobFor("running")).rejects.toThrow(/unique|duplicate/i)
        // Another source of the same org is unaffected.
        await db.insertInto("ingest_jobs").values({ id: newId("job"), org_id: orgId, source_id: await freshSource(orgId) }).execute()
      } finally {
        await db.deleteFrom("organizations").where("id", "=", orgId).execute()
      }
    })

    it("rejects origins with paths or trailing slashes", async () => {
      const orgId = newId("org")
      await db.insertInto("organizations").values({ id: orgId, name: "Origin Co" }).execute()
      // Valid exact origin: accepted.
      await db.insertInto("allowed_origins")
        .values({ org_id: orgId, origin: "https://docs.example.com" }).execute()
      // Trailing slash and path forms: each would silently never match a
      // browser Origin header, so the schema refuses to store them at all.
      for (const bad of ["https://docs.example.com/", "https://docs.example.com/help"]) {
        await expect(
          db.insertInto("allowed_origins")
            .values({ org_id: orgId, origin: bad }).execute(),
        ).rejects.toThrow(/check/i)
      }
    })
  })
})

// Vitest reports a file with zero runnable tests as an error; when the DB is
// absent the skipIf above empties the file, so this placeholder documents the
// gate instead of tripping that check.
describe.skipIf(DB_CONFIGURED)("migrateToLatest (no database)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(DB_CONFIGURED).toBe(false)
  })
})

// Referenced so the import is used even when the DB suite is skipped.
void pool
//#endregion
