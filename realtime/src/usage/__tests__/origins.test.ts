//#region Imports
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
import { utcDay } from "@/usage/daily"
import {
  MALFORMED_ORIGIN,
  MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY,
  OTHER_ORIGIN,
  normalizeRefusedOrigin,
  recordOriginMint,
} from "@/usage/origins"
import { newId } from "@shared/utils/ids"
//#endregion

//#region Test Setup
// DB-gated like the usage_daily suite it sits beside. Refused origins are
// attacker-supplied text, so beyond the arithmetic the tests here are about
// the two bounds that make it safe to store: shape and volume.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

const created: string[] = []

async function freshOrg(name: string): Promise<string> {
  const id = newId("org")
  await db.insertInto("organizations").values({ id, name }).execute()
  created.push(id)
  return id
}

async function rows(orgId: string, day = utcDay()) {
  return db
    .selectFrom("origin_daily")
    .select(["origin", "minted", "refused"])
    .where("org_id", "=", orgId)
    .where("day", "=", day)
    .orderBy("origin")
    .execute()
}
//#endregion

// The shape rule needs no database.
describe("normalizeRefusedOrigin", () => {
  it("keeps anything shaped like an origin, and the literal null", () => {
    expect(normalizeRefusedOrigin("https://thief.example")).toBe("https://thief.example")
    expect(normalizeRefusedOrigin("http://localhost:4400")).toBe("http://localhost:4400")
    expect(normalizeRefusedOrigin("https://Docs.Example.com:8443")).toBe(
      "https://Docs.Example.com:8443",
    )
    // file:// pages and sandboxed iframes send exactly this, and "someone
    // opened your page from disk" is a real thing to show a tenant.
    expect(normalizeRefusedOrigin("null")).toBe("null")
  })

  it("collapses everything else into the malformed sentinel", () => {
    expect(normalizeRefusedOrigin("")).toBe(MALFORMED_ORIGIN)
    expect(normalizeRefusedOrigin("javascript:alert(1)")).toBe(MALFORMED_ORIGIN)
    expect(normalizeRefusedOrigin("https://a.example/with/a/path")).toBe(MALFORMED_ORIGIN)
    expect(normalizeRefusedOrigin("https://a.example b")).toBe(MALFORMED_ORIGIN)
    expect(normalizeRefusedOrigin("<img onerror=alert(1)>")).toBe(MALFORMED_ORIGIN)
    expect(normalizeRefusedOrigin("https://" + "a".repeat(250) + ".example")).toBe(MALFORMED_ORIGIN)
  })
})

describe.skipIf(!DB_CONFIGURED)("origin_daily counters", () => {
  beforeAll(async () => {
    await migrateToLatest(db)
  })

  afterAll(async () => {
    if (created.length > 0) {
      await db.deleteFrom("organizations").where("id", "in", created).execute()
    }
    await db.destroy()
  })

  it("counts minted sessions per allowlisted origin, adding to the day's row", async () => {
    const org = await freshOrg("Minted Co")
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://docs.acme.example",
      outcome: "minted",
    })
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://docs.acme.example",
      outcome: "minted",
    })
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://help.acme.example",
      outcome: "minted",
    })
    expect(await rows(org)).toEqual([
      { origin: "https://docs.acme.example", minted: 2, refused: 0 },
      { origin: "https://help.acme.example", minted: 1, refused: 0 },
    ])
  })

  it("counts refused mints per unlisted origin — the copied-snippet number", async () => {
    const org = await freshOrg("Refused Co")
    for (let i = 0; i < 3; i++) {
      await recordOriginMint(db, {
        orgId: org,
        origin: "https://thief.example",
        outcome: "refused",
      })
    }
    await recordOriginMint(db, { orgId: org, origin: "null", outcome: "refused" })
    expect(await rows(org)).toEqual([
      { origin: "https://thief.example", minted: 0, refused: 3 },
      { origin: "null", minted: 0, refused: 1 },
    ])
  })

  it("keeps both counters on ONE row when an origin is refused and later allowlisted", async () => {
    // The staging-domain story: refused in the morning, allowlisted at
    // noon, minting by afternoon. One row tells the whole day.
    const org = await freshOrg("Staging Co")
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://staging.acme.example",
      outcome: "refused",
    })
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://staging.acme.example",
      outcome: "minted",
    })
    expect(await rows(org)).toEqual([
      { origin: "https://staging.acme.example", minted: 1, refused: 1 },
    ])
  })

  it("stores malformed refused origins under the sentinel, never as themselves", async () => {
    const org = await freshOrg("Malformed Co")
    await recordOriginMint(db, {
      orgId: org,
      origin: "<script>alert(1)</script>",
      outcome: "refused",
    })
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://a.example/path?x=1",
      outcome: "refused",
    })
    expect(await rows(org)).toEqual([{ origin: MALFORMED_ORIGIN, minted: 0, refused: 2 }])
  })

  it("adds ten concurrent mints as ten — the upsert is atomic", async () => {
    const org = await freshOrg("Concurrent Co")
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordOriginMint(db, { orgId: org, origin: "https://busy.example", outcome: "minted" }),
      ),
    )
    expect(await rows(org)).toEqual([{ origin: "https://busy.example", minted: 10, refused: 0 }])
  })

  it("caps distinct refused origins per day, collapsing the overflow into (other) while known origins keep their own row", async () => {
    const org = await freshOrg("Forged Co")
    // A script forging a fresh Origin per request, up to the cap.
    for (let i = 0; i < MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY; i++) {
      await recordOriginMint(db, {
        orgId: org,
        origin: `https://forged-${i}.example`,
        outcome: "refused",
      })
    }
    // Past the cap: two more distinct origins land under the sentinel…
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://forged-x.example",
      outcome: "refused",
    })
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://forged-y.example",
      outcome: "refused",
    })
    // …while an origin the day already knows still counts on its own row.
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://forged-0.example",
      outcome: "refused",
    })

    const all = await rows(org)
    expect(all).toHaveLength(MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY + 1)
    expect(all.find((r) => r.origin === OTHER_ORIGIN)).toEqual({
      origin: OTHER_ORIGIN,
      minted: 0,
      refused: 2,
    })
    expect(all.find((r) => r.origin === "https://forged-0.example")?.refused).toBe(2)
    expect(all.find((r) => r.origin === "https://forged-x.example")).toBeUndefined()
  })

  it("keeps days apart", async () => {
    const org = await freshOrg("Two Days Co")
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    await recordOriginMint(db, {
      orgId: org,
      origin: "https://a.example",
      outcome: "minted",
      now: yesterday,
    })
    await recordOriginMint(db, { orgId: org, origin: "https://a.example", outcome: "minted" })
    expect(await rows(org, utcDay(yesterday))).toEqual([
      { origin: "https://a.example", minted: 1, refused: 0 },
    ])
    expect(await rows(org)).toEqual([{ origin: "https://a.example", minted: 1, refused: 0 }])
  })

  it("refuses at the schema what the code never writes: an over-long origin, a negative counter", async () => {
    const org = await freshOrg("Check Co")
    await expect(
      sql`
      INSERT INTO origin_daily (org_id, day, origin, minted, refused)
      VALUES (${org}, ${utcDay()}, ${"https://" + "x".repeat(300)}, 1, 0)
    `.execute(db),
    ).rejects.toThrow(/origin_daily_origin_check|check constraint/i)
    await expect(
      sql`
      INSERT INTO origin_daily (org_id, day, origin, minted, refused)
      VALUES (${org}, ${utcDay()}, 'https://neg.example', -1, 0)
    `.execute(db),
    ).rejects.toThrow(/check constraint/i)
  })

  it("is deleted with its organization", async () => {
    const org = await freshOrg("Cascade Co")
    await recordOriginMint(db, { orgId: org, origin: "https://gone.example", outcome: "minted" })
    await db.deleteFrom("organizations").where("id", "=", org).execute()
    created.splice(created.indexOf(org), 1)
    expect(await rows(org)).toEqual([])
  })
})
