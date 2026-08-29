//#region Imports
import { describe, expect, it } from "vitest"

import { PLANS, PLAN_ORDER, isPlanId, planFor } from "../plans"
//#endregion

//#region Tests
// A catalog is data, so what is worth testing is its SHAPE — the properties
// three packages assume without checking. The database's agreement with it
// (the CHECK on organizations.plan) cannot be seen from here and is pinned
// by a DB-gated test in realtime instead.
describe("plan catalog", () => {
  it("orders every plan, exactly once, cheapest first", () => {
    // The billing page renders PLAN_ORDER and the upgrade path reads it, so
    // a plan missing from it would be invisible in the product while still
    // being assignable in the database.
    expect([...PLAN_ORDER].sort()).toEqual(Object.keys(PLANS).sort())
    const prices = PLAN_ORDER.map((id) => PLANS[id].priceUsdPerMonth)
    expect(prices).toEqual([...prices].sort((a, b) => a - b))
  })

  it("makes every paid tier strictly more generous than the one below", () => {
    // Not decoration: a tier that costs more and allows less is a support
    // ticket, and the quota check would happily enforce it.
    const caps = PLAN_ORDER.map((id) => PLANS[id].dailyAnswers)
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i]).toBeGreaterThan(caps[i - 1])
    }
    const sources = PLAN_ORDER.map((id) => PLANS[id].sources)
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i]).toBeGreaterThan(sources[i - 1])
    }
  })

  it("starts free at a genuinely free price", () => {
    // Unlike model prices, where 0 is almost always the wrong answer
    // (shared/pricing/models.ts), this zero is real and the product
    // promises it.
    expect(planFor("free").priceUsdPerMonth).toBe(0)
    expect(planFor("free").dailyAnswers).toBeGreaterThan(0)
  })

  it("guards strings arriving from a form or a webhook", () => {
    // isPlanId is what stands between a Stripe webhook's metadata and an
    // UPDATE on organizations.plan.
    expect(isPlanId("pro")).toBe(true)
    expect(isPlanId("enterprise")).toBe(false)
    expect(isPlanId("")).toBe(false)
    expect(isPlanId(null)).toBe(false)
    expect(isPlanId(7)).toBe(false)
    // Prototype keys are not plans — hasOwnProperty rather than `in`.
    expect(isPlanId("constructor")).toBe(false)
    expect(isPlanId("toString")).toBe(false)
  })
})
//#endregion
