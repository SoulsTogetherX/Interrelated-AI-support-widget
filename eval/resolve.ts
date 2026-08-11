//#region Type Defs
/** The minimal chunk shape resolution needs — id and stored text. Kept
 *  structural so the runner can pass database rows straight in and tests
 *  can pass two-line literals. */
interface ResolvableChunk {
  id: string
  text: string
}
//#endregion

//#region Resolution
/** Whitespace normalization applied to BOTH sides of anchor matching.
 *  Markdown paragraphs hard-wrap at the source authors' whim, so a raw
 *  indexOf would make golden anchors depend on where upstream happened to
 *  break lines — squashing makes anchors survive rewrapping, and nothing
 *  else. Case is deliberately preserved: an anchor is a quotation, and a
 *  case-insensitive match could bind to a different sentence than the one
 *  the question was written against. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Resolves one golden anchor to the chunks that contain it: every chunk of
 * the anchored document whose squashed text contains the squashed
 * mustContain substring.
 *
 * Returning ALL matching chunks (not the first) is deliberate: the chunker
 * may legally place a repeated sentence in two chunks, and both are then
 * correct retrieval targets — marking only one would punish retrieval for
 * finding the other. The caller treats an EMPTY result as fatal (golden
 * set and corpus have drifted), which is why this function does not throw:
 * the runner aggregates every failure into one complete report instead of
 * dying on the first.
 */
function resolveAnchor(chunks: readonly ResolvableChunk[], mustContain: string): string[] {
  const needle = squash(mustContain)
  if (needle.length === 0) return []
  return chunks.filter((chunk) => squash(chunk.text).includes(needle)).map((chunk) => chunk.id)
}
//#endregion

//#region Exports
export { squash, resolveAnchor }
export type { ResolvableChunk }
//#endregion
