//#region Imports
// node:util rather than the global: @types/node declares the global as a
// value only, so the annotation below needs the import to name the type.
import { TextDecoder } from "node:util"

import { parseHtml } from "@/ingest/parsers/html"
import { parseMarkdown } from "@/ingest/parsers/markdown"
import type { ParsedDocument } from "@/ingest/parsers/types"
//#endregion

//#region Type Defs
/** What the crawler hands the parser layer: the fetched bytes plus the
 *  headers' claims about them. Claims, not truth — detection below checks
 *  the bytes too, because misconfigured servers ship PDFs as text/plain and
 *  HTML as octet-stream every day. */
interface RawResource {
  url: string
  /** Lowercased bare media type from safeFetch ("" when absent). */
  contentType: string
  charset: string | null
  body: Buffer
}

type DocumentFormat = "html" | "markdown" | "pdf"
//#endregion

//#region Helpers
/**
 * Format detection, in trust order: magic bytes (unfakeable) → declared
 * media type → URL extension → content sniff → markdown as the fallback,
 * because the markdown parser degrades gracefully to plain-text paragraphs
 * while the HTML parser would silently strip nothing.
 *
 * PDF is still DETECTED but not parsed: there is no PDF parser until file
 * uploads exist (M3) — crawled docs sites are HTML/Markdown, and a chat
 * widget has no other way to receive a PDF. Detection is kept so a crawled
 * PDF is skipped with a clear error instead of being garbled into
 * "paragraphs" of binary soup by the markdown fallback.
 */
function detectFormat(resource: RawResource): DocumentFormat {
  if (resource.body.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf"
  const type = resource.contentType
  if (type === "application/pdf") return "pdf"
  if (type === "text/html" || type === "application/xhtml+xml") return "html"
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown"

  let pathname = ""
  try {
    pathname = new URL(resource.url).pathname.toLowerCase()
  } catch {
    // Unparseable URL: fall through to sniffing.
  }
  if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) return "markdown"
  if (pathname.endsWith(".html") || pathname.endsWith(".htm")) return "html"

  const head = resource.body.subarray(0, 512).toString("utf8").trimStart().toLowerCase()
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html"
  return "markdown"
}

/** Decodes with the declared charset (utf-8 when absent or unknown), strips
 *  a BOM, and normalizes newlines to \n. Normalization happens HERE, before
 *  any parser sees the text, so offsets are always into the normalized form
 *  and CRLF churn on a server can never change a content_hash. */
function decodeText(body: Buffer, charset: string | null): string {
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset ?? "utf-8")
  } catch {
    decoder = new TextDecoder("utf-8") // unknown label: utf-8 is the web default
  }
  let decoded = decoder.decode(body)
  if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1) // strip BOM
  return decoded.replace(/\r\n?/g, "\n")
}
//#endregion

//#region Exports
/** The parser layer's single entry point: bytes in, ParsedDocument out. */
async function parseResource(resource: RawResource): Promise<ParsedDocument> {
  const format = detectFormat(resource)
  if (format === "pdf") {
    // The crawler catches this and reports the page as skipped (an `error`
    // event), the same fate as any unparseable resource — the crawl goes on.
    throw new Error("PDF parsing is not supported until uploads land (M3); page skipped")
  }
  const text = decodeText(resource.body, resource.charset)
  return format === "html" ? parseHtml(text) : parseMarkdown(text)
}

export { parseResource, detectFormat }
export type { RawResource, DocumentFormat }
//#endregion
