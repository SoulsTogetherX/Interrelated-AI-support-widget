//#region Imports
import type { RetrievedChunk } from "@/retrieval/search"
//#endregion

//#region Type Defs
/**
 * The groundedness gate — the numeric decision to answer or refuse, made
 * BEFORE any model call so a refusal costs zero tokens.
 *
 * A correction to the M1 docs, worth stating loudly: the plan said the
 * refusal threshold cuts on the FUSED score, but the fused RRF score is
 * rank-based and therefore RELEVANCE-BLIND — every non-empty retrieval has
 * a rank 1, and rank 1 scores ~1/61 whether the corpus contains the answer
 * or the query is about the weather. Cutting on it would refuse almost
 * nothing. What IS calibratable is the dense arm's cosine distance: an
 * absolute-ish similarity in [0, 2] where "closest chunk is still far"
 * genuinely means "the corpus has nothing like this". So the gate cuts on
 * the MINIMUM dense distance across the retrieved set, and M2.7 chooses
 * the operating point from the eval set by plotting correct-refusal
 * against false-refusal. The fused score still orders the context; it just
 * can't gate it.
 *
 * Min over the whole set, not the top fused hit's distance: fusion may
 * legally rank a lexical-only hit first, and the gate's question is "does
 * ANY close dense evidence exist among what the model will be shown".
 */
interface GateDecision {
  refuse: boolean
  /** The signal the decision cut on — min dense cosine distance, persisted
   *  in messages.retrieval_score so production accumulates the data
   *  threshold tuning needs. Null when there was nothing to measure. */
  signal: number | null
  reason: "no_results" | "no_dense_evidence" | "distance_above_threshold" | null
}
//#endregion

//#region Constants
/** Provisional operating point (overridable via ANSWER_MAX_DISTANCE until
 *  the dashboard exists). bge-small cosine distances run roughly 0.3–0.5
 *  for related text and 0.7–1.0 for unrelated; 0.75 is deliberately
 *  permissive — a false refusal is a worse product failure than a hedged
 *  answer whose claims verification will strip anyway. M2.7 replaces this
 *  guess with the eval-derived value and publishes the curve. */
const DEFAULT_MAX_DISTANCE = 0.75
//#endregion

//#region Gate
function evaluateGroundedness(
  retrieved: readonly RetrievedChunk[],
  maxDistance: number = DEFAULT_MAX_DISTANCE,
): GateDecision {
  if (retrieved.length === 0) return { refuse: true, signal: null, reason: "no_results" }

  const distances = retrieved
    .map((chunk) => chunk.denseDistance)
    .filter((distance): distance is number => distance !== null)
  // No dense evidence at all — the org has no embeddings under the query's
  // model, or every hit is lexical-only. Without a distance there is nothing
  // to calibrate against, and "unknown" must fail closed: answering on
  // lexical rank alone is exactly the ungated behavior the gate exists to
  // prevent.
  if (distances.length === 0) return { refuse: true, signal: null, reason: "no_dense_evidence" }

  const best = Math.min(...distances)
  if (best > maxDistance) return { refuse: true, signal: best, reason: "distance_above_threshold" }
  return { refuse: false, signal: best, reason: null }
}
//#endregion

//#region Exports
export { evaluateGroundedness, DEFAULT_MAX_DISTANCE }
export type { GateDecision }
//#endregion
