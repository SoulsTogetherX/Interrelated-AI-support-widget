//#region Why this file
// One-click rotation of the publishable key — trust-model layer 5 (plan
// §widget-trust-model; CLAUDE.md §9.17). The schema was built for it from
// the start: api_keys revokes by TIMESTAMP rather than by delete, and its
// uniqueness index covers live keys only, so a rotation is an INSERT plus an
// UPDATE and the retired key stays as the audit trail. What was missing was
// the click.
//
// The whole design is the grace window. Rotation does not kill the old key
// when the owner clicks: it schedules the key's revocation ROTATION_GRACE_HOURS
// out, and realtime's session route (§3.18) treats a future revoked_at as
// live. So the new key is usable immediately, the snippet already on the
// customer's site keeps working until they redeploy, and there is never a
// keyless window — a rotation that broke the widget until someone edited
// HTML would be a rotation nobody performed. "Revoke now" on a retiring key
// is the incident-response half: it ends the window at once.
//
// Honest limit, stated where the feature is: for a PUBLIC key, rotation is
// hygiene, not defense. The value is scraped from the customer's page, so an
// attacker who re-scrapes has the new one; what actually bounds a scripted
// abuser is the origin allowlist (layer 1) and the buckets and daily
// ceiling (layer 3). Two things rotation does buy: every deployed snippet
// can be invalidated at once without downtime, and — the real reason to
// build it now — the SAME rows and the same lookup rule are what will make
// the SECRET key (layer 6) safe to issue: a bearer credential nobody can
// rotate without an outage is one nobody rotates. Nor does ending a window
// evict live visitors: a session token is bound to the org, not to the key
// that opened it, and lasts its 30 minutes (§3.17.1). Revocation stops NEW
// sessions.
//
// Written directly through Kysely, like the origin allowlist (§9.11): these
// rows hold no secret — the pk is public by design — so routing them through
// realtime's internal API would be ceremony without a reason.
//
// Every timestamp here is Postgres's NOW(), never this process's Date: the
// dashboard runs on Vercel and the session route on Render, and the ONE
// clock both can share is Neon's — the same argument the handoff socket
// makes for message ordering (§3.25). A grace end written with a Vercel
// Date would be off by the two machines' skew, which for 24 hours is
// harmless and for "revoke now" is not.
//#endregion

//#region Imports
import { sql } from "kysely"

import { isId, newId, newPublishableKey } from "@shared/utils/ids"

import { db } from "@/lib/db"
//#endregion

//#region Types
/** How long a rotated-out key keeps working. Long enough to redeploy a
 *  site on a normal cadence; short enough that "revoke now" is the
 *  exception rather than the routine. A dashboard policy, not a realtime
 *  constant — realtime only ever compares revoked_at against NOW(). */
export const ROTATION_GRACE_HOURS = 24

/** A key's standing, decided by Postgres against its own clock:
 *  - current:  revoked_at IS NULL — the key the snippet should carry
 *  - retiring: revoked_at is in the future — still accepted, on its way out
 *  - revoked:  revoked_at has passed — refused exactly like an unknown key */
export type PublishableKeyStatus = "current" | "retiring" | "revoked"

export interface PublishableKey {
  id: string
  publishableKey: string
  status: PublishableKeyStatus
  createdAt: Date
  /** Stamped by realtime on every session mint — for a retiring key this is
   *  how the owner can tell their OLD snippet is still out there. */
  lastUsedAt: Date | null
  /** When the key stopped, or will stop, being accepted. NULL while current. */
  revokedAt: Date | null
}

export type RotationResult =
  | { rotated: true; publishableKey: string; graceEndsAt: Date }
  | { rotated: false }
//#endregion

//#region Queries
/** Every public key the org has ever had, newest first, each with its
 *  standing computed IN SQL against NOW() — the same comparison the session
 *  route makes, so the dashboard can never call a key "retiring" that
 *  realtime already refuses. */
export async function listPublishableKeys(orgId: string): Promise<PublishableKey[]> {
  const rows = await db
    .selectFrom("api_keys")
    .select([
      "id",
      "public_id",
      "created_at",
      "last_used_at",
      "revoked_at",
      sql<PublishableKeyStatus>`CASE
        WHEN revoked_at IS NULL THEN 'current'
        WHEN revoked_at > NOW() THEN 'retiring'
        ELSE 'revoked'
      END`.as("status"),
    ])
    .where("org_id", "=", orgId)
    .where("kind", "=", "public")
    .orderBy("created_at", "desc")
    .execute()
  return rows.map((r) => ({
    id: r.id,
    // public_id is NOT NULL for kind='public' by the schema CHECK; the
    // fallback only satisfies the type.
    publishableKey: r.public_id ?? "",
    status: r.status,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }))
}
//#endregion

//#region Mutations
/** Issues a new publishable key and schedules the CURRENT one to retire in
 *  ROTATION_GRACE_HOURS. Idempotent per page view: the caller names the key
 *  it saw as current, and the guarded UPDATE (`revoked_at IS NULL`) is the
 *  atomic claim — a second click, a retried POST, or two owners at once all
 *  find the row already scheduled and get `rotated: false` with nothing
 *  written, instead of two rotations and three live keys. Same shape as
 *  closeHandoff's `status <> 'closed'` guard (§3.23): the race resolves in
 *  Postgres, with no lock and no read-then-check.
 *
 *  A malformed or foreign key id also yields `rotated: false`: the org
 *  scoping is in the WHERE, so an owner of org A cannot rotate org B's key
 *  by posting its id, and the two failures are indistinguishable on
 *  purpose. */
export async function rotatePublishableKey(orgId: string, fromKeyId: string): Promise<RotationResult> {
  if (!isId("key", fromKeyId)) {
    return { rotated: false }
  }
  return db.transaction().execute(async (trx) => {
    const scheduled = await trx
      .updateTable("api_keys")
      .set({ revoked_at: sql`NOW() + make_interval(hours => ${ROTATION_GRACE_HOURS})` })
      .where("id", "=", fromKeyId)
      .where("org_id", "=", orgId)
      .where("kind", "=", "public")
      .where("revoked_at", "is", null)
      .returning("revoked_at")
      .executeTakeFirst()
    if (!scheduled) {
      return { rotated: false }
    }
    const publishableKey = newPublishableKey()
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
    // returning() types the column as Date | null; the SET just made it
    // non-null, and a null here would mean the database disagreed with its
    // own statement.
    return { rotated: true, publishableKey, graceEndsAt: scheduled.revoked_at as Date }
  })
}

/** Ends a retiring key's grace window immediately. Only a RETIRING key
 *  qualifies: the current key cannot be revoked without a replacement (the
 *  org must never be keyless by a click — rotate instead), and an already
 *  revoked key is left alone so revoked_at stays the honest instant it
 *  actually stopped. Returns whether a row changed, so a double click can be
 *  answered truthfully rather than as a second revocation. */
export async function revokePublishableKeyNow(orgId: string, keyId: string): Promise<boolean> {
  if (!isId("key", keyId)) {
    return false
  }
  const result = await db
    .updateTable("api_keys")
    .set({ revoked_at: sql`NOW()` })
    .where("id", "=", keyId)
    .where("org_id", "=", orgId)
    .where("kind", "=", "public")
    .where("revoked_at", "is not", null)
    .where("revoked_at", ">", sql<Date>`NOW()`)
    .executeTakeFirst()
  return result.numUpdatedRows > 0n
}
//#endregion
