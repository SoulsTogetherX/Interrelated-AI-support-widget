// Keyless and OFFLINE: a loopback HTTP server plays HIBP (the same in-test
// loopback pattern realtime's provider suites use), so the parse and
// fail-open paths are pinned without a third-party dependency in CI.
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { checkPasswordBreached } from "../breachedPassword"

import type { Server } from "node:http"

const PASSWORD = "correct horse battery staple"
const SHA1 = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase()
const SUFFIX = SHA1.slice(5)

let server: Server | null = null

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address() as { port: number }
      resolve(`http://127.0.0.1:${address.port}/range`)
    })
  })
}

afterEach(() => {
  server?.close()
  server = null
  delete process.env.BREACH_CHECK_DISABLED
})

describe("checkPasswordBreached", () => {
  it("finds a breached password in the range response", async () => {
    const url = await listen((req, res) => {
      // The request must carry only the 5-char prefix — the k-anonymity
      // property is THE point, so assert it where the request is visible.
      expect(req.url).toBe(`/range/${SHA1.slice(0, 5)}`)
      res.end(`00000AAAA:0\r\n${SUFFIX}:1234\r\nFFFFFBBBB:7`)
    })
    expect(await checkPasswordBreached(PASSWORD, url)).toEqual({
      breached: true,
      count: 1234,
    })
  })

  it("treats an absent suffix (and 0-count padding) as clean", async () => {
    const url = await listen((_req, res) => {
      // The padding HIBP adds on request has count 0 — same parse ignores it.
      res.end(`00000AAAA:12\r\n${SUFFIX}:0`)
    })
    expect(await checkPasswordBreached(PASSWORD, url)).toEqual({ breached: false })
  })

  it("fails OPEN on a server error, saying so", async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 503
      res.end()
    })
    expect(await checkPasswordBreached(PASSWORD, url)).toEqual({
      breached: false,
      skipped: true,
      reason: "hibp status 503",
    })
  })

  it("fails OPEN when the service is unreachable", async () => {
    // A closed port refuses immediately — the fail-open catch path without
    // waiting out the real timeout.
    const result = await checkPasswordBreached(PASSWORD, "http://127.0.0.1:9/range")
    expect(result.breached).toBe(false)
    expect("skipped" in result && result.skipped).toBe(true)
  })

  it("honors the test/offline opt-out", async () => {
    process.env.BREACH_CHECK_DISABLED = "1"
    expect(await checkPasswordBreached(PASSWORD)).toEqual({
      breached: false,
      skipped: true,
      reason: "disabled",
    })
  })
})
