//#region Constants
/** Every embedding is stored as halfvec(PADDED_DIM) — see §3.3.1.
 *  This constant is the single source of truth the schema's 1024 mirrors;
 *  changing it means a new migration and a re-embed, so it is deliberately
 *  a constant and not configuration. */
const PADDED_DIM = 1024
//#endregion

//#region Exports
/**
 * Zero-pads a vector to PADDED_DIM so models of different native dimensions
 * share one indexed column.
 *
 * Why padding is mathematically safe: for padded vectors u' = [u, 0…] and
 * v' = [v, 0…], the dot product <u',v'> = <u,v> (the extra coordinates
 * contribute 0·0 terms) and |u'| = |u|. Cosine distance is built from
 * exactly those two quantities, so rankings among same-model vectors are
 * IDENTICAL before and after padding. (Cross-model comparisons are
 * meaningless regardless — that is why retrieval always filters by model.)
 */
function padVector(values: readonly number[], target: number = PADDED_DIM): number[] {
  if (values.length === 0) throw new Error("cannot pad an empty vector")
  if (values.length > target) {
    throw new Error(`vector has ${values.length} dims, exceeding the ${target}-dim column`)
  }
  const out = new Array<number>(target).fill(0)
  for (let i = 0; i < values.length; i++) out[i] = values[i] as number
  return out
}

/**
 * Serializes to pgvector's text format: "[v1,v2,…]". This is the ONE place
 * that format is written — repositories and tests import this rather than
 * hand-building strings, so a format change (or a bug fix) has one home.
 */
function toPgvector(values: readonly number[]): string {
  return `[${values.join(",")}]`
}

/** Parses pgvector's text format back to numbers (the pg driver returns
 *  vector columns as strings). Throws on malformed input rather than
 *  returning NaNs — a garbled vector is corruption, not data. */
function fromPgvector(text: string): number[] {
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new Error("not a pgvector literal")
  }
  const body = text.slice(1, -1)
  if (body === "") throw new Error("empty pgvector literal")
  return body.split(",").map((part) => {
    const n = Number(part)
    if (Number.isNaN(n)) throw new Error(`malformed pgvector component: ${part}`)
    return n
  })
}

export { PADDED_DIM, padVector, toPgvector, fromPgvector }
//#endregion
