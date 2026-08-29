//#region Imports
import type { Block, ParsedDocument } from "@/ingest/parsers/types"
//#endregion

//#region Type Defs
/**
 * Hand-written line-based Markdown block parser. Hand-written rather than a
 * dependency because the offset contract (block.text is a verbatim slice of
 * the source) is the hard requirement here, and every Markdown library
 * returns a TRANSFORMED AST — recovering exact source offsets from one is
 * more code, and more fragile code, than scanning lines ourselves. The
 * chunker only needs three block kinds, so "parse Markdown" reduces to
 * "classify lines and track offsets".
 *
 * Recognized: ATX headings (# … ######, space required after the hashes,
 * optional closing hashes stripped), fenced code blocks (``` or ~~~, fence
 * lines excluded from the block), list items (-, *, +, 1. — marker stripped
 * via offsets, each item its own block so citations point at the item), and
 * blank-line-separated paragraphs.
 *
 * Deliberately NOT recognized, because each would break the verbatim-slice
 * contract or add ambiguity for no retrieval value: setext headings
 * (underline style — ambiguous with thematic breaks), inline formatting
 * (*em*, [links] — stripping them would desynchronize offsets; the markers
 * survive in chunk text and cost nothing at retrieval time), HTML passthrough
 * blocks, and indented (non-fenced) code blocks (treated as paragraphs).
 */
//#endregion

//#region Helpers
/** A source line with its absolute offsets ([start, end) excludes the
 *  newline). Computed once up front; every classification below works in
 *  terms of these. */
interface Line {
  text: string
  start: number
  end: number
}

function splitLines(source: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const nl = source.indexOf("\n", start)
    if (nl === -1) {
      lines.push({ text: source.slice(start), start, end: source.length })
      return lines
    }
    lines.push({ text: source.slice(start, nl), start, end: nl })
    start = nl + 1
  }
}

const FENCE = /^ {0,3}(```|~~~)/
const ATX_HEADING = /^( {0,3}(#{1,6})[ \t]+)(.*)$/
const LIST_MARKER = /^( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)\S/
const BLANK = /^[ \t]*$/
//#endregion

//#region Exports
/** Parses Markdown source into blocks whose offsets index into `source`
 *  itself — the returned `text` IS the input, so the contract is trivially
 *  exact and citations deep-link into what the author actually wrote. */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function parseMarkdown(source: string): ParsedDocument {
  const lines = splitLines(source)
  const blocks: Block[] = []
  let title: string | null = null

  // The open paragraph, if any, as [startLine, endLine] indexes into lines.
  let paraStart = -1
  let paraStartOffset = 0

  const closeParagraph = (endOffset: number): void => {
    if (paraStart === -1) return
    // Trim to non-whitespace bounds via offsets so text stays a verbatim slice.
    let from = paraStartOffset
    let to = endOffset
    while (from < to && /\s/.test(source[from])) from++
    while (to > from && /\s/.test(source[to - 1])) to--
    if (to > from) {
      blocks.push({ kind: "paragraph", text: source.slice(from, to), charStart: from, charEnd: to })
    }
    paraStart = -1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── Fenced code ──────────────────────────────────────────────────────
    const fence = FENCE.exec(line.text)
    if (fence) {
      closeParagraph(line.start)
      const marker = fence[1]
      // The block spans the lines BETWEEN the fences; the fence lines are
      // scaffolding, not content someone would cite.
      let j = i + 1
      while (j < lines.length && !lines[j].text.trimStart().startsWith(marker)) j++
      const first = lines[i + 1]
      const last = lines[j - 1]
      if (first && last && j > i + 1) {
        blocks.push({
          kind: "code",
          text: source.slice(first.start, last.end),
          charStart: first.start,
          charEnd: last.end,
        })
      }
      i = j // skip past the closing fence (or EOF if unterminated)
      continue
    }

    // ── ATX heading ──────────────────────────────────────────────────────
    const heading = ATX_HEADING.exec(line.text)
    if (heading) {
      closeParagraph(line.start)
      const level = heading[2].length
      const contentStart = line.start + heading[1].length
      // Strip an optional CLOSING hash sequence ("## Title ##") and trailing
      // whitespace — again by moving the end offset, never by editing text.
      let end = line.end
      const content = heading[3]
      const closing = /[ \t]+#+[ \t]*$|[ \t]+$/.exec(content)
      if (closing) end = contentStart + (closing.index ?? content.length)
      if (end > contentStart) {
        const text = source.slice(contentStart, end)
        blocks.push({ kind: "heading", level, text, charStart: contentStart, charEnd: end })
        if (title === null && level === 1) title = text
      }
      continue
    }

    // ── Blank line: paragraph boundary ───────────────────────────────────
    if (BLANK.test(line.text)) {
      closeParagraph(line.start)
      continue
    }

    // ── List item: starts its OWN block, marker excluded via offset ──────
    const item = LIST_MARKER.exec(line.text)
    if (item) {
      closeParagraph(line.start)
      paraStart = i
      paraStartOffset = line.start + item[1].length
      continue
    }

    // ── Anything else: paragraph content (opens one if none is running) ──
    if (paraStart === -1) {
      paraStart = i
      paraStartOffset = line.start
    }
  }
  closeParagraph(source.length)

  return { title, text: source, blocks, links: [] }
}

export { parseMarkdown }
//#endregion
