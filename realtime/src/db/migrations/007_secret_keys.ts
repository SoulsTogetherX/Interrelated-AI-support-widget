//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 007 — what the SECRET key needs that the publishable key never did
// (M7.3, trust-model layer 6). api_keys has carried kind = 'secret' and
// secret_hash since 001, and the dashboard's rotation (M7.1) already writes
// the rows a secret key's lifecycle needs — issue, retire through a grace
// window, revoke. Three things were missing, and each is a statement about
// the schema rather than a table:
//
//   1. secret_suffix — the last four characters, the ONLY fragment of the
//      value kept in plaintext. The dashboard shows a secret key exactly once
//      and stores only its hash, so without a suffix an owner with a current
//      key and a retiring one could not tell which their server holds. The
//      provider-credential table keeps key_suffix for the same reason. A
//      CHECK pairs it with the kind exactly (a public key has no suffix; a
//      secret key must have one of length 4), in the api_keys style where a
//      mismatch is unrepresentable rather than merely unusual.
//
//   2. A UNIQUE index on secret_hash — the lookup POST /v1/sessions makes on
//      every mint (WHERE secret_hash = sha256(bearer)), which without an index
//      would scan the whole table for every request a customer's server sends.
//      Unique across ALL rows, live or revoked, unlike public_id's live-only
//      index: a secret key is 160 random bits, so two rows sharing a hash can
//      only mean the same key issued twice, and re-issuing a rotated-out
//      SECRET — a value that may have leaked, which is why it was rotated —
//      is precisely what must never happen. NULLs (every public row) do not
//      collide in a unique index, so no partial predicate is needed.
//
//   3. At most ONE current secret key per org — a partial unique index over
//      (org_id) WHERE kind = 'secret' AND revoked_at IS NULL. Rotation is
//      guarded by the key it rotates FROM (§9.17's playbook), but the FIRST
//      issue has no key to guard on: two owners clicking "Generate" at once
//      would otherwise both succeed and leave the org with two current secret
//      keys, each shown once to a different person. The index makes the
//      second insert a unique violation the action reports as "already
//      issued" — idempotence by schema, the handoff table's argument (§3.3.4).
//      Deliberately NOT applied to public keys: the security fixture inserts
//      an org's live and to-be-revoked public keys in one statement, and the
//      public key's invariant is already held by rotation's guarded UPDATE.
//
// The retiring/revoked semantics themselves need nothing new: the session
// routes compare revoked_at against NOW() on Postgres's clock (M7.1) for
// both kinds of key alike.
//
// Additive, and safe on every deployed database: no row of kind 'secret'
// existed before this migration (nothing minted one), so the new CHECK has
// nothing to disagree with.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE api_keys ADD COLUMN secret_suffix TEXT`.execute(db)

  await sql`
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_secret_suffix_pairs_kind CHECK (
      (kind = 'secret') = (secret_suffix IS NOT NULL)
      AND (secret_suffix IS NULL OR char_length(secret_suffix) = 4)
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX api_keys_secret_hash ON api_keys (secret_hash)
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX api_keys_one_current_secret_per_org
      ON api_keys (org_id) WHERE kind = 'secret' AND revoked_at IS NULL
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS api_keys_one_current_secret_per_org`.execute(db)
  await sql`DROP INDEX IF EXISTS api_keys_secret_hash`.execute(db)
  await sql`ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_secret_suffix_pairs_kind`.execute(db)
  await sql`ALTER TABLE api_keys DROP COLUMN IF EXISTS secret_suffix`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
