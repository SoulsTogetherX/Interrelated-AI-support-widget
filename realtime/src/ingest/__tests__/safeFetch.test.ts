//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { isPublicAddress } from "@/ingest/ip"
import { safeFetch, assertPublicUrl, SafeFetchError } from "@/ingest/safeFetch"
//#endregion

//#region Address classification
describe("isPublicAddress", () => {
  // Each entry is a boundary of a blocked range or a representative public
  // address just OUTSIDE one — the guard's whole value is at the edges.
  const nonPublic = [
    "127.0.0.1",
    "127.255.255.255", // loopback
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1", // RFC1918
    "169.254.169.254", // link-local — THE cloud metadata address
    "100.64.0.1",
    "100.127.255.255", // CGNAT
    "0.0.0.0",
    "0.1.2.3", // "this" network
    "192.0.2.5",
    "198.51.100.7",
    "203.0.113.9", // TEST-NETs
    "192.0.0.1", // IETF special-purpose
    "198.18.0.1",
    "198.19.255.255", // benchmarking
    "224.0.0.1",
    "255.255.255.255", // multicast / broadcast
    "::1",
    "::", // v6 loopback / unspecified
    "fe80::1",
    "fc00::1",
    "fdab:cdef::1",
    "ff02::1", // link-local / ULA / multicast
    "2001:db8::1", // documentation
    "2001::1",
    "2002:0808:0808::1", // Teredo / 6to4 (tunnels — opaque, rejected)
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254", // v4-mapped
    "64:ff9b::7f00:1", // NAT64 embedding loopback
  ]
  const publicAddrs = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1", // just outside 172.16/12
    "100.63.255.255",
    "100.128.0.1", // just outside CGNAT
    "198.17.255.255",
    "198.20.0.1", // just outside benchmarking
    "223.255.255.255", // last unicast before multicast
    "2606:4700:4700::1111",
    "2600::1",
    "::ffff:8.8.8.8", // v4-mapped public stays public
    "64:ff9b::808:808", // NAT64 embedding a public address
  ]
  // Alternate spellings resolvers may interpret creatively — classic SSRF
  // filter bypasses. The parser refuses to recognize them at all.
  const malformed = [
    "017700000001",
    "0x7f000001",
    "127.1",
    "127.0.0.01",
    "010.0.0.1",
    "1.2.3.4.5",
    "1.2.3.256",
    "",
    "localhost",
    "fe80::1%eth0",
    ":::1",
    "12345::g",
  ]

  it.each(nonPublic)("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(publicAddrs)("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
  it.each(malformed)("fails closed on %j", (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
})
//#endregion

//#region URL vetting
describe("assertPublicUrl", () => {
  const resolveTo =
    (...addresses: string[]) =>
    async () =>
      addresses
  const reason = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise
      return "(resolved)"
    } catch (err) {
      return err instanceof SafeFetchError ? err.reason : "(wrong type)"
    }
  }

  it("rejects non-http(s) schemes", async () => {
    expect(await reason(assertPublicUrl(new URL("ftp://example.com/")))).toBe("blocked-scheme")
    expect(await reason(assertPublicUrl(new URL("file:///etc/passwd")))).toBe("blocked-scheme")
  })

  it("rejects embedded credentials", async () => {
    expect(await reason(assertPublicUrl(new URL("https://user:pw@example.com/")))).toBe(
      "credentials-in-url",
    )
  })

  it("classifies literal IP hosts without touching DNS", async () => {
    const neverResolve = async () => {
      throw new Error("resolver must not be called")
    }
    expect(await reason(assertPublicUrl(new URL("http://127.0.0.1/"), neverResolve))).toBe(
      "non-public-address",
    )
    expect(await reason(assertPublicUrl(new URL("http://[::1]/"), neverResolve))).toBe(
      "non-public-address",
    )
    await assertPublicUrl(new URL("http://93.184.216.34/"), neverResolve) // public literal passes
  })

  it("accepts a hostname whose answers are all public", async () => {
    await assertPublicUrl(
      new URL("https://docs.example.com/"),
      resolveTo("93.184.216.34", "2606:4700::1"),
    )
  })

  it("rejects when ANY answer is non-public", async () => {
    // One private A record among public ones taints the set — the socket
    // layer may dial any of them.
    expect(
      await reason(
        assertPublicUrl(
          new URL("https://evil.example.com/"),
          resolveTo("93.184.216.34", "10.0.0.5"),
        ),
      ),
    ).toBe("non-public-address")
  })

  it("rejects on resolver failure or empty answers", async () => {
    const failing = async () => {
      throw new Error("NXDOMAIN")
    }
    expect(await reason(assertPublicUrl(new URL("https://nope.example.com/"), failing))).toBe(
      "dns-failure",
    )
    expect(await reason(assertPublicUrl(new URL("https://empty.example.com/"), resolveTo()))).toBe(
      "dns-failure",
    )
  })
})
//#endregion

//#region Live fetch behavior
describe("safeFetch", () => {
  let server: Server
  let base: string
  const allowAll = () => {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname
      switch (path) {
        case "/ok":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          res.end("<html><body>hello</body></html>")
          return
        case "/hop1":
          res.writeHead(302, { location: "/hop2" })
          res.end()
          return
        case "/hop2":
          res.writeHead(301, { location: "/ok" })
          res.end()
          return
        case "/loop":
          res.writeHead(302, { location: "/loop" })
          res.end()
          return
        case "/big-declared":
          res.writeHead(200, { "content-length": "1048576", "content-type": "text/html" })
          res.end(Buffer.alloc(1048576))
          return
        case "/big-chunked": {
          // No content-length: the cap must bite on the STREAM, not the header.
          res.writeHead(200, { "content-type": "text/html" })
          const chunk = Buffer.alloc(64 * 1024)
          for (let i = 0; i < 32; i++) res.write(chunk)
          res.end()
          return
        }
        case "/slow":
          return // never responds; the timeout must fire
        default:
          res.writeHead(404, { "content-type": "text/plain" })
          res.end("nope")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise
      return "(resolved)"
    } catch (err) {
      return err instanceof SafeFetchError ? err.reason : `(wrong type: ${String(err)})`
    }
  }

  it("BLOCKS loopback fixture servers under the default guard", async () => {
    // The security default, pinned: everything below opts out explicitly
    // with a permissive hostGuard, and only tests may do that.
    expect(await reasonOf(safeFetch(`${base}/ok`))).toBe("non-public-address")
  })

  it("fetches a page and reports final URL, status, media type", async () => {
    const res = await safeFetch(`${base}/ok`, { hostGuard: allowAll })
    expect(res.status).toBe(200)
    expect(res.contentType).toBe("text/html") // parameters stripped
    expect(res.charset).toBe("utf-8") // …but carried separately for decoding
    expect(res.finalUrl).toBe(`${base}/ok`)
    expect(res.body.toString("utf8")).toContain("hello")
  })

  it("returns non-2xx statuses rather than throwing", async () => {
    const res = await safeFetch(`${base}/missing`, { hostGuard: allowAll })
    expect(res.status).toBe(404)
  })

  it("follows redirect chains and resolves relative locations", async () => {
    const res = await safeFetch(`${base}/hop1`, { hostGuard: allowAll })
    expect(res.status).toBe(200)
    expect(res.finalUrl).toBe(`${base}/ok`)
  })

  it("caps redirect chains", async () => {
    expect(
      await reasonOf(safeFetch(`${base}/loop`, { hostGuard: allowAll, maxRedirects: 3 })),
    ).toBe("too-many-redirects")
  })

  it("re-vets EVERY redirect hop, not just the first URL", async () => {
    // A guard that admits the entry page but rejects the redirect target:
    // if the loop skipped per-hop vetting, this would resolve fine.
    const guard = (url: URL) => {
      if (url.pathname !== "/hop1")
        throw new SafeFetchError("non-public-address", `blocked ${url.pathname}`)
    }
    expect(await reasonOf(safeFetch(`${base}/hop1`, { hostGuard: guard }))).toBe(
      "non-public-address",
    )
  })

  it("rejects oversized bodies via the declared length", async () => {
    expect(
      await reasonOf(safeFetch(`${base}/big-declared`, { hostGuard: allowAll, maxBytes: 4096 })),
    ).toBe("too-large")
  })

  it("rejects oversized bodies with no content-length while streaming", async () => {
    expect(
      await reasonOf(safeFetch(`${base}/big-chunked`, { hostGuard: allowAll, maxBytes: 4096 })),
    ).toBe("too-large")
  })

  it("times out a hung server", async () => {
    expect(await reasonOf(safeFetch(`${base}/slow`, { hostGuard: allowAll, timeoutMs: 300 }))).toBe(
      "timeout",
    )
  })
})
//#endregion
