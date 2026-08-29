//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/lib/db"
import { getTodayUsage, listRecentUsage } from "@/lib/usage/queries"
import { PLANS } from "@shared/billing/plans"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// DB-gated like every integration suite here. The counters themselves are
// realtime's to write (and are tested there); what this suite pins is the
// dashboard's reading of them — the plan link, the UTC day boundary, and
// the fact that zero is an honest answer on this surface even though it is
// a lie on the metrics one.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

let orgId: string

const utcToday = (): string => new Date().toISOString().slice(0, 10)
const utcDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
//#endregion

describe.skipIf(!DB_CONFIGURED)("usage reads", () => {
  beforeAll(async () => {
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Usage Read Co" }).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
  })

  it("reports a quiet day as zero against the plan's ceiling", async () => {
    // Zero is the honest answer here, unlike the rates on the metrics page:
    // "0 answers today" is a fact about a quiet morning, where "0%
    // deflection" would be a claim about a product nobody has used.
    const usage = await getTodayUsage(orgId)
    expect(usage?.answers).toBe(0)
    expect(usage?.plan.id).toBe("free")
    expect(usage?.limit).toBe(PLANS.free.dailyAnswers)
    expect(usage?.fraction).toBe(0)
  })

  it("reads today's counters and follows a plan change", async () => {
    await db
      .insertInto("usage_daily")
      .values({
        org_id: orgId,
        day: utcToday(),
        answers: 40,
        refusals: 4,
        escalations: 2,
        input_tokens: 12_000,
        output_tokens: 900,
      })
      .execute()

    const free = await getTodayUsage(orgId)
    expect(free?.answers).toBe(40)
    expect(free?.refusals).toBe(4)
    expect(free?.escalations).toBe(2)
    expect(free?.inputTokens).toBe(12_000)
    expect(free?.fraction).toBeCloseTo(40 / PLANS.free.dailyAnswers, 10)

    await db.updateTable("organizations").set({ plan: "pro" }).where("id", "=", orgId).execute()
    try {
      const pro = await getTodayUsage(orgId)
      // Same traffic, a bigger ceiling: the number shown to the tenant is
      // the plan's, not a copy taken when the counter was written.
      expect(pro?.limit).toBe(PLANS.pro.dailyAnswers)
      expect(pro?.fraction).toBeCloseTo(40 / PLANS.pro.dailyAnswers, 10)
    } finally {
      await db.updateTable("organizations").set({ plan: "free" }).where("id", "=", orgId).execute()
    }
  })

  it("clamps an overshoot to a full bar rather than rendering past 100%", async () => {
    // A counter can exceed its cap by the answers already in flight when
    // the ceiling was reached. That overshoot is real and small; a progress
    // bar wider than its track just looks like a bug.
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Overshoot Co" }).execute()
    try {
      await db
        .insertInto("usage_daily")
        .values({
          org_id: org,
          day: utcToday(),
          answers: PLANS.free.dailyAnswers + 3,
        })
        .execute()
      const usage = await getTodayUsage(org)
      expect(usage?.answers).toBe(PLANS.free.dailyAnswers + 3)
      expect(usage?.fraction).toBe(1)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("does not count yesterday against today", async () => {
    const org = newId("org")
    await db.insertInto("organizations").values({ id: org, name: "Rollover Co" }).execute()
    try {
      await db
        .insertInto("usage_daily")
        .values({ org_id: org, day: utcDaysAgo(1), answers: 199 })
        .execute()
      const usage = await getTodayUsage(org)
      expect(usage?.answers).toBe(0)

      const recent = await listRecentUsage(org)
      expect(recent).toHaveLength(1)
      expect(recent[0]?.answers).toBe(199)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", org).execute()
    }
  })

  it("keeps one tenant's usage out of another's", async () => {
    const other = newId("org")
    await db.insertInto("organizations").values({ id: other, name: "Noisy Neighbour Co" }).execute()
    try {
      await db
        .insertInto("usage_daily")
        .values({ org_id: other, day: utcToday(), answers: 5_000 })
        .execute()
      const usage = await getTodayUsage(orgId)
      // orgId's own 40 from the earlier test, not the neighbour's 5,000.
      expect(usage?.answers).toBe(40)
      expect(await listRecentUsage(orgId)).toHaveLength(1)
    } finally {
      await db.deleteFrom("organizations").where("id", "=", other).execute()
    }
  })

  it("returns null for an org that does not exist", async () => {
    expect(await getTodayUsage(newId("org"))).toBeNull()
  })
})
