//#region Why this file
// The plan catalog — what each tier is called, what it costs, and what it
// allows. One table, read by three surfaces that must agree: realtime
// enforces the answer ceiling before every model call (§3.18), the
// dashboard shows a tenant where they stand against it (§9.14), and M5.4's
// checkout turns a plan id into a Stripe price.
//
// In shared/ for the ordinary reason — it is a cross-package contract, and
// three copies of "the free tier stops at 200" would eventually disagree
// on the number a customer was charged against. Pure data, no imports.
//
// The ids are the SAME three the schema's CHECK allows
// (organizations.plan), and that is a coupling with two enforcers rather
// than one: shared/db/schema.ts types the column as PlanId, so a plan this
// file does not know is a compile error, and a DB-gated test inserts an org
// at every catalog id, so a plan the CHECK does not know is a loud test
// failure. Neither alone is enough — the type cannot see the SQL, and the
// test cannot see a typo the compiler would catch first.
//
// What is deliberately NOT here: anything a tenant can change. Per-org
// overrides, trial extensions, and negotiated ceilings all belong in a
// column on the org, not in a constant compiled into three packages. The
// only override that exists today is a deployment-wide ceiling
// (WIDGET_DAILY_ANSWER_CAP), and it can only TIGHTEN a plan — see §3.18.
//#endregion

//#region Type Defs
/** The three tiers. Mirrors the organizations.plan CHECK exactly. */
type PlanId = "free" | "starter" | "pro"

interface Plan {
  id: PlanId
  /** What the dashboard calls it. */
  name: string
  /** USD per month, list. 0 for free — this one really is zero, unlike the
   *  model prices where unknown is null (shared/pricing/models.ts). */
  priceUsdPerMonth: number
  /**
   * Answers per UTC day, counted per ORG. The ceiling M5's pre-flight check
   * enforces before any model call — the plan's promise that the worst case
   * is a stopped widget rather than a surprise bill.
   *
   * Counts refusals too. A refusal spends no generation tokens but it does
   * spend an embedding call and a retrieval query, and excluding it would
   * let an off-topic flood run free — the cheapest questions to ask are
   * exactly the ones a quota must still bound.
   */
  dailyAnswers: number
  /** Sources (crawl targets) the org may connect. Not yet enforced — the
   *  number is shown on the billing page and the enforcement lands with the
   *  surface that would need it; stating a limit we do not check would be
   *  worse than stating none. */
  sources: number
  /** One line for the plan card, in the product's own voice. */
  blurb: string
}
//#endregion

//#region Constants
/**
 * The catalog. Deliberately three tiers with one axis that actually bites
 * (answers per day): a portfolio product with five tiers and eleven
 * feature flags is inventing a business, and the interesting engineering
 * is enforcing ONE quota correctly before the model call rather than
 * modelling many.
 */
const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    priceUsdPerMonth: 0,
    dailyAnswers: 200,
    sources: 1,
    blurb: "Enough to put the widget on a docs site and see what visitors ask.",
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceUsdPerMonth: 19,
    dailyAnswers: 2_000,
    sources: 5,
    blurb: "For a product with real support traffic and more than one source.",
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdPerMonth: 99,
    dailyAnswers: 20_000,
    sources: 50,
    blurb: "High volume, many sources, and headroom for a busy support team.",
  },
}

/** Display order — cheapest first, which is also the order the billing page
 *  renders and the order an upgrade path reads in. */
const PLAN_ORDER: readonly PlanId[] = ["free", "starter", "pro"]
//#endregion

//#region Exports
/** The plan for an org's stored tier. Total by construction: the column is
 *  typed PlanId and CHECK-constrained to the same three values, so there is
 *  no unknown-plan branch to write a wrong fallback for. */
function planFor(id: PlanId): Plan {
  return PLANS[id]
}

/** True when `value` is one of the catalog's ids — the guard for strings
 *  arriving from a form or a Stripe webhook, where the type says nothing. */
function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLANS, value)
}

export { PLANS, PLAN_ORDER, planFor, isPlanId }
export type { Plan, PlanId }
//#endregion
