// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; schema
// must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts, which states it in full).
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { hashPassword } from "@/lib/auth/password"
import { emailBlindIndex, encryptEmail } from "@/lib/auth/emailCrypto"
import {
  createOrgForUser,
  getOrgForMember,
  getPublishableKey,
  listOrgsForUser,
} from "../index"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)
const RUN = Math.random().toString(36).slice(2, 10)

// Two users: the org creator, and a registered NON-member for the
// cross-tenant denial cases.
let ownerId: string
let outsiderId: string
const createdOrgs: string[] = []

async function insertUser(tag: string): Promise<string> {
  const id = newId("usr")
  const email = `orgs-${tag}-${RUN}@example.test`
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

describe.skipIf(!hasDb)("org onboarding (integration)", () => {
  beforeAll(async () => {
    ownerId = await insertUser("owner")
    outsiderId = await insertUser("outsider")
  })

  afterAll(async () => {
    // organizations cascade to org_members and api_keys; users cascade to
    // their sessions.
    if (createdOrgs.length > 0) {
      await db.deleteFrom("organizations").where("id", "in", createdOrgs).execute()
    }
    await db.deleteFrom("users").where("id", "in", [ownerId, outsiderId]).execute()
    await db.destroy()
  })

  it("creates org + owner membership + publishable key atomically", async () => {
    const { orgId, publishableKey } = await createOrgForUser(ownerId, "Acme Support")
    createdOrgs.push(orgId)

    expect(orgId.startsWith("org_")).toBe(true)
    expect(publishableKey).toMatch(/^pk_live_/)

    const org = await db
      .selectFrom("organizations")
      .selectAll()
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow()
    expect(org.name).toBe("Acme Support")
    expect(org.plan).toBe("free") // DB default owns the starting tier

    const member = await db
      .selectFrom("org_members")
      .selectAll()
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow()
    expect(member.user_id).toBe(ownerId)
    expect(member.role).toBe("owner")

    const key = await db
      .selectFrom("api_keys")
      .selectAll()
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow()
    expect(key.kind).toBe("public")
    expect(key.public_id).toBe(publishableKey)
    expect(key.secret_hash).toBeNull()
    expect(key.revoked_at).toBeNull()

    expect(await getPublishableKey(orgId)).toBe(publishableKey)
  })

  it("scopes org access to members — the dashboard's tenant boundary", async () => {
    const orgId = createdOrgs[0]
    const asOwner = await getOrgForMember(orgId, ownerId)
    expect(asOwner).toMatchObject({ id: orgId, name: "Acme Support", role: "owner" })

    // A registered user who is NOT a member sees exactly what a probe of a
    // nonexistent org sees: null (the page turns this into a 404).
    expect(await getOrgForMember(orgId, outsiderId)).toBeNull()
    expect(await getOrgForMember(newId("org"), ownerId)).toBeNull()
    // Malformed ids fail before any query.
    expect(await getOrgForMember("new", ownerId)).toBeNull()
    expect(await getOrgForMember("org_short", ownerId)).toBeNull()
  })

  it("lists memberships in creation order and supports multiple orgs", async () => {
    const second = await createOrgForUser(ownerId, "Second Org")
    createdOrgs.push(second.orgId)

    const orgs = await listOrgsForUser(ownerId)
    expect(orgs.map((o) => o.name)).toEqual(["Acme Support", "Second Org"])
    // Each org minted its OWN key.
    expect(await getPublishableKey(second.orgId)).not.toBe(
      await getPublishableKey(createdOrgs[0]),
    )

    expect(await listOrgsForUser(outsiderId)).toEqual([])
  })
})
