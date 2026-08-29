//#region Type Defs
/** One scored query: the ids the golden set says are relevant, and the ids
 *  retrieval actually returned, best first. Ids are opaque here — the
 *  scorer never touches the database, which is what makes it unit-testable
 *  with two-line fixtures. */
interface QueryJudgment {
  relevant: ReadonlySet<string>
  ranked: readonly string[]
}

/** Macro-averaged scores for one retrieval strategy over the golden set. */
interface RunScore {
  queries: number
  /** recall@k keyed by k, e.g. { 1: 0.62, 5: 0.88, 10: 0.93 }. */
  recall: Record<number, number>
  mrr10: number
  ndcg10: number
}
//#endregion

//#region Per-query metrics
/**
 * recall@k: |relevant ∩ top-k| / |relevant|.
 *
 * With a single gold chunk this reduces to hit@k (did we surface it at
 * all); with several golds it credits partial coverage. Macro-averaged
 * across queries so every question counts equally — a 10-gold question
 * must not weigh ten times a 1-gold question.
 */
function recallAtK(judgment: QueryJudgment, k: number): number {
  assertJudgment(judgment, k)
  let found = 0
  for (let i = 0; i < Math.min(k, judgment.ranked.length); i++) {
    if (judgment.relevant.has(judgment.ranked[i])) found++
  }
  return found / judgment.relevant.size
}

/** MRR@k: 1/rank of the FIRST relevant result within the top k, else 0.
 *  The metric that punishes burying the answer at rank 7 — recall@10 alone
 *  would call that a win, but M2's prompt puts the top chunks first and
 *  models attend to early context; rank position is product quality. */
function mrrAtK(judgment: QueryJudgment, k: number): number {
  assertJudgment(judgment, k)
  for (let i = 0; i < Math.min(k, judgment.ranked.length); i++) {
    if (judgment.relevant.has(judgment.ranked[i])) return 1 / (i + 1)
  }
  return 0
}

/**
 * nDCG@k with binary gains: DCG@k / IDCG@k, where a relevant result at
 * 1-based position i contributes 1/log2(i+1) and the ideal ranking packs
 * all |relevant| golds at the top. Between recall (position-blind) and MRR
 * (first-hit-only), nDCG is the one that sees the WHOLE ordering — two
 * golds at ranks 2 and 3 beat two golds at ranks 2 and 9.
 */
function ndcgAtK(judgment: QueryJudgment, k: number): number {
  assertJudgment(judgment, k)
  let dcg = 0
  for (let i = 0; i < Math.min(k, judgment.ranked.length); i++) {
    if (judgment.relevant.has(judgment.ranked[i])) dcg += 1 / Math.log2(i + 2)
  }
  let idcg = 0
  for (let i = 0; i < Math.min(k, judgment.relevant.size); i++) {
    idcg += 1 / Math.log2(i + 2)
  }
  return dcg / idcg
}
//#endregion

//#region Aggregation
/** Scores a full run. ks are the recall cutoffs (the report uses 1/5/10);
 *  MRR and nDCG are fixed at 10 — the deepest cut the product will ever
 *  put in front of a model in M2. */
function scoreRun(
  judgments: readonly QueryJudgment[],
  ks: readonly number[] = [1, 5, 10],
): RunScore {
  if (judgments.length === 0) throw new Error("cannot score an empty run")
  const recall: Record<number, number> = {}
  for (const k of ks) {
    recall[k] = mean(judgments.map((j) => recallAtK(j, k)))
  }
  return {
    queries: judgments.length,
    recall,
    mrr10: mean(judgments.map((j) => mrrAtK(j, 10))),
    ndcg10: mean(judgments.map((j) => ndcgAtK(j, 10))),
  }
}
//#endregion

//#region Guards
function assertJudgment(judgment: QueryJudgment, k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`)
  if (judgment.relevant.size === 0) {
    // A query with no relevant chunks means a golden anchor failed to
    // resolve. The runner fails loudly BEFORE scoring; this guard exists so
    // a future refactor can't quietly average in free zeros (or free 0/0s).
    throw new Error("judgment has an empty relevant set — a golden anchor did not resolve")
  }
  const seen = new Set(judgment.ranked)
  if (seen.size !== judgment.ranked.length) {
    throw new Error("ranked list contains duplicates — upstream retrieval bug")
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length
}
//#endregion

//#region Exports
export { recallAtK, mrrAtK, ndcgAtK, scoreRun }
export type { QueryJudgment, RunScore }
//#endregion
