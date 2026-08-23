//#region Why this file
// The dashboard's read side of origin_daily (§3.3.8) — trust-model layer 4,
// "unauthorized use is visible rather than inferred from a bill". realtime
// writes one counter row per (org, UTC day, origin) on every mint attempt
// that names an org (§3.28); this file adds a window of them up per origin
// so the install page can show, next to the allowlist, where the snippet
// has actually been loaded from and where it was turned away.
//
// Straight from Postgres like every dashboard read: a realtime outage must
// not blank the page whose job is telling a customer whether somebody else
// is presenting their key. Zeros here are honest, as in lib/usage — "no
// loads yet" is a fact about a quiet week.
//
// The window is computed by POSTGRES ((NOW() AT TIME ZONE 'UTC')::date),
// matching what realtime writes, so a Vercel instance's clock is never in
// charge of which day is "today" — the same rule lib/usage follows.
//#endregion

//#region Imports
import { sql } from "kysely"

import { db } from "@/lib/db"
//#endregion

//#region Types
export interface OriginTraffic {
  /** A scheme://host[:port] origin, the literal "null", or one of realtime's
   *  sentinels ("(other)", "(malformed)") — see originLabel. */
  origin: string
  /** Sessions minted for this origin over the window. */
  minted: number
  /** Mints refused from this origin over the window — the copied-snippet
   *  number, or the forgotten-staging-domain number. */
  refused: number
  /** The most recent UTC day it was seen, YYYY-MM-DD. */
  lastSeenDay: string
  /** Whether it is on the allowlist NOW — a refused origin that has since
   *  been allowlisted needs no "Allow" button. */
  allowlisted: boolean
}

export interface RefusedSummary {
  /** Total refused mints over the window. */
  refused: number
  /** Distinct refused origins (sentinel rows count as one each). */
  origins: number
}
//#endregion

//#region Queries
/** Every origin seen in the last `days` UTC days (today included), summed,
 *  worst first: the ones with refusals ahead of the merely busy, because a
 *  refusal is the thing the tenant should look at. `days` is 7 by default —
 *  long enough to catch a weekend copy, short enough that a stale entry does
 *  not haunt the page for a month. */
export async function listOriginTraffic(orgId: string, days = 7): Promise<OriginTraffic[]> {
  const rows = await db
    .selectFrom("origin_daily")
    .select([
      "origin",
      sql<string>`sum(minted)`.as("minted"),
      sql<string>`sum(refused)`.as("refused"),
      sql<string>`max(day)::text`.as("last_seen"),
      sql<boolean>`EXISTS (
        SELECT 1 FROM allowed_origins ao
        WHERE ao.org_id = origin_daily.org_id AND ao.origin = origin_daily.origin
      )`.as("allowlisted"),
    ])
    .where("org_id", "=", orgId)
    .where("day", ">=", sql<string>`((NOW() AT TIME ZONE 'UTC')::date - make_interval(days => ${days - 1}))`)
    .groupBy(["origin_daily.org_id", "origin"])
    .orderBy(sql`sum(refused)`, "desc")
    .orderBy(sql`sum(minted)`, "desc")
    .orderBy("origin", "asc")
    .execute()

  return rows.map((row) => ({
    origin: row.origin,
    minted: Number(row.minted),
    refused: Number(row.refused),
    lastSeenDay: String(row.last_seen),
    allowlisted: Boolean(row.allowlisted),
  }))
}

/** The overview's flag: how many refused loads, from how many origins, over
 *  the window. Zero-zero for a quiet week, which the page renders as nothing
 *  at all rather than as a reassurance nobody asked for. */
export async function refusedSummary(orgId: string, days = 7): Promise<RefusedSummary> {
  const row = await db
    .selectFrom("origin_daily")
    .select([
      sql<string>`coalesce(sum(refused), 0)`.as("refused"),
      sql<string>`count(distinct origin) filter (where refused > 0)`.as("origins"),
    ])
    .where("org_id", "=", orgId)
    .where("day", ">=", sql<string>`((NOW() AT TIME ZONE 'UTC')::date - make_interval(days => ${days - 1}))`)
    .executeTakeFirst()
  return { refused: Number(row?.refused ?? 0), origins: Number(row?.origins ?? 0) }
}
//#endregion

//#region Labels
/** How the page names a stored origin. Real origins are shown as themselves;
 *  the three non-origin values realtime can write are spelled out, because
 *  "(other)" on its own reads as a bug. */
export function originLabel(origin: string): string {
  if (origin === "null") return "null — a file:// page or sandboxed iframe"
  if (origin === "(other)") return "other origins — past the daily distinct-origin cap"
  if (origin === "(malformed)") return "malformed Origin headers — not from a browser"
  return origin
}

/** Whether a stored value is a real origin the tenant could allowlist. */
export function isAllowlistable(origin: string): boolean {
  return /^https?:\/\//.test(origin)
}
//#endregion
