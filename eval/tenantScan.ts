//#region Why this file
// The scoring half of the tenant-filtering measurement (M7.11) — the number
// that justifies `hnsw.iterative_scan = 'relaxed_order'` (§3.12).
//
// The plan lists "recall with and without iterative scans under tenant
// filtering" among the retrieval metrics, and names the underlying trap as
// the most interesting decision in the schema: with HNSW, Postgres searches
// the index and THEN applies the org filter, so a small tenant inside a
// large shared index can silently come back with fewer than k rows — or
// none — while every query still returns 200 and every test that uses one
// tenant still passes. The multi-tenant regression test (§3.8) proves the
// bug bites; this produces the figure that says how hard.
//
// Pure and database-free on purpose, the same split as eval/metrics.ts and
// its runner: the harness (realtime/scripts/runTenantScan.ts) owns the
// Postgres work, and everything published is computed here where a
// hand-written fixture can pin it. The numbers reach a README, so they get
// a test.
//
// What "recall" means HERE, stated because it is not the golden set's
// recall: a tenant asking for k rows of its OWN corpus should get k. So
// recall is (rows returned that belong to the querying tenant) / k, and a
// value below 1 means the index handed back fewer than the tenant asked
// for. It is a mechanical property of filtering and geometry, not a
// question of which chunk is the better answer — which is exactly why the
// harness runs it under MOCK embeddings (§2.4.5b) rather than refusing them
// the way the quality eval does: uniform random directions make the
// discard rate depend on tenant count alone, where real embeddings would
// cluster by topic and confound it.
//#endregion

//#region Type Defs
/** One tenant's result for one setting. `returned` counts rows that came
 *  back AND belong to the querying tenant — a foreign row would be a
 *  filtering bug rather than a starvation one, and the harness asserts
 *  their absence separately. */
interface TenantOutcome {
  orgId: string
  returned: number
  latencyMs: number
}

/** What one (tenant count × setting) cell of the sweep reports. */
interface ScanSummary {
  tenants: number
  k: number
  /** Tenants that got fewer than k of their own rows. The headline: with
   *  iterative scans this must be 0, and without it climbs with the index. */
  starved: number
  starvedFraction: number
  /** Mean rows returned per tenant, and the same as a fraction of k. A
   *  tenant getting 2 of 5 is a widget answering from 40% of its own
   *  documentation without any error anywhere. */
  meanReturned: number
  recall: number
  latencyP50Ms: number
  latencyP95Ms: number
}
//#endregion

//#region Scoring
/** Nearest-rank percentile, never interpolated — loadtest/histogram.ts's
 *  argument: interpolation invents a latency nobody measured, which is the
 *  wrong thing to print beside "p95". Kept here rather than imported so
 *  eval/ stays importable without loadtest/ (they are separate alias roots
 *  and nothing else joins them). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number
}

/**
 * Summarizes one setting's run over all tenants.
 *
 * Throws on an empty run rather than reporting zeros: "no tenant starved"
 * and "no tenant was measured" are opposite findings, and a sweep that
 * silently produced the first from the second would be a published lie.
 * Same stance as eval/metrics.ts's guards.
 */
function summarizeScan(
  outcomes: readonly TenantOutcome[],
  k: number,
): ScanSummary {
  if (outcomes.length === 0) throw new Error("summarizeScan: no tenants measured")
  if (!Number.isInteger(k) || k < 1) throw new Error(`summarizeScan: k must be a positive integer, got ${k}`)

  const starved = outcomes.filter((o) => o.returned < k).length
  const totalReturned = outcomes.reduce((sum, o) => sum + o.returned, 0)
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b)

  return {
    tenants: outcomes.length,
    k,
    starved,
    starvedFraction: starved / outcomes.length,
    meanReturned: totalReturned / outcomes.length,
    // Capped at 1 per tenant before averaging would be the same number here,
    // since a tenant can never receive more of its own rows than it asked
    // for — the LIMIT bounds it. Left as a plain ratio so a future change
    // that broke that bound would show up as a recall above 1 rather than
    // being quietly clamped out of sight.
    recall: totalReturned / (outcomes.length * k),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  }
}
//#endregion

//#region Exports
export { summarizeScan, percentile }
export type { TenantOutcome, ScanSummary }
//#endregion
