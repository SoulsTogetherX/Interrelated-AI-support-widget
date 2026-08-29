//#region Type Defs
/**
 * The chunker's input is a PARSED document: an ordered list of blocks that a
 * format-specific parser (HTML and Markdown today; uploads add more in M3)
 * has already extracted.
 * Splitting "parse" from "chunk" means one chunking policy serves every
 * format, and the chunker can be tested exhaustively with hand-built blocks
 * instead of fixture files.
 *
 * Contract the parsers must honor (and tests here assume):
 *   block.text === sourceText.slice(block.charStart, block.charEnd)
 * That identity is what lets citations deep-link into the original document.
 */
interface Block {
  kind: "heading" | "paragraph" | "code"
  /** Heading depth 1–6; required when kind === "heading". */
  level?: number
  text: string
  charStart: number
  charEnd: number
}

/** One retrieval unit, shaped to insert directly into the chunks table. */
interface Chunk {
  /** Position within the document, 0-based, dense. Unique per document
   *  (enforced by the chunks_document_ord index). */
  ord: number
  /** "Billing > Refunds > Partial refunds" — the heading trail in effect
   *  where this chunk's content lives. null before any heading is seen. */
  headingPath: string | null
  text: string
  tokenCount: number
  charStart: number
  charEnd: number
}

interface ChunkOptions {
  /** Flush threshold: a chunk closes once adding the next piece would push
   *  it past this. 400 is the default the eval harness ablates against 800. */
  targetTokens?: number
  /** Hard ceiling for a SINGLE piece: paragraphs longer than this are split
   *  (sentence-wise for prose, line-wise for code) before packing. */
  maxTokens?: number
}
//#endregion

//#region Helpers
/**
 * Approximate token count: ceil(chars / 4). English BPE averages ~4 chars
 * per token, and this estimate is used ONLY for budgeting chunk sizes —
 * never for billing or quota math, which use the provider's real counts.
 * Approximation is a deliberate trade: exact tokenization would drag a
 * model-specific tokenizer dependency into shared/, which must stay
 * dependency-free, for a number where ±10% changes nothing.
 */
function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** A piece is a block fragment carrying its absolute source offsets. */
interface Piece {
  text: string
  charStart: number
  charEnd: number
}

/**
 * Splits an oversized block into pieces of at most maxTokens each. Prose
 * splits at sentence ends; code splits at newlines (a sentence regex applied
 * to code produces garbage cuts). A single indivisible run longer than
 * maxTokens is hard-cut at the token-equivalent character length — ugly,
 * but bounded memory beats faithful formatting for a 40 KB minified blob.
 * Offsets are tracked through every cut so the parser contract
 * (text === source.slice(start, end)) survives splitting.
 */
function splitOversized(block: Block, maxTokens: number): Piece[] {
  const maxChars = maxTokens * 4
  // Segment boundaries: end-of-sentence for prose, newline for code. Both
  // patterns keep the delimiter with the preceding segment so offsets stay
  // contiguous and nothing is dropped.
  const pattern = block.kind === "code" ? /[^\n]*\n|[^\n]+$/g : /[^.!?]*[.!?]+[\s]*|[^.!?]+$/g
  const segments: Piece[] = []
  for (const match of block.text.matchAll(pattern)) {
    if (match[0].length === 0) continue
    const rel = match.index ?? 0
    let segText = match[0]
    let segStart = rel
    // Hard-cut any single segment that alone exceeds the ceiling.
    while (approxTokens(segText) > maxTokens) {
      segments.push({
        text: segText.slice(0, maxChars),
        charStart: block.charStart + segStart,
        charEnd: block.charStart + segStart + maxChars,
      })
      segText = segText.slice(maxChars)
      segStart += maxChars
    }
    segments.push({
      text: segText,
      charStart: block.charStart + segStart,
      charEnd: block.charStart + segStart + segText.length,
    })
  }
  // Greedily repack segments up to the ceiling, so a paragraph of many short
  // sentences yields few pieces rather than one piece per sentence.
  const pieces: Piece[] = []
  for (const seg of segments) {
    const last = pieces[pieces.length - 1]
    if (last && approxTokens(last.text + seg.text) <= maxTokens) {
      last.text += seg.text
      last.charEnd = seg.charEnd
    } else {
      pieces.push({ ...seg })
    }
  }
  return pieces
}
//#endregion

//#region Exports
/**
 * Heading-aware chunking: walk the blocks in order, maintain the heading
 * trail as a stack, and pack paragraph/code pieces into chunks of about
 * targetTokens. Headings close the current chunk — a chunk never straddles
 * a section boundary, because a retrieval hit that mixes the tail of one
 * section with the head of the next cites both wrongly.
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function chunkBlocks(blocks: readonly Block[], options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? 400
  const maxTokens = options.maxTokens ?? 800
  if (targetTokens < 1 || maxTokens < targetTokens) {
    throw new Error("require 1 <= targetTokens <= maxTokens")
  }

  const chunks: Chunk[] = []
  const headingStack: Array<{ level: number; text: string }> = []
  let pending: Piece[] = []
  let pendingTokens = 0

  const flush = (): void => {
    if (pending.length === 0) return
    const text = pending.map((p) => p.text).join("\n\n")
    chunks.push({
      ord: chunks.length,
      headingPath: headingStack.length ? headingStack.map((h) => h.text).join(" > ") : null,
      text,
      // Counted over the JOINED text (separators included) because that is
      // the exact string the embedding provider will see.
      tokenCount: approxTokens(text),
      charStart: pending[0].charStart,
      charEnd: pending[pending.length - 1].charEnd,
    })
    pending = []
    pendingTokens = 0
  }

  for (const block of blocks) {
    if (block.kind === "heading") {
      // A heading always closes the running chunk, then rewrites the trail:
      // pop everything at its level or deeper (a sibling h2 replaces the
      // previous h2 AND its h3 children), then push itself.
      flush()
      const level = block.level ?? 1
      while (
        headingStack.length &&
        (headingStack[headingStack.length - 1] as { level: number }).level >= level
      ) {
        headingStack.pop()
      }
      headingStack.push({ level, text: block.text })
      continue
    }

    if (block.text.length === 0) continue // parser noise; nothing to retrieve

    const pieces =
      approxTokens(block.text) > maxTokens
        ? splitOversized(block, maxTokens)
        : [{ text: block.text, charStart: block.charStart, charEnd: block.charEnd }]

    for (const piece of pieces) {
      const pieceTokens = approxTokens(piece.text)
      // Close the chunk when this piece would overflow the target — unless
      // the chunk is empty, in which case the piece starts its own chunk
      // regardless of size (it is already capped at maxTokens above).
      if (pendingTokens > 0 && pendingTokens + pieceTokens > targetTokens) flush()
      pending.push(piece)
      pendingTokens += pieceTokens
    }
  }
  flush()
  return chunks
}

export { chunkBlocks, approxTokens }
export type { Block, Chunk, ChunkOptions }
//#endregion
