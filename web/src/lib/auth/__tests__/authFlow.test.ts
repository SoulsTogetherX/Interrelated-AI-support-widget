// DB-gated integration suite, the realtime pattern (§3.8): self-skips
// without POSTGRES_PASSWORD, lights up locally against the compose database
// and in CI's service container.
//
// PREREQUISITE: the schema must already be migrated — web never migrates
// (realtime owns that, §3.4). Locally that means the compose database with
// realtime's suite or a realtime boot having run once; in CI the verify
// job's realtime tests run before web tests against the same container, so
// ordering makes it true by construction. The first test asserts the users
// table exists and says exactly this when it does not.
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/lib/db"
import { createSessionForUser, destroySession, hashSessionToken, resolveSessionUser } from "../session"
import { authenticateUser, registerUser } from "../user"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)

// Unique per run so repeated local runs never collide with leftovers.
const RUN = Math.random().toString(36).slice(2, 10)
const EMAIL = `authflow-${RUN}@example.test`
const PASSWORD = "a sound passphrase, unbreached"

const createdUsers: string[] = []

describe.skipIf(!hasDb)("auth flow (integration)", () => {
  beforeAll(async () => {
    // Registration calls HIBP; tests must never depend on a third party.
    process.env.BREACH_CHECK_DISABLED = "1"
    const tables = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'users'
      ) AS exists
    `.execute(db)
    if (!tables.rows[0]?.exists) {
      throw new Error(
        "The users table is missing. web/ never migrates the database — " +
          "run realtime's suite (or boot the stack) against this Postgres " +
          "first; see DATAFLOW.md §6.",
      )
    }
  })

  afterAll(async () => {
    delete process.env.BREACH_CHECK_DISABLED
    if (createdUsers.length > 0) {
      // Sessions cascade via FK.
      await db.deleteFrom("users").where("id", "in", createdUsers).execute()
    }
    await db.destroy()
  })

  it("registers a user with email encrypted at rest", async () => {
    const result = await registerUser(`  ${EMAIL.toUpperCase()}  `, PASSWORD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    createdUsers.push(result.userId)
    expect(result.userId.startsWith("usr_")).toBe(true)

    // The at-rest promise, checked against the actual row: no plaintext
    // address in any column, and the password only as a scrypt string.
    const row = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", result.userId)
      .executeTakeFirstOrThrow()
    expect(row.email_ciphertext).not.toContain(EMAIL)
    expect(row.email_ciphertext).not.toContain("example.test")
    expect(row.email_index).not.toContain("authflow")
    expect(row.password_hash.startsWith("scrypt$")).toBe(true)
  })

  it("rejects a duplicate registration through the unique index", async () => {
    const dup = await registerUser(EMAIL, "another fine passphrase")
    expect(dup).toEqual({ ok: false, error: "That email is already registered." })
  })

  it("authenticates case-insensitively and rejects uniformly", async () => {
    const good = await authenticateUser(EMAIL.toUpperCase(), PASSWORD)
    expect(good.ok).toBe(true)

    // Wrong password and unknown account MUST be the same string — a
    // difference is an account-existence oracle.
    const wrongPassword = await authenticateUser(EMAIL, "not the password")
    const unknownEmail = await authenticateUser(`missing-${RUN}@example.test`, PASSWORD)
    const malformedEmail = await authenticateUser("not-an-email", PASSWORD)
    expect(wrongPassword.ok).toBe(false)
    if (wrongPassword.ok || unknownEmail.ok || malformedEmail.ok) return
    expect(unknownEmail.error).toBe(wrongPassword.error)
    expect(malformedEmail.error).toBe(wrongPassword.error)
  })

  it("round-trips a session and decrypts the email at resolve", async () => {
    const login = await authenticateUser(EMAIL, PASSWORD)
    expect(login.ok).toBe(true)
    if (!login.ok) return

    const { token } = await createSessionForUser(login.userId)
    const user = await resolveSessionUser(token)
    expect(user).toEqual({ id: login.userId, email: EMAIL })

    // The DB stores only the hash: the raw token must not be a session id.
    const raw = await db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", token)
      .executeTakeFirst()
    expect(raw).toBeUndefined()
    const hashed = await db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", hashSessionToken(token))
      .executeTakeFirst()
    expect(hashed).toBeDefined()

    // Tampered and absent tokens resolve to nobody.
    expect(await resolveSessionUser(token.slice(0, -2) + "zz")).toBeNull()
    expect(await resolveSessionUser(undefined)).toBeNull()

    await destroySession(token)
    expect(await resolveSessionUser(token)).toBeNull()
  })

  it("treats an expired session as no session", async () => {
    const login = await authenticateUser(EMAIL, PASSWORD)
    expect(login.ok).toBe(true)
    if (!login.ok) return

    const { token } = await createSessionForUser(login.userId)
    // Age the session past its TTL directly — the expiry check compares
    // against the DATABASE clock, so the test must move the stored
    // timestamp, not the app clock.
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", hashSessionToken(token))
      .execute()
    expect(await resolveSessionUser(token)).toBeNull()
  })
})
