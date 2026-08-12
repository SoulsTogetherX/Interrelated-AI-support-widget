//#region Imports
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { MIGRATIONS, migrateToLatest } from "@/db/migrate"
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
        }).execute(),
      ).rejects.toThrow(/check/i)
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
