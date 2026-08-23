//#region Type Defs
/** One fused result: the item's id and its accumulated RRF score. */
interface FusedResult {
  id: string
  /** Sum over rankings of 1/(k + rank). Higher is better. This is the
   *  "fused retrieval score" the plan's refusal threshold (M2) cuts on —
   *  exposing it, not just the order, is deliberate. */
  score: number
}
//#endregion

//#region Constants
/** The k in 1/(k + rank), from Cormack, Clarke & Buettcher (2009), where
 *  k=60 was shown to be robust across collections. Its job is to damp the
 *  gap between rank 1 and rank 2 (1/61 vs 1/62 — nearly equal) so one
 *  ranker's top pick cannot steamroll consensus further down. Smaller k
 *  trusts individual rankers' head picks more; larger k flattens toward
 *  counting how many rankers found the item at all. */
const DEFAULT_RRF_K = 60
//#endregion

//#region Fusion
/**
 * Reciprocal Rank Fusion: merges N ranked lists into one, scoring each item
 * by Σ 1/(k + rank_r) over the rankings r that contain it (1-based ranks).
 *
 * Why RRF and not score fusion: the two arms of hybrid retrieval produce
 * scores on incomparable scales (cosine distance in [0,2] vs ts_rank_cd's
 * unbounded positives), and any weighted-sum scheme needs per-corpus
 * calibration that would drift. RRF uses only the RANKS, which are always
 * comparable, and is the standard baseline the IR literature keeps failing
 * to beat by much. Hand-written here because retrieval is this project's
 * technical content (see the anti-tutorial rules in the plan): it is ~20
 * lines, and abstracting it away deletes the reason to show it.
 *
 * Determinism contract (the eval harness depends on it): ties in score are
 * broken by first appearance — earlier ranking first, then earlier rank.
 * Two runs over the same inputs produce byte-identical output.
 *
 * A duplicate id WITHIN one ranking is a caller bug (both retrieval arms
 * return each chunk at most once by construction) and throws rather than
 * silently double-counting.
 */
function rrfFuse(
  rankings: ReadonlyArray<ReadonlyArray<string>>,
  k: number = DEFAULT_RRF_K,
): FusedResult[] {
  if (!Number.isFinite(k) || k < 0) throw new Error(`rrf k must be a non-negative number, got ${k}`)

  // firstSeen is the tie-break: insertion order into a Map is stable, but we
  // record an explicit counter so the sort comparator can use it directly.
  const scores = new Map<string, { score: number; firstSeen: number }>()
  let seenCounter = 0

  for (const ranking of rankings) {
    const inThisRanking = new Set<string>()
    for (let rank = 1; rank <= ranking.length; rank++) {
      const id = ranking[rank - 1] as string
      if (inThisRanking.has(id)) {
        throw new Error(`duplicate id "${id}" within one ranking — upstream retrieval bug`)
      }
      inThisRanking.add(id)
      const entry = scores.get(id)
      const contribution = 1 / (k + rank)
      if (entry) entry.score += contribution
      else scores.set(id, { score: contribution, firstSeen: seenCounter++ })
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstSeen - b[1].firstSeen)
    .map(([id, { score }]) => ({ id, score }))
}
//#endregion

//#region Exports
export { rrfFuse, DEFAULT_RRF_K }
export type { FusedResult }
//#endregion
