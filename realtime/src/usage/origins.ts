//#region Imports
import { sql } from "kysely"
import type { Kysely, Transaction } from "kysely"

import type { Database } from "@/db/schema"
import { utcDay } from "@/usage/daily"
//#endregion

//#region Type Defs
/**
 * Per-origin traffic counters (M7.2, trust-model layer 4) — the write side
 * of origin_daily (§3.3.8). One upsert per session mint, keyed by the
 * origin the browser presented, split into MINTED (it was allowlisted, a
 * session was issued) and REFUSED (it was not — the mint died at layer 1).
 *
 * The refused count is the point. Layer 1 already stops an unlisted site,
 * so nothing here changes what the widget does; what changes is what the
 * tenant can SEE: a copy of their snippet on a site they never allowlisted
 * shows up as a name and a number instead of as nothing at all. Most of the
 * time that name will be their own staging domain, which the dashboard lets
 * them allowlist in one click; sometimes it will be somebody else's site,
 * which they now know about.
 *
 * Refused origins are attacker-supplied text, and this file treats them as
 * such twice. SHAPE: only strings that look like an origin (or the literal
 * "null" that file:// pages and sandboxed iframes send — a real signal) are
 * stored as themselves; anything else lands under MALFORMED_ORIGIN, so a
 * script cannot fill a tenant's page with junk. VOLUME: one org accumulates
 * at most MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY distinct refused origins per
 * UTC day, after which new ones are counted under OTHER_ORIGIN — a script
 * forging a fresh Origin per request is already held to the per-IP mint
 * bucket (§3.18), but "one row per request" is a growth curve worth capping
 * twice. The cap can overshoot by the handful of writers racing at the
 * boundary; it is a bound, not a quota, and a bound off by two is still a
 * bound.
 *
 * Every write here MUST be harmless to the product: the mint route awaits
 * these so the counters are visible the moment the response is (tests, and
 * a dashboard that never lags the widget), but wraps them so an
 * instrumentation failure logs and the visitor still gets their session.
 * Nothing here is inside a transaction with the mint because there is no
 * mint transaction — a token is signed, not stored.
 */
type DbOrTrx = Kysely<Database> | Transaction<Database>

type MintOutcome = "minted" | "refused"

interface OriginMintEntry {
  orgId: string
  /** The Origin header exactly as presented. For "minted" this has ALREADY
   *  matched an allowlist row and is stored verbatim; for "refused" it is
   *  normalized first (normalizeRefusedOrigin). */
  origin: string
  outcome: MintOutcome
  now?: Date
}
//#endregion

//#region Constants
/** Distinct refused origins one org may accumulate in one UTC day before
 *  new ones collapse into OTHER_ORIGIN. A hundred is far more than any real
 *  tenant's forgotten subdomains and far fewer than a script can forge in a
 *  minute. */
const MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY = 100
/** Sentinel rows. Parenthesized so they can never collide with a real
 *  origin, which always carries a scheme (or is the literal "null"). */
const OTHER_ORIGIN = "(other)"
const MALFORMED_ORIGIN = "(malformed)"
/** What a browser's Origin header looks like: scheme://host[:port], no
 *  path, no whitespace. The length bound mirrors the schema CHECK; the
 *  allowlist's own validator (§9.11) accepts nothing longer either. */
const ORIGIN_SHAPE = /^https?:\/\/[^\s/]+$/
const MAX_ORIGIN_CHARS = 253
//#endregion

//#region Helpers
/** True when a string is shaped like a browser Origin (scheme://host[:port],
 *  no path, no whitespace, within the DNS length ceiling). What decides
 *  whether a refused value is counted as itself; also what the secret-key
 *  mint route (§3.18) uses to tell an authenticated tenant's server "that is
 *  not an origin" apart from "that origin is not allowlisted". */
function looksLikeOrigin(value: string): boolean {
  return value.length <= MAX_ORIGIN_CHARS && ORIGIN_SHAPE.test(value)
}

/** The string a refused Origin is counted under: itself when it is shaped
 *  like an origin (or is "null"), the malformed sentinel otherwise. Case is
 *  kept — a case-variant of an allowlisted origin is refused precisely
 *  because it differs, and the tenant should see the string that was sent. */
function normalizeRefusedOrigin(origin: string): string {
  if (origin === "null") return origin
  if (looksLikeOrigin(origin)) return origin
  return MALFORMED_ORIGIN
}
//#endregion

//#region Writes
/**
 * Counts one mint attempt against (org, today, origin). Minted origins are
 * a plain upsert — the allowlist bounds them. Refused origins take the
 * capped path: an existing row is incremented in place; a NEW origin is
 * admitted only while the org's day is under the distinct-origin cap, and
 * otherwise counted under OTHER_ORIGIN.
 */
async function recordOriginMint(db: DbOrTrx, entry: OriginMintEntry): Promise<void> {
  const day = utcDay(entry.now)
  if (entry.outcome === "minted") {
    await upsert(db, entry.orgId, day, entry.origin, { minted: 1, refused: 0 })
    return
  }

  const origin = normalizeRefusedOrigin(entry.origin)
  const bumped = await db
    .updateTable("origin_daily")
    .set({ refused: sql`origin_daily.refused + 1`, updated_at: sql`NOW()` })
    .where("org_id", "=", entry.orgId)
    .where("day", "=", day)
    .where("origin", "=", origin)
    .executeTakeFirst()
  if (bumped.numUpdatedRows > 0n) return

  // A NEW origin for this org-day. Count what the day already holds before
  // admitting it; the count is one primary-key-prefix scan over at most a
  // few hundred rows.
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM origin_daily
    WHERE org_id = ${entry.orgId} AND day = ${day}
  `.execute(db)
  const distinct = Number(rows[0]?.n ?? 0)
  const target = distinct >= MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY ? OTHER_ORIGIN : origin
  await upsert(db, entry.orgId, day, target, { minted: 0, refused: 1 })
}

/** The insert-or-add, usage_daily's shape: amounts travel in VALUES and the
 *  conflict branch adds `excluded`, so each number appears once. */
async function upsert(
  db: DbOrTrx,
  orgId: string,
  day: string,
  origin: string,
  amounts: { minted: number; refused: number },
): Promise<void> {
  await db
    .insertInto("origin_daily")
    .values({ org_id: orgId, day, origin, minted: amounts.minted, refused: amounts.refused })
    .onConflict((oc) => oc.columns(["org_id", "day", "origin"]).doUpdateSet({
      minted: sql`origin_daily.minted + excluded.minted`,
      refused: sql`origin_daily.refused + excluded.refused`,
      updated_at: sql`NOW()`,
    }))
    .execute()
}
//#endregion

//#region Exports
export {
  recordOriginMint,
  normalizeRefusedOrigin,
  looksLikeOrigin,
  MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY,
  OTHER_ORIGIN,
  MALFORMED_ORIGIN,
}
export type { MintOutcome, OriginMintEntry }
//#endregion
