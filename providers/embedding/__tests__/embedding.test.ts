//#region Imports
import { describe, expect, it } from "vitest"

import { MockEmbeddingProvider } from "../mock"
import { LocalEmbeddingProvider } from "../local"
import { PADDED_DIM, padVector } from "../../../shared/utils/vectors"
//#endregion

//#region Mock provider
describe("MockEmbeddingProvider", () => {
  const provider = new MockEmbeddingProvider()

  it("is deterministic: same text, same vector, across instances", async () => {
    const [a] = await provider.embed(["refund policy"])
    const [b] = await new MockEmbeddingProvider().embed(["refund policy"])
    expect(a).toEqual(b)
  })

  it("produces uncorrelated unit vectors for different texts", async () => {
    const [a, b] = await provider.embed(["refund policy", "shipping times"])
    const dot = a!.reduce((acc, v, i) => acc + v * (b![i] as number), 0)
    const norm = Math.sqrt(a!.reduce((acc, v) => acc + v * v, 0))
    expect(norm).toBeCloseTo(1, 6)          // unit-normalized like a real model
    expect(Math.abs(dot)).toBeLessThan(0.35) // hash-seeded → near-orthogonal
  })

  it("honors batch order and declared dimension, and pads cleanly", async () => {
    const texts = ["one", "two", "three"]
    const vectors = await provider.embed(texts)
    expect(vectors).toHaveLength(3)
    for (const v of vectors) {
      expect(v).toHaveLength(provider.dim)
      expect(padVector(v)).toHaveLength(PADDED_DIM) // fits the storage column
    }
    // Order check: element 0 must be the vector for texts[0], not a sort.
    const [first] = await provider.embed(["one"])
    expect(vectors[0]).toEqual(first)
  })

  it("handles the empty batch (boundary)", async () => {
    expect(await provider.embed([])).toEqual([])
  })
})
//#endregion

//#region Local provider (gated)
// Downloads a ~30 MB ONNX model on first run and needs the fastembed dev
// dependency — so it runs only when explicitly requested:
//   FASTEMBED_TEST=1 npm test
// CI leaves it off today; the eval harness (M1.3) turns it on where it
// matters. The mock suite above covers everything shape-related.
const FASTEMBED = Boolean(process.env.FASTEMBED_TEST)

describe.skipIf(!FASTEMBED)("LocalEmbeddingProvider (real fastembed)", () => {
  it("embeds real text at the declared dimension with semantic ordering", async () => {
    const provider = new LocalEmbeddingProvider()
    const [refund, money, weather] = await provider.embed([
      "How do I get a refund for my order?",
      "Can I get my money back?",
      "Tomorrow will be sunny with light wind.",
    ])
    expect(refund).toHaveLength(provider.dim)

    const cosine = (a: number[], b: number[]): number => {
      const dot = a.reduce((acc, v, i) => acc + v * (b[i] as number), 0)
      const na = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0))
      const nb = Math.sqrt(b.reduce((acc, v) => acc + v * v, 0))
      return dot / (na * nb)
    }
    // The one semantic property everything downstream depends on: related
    // texts closer than unrelated ones. If THIS fails, the model file or
    // adapter is broken and the eval harness would be measuring noise.
    expect(cosine(refund!, money!)).toBeGreaterThan(cosine(refund!, weather!))
  }, 300_000) // first run downloads the model; generous timeout
})

describe.skipIf(FASTEMBED)("LocalEmbeddingProvider (gated off)", () => {
  it("is skipped because FASTEMBED_TEST is not set", () => {
    expect(FASTEMBED).toBe(false)
  })
})
//#endregion
