//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 006 — origin_daily (M7.2): one row per org per UTC day per
// ORIGIN, counting the widget sessions minted for it and the mints REFUSED
// from it. Trust-model layer 4: "every session mint records its Origin, and
// the dashboard breaks traffic down by origin, so unauthorized use is
// visible rather than inferred from a bill".
//
// What the row is FOR decides its shape. The allowlist (layer 1) already
// stops an unlisted site — no unlisted origin ever gets a session — so the
// interesting number here is not what got through but what was TURNED
// AWAY: "https://thief.example presented your key 340 times this week" is
// how a tenant learns a copy of their snippet exists (or that they forgot
// to allowlist their own staging site, which looks identical from here and
// is the more common case). Minted counts per allowlisted origin ride along
// because they cost the same upsert and answer "which of my sites carries
// the support traffic".
//
// A counter table rather than a log of mints, for usage_daily's reason
// (004): the dashboard wants a week per origin, and rows that grow with
// traffic would make that read grow with the customer's success. Nothing
// here identifies a visitor — origin and a count, no IP, no visitor id, no
// Referer (a browser's default Referrer-Policy strips the path on
// cross-origin requests, so a Referer would only ever repeat the Origin).
//
// origin is attacker-supplied text when the mint was refused, which is why
// there is a length CHECK here and a shape rule in usage/origins.ts: only
// strings that look like an origin (or the literal "null" that file:// and
// sandboxed iframes send) are stored as themselves; anything else lands
// under a sentinel. The same file caps how many DISTINCT refused origins one
// org can accumulate in a day, since a script forging a fresh Origin per
// request could otherwise write a row per request — bounded by the per-IP
// mint bucket, but a bound worth having twice.
//
// UTC days, as usage_daily: fixed boundary, keys that never depend on a
// tenant setting.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE origin_daily (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      day        DATE NOT NULL,
      -- An origin (scheme://host[:port]) or one of the sentinels
      -- usage/origins.ts writes; 253 is the DNS name ceiling, and an
      -- allowlist entry cannot be longer either (§9.11's validator).
      origin     TEXT NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 253),
      -- Sessions actually minted for this origin (it was allowlisted).
      minted     INT NOT NULL DEFAULT 0,
      -- Mints refused with 403 because this origin was NOT allowlisted —
      -- the "somebody else has your snippet" number.
      refused    INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Natural composite key: (org, day, origin) IS the row's identity,
      -- nothing references one individually, and its leading columns are
      -- exactly what the dashboard's range read (this org, last N days)
      -- scans — which is why, unlike 004, there is no second index.
      PRIMARY KEY (org_id, day, origin),

      -- Counters only go up; a negative would mean an increment ran
      -- backwards.
      CHECK (minted >= 0 AND refused >= 0)
    )
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS origin_daily`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
