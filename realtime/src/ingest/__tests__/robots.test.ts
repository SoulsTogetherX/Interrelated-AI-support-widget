//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  fetchRobotsPolicy,
  matchesPattern,
  normalizeForMatch,
  parseRobotsTxt,
  robotsPolicy,
  ROBOTS_MAX_BYTES,
} from "@/ingest/robots"
import { USER_AGENT_PRODUCT } from "@/ingest/safeFetch"
//#endregion

//#region Helpers
/** Policy for OUR crawler over a robots.txt body — the question every test
 *  below asks: may InterrelatedBot fetch this path? */
function policy(text: string, agent = USER_AGENT_PRODUCT) {
  return robotsPolicy(parseRobotsTxt(text), agent, "test")
}

const allowed = (text: string, url: string, agent?: string) =>
  policy(text, agent).check(url).allowed

/** The reason clause a refusal carries — what the dashboard shows. */
function reason(text: string, url: string, agent?: string): string | null {
  const verdict = policy(text, agent).check(url)
  return verdict.allowed ? null : verdict.reason
}
//#endregion

//#region Group selection (RFC 9309 §2.2.1)
describe("robots.txt — which group applies", () => {
  it("applies the wildcard group when nothing names us", () => {
    const text = "User-agent: *\nDisallow: /private/\n"
    expect(allowed(text, "https://x.test/private/notes")).toBe(false)
    expect(allowed(text, "https://x.test/public/notes")).toBe(true)
  })

  it("a group naming our product token REPLACES the wildcard rules", () => {
    const text = [
      "User-agent: *",
      "Disallow: /a",
      "",
      "User-agent: InterrelatedBot",
      "Disallow: /b",
    ].join("\n")
    expect(allowed(text, "https://x.test/a")).toBe(true) // the wildcard's rule no longer applies to us
    expect(allowed(text, "https://x.test/b")).toBe(false)
  })

  it("matches the token case-insensitively and ignores a version suffix", () => {
    const text = "User-agent: interrelatedbot/0.1\nDisallow: /secret\n"
    expect(allowed(text, "https://x.test/secret")).toBe(false)
    expect(reason(text, "https://x.test/secret")).toBe(
      `disallowed by robots.txt (User-agent: ${USER_AGENT_PRODUCT}, Disallow: /secret)`,
    )
  })

  it("a run of consecutive user-agent lines is ONE group", () => {
    const text = "User-agent: barbot\nUser-agent: bazbot\nDisallow: /example/page.html\n"
    expect(allowed(text, "https://x.test/example/page.html", "barbot")).toBe(false)
    expect(allowed(text, "https://x.test/example/page.html", "bazbot")).toBe(false)
    expect(allowed(text, "https://x.test/other", "bazbot")).toBe(true)
    // …and a third crawler is not in it, and there is no wildcard group.
    expect(allowed(text, "https://x.test/example/page.html", "quxbot")).toBe(true)
  })

  it("no group at all, or only groups for other crawlers → everything allowed", () => {
    expect(allowed("", "https://x.test/anything")).toBe(true)
    expect(allowed("# just a comment\n", "https://x.test/anything")).toBe(true)
    expect(allowed("User-agent: Googlebot\nDisallow: /\n", "https://x.test/anything")).toBe(true)
  })

  it("MERGES several groups that name the same agent (§2.2.1)", () => {
    const text = [
      "User-agent: *",
      "Disallow: /a",
      "",
      "User-agent: Googlebot",
      "Disallow: /g",
      "",
      "User-agent: *",
      "Disallow: /b",
    ].join("\n")
    expect(allowed(text, "https://x.test/a")).toBe(false)
    expect(allowed(text, "https://x.test/b")).toBe(false)
    expect(allowed(text, "https://x.test/g")).toBe(true)
  })

  it("rules before any user-agent line belong to nobody", () => {
    const text = "Disallow: /orphan\nUser-agent: *\nDisallow: /kept\n"
    expect(allowed(text, "https://x.test/orphan")).toBe(true)
    expect(allowed(text, "https://x.test/kept")).toBe(false)
  })

  it("a non-rule line ends the user-agent run but not the group", () => {
    // Sitemap between the agent line and its rules: the rules still attach.
    const text = "User-agent: *\nSitemap: https://x.test/sitemap.xml\nDisallow: /a\n"
    expect(allowed(text, "https://x.test/a")).toBe(false)
    // …whereas a user-agent line AFTER rules starts a fresh group.
    const two = "User-agent: other\nDisallow: /x\nUser-agent: *\nDisallow: /y\n"
    expect(allowed(two, "https://x.test/x")).toBe(true)
    expect(allowed(two, "https://x.test/y")).toBe(false)
  })
})
//#endregion

//#region Rule precedence (RFC 9309 §2.2.2)
describe("robots.txt — which rule wins", () => {
  it("the RFC's own example, per crawler", () => {
    const text = [
      "User-Agent: *",
      "Disallow: *.gif$",
      "Disallow: /example/",
      "Allow: /publications/",
      "",
      "User-Agent: foobot",
      "Disallow:/",
      "Allow:/example/page.html",
      "Allow:/example/allowed.gif",
      "",
      "User-Agent: barbot",
      "User-Agent: bazbot",
      "Disallow: /example/page.html",
    ].join("\n")
    // Us: the wildcard group.
    expect(allowed(text, "https://x.test/pic.gif")).toBe(false)
    expect(allowed(text, "https://x.test/pic.gifx")).toBe(true) // `$` anchors
    expect(allowed(text, "https://x.test/example/foo")).toBe(false)
    expect(allowed(text, "https://x.test/publications/a")).toBe(true)
    expect(allowed(text, "https://x.test/other")).toBe(true)
    // foobot: everything closed except two paths, by longer Allow rules.
    expect(allowed(text, "https://x.test/", "foobot")).toBe(false)
    expect(allowed(text, "https://x.test/example/page.html", "foobot")).toBe(true)
    expect(allowed(text, "https://x.test/example/allowed.gif", "foobot")).toBe(true)
    expect(allowed(text, "https://x.test/example/other", "foobot")).toBe(false)
  })

  it("the most specific (longest) match wins", () => {
    const text = "User-agent: *\nDisallow: /a\nAllow: /a/b\n"
    expect(allowed(text, "https://x.test/a/b/c")).toBe(true)
    expect(allowed(text, "https://x.test/a/c")).toBe(false)
    // Length is of the PATTERN: /abc (4) beats /a* (3) on /abcd.
    const wild = "User-agent: *\nAllow: /a*\nDisallow: /abc\n"
    expect(allowed(wild, "https://x.test/abcd")).toBe(false)
    expect(allowed(wild, "https://x.test/abd")).toBe(true)
  })

  it("an Allow and a Disallow of equal length → Allow", () => {
    expect(allowed("User-agent: *\nDisallow: /a\nAllow: /a\n", "https://x.test/a")).toBe(true)
    expect(allowed("User-agent: *\nAllow: /a\nDisallow: /a\n", "https://x.test/a")).toBe(true) // order-independent
  })

  it("an empty Disallow is 'nothing disallowed', not 'everything'", () => {
    expect(allowed("User-agent: *\nDisallow:\n", "https://x.test/anything")).toBe(true)
    // …and it does not cancel a real rule beside it.
    expect(allowed("User-agent: *\nDisallow:\nDisallow: /a\n", "https://x.test/a")).toBe(false)
  })

  it("names the deciding rule in the reason", () => {
    const text = "User-agent: *\nDisallow: /private/\nDisallow: /private/deep/\n"
    expect(reason(text, "https://x.test/private/deep/x")).toBe(
      "disallowed by robots.txt (User-agent: *, Disallow: /private/deep/)",
    )
    expect(reason(text, "https://x.test/private/y")).toBe(
      "disallowed by robots.txt (User-agent: *, Disallow: /private/)",
    )
  })

  it("Crawl-delay comes from the matched group, and only from it", () => {
    const text =
      "User-agent: *\nCrawl-delay: 10\n\nUser-agent: InterrelatedBot\nCrawl-delay: 2.5\nDisallow: /x\n"
    expect(policy(text).crawlDelaySeconds).toBe(2.5)
    expect(policy(text, "otherbot").crawlDelaySeconds).toBe(10)
    expect(policy("User-agent: *\nCrawl-delay: soon\n").crawlDelaySeconds).toBeNull()
    expect(policy("User-agent: *\nCrawl-delay: -1\n").crawlDelaySeconds).toBeNull()
    expect(policy("User-agent: *\nDisallow: /\n").crawlDelaySeconds).toBeNull()
  })
})
//#endregion

//#region Path matching (RFC 9309 §2.2.3)
describe("robots.txt — patterns", () => {
  it("a pattern without $ is a prefix; with $ it anchors", () => {
    expect(matchesPattern("/a", "/ab")).toBe(true)
    expect(matchesPattern("/a$", "/ab")).toBe(false)
    expect(matchesPattern("/a$", "/a")).toBe(true)
    expect(matchesPattern("/", "/anything/at/all")).toBe(true)
  })

  it("* matches any run, including none, anywhere", () => {
    expect(matchesPattern("/*.pdf$", "/docs/manual.pdf")).toBe(true)
    expect(matchesPattern("/*.pdf$", "/docs/manual.pdf?dl=1")).toBe(false)
    expect(matchesPattern("/*.pdf", "/docs/manual.pdf?dl=1")).toBe(true)
    expect(matchesPattern("/*?", "/search?q=x")).toBe(true) // ? is a literal — only * and $ are special
    expect(matchesPattern("/*?", "/search")).toBe(false)
    expect(matchesPattern("/a**b", "/ab")).toBe(true) // consecutive stars collapse
    expect(matchesPattern("*", "/")).toBe(true)
    expect(matchesPattern("*$", "/x")).toBe(true)
  })

  it("$ anywhere but the end is a literal dollar sign", () => {
    expect(matchesPattern("/a$b", "/a$b")).toBe(true)
    expect(matchesPattern("/a$b", "/a")).toBe(false)
  })

  it("stays linear on the pattern that would send a regex exponential", () => {
    const pattern = "/*a*a*a*a*a*a*a*a*a*a*a*a*b"
    const path = "/" + "a".repeat(5000)
    const started = Date.now()
    expect(matchesPattern(pattern, path)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
//#endregion

//#region Percent-encoding (RFC 9309 §2.2.2)
describe("robots.txt — comparison form", () => {
  it("encodes non-ASCII on both sides, so a written path matches a requested one", () => {
    expect(allowed("User-agent: *\nDisallow: /café\n", "https://x.test/caf%C3%A9")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /caf%C3%A9\n", "https://x.test/café")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /caf%c3%a9\n", "https://x.test/café")).toBe(false) // hex case
    expect(allowed("User-agent: *\nDisallow: /a b\n", "https://x.test/a%20b")).toBe(false)
  })

  it("decodes escapes of UNRESERVED characters and nothing else", () => {
    expect(normalizeForMatch("/%7Euser/%41")).toBe("/~user/A")
    expect(normalizeForMatch("/a%2fb")).toBe("/a%2Fb") // reserved: kept, hex uppercased
    expect(allowed("User-agent: *\nDisallow: /%7Euser\n", "https://x.test/~user")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /a%2fb\n", "https://x.test/a%2Fb")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /a%2fb\n", "https://x.test/a/b")).toBe(true) // %2F is not a slash
    expect(normalizeForMatch("100%")).toBe("100%") // a bare % that escapes nothing is a literal
  })

  it("the query string is part of what is matched", () => {
    const text = "User-agent: *\nDisallow: /search?q=\n"
    expect(allowed(text, "https://x.test/search?q=anything")).toBe(false)
    expect(allowed(text, "https://x.test/search")).toBe(true)
  })

  it("an unparseable URL gets no verdict from robots.txt", () => {
    expect(policy("User-agent: *\nDisallow: /\n").check("not a url").allowed).toBe(true)
  })
})
//#endregion

//#region Tolerant parsing (RFC 9309 §2.2.4)
describe("robots.txt — parsing tolerance", () => {
  it("survives comments, CRLF, a BOM, mixed-case fields, and missing spaces", () => {
    const text =
      "\uFEFFuser-AGENT: *   # everyone\r\nDISALLOW:/a # trailing comment\r\n\r\nallow:  /a/b\r\n"
    expect(allowed(text, "https://x.test/a/x")).toBe(false)
    expect(allowed(text, "https://x.test/a/b")).toBe(true)
  })

  it("ignores lines that are not field: value, and unknown fields", () => {
    const text = "User-agent: *\nthis line has no colon\nHost: x.test\nFoo: bar\nDisallow: /a\n"
    expect(allowed(text, "https://x.test/a")).toBe(false)
    expect(parseRobotsTxt(text).groups).toHaveLength(1)
  })
})
//#endregion

//#region Fetch semantics (RFC 9309 §2.3.1)
describe("fetchRobotsPolicy — what the outcome of the fetch means", () => {
  let server: Server
  let base: string
  let mode:
    | "ok"
    | "specific"
    | "notfound"
    | "forbidden"
    | "gone"
    | "error"
    | "redirect"
    | "huge"
    | "no-location" = "ok"
  let seenAgent: string | undefined

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname
      if (path === "/robots.txt") seenAgent = req.headers["user-agent"]
      if (path === "/moved/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain" })
          .end("User-agent: *\nDisallow: /moved-rule\n")
        return
      }
      switch (mode) {
        case "ok":
          res
            .writeHead(200, { "content-type": "text/plain" })
            .end("User-agent: *\nDisallow: /private/\nCrawl-delay: 3\n")
          return
        case "specific":
          res
            .writeHead(200)
            .end("User-agent: *\nAllow: /\n\nUser-agent: InterrelatedBot\nDisallow: /secret\n")
          return
        case "notfound":
          res.writeHead(404).end("nope")
          return
        case "forbidden":
          res.writeHead(403).end("nope")
          return
        case "gone":
          res.writeHead(410).end("nope")
          return
        case "error":
          res.writeHead(503).end("down")
          return
        case "redirect":
          res.writeHead(301, { location: "/moved/robots.txt" }).end()
          return
        case "no-location":
          res.writeHead(302).end()
          return
        case "huge":
          res.writeHead(200, { "content-type": "text/plain" }).end("#".repeat(ROBOTS_MAX_BYTES + 1))
          return
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

  beforeEach(() => {
    seenAgent = undefined
  })

  const fetchOptions = { hostGuard: () => {} }

  it("2xx: parsed, and the request identified the crawler by its product token", async () => {
    mode = "ok"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    expect(p.source).toBe("robots.txt (HTTP 200)")
    expect(p.check(`${base}/private/x`).allowed).toBe(false)
    expect(p.check(`${base}/public/x`).allowed).toBe(true)
    expect(p.crawlDelaySeconds).toBe(3)
    expect(seenAgent).toMatch(new RegExp(`^${USER_AGENT_PRODUCT}/`))
  })

  it("selects the group for OUR token by default", async () => {
    mode = "specific"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    expect(p.check(`${base}/secret`).allowed).toBe(false)
    expect(p.check(`${base}/open`).allowed).toBe(true)
  })

  it("4xx: unavailable → everything allowed (§2.3.1.3)", async () => {
    for (const m of ["notfound", "forbidden", "gone"] as const) {
      mode = m
      const p = await fetchRobotsPolicy(base, fetchOptions)
      expect(p.check(`${base}/anything`).allowed).toBe(true)
      expect(p.source).toMatch(/^no robots\.txt \(HTTP 4\d\d\)$/)
    }
  })

  it("5xx: unreachable → NOTHING allowed, with the status in the reason (§2.3.1.4)", async () => {
    mode = "error"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    const verdict = p.check(`${base}/anything`)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("HTTP 503")
      expect(verdict.reason).toContain("RFC 9309")
    }
  })

  it("redirects are followed to the file that ends the chain (§2.3.1.2)", async () => {
    mode = "redirect"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    expect(p.check(`${base}/moved-rule/x`).allowed).toBe(false)
    expect(p.check(`${base}/elsewhere`).allowed).toBe(true)
  })

  it("a redirect with nowhere to go counts as no file", async () => {
    mode = "no-location"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    expect(p.check(`${base}/anything`).allowed).toBe(true)
  })

  it("a network failure is unreachable, not absent", async () => {
    // A port nobody listens on: the request never produces a status.
    const p = await fetchRobotsPolicy("http://127.0.0.1:9", { ...fetchOptions, timeoutMs: 2000 })
    const verdict = p.check("http://127.0.0.1:9/anything")
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toContain("unreachable")
  })

  it("a file over the parse cap is unreachable too, and says how big", async () => {
    mode = "huge"
    const p = await fetchRobotsPolicy(base, fetchOptions)
    const verdict = p.check(`${base}/anything`)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toContain("larger than 512 KiB")
  })
})
//#endregion
