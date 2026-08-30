//#region Imports
// node:util rather than the global: @types/node declares the global as a
// value only, so the annotation below needs the import to name the type.
import { TextDecoder } from "node:util"

import { parseHtml } from "@/ingest/parsers/html"
import { parseMarkdown } from "@/ingest/parsers/markdown"
import { parsePdf } from "@/ingest/parsers/pdf"
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
 * PDF detection leads the order and is the one check that cannot be fooled:
 * a PDF served as text/plain (misconfigured servers do it daily) would
 * otherwise fall through to the markdown fallback and be "parsed" into
 * paragraphs of binary soup. Since M7.6 detection is followed by an actual
 * parser (§3.10.7); before that it was followed by a refusal, which is why
 * this order was worth keeping even while the format was unsupported.
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
  // A PDF is BYTES, not text: no charset applies, and decoding one would
  // destroy it. It takes the buffer straight, and is the only branch that
  // loads a dependency (dynamically — §3.10.7).
  if (format === "pdf") return parsePdf(resource.body)
  const text = decodeText(resource.body, resource.charset)
  return format === "html" ? parseHtml(text) : parseMarkdown(text)
}

export { parseResource, detectFormat }

//#endregion
