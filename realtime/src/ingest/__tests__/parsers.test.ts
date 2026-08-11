//#region Imports
import { describe, expect, it } from "vitest"

import { parseMarkdown } from "@/ingest/parsers/markdown"
import { parseHtml } from "@/ingest/parsers/html"
import { parseResource, detectFormat } from "@/ingest/parsers/index"
import type { ParsedDocument } from "@/ingest/parsers/types"
import { chunkBlocks } from "@shared/chunking/chunker"
//#endregion

//#region Helpers
/** THE parser contract: every block is a verbatim slice of the canonical
 *  text. Run against every fixture in this file — a parser that violates it
 *  produces citations that deep-link to the wrong characters. */
function assertOffsetContract(doc: ParsedDocument): void {
  for (const block of doc.blocks) {
    expect(block.text).toBe(doc.text.slice(block.charStart, block.charEnd))
  }
}

/** Enough of a PDF for detection: the magic bytes are the first five. */
const FAKE_PDF = Buffer.from("%PDF-1.4\nnot a real pdf body", "latin1")
//#endregion

//#region Markdown
describe("parseMarkdown", () => {
  const doc = [
    "# Billing Guide",
    "",
    "Intro paragraph spanning",
    "two source lines.",
    "",
    "## Refunds ##",
    "",
    "Refunds take five days.",
    "",
    "- first item",
    "- second item",
    "  continues here",
    "",
    "```js",
    "const x = 1",
    "```",
    "",
    "#NotAHeading because no space",
  ].join("\n")

  it("honors the offset contract on every block", () => {
    assertOffsetContract(parseMarkdown(doc))
  })

  it("keeps the source itself as the canonical text", () => {
    expect(parseMarkdown(doc).text).toBe(doc)
  })

  it("extracts headings with levels, stripping closing hashes", () => {
    const headings = parseMarkdown(doc).blocks.filter((b) => b.kind === "heading")
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Billing Guide"],
      [2, "Refunds"],
    ])
  })

  it("takes the first h1 as the title", () => {
    expect(parseMarkdown(doc).title).toBe("Billing Guide")
    expect(parseMarkdown("plain text only").title).toBeNull()
  })

  it("treats hash-without-space as a paragraph, not a heading", () => {
    const parsed = parseMarkdown(doc)
    const para = parsed.blocks.find((b) => b.text.startsWith("#NotAHeading"))
    expect(para?.kind).toBe("paragraph")
  })

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    const paragraphs = parseMarkdown(doc).blocks.filter((b) => b.kind === "paragraph")
    expect(paragraphs[0]?.text).toBe("Intro paragraph spanning\ntwo source lines.")
    expect(paragraphs[1]?.text).toBe("Refunds take five days.")
  })

  it("makes each list item its own block with the marker stripped", () => {
    const items = parseMarkdown(doc).blocks.filter((b) => b.text.includes("item"))
    expect(items.map((b) => b.text)).toEqual(["first item", "second item\n  continues here"])
  })

  it("extracts fenced code without the fence lines", () => {
    const code = parseMarkdown(doc).blocks.filter((b) => b.kind === "code")
    expect(code.map((b) => b.text)).toEqual(["const x = 1"])
  })

  it("runs an unterminated fence to EOF and drops an empty fence", () => {
    const unterminated = parseMarkdown("```\nline one\nline two")
    expect(unterminated.blocks.map((b) => [b.kind, b.text])).toEqual([["code", "line one\nline two"]])
    assertOffsetContract(unterminated)
    expect(parseMarkdown("```\n```").blocks).toEqual([])
  })

  it("feeds the shared chunker a working heading trail end to end", () => {
    // The whole reason parsers emit heading blocks: chunk heading paths.
    const chunks = chunkBlocks(parseMarkdown(doc).blocks)
    const refundChunk = chunks.find((c) => c.text.includes("five days"))
    expect(refundChunk?.headingPath).toBe("Billing Guide > Refunds")
  })
})
//#endregion

//#region HTML
describe("parseHtml", () => {
  const page = `
    <!doctype html>
    <html><head>
      <title>  Support &amp; Billing  </title>
      <style>body { color: red }</style>
      <script>var tracked = "not content";</script>
    </head><body>
      <nav><a href="/other-page">Other</a> navigation chrome</nav>
      <main>
        <h1>Billing</h1>
        <p>Refunds &lt;always&gt; take   five
        days.</p>
        <h2>Contact</h2>
        <div>Bare div text becomes a paragraph.</div>
        <ul><li>alpha</li><li>beta</li></ul>
        <pre>  const keep = "  spacing  "</pre>
        <a href="mailto:x@y.z">mail</a>
        <a href="https://docs.example.com/deep">deep</a>
      </main>
      <footer>© 2026 chrome to drop</footer>
    </body></html>`

  it("honors the offset contract over the constructed text", () => {
    assertOffsetContract(parseHtml(page))
  })

  it("takes <title> (whitespace-collapsed, entity-decoded) as the title", () => {
    expect(parseHtml(page).title).toBe("Support & Billing")
    expect(parseHtml("<h1>Fallback</h1>").title).toBe("Fallback")
    expect(parseHtml("<p>nothing</p>").title).toBeNull()
  })

  it("drops chrome subtrees but keeps their links", () => {
    const parsed = parseHtml(page)
    expect(parsed.text).not.toContain("navigation chrome")
    expect(parsed.text).not.toContain("not content")
    expect(parsed.text).not.toContain("color: red")
    expect(parsed.text).not.toContain("chrome to drop")
    // Nav links are how docs sites interlink — the crawler needs them even
    // though the nav TEXT is noise.
    expect(parsed.links).toContain("/other-page")
    expect(parsed.links).toContain("https://docs.example.com/deep")
    expect(parsed.links).toContain("mailto:x@y.z") // crawler's job to reject
  })

  it("collapses prose whitespace and decodes entities", () => {
    const para = parseHtml(page).blocks.find((b) => b.text.includes("Refunds"))
    expect(para?.text).toBe("Refunds <always> take five days.")
  })

  it("emits headings with levels and cell/list-item paragraphs", () => {
    const parsed = parseHtml(page)
    const kinds = parsed.blocks.map((b) => [b.kind, b.level ?? null, b.text])
    expect(kinds).toContainEqual(["heading", 1, "Billing"])
    expect(kinds).toContainEqual(["heading", 2, "Contact"])
    expect(kinds).toContainEqual(["paragraph", null, "alpha"])
    expect(kinds).toContainEqual(["paragraph", null, "beta"])
    expect(kinds).toContainEqual(["paragraph", null, "Bare div text becomes a paragraph."])
  })

  it("preserves whitespace inside <pre> as a code block", () => {
    const code = parseHtml(page).blocks.find((b) => b.kind === "code")
    expect(code?.text).toBe('  const keep = "  spacing  "')
  })

  it("extracts identical text regardless of source indentation", () => {
    // Load-bearing for the content_hash recrawl short-circuit: a formatting
    // churn on the customer's site must not look like a content change.
    const compact = "<h1>T</h1><p>alpha beta</p>"
    const airy = "<h1>\n  T\n</h1>\n\n<p>\n    alpha\n    beta\n</p>"
    expect(parseHtml(compact).text).toBe(parseHtml(airy).text)
  })
})
//#endregion

//#region Dispatch
describe("detectFormat / parseResource", () => {
  const raw = (over: Partial<Parameters<typeof detectFormat>[0]>) => ({
    url: "https://docs.example.com/page",
    contentType: "",
    charset: null,
    body: Buffer.from("plain text"),
    ...over,
  })

  it("trusts magic bytes over a lying content-type", () => {
    expect(detectFormat(raw({ contentType: "text/plain", body: FAKE_PDF }))).toBe("pdf")
  })

  it("routes by declared media type", () => {
    expect(detectFormat(raw({ contentType: "text/html" }))).toBe("html")
    expect(detectFormat(raw({ contentType: "text/markdown" }))).toBe("markdown")
    expect(detectFormat(raw({ contentType: "application/pdf" }))).toBe("pdf")
  })

  it("refuses to parse a detected PDF instead of garbling it", async () => {
    // No PDF parser until M3 uploads. The important property is that a PDF
    // is REJECTED (the crawler skips the page) rather than falling through
    // to the markdown parser and being stored as binary-soup "paragraphs".
    await expect(parseResource(raw({ body: FAKE_PDF }))).rejects.toThrow(/PDF.*M3/)
  })

  it("falls back to URL extension, then a content sniff, then markdown", () => {
    expect(detectFormat(raw({ url: "https://x.test/readme.md", contentType: "application/octet-stream" }))).toBe("markdown")
    expect(detectFormat(raw({ body: Buffer.from("  <!DOCTYPE HTML><html>") }))).toBe("html")
    expect(detectFormat(raw({}))).toBe("markdown")
  })

  it("decodes the declared charset and survives unknown labels", async () => {
    const latin1 = await parseResource(raw({
      contentType: "text/markdown", charset: "iso-8859-1", body: Buffer.from("caf\xe9", "latin1"),
    }))
    expect(latin1.text).toBe("café")
    const unknown = await parseResource(raw({
      contentType: "text/markdown", charset: "no-such-charset", body: Buffer.from("plain"),
    }))
    expect(unknown.text).toBe("plain")
  })

  it("strips a BOM and normalizes CRLF before parsing, keeping the contract", async () => {
    const parsed = await parseResource(raw({
      contentType: "text/markdown",
      body: Buffer.from("﻿# Title\r\n\r\nBody line.\r\n", "utf8"),
    }))
    expect(parsed.text).toBe("# Title\n\nBody line.\n")
    expect(parsed.title).toBe("Title")
    assertOffsetContract(parsed)
  })
})
//#endregion
