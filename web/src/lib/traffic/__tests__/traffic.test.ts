// DB-gated integration suite (self-skips without POSTGRES_PASSWORD; schema
// must already be migrated — same prerequisite and CI ordering as
// lib/auth/__tests__/authFlow.test.ts). The counter rows are inserted
// directly: writing them is realtime's job (usage/origins.ts) and tested
// there; this suite is about adding them up correctly for the page.
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { newId } from "@shared/utils/ids"

import { db } from "@/lib/db"
import { isAllowlistable, listOriginTraffic, originLabel, refusedSummary } from "../queries"

const hasDb = Boolean(process.env.POSTGRES_PASSWORD)

let orgA: string
let orgB: string

/** A UTC day `n` days ago as YYYY-MM-DD, computed by POSTGRES so the test's
 *  idea of "today" is the query's. */
async function daysAgo(n: number): Promise<string> {
  const r = await sql<{ d: string }>`
    SELECT ((NOW() AT TIME ZONE 'UTC')::date - make_interval(days => ${n}))::date::text AS d
  `.execute(db)
  return r.rows[0]!.d
}

async function counter(orgId: string, day: string, origin: string, minted: number, refused: number) {
  await db.insertInto("origin_daily").values({ org_id: orgId, day, origin, minted, refused }).execute()
}

describe.skipIf(!hasDb)("origin traffic (integration)", () => {
  beforeAll(async () => {
    orgA = newId("org")
    orgB = newId("org")
    await db.insertInto("organizations").values([
      { id: orgA, name: "Traffic Co" },
      { id: orgB, name: "Other Tenant" },
    ]).execute()
    await db.insertInto("allowed_origins").values({ org_id: orgA, origin: "https://docs.acme.example" }).execute()

    const today = await daysAgo(0)
    const twoAgo = await daysAgo(2)
    const sixAgo = await daysAgo(6)
    const sevenAgo = await daysAgo(7)
    // Allowlisted, busy, no refusals — should sort BELOW anything refused.
    await counter(orgA, today, "https://docs.acme.example", 40, 0)
    await counter(orgA, twoAgo, "https://docs.acme.example", 60, 0)
    // A copy on someone else's site: refused, spread over two days.
    await counter(orgA, today, "https://thief.example", 0, 3)
    await counter(orgA, sixAgo, "https://thief.example", 0, 4)
    // The forgotten staging domain: refused, then (this test does not
    // allowlist it) — allowlistable, not allowlisted.
    await counter(orgA, twoAgo, "https://staging.acme.example", 0, 1)
    // Sentinels realtime can write.
    await counter(orgA, today, "(malformed)", 0, 9)
    await counter(orgA, today, "null", 0, 2)
    // Just outside a 7-day window: must not appear.
    await counter(orgA, sevenAgo, "https://ancient.example", 0, 100)
    // Another tenant's busier week: invisible to A.
    await counter(orgB, today, "https://thief.example", 0, 500)
    await counter(orgB, today, "https://docs.acme.example", 500, 0)
  })

  afterAll(async () => {
    await db.deleteFrom("organizations").where("id", "in", [orgA, orgB]).execute()
    await db.destroy()
  })

  it("sums the window per origin, refused first, and flags what is allowlisted now", async () => {
    const rows = await listOriginTraffic(orgA, 7)
    expect(rows.map((r) => r.origin)).toEqual([
      "(malformed)",                 // 9 refused
      "https://thief.example",       // 7 refused
      "null",                        // 2 refused
      "https://staging.acme.example", // 1 refused
      "https://docs.acme.example",   // 0 refused, 100 minted
    ])
    const thief = rows.find((r) => r.origin === "https://thief.example")!
    expect(thief).toMatchObject({ minted: 0, refused: 7, allowlisted: false })
    expect(thief.lastSeenDay).toBe(await daysAgo(0))
    const docs = rows.find((r) => r.origin === "https://docs.acme.example")!
    expect(docs).toMatchObject({ minted: 100, refused: 0, allowlisted: true })
    // Seven days ago is outside "the last 7 days, today included".
    expect(rows.find((r) => r.origin === "https://ancient.example")).toBeUndefined()
  })

  it("widens with the window", async () => {
    const rows = await listOriginTraffic(orgA, 8)
    expect(rows.find((r) => r.origin === "https://ancient.example")).toMatchObject({ refused: 100 })
  })

  it("summarizes refusals for the overview flag, and reads zero-zero for a quiet tenant", async () => {
    expect(await refusedSummary(orgA, 7)).toEqual({ refused: 9 + 7 + 2 + 1, origins: 4 })
    const quiet = newId("org")
    await db.insertInto("organizations").values({ id: quiet, name: "Quiet Co" }).execute()
    try {
      expect(await refusedSummary(quiet, 7)).toEqual({ refused: 0, origins: 0 })
      expect(await listOriginTraffic(quiet, 7)).toEqual([])
    } finally {
      await db.deleteFrom("organizations").where("id", "=", quiet).execute()
    }
  })

  it("keeps tenants apart — B's busier week is invisible to A and vice versa", async () => {
    const b = await listOriginTraffic(orgB, 7)
    expect(b.map((r) => [r.origin, r.minted, r.refused])).toEqual([
      ["https://thief.example", 0, 500],
      ["https://docs.acme.example", 500, 0],
    ])
    // B never allowlisted docs.acme — the flag is per tenant, not per string.
    expect(b.find((r) => r.origin === "https://docs.acme.example")?.allowlisted).toBe(false)
  })
})

describe("origin labels", () => {
  it("spells out the non-origin values and leaves real origins alone", () => {
    expect(originLabel("https://thief.example")).toBe("https://thief.example")
    expect(originLabel("null")).toMatch(/file:\/\//)
    expect(originLabel("(other)")).toMatch(/cap/)
    expect(originLabel("(malformed)")).toMatch(/malformed/i)
  })

  it("offers Allow only for something the allowlist could hold", () => {
    expect(isAllowlistable("https://staging.acme.example")).toBe(true)
    expect(isAllowlistable("http://localhost:4400")).toBe(true)
    expect(isAllowlistable("null")).toBe(false)
    expect(isAllowlistable("(other)")).toBe(false)
    expect(isAllowlistable("(malformed)")).toBe(false)
  })
})
