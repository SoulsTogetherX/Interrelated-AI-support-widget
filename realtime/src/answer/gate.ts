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
/**
 * The eval-derived operating point (M2.7; `npm run eval -- --sweep-threshold`,
 * curve in eval/results/threshold-sweep.csv, analysis in eval/RESULTS.md).
 * Measured on bge-small-en-v1.5 over the 80-question golden set vs the
 * 40-question adversarial no-answer set:
 *
 *   answerable questions   min 0.084 … max 0.304
 *   off-topic questions    min 0.386 … max 0.562
 *
 * — a CLEAN separation window (0.304, 0.386). 0.34 sits inside it with
 * margin on both sides (same headroom logic as the recall floor: an exact
 * boundary would flip on cross-machine ONNX noise), giving 0% false
 * refusals and 100% off-topic refusal. What the number honestly does NOT
 * do: catch on-topic questions the corpus can't answer (absent-detail CR
 * is 7% here) — those retrieve genuinely close text, so no distance can
 * separate them, and they are the CLAIM VERIFIER's job: an answer that
 * isn't in the context can't be quoted from it. The gate is a topicality
 * filter; verification is the coverage filter. Both measured, neither
 * pretending to be the other.
 *
 * Model-specific by nature: distances live on each embedding model's own
 * scale, so a BYO embedding model (M3) needs its own sweep — the tool is
 * the calibration procedure. Overridable via ANSWER_MAX_DISTANCE.
 */
const DEFAULT_MAX_DISTANCE = 0.34
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

//#endregion
