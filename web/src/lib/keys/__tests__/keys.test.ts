// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; schema
// must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts, which states it in full).
//
// What is under test is the shape of rotation, not the arithmetic of a
// clock: the grace window is written and read by Postgres's NOW(), so the
// assertions about it are made in SQL against that same clock.
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { hashPassword } from "@/lib/auth/password"
import { emailBlindIndex, encryptEmail } from "@/lib/auth/emailCrypto"
import { createOrgForUser, getPublishableKey } from "@/lib/orgs"
import {
  ROTATION_GRACE_HOURS,
  listPublishableKeys,
  revokePublishableKeyNow,
  rotatePublishableKey,
} from "../index"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const RUN = Math.random().toString(36).slice(2, 10)

let ownerId: string
let orgA: string
let orgB: string
/** org A's first key — the one createOrgForUser minted. */
let firstKeyId: string
let firstPk: string

async function insertUser(tag: string): Promise<string> {
  const id = newId("usr")
  const email = `keys-${tag}-${RUN}@example.test`
  await db
    .insertInto("users")
    .values({
      id,
      email_index: await emailBlindIndex(email),
      email_ciphertext: encryptEmail(email, id),
      password_hash: await hashPassword("irrelevant passphrase"),
    })
    .execute()
  return id
}

/** Seconds from the DATABASE's now to the row's revoked_at — the number the
 *  session route effectively compares against. */
async function secondsUntilRevocation(keyId: string): Promise<number> {
  const row = await sql<{ seconds: number }>`
    SELECT EXTRACT(EPOCH FROM (revoked_at - NOW()))::float8 AS seconds
    FROM api_keys WHERE id = ${keyId}
  `.execute(db)
  return row.rows[0]!.seconds
}

async function currentKeys(orgId: string) {
  return (await listPublishableKeys(orgId)).filter((k) => k.status === "current")
}

describe.skipIf(!hasDb)("publishable key rotation (integration)", () => {
  beforeAll(async () => {
    ownerId = await insertUser("owner")
    const a = await createOrgForUser(ownerId, "Rotation Co")
    const b = await createOrgForUser(ownerId, "Other Tenant")
    orgA = a.orgId
    orgB = b.orgId
    firstPk = a.publishableKey
    const [only] = await listPublishableKeys(orgA)
    firstKeyId = only!.id
  })

  afterAll(async () => {
    // organizations cascade to api_keys and org_members; users to sessions.
    await db.deleteFrom("organizations").where("id", "in", [orgA, orgB]).execute()
    await db.deleteFrom("users").where("id", "=", ownerId).execute()
    await db.destroy()
  })

  it("starts with exactly one current key and no history", async () => {
    const keys = await listPublishableKeys(orgA)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      id: firstKeyId,
      publishableKey: firstPk,
      status: "current",
      revokedAt: null,
      lastUsedAt: null,
    })
  })

  it("rotates: a new current key, the old one retiring on the database's clock", async () => {
    const result = await rotatePublishableKey(orgA, firstKeyId)
    expect(result.rotated).toBe(true)
    if (!result.rotated) return
    expect(result.publishableKey).toMatch(/^pk_live_/)
    expect(result.publishableKey).not.toBe(firstPk)

    const keys = await listPublishableKeys(orgA)
    expect(keys.map((k) => k.status)).toEqual(["current", "retiring"]) // newest first
    expect(keys[0]!.publishableKey).toBe(result.publishableKey)
    expect(keys[1]!.id).toBe(firstKeyId)
    // The snippet page follows the current key immediately.
    expect(await getPublishableKey(orgA)).toBe(result.publishableKey)

    // The grace end is ROTATION_GRACE_HOURS from Postgres's now — measured
    // in SQL, so a Vercel-vs-Neon skew could never make this assertion lie
    // in either direction. A minute of slack covers the round trips.
    const seconds = await secondsUntilRevocation(firstKeyId)
    expect(seconds).toBeGreaterThan(ROTATION_GRACE_HOURS * 3600 - 60)
    expect(seconds).toBeLessThanOrEqual(ROTATION_GRACE_HOURS * 3600)
    // …and the returned instant is that same row's value.
    expect(keys[1]!.revokedAt?.getTime()).toBe(result.graceEndsAt.getTime())
  })

  it("is idempotent per page view: rotating from a key that is no longer current writes nothing", async () => {
    const before = await listPublishableKeys(orgA)
    const again = await rotatePublishableKey(orgA, firstKeyId)
    expect(again).toEqual({ rotated: false })
    const after = await listPublishableKeys(orgA)
    expect(after).toEqual(before) // same rows, same timestamps, no third key
    expect(await currentKeys(orgA)).toHaveLength(1)
  })

  it("resolves five concurrent rotations from one key into exactly one", async () => {
    // The only way to show idempotence comes from the guarded UPDATE and
    // not from the read above it: fire them together. Without the guard
    // this would produce up to five current keys.
    const [current] = await currentKeys(orgA)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rotatePublishableKey(orgA, current!.id)),
    )
    expect(results.filter((r) => r.rotated)).toHaveLength(1)
    expect(results.filter((r) => !r.rotated)).toHaveLength(4)
    const keys = await listPublishableKeys(orgA)
    expect(keys.filter((k) => k.status === "current")).toHaveLength(1)
    // Two retiring now: the first key and the one this test rotated out.
    expect(keys.filter((k) => k.status === "retiring")).toHaveLength(2)
    expect(keys).toHaveLength(3)
  })

  it("revokes a retiring key now, and only a retiring key", async () => {
    const keys = await listPublishableKeys(orgA)
    const current = keys.find((k) => k.status === "current")!
    const retiring = keys.filter((k) => k.status === "retiring")

    // The current key cannot be revoked by this path — the org must never be
    // left keyless by a click; the way to retire it is to rotate.
    expect(await revokePublishableKeyNow(orgA, current.id)).toBe(false)
    expect((await listPublishableKeys(orgA)).find((k) => k.id === current.id)!.status).toBe("current")

    // A retiring key ends its window at once, on the database's clock.
    expect(await revokePublishableKeyNow(orgA, retiring[0]!.id)).toBe(true)
    const revoked = (await listPublishableKeys(orgA)).find((k) => k.id === retiring[0]!.id)!
    expect(revoked.status).toBe("revoked")
    expect(await secondsUntilRevocation(revoked.id)).toBeLessThanOrEqual(0)

    // Revoking it AGAIN changes nothing — revoked_at stays the honest instant
    // it actually stopped, byte-identical.
    expect(await revokePublishableKeyNow(orgA, revoked.id)).toBe(false)
    const still = (await listPublishableKeys(orgA)).find((k) => k.id === revoked.id)!
    expect(still.revokedAt?.getTime()).toBe(revoked.revokedAt?.getTime())

    // The other retiring key was not touched.
    expect((await listPublishableKeys(orgA)).find((k) => k.id === retiring[1]!.id)!.status).toBe("retiring")
  })

  it("scopes both mutations to the org — another tenant's key id is a no-op", async () => {
    const [aCurrent] = await currentKeys(orgA)
    const aRetiring = (await listPublishableKeys(orgA)).find((k) => k.status === "retiring")!
    const bBefore = await listPublishableKeys(orgB)

    // Org B naming org A's key ids: nothing happens to A, nothing to B.
    expect(await rotatePublishableKey(orgB, aCurrent!.id)).toEqual({ rotated: false })
    expect(await revokePublishableKeyNow(orgB, aRetiring.id)).toBe(false)
    expect((await listPublishableKeys(orgA)).find((k) => k.id === aCurrent!.id)!.status).toBe("current")
    expect((await listPublishableKeys(orgA)).find((k) => k.id === aRetiring.id)!.status).toBe("retiring")
    expect(await listPublishableKeys(orgB)).toEqual(bBefore)
  })

  it("refuses malformed key ids before any query", async () => {
    expect(await rotatePublishableKey(orgA, "not-a-key")).toEqual({ rotated: false })
    expect(await rotatePublishableKey(orgA, "org_" + "0".repeat(32))).toEqual({ rotated: false })
    expect(await revokePublishableKeyNow(orgA, "")).toBe(false)
    expect(await revokePublishableKeyNow(orgA, newId("org"))).toBe(false)
  })

  it("lists another tenant's keys as their own, unaffected by A's history", async () => {
    const keys = await listPublishableKeys(orgB)
    expect(keys).toHaveLength(1)
    expect(keys[0]!.status).toBe("current")
  })
})
