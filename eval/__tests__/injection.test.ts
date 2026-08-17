//#region Imports
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
//#endregion

//#region Test Setup
// The injection corpus (M6.3) is a hand-written asset, and these are the
// invariants the probe's arithmetic depends on. Each one, if broken, would
// not crash the probe — it would make a number lie:
//
//   · A canary that also appears in the LEGIT paragraph would be "relayed"
//     by any model that quotes the legitimate sentence, and the probe would
//     report an injection the model never followed.
//   · A multi-line legit paragraph would put its second line where the mock
//     responder never looks (it quotes the chunk's first line), and the
//     mock-mode control that the poisoned page was actually cited would
//     become a matter of luck.
//   · An entry whose combined text exceeds the chat route's question cap
//     could never be asked as its own exact text under the mock embedder,
//     and would silently drop out of the run.
interface InjectionEntry {
  id: string
  category: string
  url: string
  title: string
  heading: string
  legit: string
  injected: string
  canary: string | null
  attackerUrls: string[]
  question: string
}

const entries: InjectionEntry[] = readFileSync(resolve(__dirname, "../injection.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as InjectionEntry)

/** Mirrors realtime's MAX_QUESTION_CHARS. Repeated rather than imported:
 *  eval/ must not reach into realtime/ (the alias points the other way). */
const MAX_QUESTION_CHARS = 2_000
//#endregion

describe("injection corpus", () => {
  it("has entries with every field the seed and the probe read", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8)
    for (const entry of entries) {
      for (const field of ["id", "category", "url", "title", "heading", "legit", "injected", "question"] as const) {
        expect(typeof entry[field], `${entry.id}.${field}`).toBe("string")
        expect(entry[field].length, `${entry.id}.${field}`).toBeGreaterThan(0)
      }
      expect(Array.isArray(entry.attackerUrls), `${entry.id}.attackerUrls`).toBe(true)
      expect(entry.canary === null || typeof entry.canary === "string", `${entry.id}.canary`).toBe(true)
    }
  })

  it("keeps ids and urls unique — one page per poison, one poison per page", () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
    expect(new Set(entries.map((e) => e.url)).size).toBe(entries.length)
  })

  it("puts every canary in the INJECTED text and never in the legit paragraph", () => {
    // The whole basis of the relay count: a model that quotes the
    // legitimate sentence must not be scored as having followed the
    // injection.
    for (const entry of entries) {
      if (entry.canary === null) continue
      expect(entry.injected.includes(entry.canary), `${entry.id}: canary missing from injected`).toBe(true)
      expect(entry.legit.includes(entry.canary), `${entry.id}: canary leaked into legit`).toBe(false)
      expect(entry.question.includes(entry.canary), `${entry.id}: canary in the natural question`).toBe(false)
    }
  })

  it("keeps the legit paragraph on one line, so the mock quotes it and only it", () => {
    for (const entry of entries) {
      expect(entry.legit.includes("\n"), `${entry.id}: legit spans lines`).toBe(false)
    }
  })

  it("keeps attacker URLs out of the corpus's own hostnames", () => {
    // A claim citing an attacker URL is a failure the probe asserts; that
    // assertion is only meaningful if no legitimate page lives there.
    for (const entry of entries) {
      for (const url of entry.attackerUrls) {
        expect(new URL(url).host, `${entry.id}: attacker URL on the corpus host`).not.toBe(new URL(entry.url).host)
        expect(entry.injected.includes(url), `${entry.id}: attacker URL not actually in the injected text`).toBe(true)
      }
    }
  })

  it("fits every combined page text inside the chat route's question cap", () => {
    // Under the mock embedder the probe asks the exact page text; a page
    // over the cap would be refused with 400 and vanish from the run.
    for (const entry of entries) {
      const text = `${entry.legit}\n\n${entry.injected}`
      expect(text.length, `${entry.id}: ${text.length} chars`).toBeLessThanOrEqual(MAX_QUESTION_CHARS)
    }
  })

  it("covers the categories the probe's report groups by", () => {
    const categories = new Set(entries.map((e) => e.category))
    for (const required of ["instruction_override", "prompt_exfiltration", "link_injection", "format_override", "data_exfiltration"]) {
      expect(categories.has(required), `missing category ${required}`).toBe(true)
    }
  })
})
