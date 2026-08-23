//#region Imports
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { LLMHttpError } from "../../llm/http"
import { GeminiEmbeddingProvider, GEMINI_EMBED_DIM } from "../gemini"
import { OpenAICompatibleEmbeddingProvider } from "../openaiCompatible"
import { OllamaEmbeddingProvider } from "../ollama"
//#endregion

//#region Test Setup
// The remote embedding adapters against in-test loopback servers speaking
// each wire protocol — the same keyless pattern the LLM adapters use
// (llm/__tests__/httpProviders.test.ts), so CI exercises real sockets and
// real JSON with no API key anywhere.

interface Captured {
  url: string
  headers: IncomingMessage["headers"]
  body: Record<string, unknown>
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  servers.length = 0
})

async function boot(
  handle: (captured: Captured, res: ServerResponse) => void,
): Promise<{ baseUrl: string; captured: () => Captured }> {
  let captured: Captured | undefined
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      }
      handle(captured, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured: () => {
      if (!captured) throw new Error("server saw no request")
      return captured
    },
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** A vector of `n` components that is deliberately NOT unit length, so the
 *  normalization assertions have something to bite on. */
function ramp(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1)
}
//#endregion

describe("GeminiEmbeddingProvider", () => {
  it("requests the reduced dimension per text and returns unit vectors in order", async () => {
    const { baseUrl, captured } = await boot((_, res) =>
      json(res, 200, { embeddings: [{ values: ramp(GEMINI_EMBED_DIM) }, { values: ramp(GEMINI_EMBED_DIM).reverse() }] }),
    )
    const provider = new GeminiEmbeddingProvider({ apiKey: "AIza-test", baseUrl })
    const vectors = await provider.embed(["first", "second"])

    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(GEMINI_EMBED_DIM)
    // Re-normalized: the ramp we served has a norm far from 1.
    const norm = Math.sqrt(vectors[0]!.reduce((acc, v) => acc + v * v, 0))
    expect(norm).toBeCloseTo(1, 10)
    // Order preserved, not sorted: [0] is "first"'s ascending ramp.
    expect(vectors[0]![0]!).toBeLessThan(vectors[0]![1]!)
    expect(vectors[1]![0]!).toBeGreaterThan(vectors[1]![1]!)

    const sent = captured()
    expect(sent.url).toBe("/v1beta/models/gemini-embedding-001:batchEmbedContents")
    // Auth rides the header, never the URL — URLs land in logs.
    expect(sent.headers["x-goog-api-key"]).toBe("AIza-test")
    expect(sent.url).not.toContain("AIza-test")
    const requests = sent.body["requests"] as Array<Record<string, unknown>>
    expect(requests).toHaveLength(2)
    expect(requests[0]!["model"]).toBe("models/gemini-embedding-001")
    // 3072 native would not fit halfvec(1024) — the reduced size is not
    // optional, so it must be on every sub-request.
    expect(requests[0]!["outputDimensionality"]).toBe(GEMINI_EMBED_DIM)
    expect(requests[0]!["taskType"]).toBe("RETRIEVAL_DOCUMENT")
  })

  it("maps the query task hint to RETRIEVAL_QUERY", async () => {
    const { baseUrl, captured } = await boot((_, res) => json(res, 200, { embeddings: [{ values: ramp(GEMINI_EMBED_DIM) }] }))
    const provider = new GeminiEmbeddingProvider({ apiKey: "k".repeat(10), baseUrl })
    await provider.embed(["how do refunds work?"], { task: "query" })

    const requests = captured().body["requests"] as Array<Record<string, unknown>>
    expect(requests[0]!["taskType"]).toBe("RETRIEVAL_QUERY")
  })

  it("throws when the model's dimension changes under a declared credential", async () => {
    const { baseUrl } = await boot((_, res) => json(res, 200, { embeddings: [{ values: ramp(1536) }] }))
    const provider = new GeminiEmbeddingProvider({ apiKey: "k".repeat(10), baseUrl, dim: GEMINI_EMBED_DIM })
    await expect(provider.embed(["text"])).rejects.toThrow(/1536 dimensions, expected 768/)
  })

  it("reports a 429 as LLMHttpError with the retry delay and no key in the message", async () => {
    const { baseUrl } = await boot((_, res) => {
      res.setHeader("retry-after", "30")
      json(res, 429, { error: { message: "quota exceeded" } })
    })
    const provider = new GeminiEmbeddingProvider({ apiKey: "AIza-secret", baseUrl })
    const error = await provider.embed(["text"]).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LLMHttpError)
    expect((error as LLMHttpError).status).toBe(429)
    expect((error as LLMHttpError).retryAfterMs).toBe(30_000)
    expect((error as LLMHttpError).message).not.toContain("AIza-secret")
  })
})

describe("OpenAICompatibleEmbeddingProvider", () => {
  it("posts the batch, sorts by index, and discovers the dimension", async () => {
    const { baseUrl, captured } = await boot((_, res) =>
      // Deliberately out of order: the adapter must trust `index`, not
      // arrival order — a swap here would misattribute every chunk vector.
      json(res, 200, {
        data: [
          { index: 1, embedding: [0, 1, 0, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    )
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "bge-small", apiKey: "sk-test" })
    expect(provider.dim).toBe(0) // DIM_UNKNOWN until the first response

    const vectors = await provider.embed(["first", "second"])
    expect(vectors[0]).toEqual([1, 0, 0, 0])
    expect(vectors[1]).toEqual([0, 1, 0, 0])
    expect(provider.dim).toBe(4)

    const sent = captured()
    expect(sent.url).toBe("/embeddings")
    expect(sent.headers.authorization).toBe("Bearer sk-test")
    expect(sent.body["model"]).toBe("bge-small")
    expect(sent.body["input"]).toEqual(["first", "second"])
    // `dimensions` is never sent: compat servers disagree on unknown fields.
    expect(sent.body["dimensions"]).toBeUndefined()
  })

  it("sends no Authorization header for a keyless server", async () => {
    const { baseUrl, captured } = await boot((_, res) => json(res, 200, { data: [{ index: 0, embedding: [1, 0] }] }))
    await new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "local-model" }).embed(["text"])
    expect(captured().headers.authorization).toBeUndefined()
  })

  it("rejects a base64 embedding instead of storing corruption", async () => {
    const { baseUrl } = await boot((_, res) => json(res, 200, { data: [{ index: 0, embedding: "eyJhIjoxfQ==" }] }))
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "m" })
    await expect(provider.embed(["text"])).rejects.toThrow(/non-numeric embedding/)
  })

  it("rejects a short batch — one vector per text or nothing", async () => {
    const { baseUrl } = await boot((_, res) => json(res, 200, { data: [{ index: 0, embedding: [1, 0] }] }))
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "m" })
    await expect(provider.embed(["one", "two"])).rejects.toThrow(/returned 1 embeddings for 2 texts/)
  })

  it("reports a non-JSON 200 (wrong endpoint, captive portal) as a provider error", async () => {
    const { baseUrl } = await boot((_, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html>login required</html>")
    })
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "m" })
    await expect(provider.embed(["text"])).rejects.toThrow(/was not JSON/)
  })

  it("spends no request on an empty batch", async () => {
    const { baseUrl, captured } = await boot((_, res) => json(res, 200, { data: [] }))
    expect(await new OpenAICompatibleEmbeddingProvider({ baseUrl, model: "m" }).embed([])).toEqual([])
    expect(() => captured()).toThrow(/saw no request/)
  })
})

describe("OllamaEmbeddingProvider", () => {
  it("uses the batch endpoint and returns vectors in order", async () => {
    const { baseUrl, captured } = await boot((_, res) =>
      json(res, 200, { embeddings: [[1, 0, 0], [0, 1, 0]] }),
    )
    const provider = new OllamaEmbeddingProvider({ model: "nomic-embed-text", baseUrl })
    const vectors = await provider.embed(["first", "second"])

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]])
    expect(provider.dim).toBe(3)
    const sent = captured()
    // /api/embed (batch), not the single-prompt /api/embeddings.
    expect(sent.url).toBe("/api/embed")
    expect(sent.body["input"]).toEqual(["first", "second"])
    expect(sent.headers.authorization).toBeUndefined()
  })

  it("fails loudly when the server is down rather than hanging", async () => {
    // Port 1 is reserved and never listening.
    const provider = new OllamaEmbeddingProvider({ model: "m", baseUrl: "http://127.0.0.1:1" })
    await expect(provider.embed(["text"])).rejects.toThrow()
  })
})
