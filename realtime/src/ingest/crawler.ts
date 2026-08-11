//#region Imports
import { parseResource } from "@/ingest/parsers/index"
import type { ParsedDocument } from "@/ingest/parsers/types"
import { safeFetch } from "@/ingest/safeFetch"
import type { SafeFetchOptions } from "@/ingest/safeFetch"
//#endregion

//#region Type Defs
/**
 * The crawler: turns a source (a start URL or a sitemap) into a stream of
 * parsed pages. It is an async GENERATOR rather than a collect-and-return
 * because a crawl is minutes of network time — the worker persists each page
 * as it arrives, updates job progress, and can stop between pages, none of
 * which work if the crawl is an opaque awaited array. Memory stays bounded
 * by one page, not one site.
 *
 * Scope rules, all enforced here rather than trusted to callers:
 *   - SAME-ORIGIN ONLY, judged against the source's origin — including the
 *     FINAL URL after redirects, so an on-origin link that redirects off
 *     origin is skipped, not ingested.
 *   - Every fetch goes through safeFetch (the SSRF guard); the crawler never
 *     touches the network directly.
 *   - Bounded: maxPages cap, per-fetch delay (politeness — one small site
 *     should not experience us as a burst), crawl_depth from the source row
 *     (schema-capped at 3).
 *
 * Failure policy: the ROOT failing is a source failure (thrown — nothing was
 * crawlable); any later page failing is an `error` EVENT and the crawl
 * continues, because one broken link must not abort a 100-page ingest.
 *
 * Deliberately not implemented yet, stated honestly: robots.txt (the cap and
 * delay bound our footprint; robots support belongs with the M3 dashboard
 * where a customer can see WHY a page was skipped) and off-origin crawling
 * (never — that is scope, not a missing feature).
 */
interface CrawlSource {
  kind: "url" | "sitemap"
  location: string
  /** Link-following depth for kind "url" (0 = just the page). Ignored for
   *  sitemaps, which enumerate their pages explicitly. */
  crawlDepth: number
}

type CrawlEvent =
  /** Emitted once, before any page, when the total is knowable up front
   *  (sitemaps). BFS crawls never emit it — the frontier is discovered. */
  | { kind: "plan"; total: number }
  | { kind: "page"; url: string; doc: ParsedDocument }
  | { kind: "error"; url: string; message: string }

interface CrawlerOptions {
  maxPages?: number
  fetchDelayMs?: number
  /** Threaded through to safeFetch — tests use it to point the crawler at a
   *  loopback fixture server via a permissive hostGuard. */
  fetchOptions?: SafeFetchOptions
}

/** A source so broken nothing could be crawled (invalid location, root
 *  unfetchable). The worker maps this to sources.status = 'failed'. */
class CrawlError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "CrawlError"
  }
}
//#endregion

//#region Constants
const DEFAULT_MAX_PAGES = 100
const DEFAULT_FETCH_DELAY_MS = 150
const MAX_CHILD_SITEMAPS = 10

/** Never-fetch extensions: assets and formats no parser handles — including
 *  .pdf until uploads land in M3 (see parsers/index.ts). A miss here is
 *  cheap (the fetch happens and the parser layer skips or degrades) — this
 *  filter exists to not SPEND fetches, not as a correctness gate. */
const SKIP_EXTENSIONS =
  /\.(pdf|png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|json|ya?ml|xml|rss|atom|zip|tar|gz|tgz|mp[34]|webm|wav|woff2?|ttf|eot|otf|exe|dmg|wasm)$/i
//#endregion

//#region Helpers
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves + normalizes to a fetchable identity: http(s) only, fragment
 *  dropped (a fragment names a position, not a resource — keeping it would
 *  make /page and /page#top two "documents"). Query strings survive: docs
 *  sites genuinely vary content on them. */
function normalizeUrl(input: string, base?: string): string | null {
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  url.hash = ""
  return url.href
}

/** Minimal XML entity decoding for sitemap <loc> values — the five
 *  predefined XML entities are the only ones a conformant sitemap can use. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&amp;/g, "&") // last, so "&amp;lt;" decodes to "&lt;" not "<"
}

/** Pulls <loc> values out of sitemap XML. A regex, deliberately: sitemaps
 *  are machine-generated, schema-fixed XML where <loc> cannot nest or carry
 *  attributes — the pathological inputs that make "regex over XML" a trap
 *  cannot occur without violating the sitemap schema first. */
function extractLocs(xml: string): string[] {
  const locs: string[] = []
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    locs.push(decodeXmlEntities(match[1] as string))
  }
  return locs
}
//#endregion

//#region Crawl
async function* crawl(source: CrawlSource, options: CrawlerOptions = {}): AsyncGenerator<CrawlEvent> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const fetchDelayMs = options.fetchDelayMs ?? DEFAULT_FETCH_DELAY_MS
  const fetchOptions = options.fetchOptions ?? {}

  const root = normalizeUrl(source.location)
  if (root === null) throw new CrawlError(`source location is not a crawlable URL: ${source.location}`)
  const origin = new URL(root).origin

  //#region Shared page-fetch machinery
  // Dedupe is by REQUESTED and FINAL URL both: two links that redirect to
  // the same page yield it once, under its final identity.
  const visited = new Set<string>()
  let fetchedAny = false

  type PageResult =
    | { ok: true; url: string; doc: ParsedDocument }
    | { ok: false; url: string; message: string }
    | { ok: false; url: string; message: null } // duplicate after redirect: not an error, just nothing

  const fetchPage = async (url: string): Promise<PageResult> => {
    if (fetchedAny && fetchDelayMs > 0) await sleep(fetchDelayMs)
    let res
    try {
      res = await safeFetch(url, fetchOptions)
    } catch (err) {
      return { ok: false, url, message: err instanceof Error ? err.message : String(err) }
    } finally {
      fetchedAny = true
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, url, message: `HTTP ${res.status}` }
    }
    const finalUrl = normalizeUrl(res.finalUrl) ?? url
    if (finalUrl !== url) {
      if (visited.has(finalUrl)) return { ok: false, url, message: null }
      visited.add(finalUrl)
    }
    if (new URL(finalUrl).origin !== origin) {
      return { ok: false, url, message: `redirected off-origin to ${finalUrl}` }
    }
    try {
      const doc = await parseResource({ url: finalUrl, contentType: res.contentType, charset: res.charset, body: res.body })
      return { ok: true, url: finalUrl, doc }
    } catch (err) {
      return { ok: false, url: finalUrl, message: `unparseable: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  //#endregion

  if (source.kind === "sitemap") {
    yield* crawlSitemap(root, origin, maxPages, visited, fetchPage, fetchOptions)
  } else {
    yield* crawlBfs(root, origin, source.crawlDepth, maxPages, visited, fetchPage)
  }
}

/** Breadth-first over same-origin links. BFS (not DFS) so depth means "link
 *  distance from the root" — the intuitive meaning of a crawl_depth knob. */
async function* crawlBfs(
  root: string,
  origin: string,
  crawlDepth: number,
  maxPages: number,
  visited: Set<string>,
  fetchPage: (url: string) => Promise<{ ok: true; url: string; doc: ParsedDocument } | { ok: false; url: string; message: string | null }>,
): AsyncGenerator<CrawlEvent> {
  const queue: Array<{ url: string; depth: number }> = [{ url: root, depth: 0 }]
  visited.add(root)
  let yielded = 0

  while (queue.length > 0 && yielded < maxPages) {
    const { url, depth } = queue.shift() as { url: string; depth: number }
    const result = await fetchPage(url)
    if (!result.ok) {
      // A dead ROOT means nothing was crawlable — that is a source failure,
      // not a page error. Anything later is one broken link among many.
      if (url === root && yielded === 0) throw new CrawlError(`root fetch failed: ${result.message ?? "duplicate"}`)
      if (result.message !== null) yield { kind: "error", url: result.url, message: result.message }
      continue
    }
    yield { kind: "page", url: result.url, doc: result.doc }
    yielded++

    if (depth >= crawlDepth) continue
    for (const href of result.doc.links) {
      const next = normalizeUrl(href, result.url)
      if (next === null || visited.has(next)) continue
      const nextUrl = new URL(next)
      if (nextUrl.origin !== origin) continue
      if (SKIP_EXTENSIONS.test(nextUrl.pathname)) continue
      visited.add(next)
      queue.push({ url: next, depth: depth + 1 })
    }
  }
}

/** Sitemap mode: the site tells us its pages; we fetch exactly those (still
 *  same-origin — a sitemap listing foreign URLs is out of scope by the same
 *  rule as everywhere else). One level of sitemapindex nesting is supported,
 *  because index files are how every generator ships large sites. */
async function* crawlSitemap(
  root: string,
  origin: string,
  maxPages: number,
  visited: Set<string>,
  fetchPage: (url: string) => Promise<{ ok: true; url: string; doc: ParsedDocument } | { ok: false; url: string; message: string | null }>,
  fetchOptions: SafeFetchOptions,
): AsyncGenerator<CrawlEvent> {
  const fetchXml = async (url: string): Promise<string> => {
    const res = await safeFetch(url, fetchOptions)
    if (res.status < 200 || res.status >= 300) throw new CrawlError(`sitemap fetch failed: HTTP ${res.status} for ${url}`)
    return res.body.toString("utf8")
  }

  let rootXml: string
  try {
    rootXml = await fetchXml(root)
  } catch (err) {
    throw err instanceof CrawlError ? err : new CrawlError(`sitemap fetch failed for ${root}`, err)
  }

  const pageUrls: string[] = []
  const collectLocs = (xml: string): void => {
    for (const loc of extractLocs(xml)) {
      const url = normalizeUrl(loc)
      if (url === null || visited.has(url)) continue
      if (new URL(url).origin !== origin) continue
      visited.add(url)
      pageUrls.push(url)
    }
  }

  if (/<sitemapindex[\s>]/i.test(rootXml)) {
    const children = extractLocs(rootXml)
      .map((loc) => normalizeUrl(loc))
      .filter((url): url is string => url !== null && new URL(url).origin === origin)
      .slice(0, MAX_CHILD_SITEMAPS)
    for (const child of children) {
      try {
        collectLocs(await fetchXml(child))
      } catch (err) {
        yield { kind: "error", url: child, message: err instanceof Error ? err.message : String(err) }
      }
    }
  } else {
    collectLocs(rootXml)
  }

  const plan = pageUrls.slice(0, maxPages)
  yield { kind: "plan", total: plan.length }
  for (const url of plan) {
    const result = await fetchPage(url)
    if (!result.ok) {
      if (result.message !== null) yield { kind: "error", url: result.url, message: result.message }
      continue
    }
    yield { kind: "page", url: result.url, doc: result.doc }
  }
}
//#endregion

//#region Exports
export { crawl, CrawlError, normalizeUrl }
export type { CrawlSource, CrawlEvent, CrawlerOptions }
//#endregion
