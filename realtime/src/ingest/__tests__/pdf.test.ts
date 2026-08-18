//#region Imports
import { describe, expect, it } from "vitest"

import { chunkBlocks } from "@shared/chunking/chunker"
import { parseResource } from "@/ingest/parsers/index"
import { parsePdf, PdfParseError } from "@/ingest/parsers/pdf"
import { buildPdf } from "@/ingest/__tests__/pdfFixtures"
//#endregion

//#region Helpers
/** The contract EVERY parser is judged by (parsers/types.ts). Asserted on
 *  every document this suite produces, because an offset that drifts is a
 *  citation that deep-links into the wrong sentence. */
function expectOffsetContract(doc: { text: string; blocks: Array<{ text: string; charStart: number; charEnd: number }> }): void {
  for (const block of doc.blocks) {
    expect(doc.text.slice(block.charStart, block.charEnd)).toBe(block.text)
  }
}

const asResource = (body: Buffer, overrides: Partial<{ url: string; contentType: string; charset: string | null }> = {}) => ({
  url: "https://docs.example.com/policy.pdf",
  contentType: "application/pdf",
  charset: null,
  body,
  ...overrides,
})
//#endregion

//#region The happy path
describe("parsePdf", () => {
  it("extracts text, keeps the offset contract, and titles from the Info dictionary", async () => {
    const pdf = buildPdf(
      [{ lines: ["Refund Policy", "Refunds are processed within five business days."] }],
      { info: { Title: "Refund Policy 2026", Author: "Acme Support" } },
    )
    const doc = await parsePdf(pdf)

    expect(doc.title).toBe("Refund Policy 2026")
    expect(doc.text).toContain("Refunds are processed within five business days.")
    expect(doc.blocks.length).toBeGreaterThan(0)
    expectOffsetContract(doc)
    // A PDF's link annotations are never followed: `links` drives the crawler's
    // same-origin frontier, and a document's citations are not a site's pages.
    expect(doc.links).toEqual([])
  })

  it("falls back to the first line when the PDF claims no title", async () => {
    const doc = await parsePdf(buildPdf([{ lines: ["Shipping Terms", "We ship on weekdays."] }]))
    expect(doc.title).toBe("Shipping Terms")
  })

  it("keeps a page's wrapped lines in ONE block rather than one block per line", async () => {
    // The reason lines are grouped: the chunker joins the blocks it packs
    // with a BLANK line, so one block per line would blank-separate the
    // halves of every wrapped sentence — in the embedded text and in the
    // verbatim quote a citation has to contain.
    //
    // This also pins the MEASURED behavior the parser is written against:
    // pdf.js reports no blank line between rows however large the gap (a
    // fixture line of "" is dropped entirely, as asserted below), so a page
    // arrives as one run of lines and leaves as one block.
    const doc = await parsePdf(
      buildPdf([{ lines: ["Refunds are processed within", "five business days of approval.", "", "Exceptions need a manager."] }]),
    )
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0]?.text).toBe(
      "Refunds are processed within\nfive business days of approval.\nExceptions need a manager.",
    )
    expectOffsetContract(doc)
  })

  it("separates pages by a blank line and keeps offsets correct across the boundary", async () => {
    const doc = await parsePdf(
      buildPdf([{ lines: ["Page one text."] }, { lines: ["Page two text."] }]),
    )
    expect(doc.text).toBe("Page one text.\n\nPage two text.")
    expect(doc.blocks.map((b) => b.text)).toEqual(["Page one text.", "Page two text."])
    // The second page's block must point PAST the separator, not at it.
    expect(doc.blocks[1]?.charStart).toBe("Page one text.\n\n".length)
    expectOffsetContract(doc)
  })

  it("collapses layout whitespace, so the same bytes always hash the same", async () => {
    // Kerning and table columns reach the extractor as runs of spaces; if
    // they survived, documents.content_hash would depend on them.
    const pdf = buildPdf([{ lines: ["Column   one     and    column  two"] }])
    const first = await parsePdf(pdf)
    const second = await parsePdf(pdf)
    expect(first.text).toBe("Column one and column two")
    expect(second.text).toBe(first.text)
    expectOffsetContract(first)
  })

  it("survives being called twice on the same buffer (pdf.js detaches its input)", async () => {
    // The failure this pins: pdf.js TRANSFERS the array it is given, so a
    // parser that passed the caller's buffer straight through would work
    // once and then throw DataCloneError on the next page of the crawl.
    const pdf = buildPdf([{ lines: ["Reused buffer."] }])
    expect((await parsePdf(pdf)).text).toBe("Reused buffer.")
    expect((await parsePdf(pdf)).text).toBe("Reused buffer.")
    expect(pdf.byteLength).toBeGreaterThan(0) // the caller's buffer is intact
  })
})
//#endregion

//#region What it refuses, and how it says so
describe("parsePdf — refusals", () => {
  it("names OCR when the PDF has no text layer (a scan)", async () => {
    // A page with no content stream is what every page of a scanned document
    // looks like to a text extractor: the content is pixels.
    const scanned = buildPdf([{ lines: [] }, { lines: [] }])
    await expect(parsePdf(scanned)).rejects.toThrow(PdfParseError)
    await expect(parsePdf(scanned)).rejects.toThrow(/no text layer.*OCR/)
  })

  it("refuses bytes that are not a readable PDF, instead of hanging or guessing", async () => {
    const truncated = buildPdf([{ lines: ["Cut short."] }]).subarray(0, 250)
    await expect(parsePdf(truncated)).rejects.toThrow(PdfParseError)
    await expect(parsePdf(Buffer.from("%PDF-1.4 and then nothing useful"))).rejects.toThrow(PdfParseError)
    await expect(parsePdf(Buffer.alloc(0))).rejects.toThrow(PdfParseError)
  })

  it("refuses an oversized PDF BEFORE handing it to pdf.js", async () => {
    // The backstop cap: of everything in the ingest path this parser is the
    // largest attack surface, and the input is the half that can be bounded
    // cheaply. Refused on size alone — the bytes here are a valid PDF
    // followed by padding, so only the cap can be what rejects it.
    const padded = Buffer.concat([buildPdf([{ lines: ["Valid, but enormous."] }]), Buffer.alloc(10 * 1024 * 1024)])
    await expect(parsePdf(padded)).rejects.toThrow(/larger than 10 MB/)
  })
})
//#endregion

//#region Through the dispatcher
describe("parseResource — PDFs", () => {
  it("parses a PDF the server mislabels as text/plain (magic bytes decide)", async () => {
    // The detection order's whole purpose: mislabeled as text, this would
    // otherwise reach the markdown fallback and become paragraphs of binary.
    const pdf = buildPdf([{ lines: ["Mislabeled but readable."] }], { info: { Title: "Mislabeled" } })
    const doc = await parseResource(asResource(pdf, { contentType: "text/plain", charset: "utf-8" }))
    expect(doc.title).toBe("Mislabeled")
    expect(doc.text).toBe("Mislabeled but readable.")
    expectOffsetContract(doc)
  })

  it("hands a PDF the raw bytes — no charset decoding on the way in", async () => {
    // A declared charset must not touch a binary format; decoding would
    // corrupt it before the parser ever saw it.
    const pdf = buildPdf([{ lines: ["Binary in, text out."] }])
    const doc = await parseResource(asResource(pdf, { charset: "iso-8859-1" }))
    expect(doc.text).toBe("Binary in, text out.")
  })

  it("chunks end to end, the way the ingest worker will", async () => {
    const pdf = buildPdf(
      [{ lines: ["Warranty Terms", "Coverage lasts twelve months from delivery."] }, { lines: ["Claims are filed online."] }],
      { info: { Title: "Warranty" } },
    )
    const doc = await parseResource(asResource(pdf))
    const chunks = chunkBlocks(doc.blocks)
    expect(chunks.length).toBeGreaterThan(0)
    // Every chunk's span still points at its own text in the document — the
    // property that makes a citation deep-link truthfully.
    for (const chunk of chunks) {
      expect(doc.text.slice(chunk.charStart, chunk.charEnd)).toContain(chunk.text.split("\n\n")[0] as string)
    }
    expect(chunks.map((c) => c.text).join(" ")).toContain("Coverage lasts twelve months")
  })
})
//#endregion
