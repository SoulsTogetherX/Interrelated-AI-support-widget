//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import {
  getDailyQuota,
  recordAnswer,
  recordEscalation,
  recordSchemaFailure,
  utcDay,
} from "@/usage/daily"
import { PLANS, PLAN_ORDER } from "@shared/billing/plans"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// DB-gated like every integration suite. The counters are the one thing in
// the system that could silently disagree with the history they summarize,
// so most of these tests are about arithmetic under concurrency and about
// the CHECKs that make a disagreement unrepresentable.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

let orgId: string

async function usageRow(org: string, day = utcDay()) {
  return db
    .selectFrom("usage_daily")
    .selectAll()
    .where("org_id", "=", org)
    .where("day", "=", day)
    .executeTakeFirst()
}
//#endregion

// One outer describe so the pool is destroyed exactly once, after every
// nested suite: a per-suite destroy would tear the driver out from under
// the next one.
describe.skipIf(!DB_CONFIGURED)("usage", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
    orgId = newId("org")
    await db.insertInto("organizations").values({ id: orgId, name: "Usage Co" }).execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "=", orgId).execute()
    await db.destroy()
  })

  describe("usage_daily counters", () => {
    it("creates the day's row on the first answer and ADDS to it after", async () => {
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "First Co" }).execute()
      try {
        await recordAnswer(db, {
          orgId: org,
          refused: false,
          usage: { inputTokens: 100, outputTokens: 10 },
        })
        await recordAnswer(db, {
          orgId: org,
          refused: false,
          usage: { inputTokens: 200, outputTokens: 20 },
        })

        const row = await usageRow(org)
        expect(row?.answers).toBe(2)
        expect(row?.refusals).toBe(0)
        // BIGINT comes back as a string from pg — a sum that reached the UI
        // as "300" would be a silent formatting bug, so the coercion belongs
        // to the caller and the test asserts the raw shape.
        expect(Number(row?.input_tokens)).toBe(300)
        expect(Number(row?.output_tokens)).toBe(30)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("counts a refusal as an answer, with zero tokens", async () => {
      // The quota's whole stance: a refusal spends no generation tokens but
      // it does spend an embedding call and a retrieval query, and a ceiling
      // that exempted the cheapest questions is one an off-topic flood runs
      // straight through.
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Refusal Co" }).execute()
      try {
        await recordAnswer(db, { orgId: org, refused: true, usage: null })
        const row = await usageRow(org)
        expect(row?.answers).toBe(1)
        expect(row?.refusals).toBe(1)
        expect(Number(row?.input_tokens)).toBe(0)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("counts CONCURRENT answers exactly once each", async () => {
      // The reason this is an upsert and not a read-then-write: ten answers
      // landing together must produce ten, not "somewhere between two and
      // ten". Postgres serializes the conflicting inserts; application-side
      // arithmetic would lose most of them.
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Concurrent Co" }).execute()
      try {
        await Promise.all(
          Array.from({ length: 10 }, () =>
            recordAnswer(db, {
              orgId: org,
              refused: false,
              usage: { inputTokens: 10, outputTokens: 1 },
            }),
          ),
        )
        const row = await usageRow(org)
        expect(row?.answers).toBe(10)
        expect(Number(row?.input_tokens)).toBe(100)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("keeps days apart", async () => {
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Yesterday Co" }).execute()
      try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        await recordAnswer(db, { orgId: org, refused: false, usage: null, now: yesterday })
        await recordAnswer(db, { orgId: org, refused: false, usage: null })

        const rows = await db
          .selectFrom("usage_daily")
          .selectAll()
          .where("org_id", "=", org)
          .orderBy("day")
          .execute()
        expect(rows).toHaveLength(2)
        expect(rows.every((row) => row.answers === 1)).toBe(true)
        // Yesterday's quota must not follow a tenant into today — the whole
        // point of a DAILY ceiling.
        const quota = await getDailyQuota(db, org)
        expect(quota?.answersToday).toBe(1)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("counts escalations without touching the answer count", async () => {
      await recordEscalation(db, { orgId })
      await recordEscalation(db, { orgId })
      const row = await usageRow(orgId)
      expect(row?.escalations).toBe(2)
      expect(row?.answers).toBe(0)
    })

    it("counts a contract failure without spending the tenant's quota", async () => {
      // M7.10. The question produced NO answer — the model broke the JSON
      // contract twice — so there is no message row to count it on, and it
      // must not be charged as an answer either: a misbehaving model would
      // otherwise burn a customer's daily allowance producing nothing.
      await recordSchemaFailure(db, orgId)
      await recordSchemaFailure(db, orgId)
      const row = await usageRow(orgId)
      expect(row?.schema_failures).toBe(2)
      expect(row?.answers).toBe(0)
      expect(row?.refusals).toBe(0)
    })

    it("adds concurrent contract failures as concurrent, not as one", async () => {
      // The upsert's reason for existing, same as recordAnswer's: five
      // requests failing the contract at once must read as five.
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Concurrent Fail Co" }).execute()
      try {
        await Promise.all(Array.from({ length: 5 }, () => recordSchemaFailure(db, org)))
        const row = await usageRow(org)
        expect(row?.schema_failures).toBe(5)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("refuses a counter state that would mean two writers disagreed", async () => {
      // refusals <= answers is a CHECK because the two are written by one
      // function: a row where they diverge means something else wrote the
      // table, and a quota computed from it would be wrong in the tenant's
      // favour or against it, silently either way.
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Bad Counter Co" }).execute()
      try {
        await expect(
          db
            .insertInto("usage_daily")
            .values({
              org_id: org,
              day: utcDay(),
              answers: 1,
              refusals: 2,
            })
            .execute(),
        ).rejects.toThrow()
        await expect(
          db
            .insertInto("usage_daily")
            .values({
              org_id: org,
              day: utcDay(),
              answers: -1,
            })
            .execute(),
        ).rejects.toThrow()
        // One row per org per day, by primary key.
        await db
          .insertInto("usage_daily")
          .values({ org_id: org, day: utcDay(), answers: 1 })
          .execute()
        await expect(
          db
            .insertInto("usage_daily")
            .values({
              org_id: org,
              day: utcDay(),
              answers: 1,
            })
            .execute(),
        ).rejects.toThrow()
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })
  })

  describe("daily quota", () => {
    let quotaOrg: string

    beforeAll(async () => {
      quotaOrg = newId("org")
      await db.insertInto("organizations").values({ id: quotaOrg, name: "Quota Co" }).execute()
    })

    afterAll(async () => {
      await db.deleteFrom("organizations").where("id", "=", quotaOrg).execute()
    })

    it("reports the PLAN's ceiling, and a day with no traffic as zero", async () => {
      const quota = await getDailyQuota(db, quotaOrg)
      expect(quota?.plan).toBe("free")
      expect(quota?.limit).toBe(PLANS.free.dailyAnswers)
      // No counter row yet — absence is a quiet day, not an error.
      expect(quota?.answersToday).toBe(0)
      expect(quota?.exceeded).toBe(false)
    })

    it("follows the org's plan when it changes", async () => {
      await db
        .updateTable("organizations")
        .set({ plan: "pro" })
        .where("id", "=", quotaOrg)
        .execute()
      try {
        const quota = await getDailyQuota(db, quotaOrg)
        expect(quota?.limit).toBe(PLANS.pro.dailyAnswers)
      } finally {
        await db
          .updateTable("organizations")
          .set({ plan: "free" })
          .where("id", "=", quotaOrg)
          .execute()
      }
    })

    it("lets a deployment override TIGHTEN the plan but never widen it", async () => {
      // The direction is the point. A demo deployment must be able to cap
      // every org below its plan; a mistyped variable must not be able to
      // hand every tenant an unlimited allowance, which is exactly the
      // failure a quota exists to prevent.
      const tightened = await getDailyQuota(db, quotaOrg, { overrideLimit: 5 })
      expect(tightened?.limit).toBe(5)
      const widened = await getDailyQuota(db, quotaOrg, { overrideLimit: 1_000_000 })
      expect(widened?.limit).toBe(PLANS.free.dailyAnswers)
    })

    it("flips to exceeded AT the limit, not past it", async () => {
      const org = newId("org")
      await db.insertInto("organizations").values({ id: org, name: "Boundary Co" }).execute()
      try {
        await recordAnswer(db, { orgId: org, refused: false, usage: null })
        await recordAnswer(db, { orgId: org, refused: false, usage: null })
        // Two answers spent. A cap of 3 still allows one; a cap of 2 is done
        // — the check is >=, so the Nth answer is the last one served.
        expect((await getDailyQuota(db, org, { overrideLimit: 3 }))?.exceeded).toBe(false)
        expect((await getDailyQuota(db, org, { overrideLimit: 2 }))?.exceeded).toBe(true)
      } finally {
        await db.deleteFrom("organizations").where("id", "=", org).execute()
      }
    })

    it("returns null for an org that does not exist, rather than inventing a plan", async () => {
      expect(await getDailyQuota(db, newId("org"))).toBeNull()
    })

    it("accepts EVERY plan the catalog knows — the schema's CHECK, pinned", async () => {
      // The half of the plan-catalog contract the compiler cannot see:
      // shared/db/schema.ts types the column as PlanId, but only the database
      // knows what its CHECK allows. Adding a tier to the catalog without a
      // migration fails here, loudly, instead of at a customer's upgrade.
      for (const plan of PLAN_ORDER) {
        const org = newId("org")
        await db
          .insertInto("organizations")
          .values({ id: org, name: `Plan ${plan}`, plan })
          .execute()
        try {
          const stored = await db
            .selectFrom("organizations")
            .select("plan")
            .where("id", "=", org)
            .executeTakeFirstOrThrow()
          expect(stored.plan).toBe(plan)
          expect((await getDailyQuota(db, org))?.limit).toBe(PLANS[plan].dailyAnswers)
        } finally {
          await db.deleteFrom("organizations").where("id", "=", org).execute()
        }
      }
    })
  })
})

describe.skipIf(DB_CONFIGURED)("usage counters (skipped)", () => {
  it("is skipped because POSTGRES_PASSWORD is not set", () => {
    expect(pool).toBeDefined()
  })
})
