//#region Imports
import type { Block, ParsedDocument } from "@/ingest/parsers/types"
//#endregion

//#region Type Defs
/**
 * The PDF parser — the format a documentation site links and a customer
 * uploads, and the one the pipeline refused until M7.6.
 *
 * History worth keeping, because it is the reason this file looks the way it
 * does: a `pdf-parse` implementation was built at M1 and then REMOVED on
 * review (§3), for 21 MB of image weight and a browser-sized parsing surface
 * serving a feature with no caller. Both halves of that objection are
 * answered here rather than forgotten. The dependency is `unpdf` — a
 * serverless-shaped build of Mozilla's pdf.js, 2.1 MB unpacked with ZERO
 * dependencies of its own (pdf-parse today pulls `pdfjs-dist` *and* a native
 * canvas: 21 MB) — and it is loaded by DYNAMIC IMPORT, the providers/ rule
 * (§2.4.5c): a stack that never meets a PDF never pays for it, and every
 * module that imports the parser layer stays importable everywhere.
 *
 * Writing a PDF text extractor by hand was never on the table, and that is
 * the same judgment htmlparser2 got (§3.10.3): PDF is a 1,000-page
 * specification with compression, encryption, 14 standard fonts and a dozen
 * text-positioning operators, all of it infrastructure rather than this
 * project's technical content.
 *
 * Two mechanical facts about pdf.js drive the implementation, both learned
 * from it failing:
 *
 *   1. The input array is TRANSFERRED (detached) by the first call — after
 *      it, `bytes.byteLength` is 0 and a second call throws DataCloneError.
 *      So the document is opened ONCE into a proxy, and title and text are
 *      both read from that proxy.
 *   2. A Node Buffer is a view into a shared pool, which cannot be
 *      transferred at all. So the bytes are copied into a standalone array
 *      first — one copy per document, paid once.
 *
 * The offset contract (`block.text === text.slice(charStart, charEnd)`)
 * holds BY CONSTRUCTION, as it does for HTML: a PDF has no source text to
 * point into — layout is not text — so the extraction IS the canonical
 * document, and the blocks are literally the slices this file assembled.
 */
type UnpdfModule = typeof import("unpdf")

/** A PDF that could not be read as one. Thrown rather than returned empty:
 *  types.ts reserves exactly this for "formats with real integrity checks",
 *  and every caller already turns a throw into a visible, reasoned skip —
 *  the crawler into a `skipped_pages` row, the upload route into a sentence
 *  the tenant reads. */
class PdfParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "PdfParseError"
  }
}
//#endregion

//#region Constants
/** Page texts are joined by a blank line: a page boundary is at least a
 *  paragraph boundary, and never less. */
const PAGE_SEPARATOR = "\n\n"

/**
 * The largest PDF this parser will open, checked BEFORE pdf.js sees a byte.
 *
 * Both callers already cap their input — safeFetch streams a crawl body to
 * a 10 MB ceiling, and the upload route has its own — so this is a backstop
 * rather than the first line, and it is deliberate: of everything in the
 * ingest path, a PDF parser is the largest attack surface, because unlike
 * an HTML tokenizer it decompresses, and a crawl target is a URL a stranger
 * can put on a page. Bounding the INPUT is the honest, cheap half of that
 * problem; the half this does not solve is stated in §3.10.7 rather than
 * pretended away — a small PDF crafted to be pathologically slow still
 * occupies the single ingest worker while it parses, bounded only by the
 * crawl's own attempts cap.
 */
const PDF_MAX_BYTES = 10 * 1024 * 1024
//#endregion

//#region Loading
// Cached module promise: the import is resolved once per process, so a
// hundred-PDF crawl pays for it on the first page only. Deliberately a
// PROMISE and not an awaited value, so concurrent first calls share one load.
let unpdfModule: Promise<UnpdfModule> | null = null

async function loadUnpdf(): Promise<UnpdfModule> {
  if (unpdfModule === null) {
    unpdfModule = import("unpdf").catch((err: unknown) => {
      // Reset so a transient failure (a partial install) can be retried
      // rather than poisoning the process for its lifetime.
      unpdfModule = null
      throw new PdfParseError("the PDF parser could not be loaded (is `unpdf` installed?)", err)
    })
  }
  return unpdfModule
}
//#endregion

//#region Extraction
/** A copy that pdf.js may transfer: standalone ArrayBuffer, no Buffer pool.
 *  (`new Uint8Array(n)` + set, rather than `.slice()`, so the source may be
 *  either a Buffer or a Uint8Array without a branch.) */
function standalone(body: Buffer | Uint8Array): Uint8Array {
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy
}

/** Collapses the whitespace pdf.js emits from layout — runs of spaces that
 *  were kerning, tabs that were table columns — to single spaces, and trims.
 *  Applied BEFORE `text` is assembled, so the offsets are into the cleaned
 *  form and the same bytes always produce the same text (which is what
 *  documents.content_hash depends on). */
function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

/**
 * One page's extracted text → paragraph blocks, with offsets into the
 * document text that `pageStart` says this page begins at.
 *
 * Lines are GROUPED into paragraphs rather than emitted individually,
 * because a line break inside a PDF is layout: pdf.js reports one line per
 * row of glyphs, and a wrapped sentence is several rows. The chunker joins
 * the blocks it packs with a blank line (shared/chunking/chunker.ts), so
 * one-block-per-line would blank-separate the halves of every wrapped
 * sentence — mangling both the embedded text and the verbatim quote a
 * citation has to contain.
 *
 * What that means in practice was MEASURED rather than assumed: pdf.js emits
 * no blank line between rows however large the vertical gap, so a page
 * normally becomes exactly ONE block. The blank-line branch below is not
 * decoration — a text item of pure whitespace cleans to "" and ends the
 * paragraph — but the common case is one block per page, and that is the
 * right shape: the chunker splits an oversized paragraph at sentence bounds
 * (§2.4.0) carrying the offsets, so a 40-page PDF becomes ~400-token chunks
 * that quote cleanly rather than page-sized chunks that do not.
 *
 * The honest limit, stated where the code is: a PDF gets NO heading trail.
 * Headings in a PDF are a font-size convention, not a structure, and
 * inferring them would be a heuristic with silent failure modes — so
 * chunks from a PDF carry heading_path = null and are found by their text.
 */
function pageBlocks(pageText: string, pageStart: number): Block[] {
  const blocks: Block[] = []
  let cursor = 0 // offset within this page's cleaned text
  let paragraph: string[] = []
  let paragraphStart = 0

  const flush = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join("\n")
    blocks.push({
      kind: "paragraph",
      text,
      charStart: pageStart + paragraphStart,
      charEnd: pageStart + paragraphStart + text.length,
    })
    paragraph = []
  }

  for (const line of pageText.split("\n")) {
    if (line === "") {
      flush()
      cursor += 1 // the blank line's own "\n" in the assembled text
      continue
    }
    if (paragraph.length === 0) paragraphStart = cursor
    paragraph.push(line)
    cursor += line.length + 1 // the line and the "\n" that follows it
  }
  flush()
  return blocks
}

/** Every page reduced to its canonical form ONCE — line whitespace
 *  collapsed, the page trimmed — because `text` and the block offsets are
 *  computed from this same array, and two places cleaning "the same way"
 *  is how offsets drift apart. */
function cleanPages(pages: string[]): string[] {
  return pages.map((page) => page.split("\n").map(cleanLine).join("\n").trim())
}

/** The document's own text, assembled from the cleaned pages — this is what
 *  the blocks slice, what content_hash fingerprints, and what a citation
 *  quotes. Returned with each page's start offset so blocks can be placed. */
function assemble(cleaned: string[]): { text: string; starts: number[] } {
  const starts: number[] = []
  let text = ""
  for (const page of cleaned) {
    if (text !== "") text += PAGE_SEPARATOR
    starts.push(text.length)
    text += page
  }
  return { text, starts }
}
//#endregion

//#region Exports
/**
 * Bytes → ParsedDocument. Throws PdfParseError for a file that is not a
 * readable PDF, is password-protected, or carries no text layer at all.
 *
 * That last one is the case worth naming: a SCANNED PDF is a stack of
 * images, and its content is pixels rather than characters. Returning an
 * empty document would store a source that answers nothing and says nothing
 * about why — so the parser refuses with a sentence that names OCR, which
 * the crawler records against the page and the dashboard shows.
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
async function parsePdf(body: Buffer | Uint8Array): Promise<ParsedDocument> {
  if (body.byteLength > PDF_MAX_BYTES) {
    throw new PdfParseError(
      `the PDF is larger than ${PDF_MAX_BYTES / (1024 * 1024)} MB, which is more than this crawler will parse`,
    )
  }
  const { getDocumentProxy, getMeta, extractText } = await loadUnpdf()

  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    proxy = await getDocumentProxy(standalone(body))
  } catch (err) {
    // pdf.js names its failures; the two a tenant can act on are told apart.
    const name = err instanceof Error ? err.name : ""
    if (name === "PasswordException") {
      throw new PdfParseError("the PDF is password-protected, so its text cannot be read", err)
    }
    const detail = err instanceof Error ? err.message : String(err)
    throw new PdfParseError(`not a readable PDF (${detail})`, err)
  }

  let pages: string[]
  let title: string | null = null
  try {
    // ONE proxy, both readers — see the header: the input array is gone
    // after the first of these two calls.
    const meta = await getMeta(proxy)
    const infoTitle = typeof meta.info?.Title === "string" ? meta.info.Title.trim() : ""
    if (infoTitle !== "") title = infoTitle

    const extracted = await extractText(proxy, { mergePages: false })
    pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text]
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new PdfParseError(`the PDF could not be read (${detail})`, err)
  }

  const cleaned = cleanPages(pages)
  const { text, starts } = assemble(cleaned)
  if (text.trim() === "") {
    throw new PdfParseError(
      "the PDF has no text layer — it is probably a scan, which needs OCR before it can be indexed",
    )
  }

  const blocks = cleaned.flatMap((page, i) => pageBlocks(page, starts[i] as number))

  // The Info title is the document's own claim about itself; failing that,
  // the first line is what a reader would call it (markdown's rule, §3.10.3).
  if (title === null) {
    const firstLine = text.split("\n", 1)[0]?.trim() ?? ""
    if (firstLine !== "") title = firstLine
  }

  // PDFs carry link annotations, and the crawler deliberately does not want
  // them: `links` drives the same-origin BFS frontier, and a PDF's links are
  // overwhelmingly citations to other sites. A crawl follows a docs SITE, not
  // its bibliography.
  return { title, text, blocks, links: [] }
}

export { parsePdf, PdfParseError }
//#endregion
