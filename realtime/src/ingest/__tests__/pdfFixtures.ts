//#region Why this file
// A minimal PDF WRITER, so the PDF parser's tests need no binary fixtures
// and no dependency — the same instinct as the zero-dependency .mjs probes
// (§6.1). A PDF is a text-shaped container with a byte-offset table, so
// building one honestly is ~40 lines, and the payoff is that a test can say
// "a two-page document whose second page wraps a sentence" instead of
// shipping an opaque blob nobody can read a diff of.
//
// It writes the smallest structure pdf.js accepts as VALID (a real xref
// table with correct offsets, a catalog, a page tree, one Helvetica font):
// deliberately not a broken file that pdf.js happens to recover, or the
// tests would be measuring its recovery path instead of the parser.
//
// NOT a general PDF writer: no compression, no encryption, no unicode
// beyond Latin-1, one font. Everything the parser's tests need and nothing
// they do not.
//#endregion

//#region Types
interface PdfPage {
  /** Lines of text drawn down the page. An empty array is a page with no
   *  content stream at all — how a SCANNED page looks to a text extractor. */
  lines: string[]
}

interface PdfOptions {
  /** Entries for the Info dictionary (Title, Author…). Omitted entirely
   *  when empty, which is how a PDF with no metadata reads. */
  info?: Record<string, string>
}
//#endregion

//#region Builder
/** Escapes the three characters that end a PDF literal string early. */
function escapeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

/**
 * Builds a syntactically valid PDF containing exactly these pages of text.
 *
 * Layout: each line is drawn 18 units below the previous one from a fixed
 * origin, which is enough for pdf.js to report them as separate lines in
 * reading order — the property the parser's line grouping is tested against.
 */
function buildPdf(pages: PdfPage[], options: PdfOptions = {}): Buffer {
  const objects: Array<string | null> = []
  const add = (body: string | null): number => {
    objects.push(body)
    return objects.length // PDF object numbers are 1-based
  }

  // Catalog and page tree are referenced by the pages, so they are reserved
  // first and filled once the page ids are known.
  const catalogId = add(null)
  const pagesId = add(null)
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  const pageIds: number[] = []
  for (const page of pages) {
    let contentsRef = ""
    if (page.lines.length > 0) {
      let content = "BT\n/F1 12 Tf\n72 720 Td\n"
      page.lines.forEach((line, i) => {
        if (i > 0) content += "0 -18 Td\n"
        content += `(${escapeLiteral(line)}) Tj\n`
      })
      content += "ET"
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      contentsRef = ` /Contents ${contentId} 0 R`
    }
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792]${contentsRef}` +
          ` /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
      ),
    )
  }

  const infoEntries = Object.entries(options.info ?? {})
    .map(([key, value]) => `/${key} (${escapeLiteral(value)})`)
    .join(" ")
  const infoId = infoEntries === "" ? null : add(`<< ${infoEntries} >>`)

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`

  // Serialize, recording each object's byte offset for the xref table —
  // getting these wrong is what makes a PDF "corrupt", so the test suite's
  // own correctness rides on this loop.
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objects[i] as string}\nendobj\n`
  }

  const xrefAt = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R` +
    `${infoId === null ? "" : ` /Info ${infoId} 0 R`} >>\nstartxref\n${xrefAt}\n%%EOF\n`

  // latin1: every byte written above is one character, and utf-8 would
  // silently widen any non-ASCII into a sequence the xref offsets no longer
  // point at.
  return Buffer.from(out, "latin1")
}
//#endregion

//#region Exports
export { buildPdf }
export type { PdfPage, PdfOptions }
//#endregion
