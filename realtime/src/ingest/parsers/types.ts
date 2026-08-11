//#region Imports
import type { Block } from "@shared/chunking/chunker"
//#endregion

//#region Type Defs
/**
 * What every format parser produces, and the ONE contract that matters:
 *
 *   blocks[i].text === text.slice(blocks[i].charStart, blocks[i].charEnd)
 *
 * `text` is the parser's NORMALIZED extraction of the document — for
 * Markdown it is the source itself (offsets point into what the author
 * wrote); for HTML and PDF it is constructed during extraction (markup and
 * layout are gone, so the extraction IS the canonical text). Downstream,
 * `text` is what content_hash fingerprints (documents.content_hash) and what
 * chunk char spans deep-link into — so the same input must always produce
 * the same `text`, or recrawl short-circuiting breaks.
 *
 * Every parser is total: garbage in produces an empty ParsedDocument (or a
 * thrown error for formats with real integrity checks, like PDF), never a
 * half-populated one that violates the offset contract.
 */
interface ParsedDocument {
  /** Best-effort document title (<title>, first #-heading, PDF Info), used
   *  for display in citations and the dashboard. null when absent. */
  title: string | null
  /** The canonical normalized text — see above. */
  text: string
  /** Ordered blocks over `text`, shaped for the shared chunker. */
  blocks: Block[]
  /** Raw hrefs discovered during parsing (HTML only — other formats yield
   *  none). Unresolved and unfiltered: the crawler owns resolution against
   *  the page URL and the same-origin policy. */
  links: string[]
}
//#endregion

//#region Exports
export type { ParsedDocument, Block }
//#endregion
