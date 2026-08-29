//#region Imports
import type { Claim } from "./claims"
//#endregion

//#region Type Defs
/** The minimal chunk shape verification needs — id and stored text. Kept
 *  structural (like eval/resolve.ts's ResolvableChunk) so the pipeline can
 *  pass RetrievedChunk rows straight in and tests can pass literals. */
interface VerifiableChunk {
  id: string
  text: string
}

/**
 * Per-citation verdict — the value stored in message_citations.verified and
 * aggregated into the published verification/strip rates. Failure splits in
 * two because the failures mean different things: `unknown_chunk` is the
 * model citing a chunk it was never shown (fabricated or garbled id);
 * `quote_not_found` is the model naming a real chunk but misquoting it —
 * paraphrase drift, cross-chunk borrowing, or invention. The metrics story
 * needs them separately.
 */
type CitationVerdict =
  | { status: "verified"; start: number; end: number }
  | { status: "unknown_chunk" }
  | { status: "quote_not_found" }

interface VerifiedClaim {
  claim: Claim
  verdict: CitationVerdict
}
//#endregion

//#region Quote search
/**
 * Finds the first occurrence of `quote` in `haystack`, tolerating only
 * whitespace differences, and returns RAW character offsets into haystack.
 *
 * Same normalization stance as eval/resolve.ts's anchor matching, for the
 * same reason: stored chunk text hard-wraps wherever the source happened to
 * break lines, so runs of whitespace must compare equal — and nothing else
 * may. Case stays significant: a quote is a quotation, and case-folding
 * could bind it to a different sentence than the one the model relied on.
 *
 * Implemented as an escaped-literal regex with whitespace runs generalized
 * to \s+ (escape FIRST — escaping never touches whitespace, so the
 * replacement sees the original spacing). A squash-both-sides indexOf would
 * confirm presence but lose the raw offsets, and the offsets are the
 * point: message_citations stores them so the dashboard can highlight the
 * exact span, and chunk.charStart + start deep-links into the source
 * document. First match (regex semantics) keeps repeated sentences
 * deterministic.
 */
function findQuote(haystack: string, quote: string): { start: number; end: number } | null {
  const trimmed = quote.trim()
  if (trimmed.length === 0) return null
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
  const match = new RegExp(pattern).exec(haystack)
  if (match === null) return null
  return { start: match.index, end: match.index + match[0].length }
}
//#endregion

//#region Verification
/**
 * The deterministic citation check — the code that makes "verified" mean
 * something. For each claim: the named chunk must be among the chunks the
 * model was ACTUALLY shown (not merely any chunk in the corpus — a citation
 * to unretrieved content is unauditable even if the text exists somewhere),
 * and the quote must occur in that chunk's text under findQuote's rules.
 *
 * Pure and synchronous: no I/O, no model, no clock. Given the same claims
 * and chunks it returns the same verdicts forever — which is what lets
 * tests pin it and lets the strip rate be a metric instead of an anecdote.
 * Order is preserved so the widget renders claims in the model's intended
 * sequence.
 */
function verifyClaims(
  claims: readonly Claim[],
  chunks: readonly VerifiableChunk[],
): VerifiedClaim[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  return claims.map((claim) => {
    const chunk = chunkById.get(claim.chunkId)
    if (chunk === undefined) return { claim, verdict: { status: "unknown_chunk" as const } }
    const span = findQuote(chunk.text, claim.quote)
    if (span === null) return { claim, verdict: { status: "quote_not_found" as const } }
    return { claim, verdict: { status: "verified" as const, start: span.start, end: span.end } }
  })
}

/**
 * The strip policy, as one named function: only verified claims reach the
 * visitor. Centralized here (rather than an inline filter in the SSE route)
 * because "unverifiable claims are stripped before display" is the product's
 * core promise — it should have exactly one implementation to cite and test,
 * not a convention each caller re-derives.
 */
function displayableClaims(verified: readonly VerifiedClaim[]): Claim[] {
  return verified.filter((v) => v.verdict.status === "verified").map((v) => v.claim)
}
//#endregion

//#region Exports
export { findQuote, verifyClaims, displayableClaims }
export type { VerifiableChunk, CitationVerdict, VerifiedClaim }
//#endregion
