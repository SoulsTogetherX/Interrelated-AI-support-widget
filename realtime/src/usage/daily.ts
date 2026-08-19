//#region Imports
import { sql } from "kysely"
import type { Kysely, Transaction } from "kysely"

import type { PlanId } from "@shared/billing/plans"
import { planFor } from "@shared/billing/plans"
import type { LLMUsage } from "@providers/llm/types"

import type { Database } from "@/db/schema"
//#endregion

//#region Type Defs
/**
 * The usage counters (M5.3) — writes on the answer path, one read on the
 * hot path before every model call.
 *
 * Every write here takes a Kysely OR a Transaction, and every caller passes
 * a transaction: the counter is incremented in the same transaction as the
 * row it counts, so the two cannot disagree. That is the property a nightly
 * rollup job would give up, and with it the ability to enforce a quota at
 * all — a cap checked against a number that is up to a day stale is not a
 * cap.
 */
type DbOrTrx = Kysely<Database> | Transaction<Database>

/** What the pre-flight check needs, in one primary-key-shaped read. */
interface DailyQuota {
  plan: PlanId
  /** Answers already spent today, refusals included. */
  answersToday: number
  /** The ceiling in force: the plan's, tightened by any deployment-wide
   *  override. */
  limit: number
  exceeded: boolean
}
//#endregion

//#region Helpers
/**
 * The UTC day an instant belongs to, as `YYYY-MM-DD`.
 *
 * UTC rather than an org-local day: the primary key would otherwise depend
 * on a setting a tenant can change, and moving offices would silently
 * re-bucket their history. An arbitrary but FIXED boundary is what makes
 * yesterday's number still true tomorrow. Built from the UTC components
 * rather than slicing toISOString() so the intent survives a reader who
 * wonders whether the slice is timezone-dependent (it is not, but the
 * question costs more than the four lines).
 */
function utcDay(now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
//#endregion

//#region Writes
/**
 * Counts one answer — every assistant message, refusals included (the
 * migration explains why the cheapest questions must still count).
 *
 * The increment amounts travel in the VALUES and the conflict branch adds
 * `excluded` to the stored row, so the numbers appear exactly once in this
 * function instead of once per branch. A refusal contributes 1 answer, 1
 * refusal, and 0 tokens; an unmetered answer contributes 0 tokens rather
 * than nothing, because "the provider said nothing" must not stop the
 * ANSWER from counting against the quota.
 */
async function recordAnswer(
  db: DbOrTrx,
  entry: { orgId: string; refused: boolean; usage: LLMUsage | null; now?: Date },
): Promise<void> {
  await db
    .insertInto("usage_daily")
    .values({
      org_id: entry.orgId,
      day: utcDay(entry.now),
      answers: 1,
      refusals: entry.refused ? 1 : 0,
      escalations: 0,
      input_tokens: entry.usage?.inputTokens ?? 0,
      output_tokens: entry.usage?.outputTokens ?? 0,
    })
    .onConflict((oc) => oc.columns(["org_id", "day"]).doUpdateSet({
      answers: sql`usage_daily.answers + excluded.answers`,
      refusals: sql`usage_daily.refusals + excluded.refusals`,
      input_tokens: sql`usage_daily.input_tokens + excluded.input_tokens`,
      output_tokens: sql`usage_daily.output_tokens + excluded.output_tokens`,
      updated_at: sql`NOW()`,
    }))
    .execute()
}

/** Counts one escalation. Called ONLY when a handoff row was actually
 *  created (§3.23) — an idempotent re-request returns the first handoff and
 *  must add nothing, or one visitor's impatience inflates the escalation
 *  rate the deflection metric is measured against. */
async function recordEscalation(
  db: DbOrTrx,
  entry: { orgId: string; now?: Date },
): Promise<void> {
  await db
    .insertInto("usage_daily")
    .values({
      org_id: entry.orgId,
      day: utcDay(entry.now),
      answers: 0,
      refusals: 0,
      escalations: 1,
      input_tokens: 0,
      output_tokens: 0,
    })
    .onConflict((oc) => oc.columns(["org_id", "day"]).doUpdateSet({
      escalations: sql`usage_daily.escalations + excluded.escalations`,
      updated_at: sql`NOW()`,
    }))
    .execute()
}

/**
 * A question that produced NO answer because the model broke the answer
 * contract twice (migration 010). The one schema-violation case that cannot
 * be a column on `messages`, because there IS no message row — which is
 * exactly why it must be counted somewhere: a provider failing
 * systematically would otherwise show up as perfect, its worst outcome
 * recorded as no outcome.
 *
 * Deliberately NOT part of `answers`. That counter is the quota's
 * denominator, and charging a tenant's daily allowance for a question the
 * product failed to answer would let a misbehaving model burn a customer's
 * plan. It costs us tokens, which the messages rows already record for the
 * attempts that did produce answers; this row is the alerting number.
 *
 * Takes a plain Kysely rather than requiring a transaction, unlike its
 * siblings: there is no row to stay consistent WITH — the pipeline throws
 * immediately after — and the caller wraps it so an instrumentation failure
 * can never replace the error the visitor's request actually produced.
 */
async function recordSchemaFailure(
  db: DbOrTrx,
  orgId: string,
  now?: Date,
): Promise<void> {
  await db
    .insertInto("usage_daily")
    .values({
      org_id: orgId,
      day: utcDay(now),
      answers: 0,
      refusals: 0,
      escalations: 0,
      schema_failures: 1,
      input_tokens: 0,
      output_tokens: 0,
    })
    .onConflict((oc) => oc.columns(["org_id", "day"]).doUpdateSet({
      schema_failures: sql`usage_daily.schema_failures + excluded.schema_failures`,
      updated_at: sql`NOW()`,
    }))
    .execute()
}
//#endregion

//#region Reads
/**
 * The pre-flight quota check: the org's plan and what it has spent today,
 * in ONE round trip.
 *
 * A LEFT JOIN rather than two queries because both sides are primary-key
 * lookups and the answer is needed before anything else happens — the check
 * runs ahead of every question, so its cost is paid more often than any
 * other query on this path. Missing counter row means a day with no
 * traffic, which is 0 rather than an error.
 *
 * `overrideLimit` is a DEPLOYMENT-wide ceiling (WIDGET_DAILY_ANSWER_CAP)
 * and can only TIGHTEN: the effective limit is the minimum of it and the
 * plan's. Letting it widen would mean one mistyped environment variable
 * hands every tenant on every plan an unlimited allowance, which is the
 * failure mode a quota exists to prevent.
 *
 * Returns null when the org does not exist — the caller decides what that
 * means (on the widget route it cannot happen, since the session token was
 * minted against a live org, but returning null beats inventing a plan).
 */
async function getDailyQuota(
  db: DbOrTrx,
  orgId: string,
  options: { overrideLimit?: number | undefined; now?: Date } = {},
): Promise<DailyQuota | null> {
  const row = await db
    .selectFrom("organizations")
    .leftJoin("usage_daily", (join) => join
      .onRef("usage_daily.org_id", "=", "organizations.id")
      .on("usage_daily.day", "=", utcDay(options.now)))
    .select(["organizations.plan as plan", "usage_daily.answers as answers"])
    .where("organizations.id", "=", orgId)
    .executeTakeFirst()
  if (!row) return null

  const planLimit = planFor(row.plan).dailyAnswers
  const limit = options.overrideLimit === undefined
    ? planLimit
    : Math.min(planLimit, options.overrideLimit)
  const answersToday = Number(row.answers ?? 0)
  return { plan: row.plan, answersToday, limit, exceeded: answersToday >= limit }
}
//#endregion

//#region Exports
export { utcDay, recordAnswer, recordEscalation, recordSchemaFailure, getDailyQuota }
export type { DailyQuota }
//#endregion
