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
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname
    requested.push(path)
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
