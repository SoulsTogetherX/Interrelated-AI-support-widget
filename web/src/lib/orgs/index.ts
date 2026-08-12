//#region Org membership and onboarding
// The org data layer: everything the dashboard knows about organizations
// and who belongs to them. Same split as lib/auth — queries here (plain
// vitest-testable), Server Actions in ./actions.ts, next/navigation only in
// the page-level guard.
//#endregion

//#region Imports
import { notFound } from "next/navigation"

import { isId, newId, newPublishableKey } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { requireUser } from "@/lib/auth/requireUser"

import type { Validated } from "@/lib/auth/validation"
import type { SessionUser } from "@/lib/auth/session"
//#endregion

//#region Types
export interface OrgMembership {
  id: string
  name: string
  plan: "free" | "starter" | "pro"
  role: "owner" | "agent"
}
//#endregion

//#region Validation
// Bounds only — an org name is a display label, not an identifier, so any
// printable content is fine. 64 keeps headers and audit lines readable.
export function validateOrgName(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Organization name is required." }
  }
  const name = input.trim()
  if (name.length < 2) {
    return { ok: false, error: "Organization name must be at least 2 characters." }
  }
  if (name.length > 64) {
    return { ok: false, error: "Organization name must be at most 64 characters." }
  }
  return { ok: true, value: name }
}
//#endregion

//#region Queries
/** Org + owner membership + publishable key, in ONE transaction — an org
 *  with no owner or no widget key is not a partially-onboarded org, it is
 *  corruption, so the three rows are indivisible. Only the PUBLIC key is
 *  minted here: the secret (sk) key exists for server-side session minting,
 *  a feature that arrives with its consumers — minting one nobody can use
 *  would just be a credential to rotate later. */
export async function createOrgForUser(
  userId: string,
  name: string,
): Promise<{ orgId: string; publishableKey: string }> {
  const orgId = newId("org")
  const publishableKey = newPublishableKey()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("organizations").values({ id: orgId, name }).execute()
    await trx
      .insertInto("org_members")
      .values({ org_id: orgId, user_id: userId, role: "owner" })
      .execute()
    await trx
      .insertInto("api_keys")
      .values({
        id: newId("key"),
        org_id: orgId,
        kind: "public",
        public_id: publishableKey,
        secret_hash: null,
      })
      .execute()
  })
  return { orgId, publishableKey }
}

export async function listOrgsForUser(userId: string): Promise<OrgMembership[]> {
  return db
    .selectFrom("org_members")
    .innerJoin("organizations", "organizations.id", "org_members.org_id")
    .select([
      "organizations.id as id",
      "organizations.name as name",
      "organizations.plan as plan",
      "org_members.role as role",
    ])
    .where("org_members.user_id", "=", userId)
    .orderBy("organizations.created_at", "asc")
    .execute()
}

/** Membership-scoped org lookup: null unless THIS user belongs to the org.
 *  The malformed-id fast path is not just an optimization — every org query
 *  in the dashboard goes through membership, so retrieval-style cross-tenant
 *  bugs are unrepresentable at this layer. */
export async function getOrgForMember(
  orgId: string,
  userId: string,
): Promise<OrgMembership | null> {
  if (!isId("org", orgId)) {
    return null
  }
  const row = await db
    .selectFrom("org_members")
    .innerJoin("organizations", "organizations.id", "org_members.org_id")
    .select([
      "organizations.id as id",
      "organizations.name as name",
      "organizations.plan as plan",
      "org_members.role as role",
    ])
    .where("org_members.org_id", "=", orgId)
    .where("org_members.user_id", "=", userId)
    .executeTakeFirst()
  return row ?? null
}

/** The org's publishable widget key. Every org has exactly one live public
 *  key today (rotation, M3.8, revokes-and-reissues rather than deleting). */
export async function getPublishableKey(orgId: string): Promise<string | null> {
  const row = await db
    .selectFrom("api_keys")
    .select("public_id")
    .where("org_id", "=", orgId)
    .where("kind", "=", "public")
    .where("revoked_at", "is", null)
    .executeTakeFirst()
  return row?.public_id ?? null
}
//#endregion

//#region Page guard
/** The org-scoped sibling of requireUser: resolves the signed-in user AND
 *  their membership, or 404s. notFound() rather than a redirect on purpose:
 *  a non-member probing /dashboard/org_… must not learn whether the org
 *  exists, and "page does not exist" is exactly what a wrong id looks like. */
export async function requireOrgMember(
  orgId: string,
): Promise<{ user: SessionUser; org: OrgMembership }> {
  const user = await requireUser()
  const org = await getOrgForMember(orgId, user.id)
  if (!org) {
    notFound()
  }
  return { user, org }
}
//#endregion
