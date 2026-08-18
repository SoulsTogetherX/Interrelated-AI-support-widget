// Keyless and offline: a loopback server plays realtime's internal API, so
// the client's contract — secret header on every call, no-store, error
// mapping, and the not-connected state — is pinned without realtime
// running. (The REAL API's behavior is realtime's own suite; this tests
// OUR half of the wire.)
import { createServer } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { createSource, recrawlSource, removeCredential, submitCredential } from "../index"

import type { Server } from "node:http"
import type { IncomingMessage } from "node:http"

let server: Server | null = null
let seen: Array<{ method: string; url: string; secret: string | undefined; body: string }>

function listen(status: number, responseBody: unknown): Promise<void> {
  seen = []
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res) => {
      let body = ""
      req.on("data", (c: Buffer) => (body += c.toString()))
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          secret: req.headers["x-internal-secret"] as string | undefined,
          body,
        })
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(responseBody))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number }
      process.env.REALTIME_INTERNAL_URL = `http://127.0.0.1:${addr.port}`
      process.env.INTERNAL_API_SECRET = "web-client-test-secret-0123456789ab"
      resolve()
    })
  })
}

afterEach(() => {
  server?.close()
  server = null
  delete process.env.REALTIME_INTERNAL_URL
  delete process.env.INTERNAL_API_SECRET
})

describe("realtime internal client", () => {
  it("surfaces the not-connected state instead of throwing", async () => {
    const result = await submitCredential("org_x", { role: "generation", provider: "groq" }, false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("not connected")
  })

  it("sends the secret header and the save flag, and maps the outcome", async () => {
    await listen(200, { ok: true, saved: true, model: "m", latencyMs: 42, suffix: "a3f9" })
    const result = await submitCredential(
      "org_00000000000000000000000000000000",
      { role: "generation", provider: "groq", apiKey: "gsk_something" },
      true,
    )
    expect(result).toEqual({
      ok: true,
      // A generation save reports no dimension and no re-index — both are
      // embedding-role facts, and the client normalizes their absence
      // rather than leaving the UI to check for undefined.
      value: { saved: true, model: "m", latencyMs: 42, suffix: "a3f9", dim: null, reindexed: 0 },
    })
    expect(seen[0].method).toBe("POST")
    expect(seen[0].url).toBe("/internal/orgs/org_00000000000000000000000000000000/credentials")
    expect(seen[0].secret).toBe("web-client-test-secret-0123456789ab")
    expect(JSON.parse(seen[0].body)).toMatchObject({ save: true, apiKey: "gsk_something" })
  })

  it("carries the embedding role's dimension and re-index count through", async () => {
    await listen(200, { ok: true, saved: true, model: "gemini-embedding-001", latencyMs: 300, dim: 768, reindexed: 2 })
    const result = await submitCredential(
      "org_00000000000000000000000000000000",
      { role: "embedding", provider: "gemini", apiKey: "AIza-something" },
      true,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dim).toBe(768)
    // The number the UI turns into "2 sources queued for re-indexing" —
    // dropping it silently is how a tenant ends up confused by crawls they
    // did not start.
    expect(result.value.reindexed).toBe(2)
    expect(JSON.parse(seen[0].body)).toMatchObject({ role: "embedding" })
  })

  it("relays the server's validation error verbatim", async () => {
    await listen(422, { ok: false, error: "The base URL must resolve to a public address." })
    const result = await submitCredential(
      "org_00000000000000000000000000000000",
      { role: "generation", provider: "openai_compatible", baseUrl: "http://10.0.0.1/v1", model: "m" },
      false,
    )
    expect(result).toEqual({
      ok: false,
      error: "The base URL must resolve to a public address.",
    })
  })

  it("names a secret mismatch for the operator", async () => {
    await listen(401, {})
    const result = await removeCredential("org_00000000000000000000000000000000", "generation")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("misconfigured")
  })

  it("DELETEs the role path", async () => {
    await listen(200, { ok: true })
    const result = await removeCredential("org_00000000000000000000000000000000", "generation")
    expect(result.ok).toBe(true)
    expect(seen[0].method).toBe("DELETE")
    expect(seen[0].url).toBe(
      "/internal/orgs/org_00000000000000000000000000000000/credentials/generation",
    )
  })

  it("POSTs a source and maps the enqueue result", async () => {
    await listen(200, { ok: true, sourceId: "src_x", jobId: "job_y" })
    const result = await createSource("org_00000000000000000000000000000000", {
      kind: "url",
      location: "https://docs.example.com/",
      crawlDepth: 2,
    })
    expect(result).toEqual({ ok: true, value: { sourceId: "src_x", jobId: "job_y" } })
    expect(seen[0].url).toBe("/internal/orgs/org_00000000000000000000000000000000/sources")
    expect(JSON.parse(seen[0].body)).toEqual({
      kind: "url",
      location: "https://docs.example.com/",
      crawlDepth: 2,
    })
  })

  it("POSTs a re-crawl and reads `queued` back, false being a normal answer", async () => {
    await listen(200, { ok: true, queued: false })
    const result = await recrawlSource("org_00000000000000000000000000000000", "src_00000000000000000000000000000000")
    expect(result).toEqual({ ok: true, value: { queued: false } })
    expect(seen[0].method).toBe("POST")
    expect(seen[0].url).toBe(
      "/internal/orgs/org_00000000000000000000000000000000/sources/src_00000000000000000000000000000000/recrawl",
    )
    expect(seen[0].secret).toBe("web-client-test-secret-0123456789ab")
  })
})
