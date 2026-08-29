//#region Imports
import { Parser } from "htmlparser2"

import type { Block, ParsedDocument } from "@/ingest/parsers/types"
//#endregion

//#region Type Defs
/**
 * HTML → blocks, via htmlparser2's streaming callbacks. Unlike Markdown
 * (where the source itself is the canonical text), HTML's canonical text is
 * CONSTRUCTED here: markup, chrome, and scripts are gone after extraction,
 * so the extraction is the document. Block offsets index into that
 * constructed text, which makes the offset contract hold by construction —
 * each block's text is appended exactly where its offsets say it is.
 *
 * htmlparser2 (a dependency, unlike the hand-written Markdown parser)
 * because tokenizing real-world HTML — entities, unclosed tags, script
 * islands, comments — is a well-known swamp with a well-maintained boring
 * answer. Parsing HTML is infrastructure here, not the thesis; the
 * retrieval layer is where hand-written code earns its keep.
 *
 * Extraction policy:
 *   - Whole subtrees that are chrome or code-not-content are dropped:
 *     script, style, nav, header, footer, aside, forms, svg, iframes.
 *     A support answer citing a nav menu is worse than no answer.
 *   - h1–h6 become heading blocks (they drive the chunker's heading trail).
 *   - <pre> becomes a code block with whitespace preserved.
 *   - p, li, blockquote, table cells, figcaptions become paragraph blocks;
 *     text sitting directly in a div/section joins an implicit paragraph.
 *   - Prose whitespace is collapsed (HTML's own rendering rule, and it makes
 *     the extraction deterministic across source formatting churn — the
 *     content_hash recrawl short-circuit depends on that determinism).
 *   - <a href> values are collected raw for the crawler.
 */
//#endregion

//#region Constants
/** Subtrees dropped wholesale. `template` and `dialog` are unrendered or
 *  chrome; `select`/`button`/`form` are controls whose text is UI, not
 *  documentation content. */
const SKIP_SUBTREES = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "dialog",
])

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

/** Elements whose text forms its own paragraph block. Table cells are here
 *  (not whole rows) — cell fragments read oddly alone, but the chunker packs
 *  adjacent blocks back together, and per-cell blocks keep offsets simple. */
const PARAGRAPH_CONTAINERS = new Set([
  "p",
  "li",
  "blockquote",
  "dd",
  "dt",
  "figcaption",
  "caption",
  "summary",
  "td",
  "th",
])

/** Structural elements that close whatever block is open. */
const FLUSH_BOUNDARIES = new Set([
  "div",
  "section",
  "article",
  "main",
  "body",
  "ul",
  "ol",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "figure",
  "details",
  "hr",
])
//#endregion

//#region Exports
function parseHtml(html: string): ParsedDocument {
  const blocks: Block[] = []
  const links: string[] = []
  let text = ""
  let firstH1: string | null = null

  // Appends a finished block to the constructed text; the offsets recorded
  // here ARE where the text was appended, which is the whole contract.
  const emit = (kind: Block["kind"], blockText: string, level?: number): void => {
    if (blockText.length === 0) return
    if (text.length > 0) text += "\n\n"
    const charStart = text.length
    text += blockText
    const block: Block = { kind, text: blockText, charStart, charEnd: text.length }
    if (level !== undefined) block.level = level
    blocks.push(block)
  }

  //#region Parser state
  let skipDepth = 0
  let preDepth = 0
  let inTitle = false
  const titleParts: string[] = []
  const codeParts: string[] = []
  // The open prose collector (heading or paragraph). Headings also carry
  // their level so the chunker can maintain the trail stack.
  let collector: { kind: "heading" | "paragraph"; level?: number; parts: string[] } | null = null

  const flushProse = (): void => {
    if (!collector) return
    // HTML whitespace rule: runs collapse to one space. This also makes the
    // extraction insensitive to source indentation — load-bearing for the
    // content_hash short-circuit.
    const prose = collector.parts.join("").replace(/\s+/g, " ").trim()
    emit(collector.kind === "heading" ? "heading" : "paragraph", prose, collector.level)
    if (
      collector.kind === "heading" &&
      collector.level === 1 &&
      firstH1 === null &&
      prose.length > 0
    ) {
      firstH1 = prose
    }
    collector = null
  }

  const flushCode = (): void => {
    const code = codeParts
      .join("")
      .replace(/^\n+|\n+$/g, "")
      .trimEnd()
    codeParts.length = 0
    emit("code", code)
  }
  //#endregion

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "a" && typeof attribs["href"] === "string" && attribs["href"].length > 0) {
          links.push(attribs["href"]) // collected even inside skipped chrome? No —
          // links inside skipped subtrees are still USEFUL for crawling (nav
          // menus are how docs sites link their pages), so this runs before
          // the skip check on purpose.
        }
        if (SKIP_SUBTREES.has(name)) {
          skipDepth++
          return
        }
        if (skipDepth > 0) return
        if (name === "title") {
          inTitle = true
          return
        }
        if (name === "pre") {
          flushProse()
          preDepth++
          return
        }
        if (preDepth > 0) return // structure inside <pre> is content, not markup
        const level = HEADING_LEVEL[name]
        if (level !== undefined) {
          flushProse()
          collector = { kind: "heading", level, parts: [] }
          return
        }
        if (PARAGRAPH_CONTAINERS.has(name)) {
          flushProse() // a container opening inside another (li > p) splits
          collector = { kind: "paragraph", parts: [] }
          return
        }
        if (name === "br") {
          collector?.parts.push(" ")
          return
        }
        if (FLUSH_BOUNDARIES.has(name)) flushProse()
      },

      ontext(data) {
        if (skipDepth > 0) return
        if (inTitle) {
          titleParts.push(data)
          return
        }
        if (preDepth > 0) {
          codeParts.push(data)
          return
        }
        if (!collector) {
          // Text directly inside a div/section — no container claimed it, so
          // it opens an implicit paragraph rather than being dropped.
          if (data.trim().length === 0) return
          collector = { kind: "paragraph", parts: [] }
        }
        collector.parts.push(data)
      },

      onclosetag(name) {
        if (SKIP_SUBTREES.has(name)) {
          if (skipDepth > 0) skipDepth--
          return
        }
        if (skipDepth > 0) return
        if (name === "title") {
          inTitle = false
          return
        }
        if (name === "pre") {
          if (preDepth > 0) preDepth--
          if (preDepth === 0) flushCode()
          return
        }
        if (preDepth > 0) return
        if (
          HEADING_LEVEL[name] !== undefined ||
          PARAGRAPH_CONTAINERS.has(name) ||
          FLUSH_BOUNDARIES.has(name)
        ) {
          flushProse()
        }
      },
    },
    // decodeEntities defaults on; lowerCaseTags on for HTML — stated
    // explicitly so the behavior survives an htmlparser2 default change.
    { decodeEntities: true, lowerCaseTags: true },
  )
  parser.write(html)
  parser.end()
  flushProse() // text after the last close tag in malformed documents

  const titleText = titleParts.join("").replace(/\s+/g, " ").trim()
  const docTitle = titleText.length > 0 ? titleText : firstH1

  return { title: docTitle, text, blocks, links }
}

export { parseHtml }
//#endregion
