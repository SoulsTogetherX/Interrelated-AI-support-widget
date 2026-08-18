//#region Imports
import { createServer } from "node:http"
import type { Server } from "node:http"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { crawl, CrawlError } from "@/ingest/crawler"
import type { CrawlEvent, CrawlSource } from "@/ingest/crawler"
//#endregion

//#region Fixture site
// A tiny documentation site with every scope hazard the crawler must handle:
// cross-origin links, binary assets, fragments, duplicate links, redirects,
// broken links, markdown served as text/plain, and a sitemap + index.
let server: Server
let base: string
let requested: string[] = []
/** Wall-clock of each request, for the Crawl-delay pacing assertions. */
let requestedAt: number[] = []
/** What /robots.txt answers: null → 404 (the fixture's default, and the
 *  common case for a small docs site), a body → 200 with it, a status → that
 *  status with an empty body. Set per test, reset in beforeEach. */
let robotsTxt: string | { status: number } | null = null

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`

const routes: Record<string, { type: string; body: string } | { redirect: string } | { status: number }> = {
  "/site/index.html": {
    type: "text/html",
    body: html(`
      <h1>Root</h1>
      <a href="/site/a.html">a</a>
      <a href="/site/a.html#section">a again via fragment</a>
      <a href="/site/b.md">b</a>
      <a href="/site/deep/c.html">c</a>
      <a href="/site/broken.html">broken</a>
      <a href="/site/redirect">redirected</a>
      <a href="/site/logo.png">logo</a>
      <a href="/site/manual.pdf">pdf manual</a>
      <a href="https://elsewhere.example/x">external</a>
      <a href="mailto:x@y.z">mail</a>`),
  },
  "/site/a.html": {
    type: "text/html",
    body: html(`<h1>A</h1><a href="/site/d.html">d — only reachable from a</a>`),
  },
  "/site/b.md": { type: "text/plain", body: "# B\n\nMarkdown page." },
  "/site/deep/c.html": { type: "text/html", body: html("<h1>C</h1>") },
  "/site/d.html": { type: "text/html", body: html("<h1>D</h1>") },
  "/site/redirect": { redirect: "/site/a.html" },
  "/site/broken.html": { status: 404 },
  "/sitemap.xml": {
    type: "application/xml",
    body: `<?xml version="1.0"?><urlset>
      <sitemap-placeholder/>
      <url><loc>__BASE__/site/a.html</loc></url>
      <url><loc> __BASE__/site/b.md </loc></url>
      <url><loc>__BASE__/site/broken.html</loc></url>
      <url><loc>https://elsewhere.example/foreign.html</loc></url>
    </urlset>`,
  },
  "/sitemapindex.xml": {
    type: "application/xml",
    body: `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>__BASE__/sitemap.xml</loc></sitemap>
      <sitemap><loc>__BASE__/missing-sitemap.xml</loc></sitemap>
    </sitemapindex>`,
  },
  // The robots.txt fixtures (M7.5): a root whose links cross into areas a
  // robots.txt may close, a redirect that lands in one, and a sitemap that
  // lists one — each the way a real docs site would present it.
  "/site/robots-root.html": {
    type: "text/html",
    body: html(`
      <h1>Robots root</h1>
      <a href="/site/a.html">a</a>
      <a href="/site/private/p.html">private</a>
      <a href="/site/drafts/d.html">draft</a>
      <a href="/site/to-secret">redirects into an area only the redirect reveals</a>`),
  },
  "/site/private/p.html": { type: "text/html", body: html("<h1>Private</h1>") },
  "/site/drafts/d.html": { type: "text/html", body: html("<h1>Draft</h1>") },
  // /site/secret/ is linked from nowhere directly — only a redirect lands
  // there, so a robots.txt closing it can only be honored on ARRIVAL.
  "/site/to-secret": { redirect: "/site/secret/s.html" },
  "/site/secret/s.html": { type: "text/html", body: html("<h1>Secret</h1>") },
  "/robots-sitemap.xml": {
    type: "application/xml",
    body: `<?xml version="1.0"?><urlset>
      <url><loc>__BASE__/site/a.html</loc></url>
      <url><loc>__BASE__/site/private/p.html</loc></url>
    </urlset>`,
  },
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname
    requested.push(path)
    requestedAt.push(Date.now())
    if (path === "/robots.txt") {
      if (robotsTxt === null) res.writeHead(404).end("no robots here")
      else if (typeof robotsTxt === "string") res.writeHead(200, { "content-type": "text/plain" }).end(robotsTxt)
      else res.writeHead(robotsTxt.status).end()
      return
    }
    const route = routes[path]
    if (!route) {
      res.writeHead(404).end("not found")
    } else if ("redirect" in route) {
      res.writeHead(302, { location: route.redirect }).end()
    } else if ("status" in route) {
      res.writeHead(route.status).end("error page")
    } else {
      res.writeHead(200, { "content-type": route.type }).end(route.body.replaceAll("__BASE__", base))
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
  requested = []
  requestedAt = []
  robotsTxt = null
})
//#endregion

//#region Helpers
const options = { fetchDelayMs: 0, fetchOptions: { hostGuard: () => {} } }

async function run(source: Partial<CrawlSource> & { location: string }, extra: Record<string, unknown> = {}) {
  const events: CrawlEvent[] = []
  for await (const event of crawl(
    { kind: "url", crawlDepth: 1, ...source },
    { ...options, ...extra },
  )) events.push(event)
  return {
    events,
    pages: events.flatMap((e) => (e.kind === "page" ? [e.url] : [])),
    errors: events.flatMap((e) => (e.kind === "error" ? [e] : [])),
    skipped: events.flatMap((e) => (e.kind === "skipped" ? [e] : [])),
  }
}
//#endregion

//#region BFS crawling
describe("crawl (url kind)", () => {
  it("yields only the root at depth 0", async () => {
    const { pages } = await run({ location: `${base}/site/index.html`, crawlDepth: 0 })
    expect(pages).toEqual([`${base}/site/index.html`])
  })

  it("follows same-origin links to the configured depth", async () => {
    const depth1 = await run({ location: `${base}/site/index.html`, crawlDepth: 1 })
    expect(depth1.pages.sort()).toEqual([
      `${base}/site/a.html`, `${base}/site/b.md`, `${base}/site/deep/c.html`, `${base}/site/index.html`,
    ])
    // d.html is only linked FROM a.html — depth 2 territory.
    const depth2 = await run({ location: `${base}/site/index.html`, crawlDepth: 2 })
    expect(depth2.pages).toContain(`${base}/site/d.html`)
  })

  it("parses each page (markdown served as text/plain included)", async () => {
    const { events } = await run({ location: `${base}/site/index.html` })
    const md = events.find((e) => e.kind === "page" && e.url.endsWith("/b.md"))
    expect(md?.kind === "page" && md.doc.blocks.some((b) => b.kind === "heading" && b.text === "B")).toBe(true)
  })

  it("dedupes fragment variants and redirect targets", async () => {
    const { pages } = await run({ location: `${base}/site/index.html` })
    // a.html is linked plainly, via #fragment, and via /site/redirect —
    // one yield under its final identity.
    expect(pages.filter((u) => u.endsWith("/a.html"))).toHaveLength(1)
  })

  it("never fetches cross-origin links, binary assets, or PDFs", async () => {
    await run({ location: `${base}/site/index.html` })
    expect(requested).not.toContain("/site/logo.png")
    expect(requested).not.toContain("/site/manual.pdf") // unsupported until M3 uploads
    expect(requested.every((p) => !p.includes("elsewhere"))).toBe(true)
  })

  it("reports broken links as error events and keeps crawling", async () => {
    const { errors, pages } = await run({ location: `${base}/site/index.html` })
    expect(errors).toEqual([{ kind: "error", url: `${base}/site/broken.html`, message: "HTTP 404" }])
    expect(pages.length).toBeGreaterThan(1) // the failure aborted nothing
  })

  it("stops at maxPages", async () => {
    const { pages } = await run({ location: `${base}/site/index.html` }, { maxPages: 2 })
    expect(pages).toHaveLength(2)
  })

  it("throws CrawlError when the root itself is unfetchable", async () => {
    await expect(run({ location: `${base}/site/broken.html` })).rejects.toThrow(CrawlError)
    await expect(run({ location: "not a url at all" })).rejects.toThrow(CrawlError)
  })
})
//#endregion

//#region Sitemap crawling
describe("crawl (sitemap kind)", () => {
  it("announces a plan, fetches exactly the same-origin locs, reports failures", async () => {
    const { events, pages, errors } = await run({ kind: "sitemap", location: `${base}/sitemap.xml` })
    // Plan counts fetchABLE urls (foreign loc excluded); broken.html is in
    // the plan — its failure is discovered by fetching, not planning.
    expect(events[0]).toEqual({ kind: "plan", total: 3 })
    expect(pages.sort()).toEqual([`${base}/site/a.html`, `${base}/site/b.md`])
    expect(errors).toEqual([{ kind: "error", url: `${base}/site/broken.html`, message: "HTTP 404" }])
    expect(requested).not.toContain("/foreign.html")
    // Sitemaps enumerate; they do not license link-walking — d.html is
    // linked from a.html but must not be fetched.
    expect(requested).not.toContain("/site/d.html")
  })

  it("resolves one level of sitemapindex nesting, tolerating dead children", async () => {
    const { pages, errors } = await run({ kind: "sitemap", location: `${base}/sitemapindex.xml` })
    expect(pages.sort()).toEqual([`${base}/site/a.html`, `${base}/site/b.md`])
    expect(errors.some((e) => e.url.endsWith("/missing-sitemap.xml"))).toBe(true)
  })

  it("throws CrawlError when the sitemap itself is unfetchable", async () => {
    await expect(run({ kind: "sitemap", location: `${base}/missing-sitemap.xml` })).rejects.toThrow(CrawlError)
  })
})
//#endregion

//#region robots.txt (M7.5)
describe("crawl honors robots.txt", () => {
  const robotsRoot = () => `${base}/site/robots-root.html`

  it("reads robots.txt once, FIRST, and skips disallowed links without spending a fetch", async () => {
    robotsTxt = "User-agent: *\nDisallow: /site/private/\n"
    const { pages, skipped } = await run({ location: robotsRoot() })
    expect(requested[0]).toBe("/robots.txt")
    expect(requested.filter((p) => p === "/robots.txt")).toHaveLength(1)
    // The private link is reported, once, with the rule — and never requested.
    expect(skipped).toContainEqual({
      kind: "skipped",
      url: `${base}/site/private/p.html`,
      reason: "disallowed by robots.txt (User-agent: *, Disallow: /site/private/)",
    })
    expect(skipped.filter((s) => s.url.endsWith("/private/p.html"))).toHaveLength(1)
    expect(requested).not.toContain("/site/private/p.html")
    // Everything else crawled as before — the redirect's target included,
    // since nothing closes /site/secret/ here.
    expect(pages).toContain(robotsRoot())
    expect(pages).toContain(`${base}/site/a.html`)
    expect(pages).toContain(`${base}/site/drafts/d.html`)
    expect(pages).toContain(`${base}/site/secret/s.html`)
    expect(pages).not.toContain(`${base}/site/private/p.html`)
  })

  it("no robots.txt (404) means everything is crawlable", async () => {
    const { pages, skipped } = await run({ location: robotsRoot() })
    expect(pages).toContain(`${base}/site/private/p.html`)
    expect(pages).toContain(`${base}/site/drafts/d.html`)
    expect(pages).toContain(`${base}/site/secret/s.html`)
    expect(skipped).toEqual([])
  })

  it("a group naming InterrelatedBot wins over the wildcard", async () => {
    robotsTxt = "User-agent: *\nDisallow: /\n\nUser-agent: InterrelatedBot\nDisallow: /site/drafts/\n"
    const { pages, skipped } = await run({ location: robotsRoot() })
    expect(pages).toContain(`${base}/site/private/p.html`) // the wildcard's Disallow: / does not bind us
    expect(skipped.map((s) => s.url)).toEqual([`${base}/site/drafts/d.html`])
    expect(skipped[0]?.reason).toBe("disallowed by robots.txt (User-agent: InterrelatedBot, Disallow: /site/drafts/)")
  })

  it("a redirect that lands on a disallowed page is not ingested", async () => {
    robotsTxt = "User-agent: *\nDisallow: /site/secret/\n"
    const { pages, skipped } = await run({ location: robotsRoot() })
    // /site/to-secret is allowed, so it is fetched; it answers with the
    // secret page, which is refused on ARRIVAL — the fetch was spent, the
    // content is not kept, and the skip is reported under the URL that
    // actually answered.
    expect(requested).toContain("/site/to-secret")
    expect(requested).toContain("/site/secret/s.html")
    expect(pages).not.toContain(`${base}/site/secret/s.html`)
    expect(skipped).toContainEqual({
      kind: "skipped",
      url: `${base}/site/secret/s.html`,
      reason: "disallowed by robots.txt (User-agent: *, Disallow: /site/secret/)",
    })
  })

  it("a disallowed root is a source failure that names the rule, before any page is fetched", async () => {
    robotsTxt = "User-agent: *\nDisallow: /\n"
    await expect(run({ location: robotsRoot() })).rejects.toThrow(
      "nothing crawlable — disallowed by robots.txt (User-agent: *, Disallow: /)",
    )
    expect(requested).toEqual(["/robots.txt"])
  })

  it("an unreachable robots.txt (5xx) refuses the crawl, saying why (RFC 9309 §2.3.1.4)", async () => {
    robotsTxt = { status: 503 }
    const failure = run({ location: robotsRoot() })
    await expect(failure).rejects.toThrow(CrawlError)
    await expect(failure).rejects.toThrow(/HTTP 503.*RFC 9309/)
    expect(requested).toEqual(["/robots.txt"])
  })

  it("sitemap entries robots.txt disallows are skipped and left out of the plan", async () => {
    robotsTxt = "User-agent: *\nDisallow: /site/private/\n"
    const { events, pages, skipped } = await run({ kind: "sitemap", location: `${base}/robots-sitemap.xml` })
    expect(skipped.map((s) => s.url)).toEqual([`${base}/site/private/p.html`])
    // The skip is announced BEFORE the plan, and the plan counts only what
    // will be fetched — the progress bar never waits for a page that is not
    // coming.
    const planAt = events.findIndex((e) => e.kind === "plan")
    const skipAt = events.findIndex((e) => e.kind === "skipped")
    expect(skipAt).toBeLessThan(planAt)
    expect(events[planAt]).toEqual({ kind: "plan", total: 1 })
    expect(pages).toEqual([`${base}/site/a.html`])
    expect(requested).not.toContain("/site/private/p.html")
  })

  it("a sitemap the robots.txt disallows is nothing crawlable", async () => {
    robotsTxt = "User-agent: *\nDisallow: /robots-sitemap.xml\n"
    await expect(run({ kind: "sitemap", location: `${base}/robots-sitemap.xml` })).rejects.toThrow(/nothing crawlable/)
    expect(requested).toEqual(["/robots.txt"])
  })

  it("honors Crawl-delay between requests, up to the cap", async () => {
    // a.html links only to d.html (no redirects — a redirect's hops are one
    // logical request inside safeFetch and are not paced): robots.txt, a, d
    // at 0.3 s each, so both gaps must be ≥ ~300 ms.
    robotsTxt = "User-agent: *\nCrawl-delay: 0.3\n"
    await run({ location: `${base}/site/a.html` })
    let gaps = requestedAt.slice(1).map((t, i) => t - (requestedAt[i] as number))
    expect(requested).toEqual(["/robots.txt", "/site/a.html", "/site/d.html"])
    expect(gaps.every((g) => g >= 250)).toBe(true)

    // Capped: a site asking for 100 s per request gets the cap, not the wish
    // — the same crawl completes in well under a second per page.
    robotsTxt = "User-agent: *\nCrawl-delay: 100\n"
    requested = []
    requestedAt = []
    const started = Date.now()
    const { pages } = await run({ location: `${base}/site/a.html` }, { maxCrawlDelayMs: 200 })
    gaps = requestedAt.slice(1).map((t, i) => t - (requestedAt[i] as number))
    expect(pages).toHaveLength(2)
    expect(gaps).toHaveLength(2)
    expect(gaps.every((g) => g >= 150)).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
//#endregion
