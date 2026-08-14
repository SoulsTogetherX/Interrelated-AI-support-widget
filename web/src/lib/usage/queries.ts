//#region Why this file
// The dashboard's read side of the usage counters (M5.3) — the same
// usage_daily rows realtime writes on the answer path and reads before
// every model call, shown to the tenant so the ceiling is never a surprise.
//
// Straight from Postgres like every dashboard read (§9.4): a realtime
// outage must not blank a page whose whole job is telling a customer
// whether their widget is still answering.
//
// Zeros here are honest, unlike the rates in metrics/queries.ts. "0 answers
// today" is a fact about a quiet morning; "0% deflection" would be a claim
// about a product nobody has used. Absence of a counter row means a day
// with no traffic, which is 0 rather than null.
//#endregion

//#region Imports
import { sql } from "kysely"

import { planFor } from "@shared/billing/plans"
import type { Plan, PlanId } from "@shared/billing/plans"

import { db } from "@/lib/db"
//#endregion

//#region Types
export interface TodayUsage {
  plan: Plan
  answers: number
  refusals: number
  escalations: number
  inputTokens: number
  outputTokens: number
  /** The plan's daily ceiling. The deployment override (§3.18) is NOT
   *  applied here: it lives in realtime's environment, and a dashboard that
   *  guessed at it would state a limit the service might not enforce. What
   *  this page promises is what the PLAN promises. */
  limit: number
  /** 0–1, clamped: a counter can exceed its cap by the answers already in
   *  flight when the ceiling was reached, and a progress bar past 100% reads
   *  as a rendering bug rather than as the honest overshoot it is. */
  fraction: number
}

export interface UsageDay {
  day: string
  answers: number
  refusals: number
  escalations: number
}
//#endregion

//#region Queries
/** Today's counters against the org's plan — one primary-key read, the same
 *  row realtime checks before every answer. */
export async function getTodayUsage(orgId: string): Promise<TodayUsage | null> {
  const row = await db
    .selectFrom("organizations")
    .leftJoin("usage_daily", (join) => join
      .onRef("usage_daily.org_id", "=", "organizations.id")
      // The day boundary is the DATABASE's idea of today in UTC, matching
      // what realtime writes (realtime/src/usage/daily.ts). Computing it in
      // this process instead would put a Vercel instance's clock in charge
      // of a boundary Postgres already owns.
      .on("usage_daily.day", "=", sql<string>`(NOW() AT TIME ZONE 'UTC')::date`))
    .select([
      "organizations.plan as plan",
      "usage_daily.answers as answers",
      "usage_daily.refusals as refusals",
      "usage_daily.escalations as escalations",
      "usage_daily.input_tokens as input_tokens",
      "usage_daily.output_tokens as output_tokens",
    ])
    .where("organizations.id", "=", orgId)
    .executeTakeFirst()
  if (!row) return null

  const plan = planFor(row.plan as PlanId)
  const answers = Number(row.answers ?? 0)
  return {
    plan,
    answers,
    refusals: Number(row.refusals ?? 0),
    escalations: Number(row.escalations ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    limit: plan.dailyAnswers,
    fraction: Math.min(1, answers / plan.dailyAnswers),
  }
}

/** The trailing window, newest first — the usage_daily_recent index's only
 *  caller. Days with no traffic are simply absent; the caller renders what
 *  it gets rather than this file inventing empty rows for a chart that does
 *  not exist yet. */
export async function listRecentUsage(orgId: string, days = 14): Promise<UsageDay[]> {
  const rows = await db
    .selectFrom("usage_daily")
    .select(["day", "answers", "refusals", "escalations"])
    .where("org_id", "=", orgId)
    .where("day", ">=", sql<string>`((NOW() AT TIME ZONE 'UTC')::date - make_interval(days => ${days}))`)
    .orderBy("day", "desc")
    .execute()

  return rows.map((row) => ({
    day: String(row.day),
    answers: Number(row.answers),
    refusals: Number(row.refusals),
    escalations: Number(row.escalations),
  }))
}
//#endregion
