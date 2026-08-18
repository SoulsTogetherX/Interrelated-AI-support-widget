//#region Imports
import { parseResource } from "@/ingest/parsers/index"
import type { ParsedDocument } from "@/ingest/parsers/types"
import { fetchRobotsPolicy } from "@/ingest/robots"
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
 * robots.txt (M7.5, ingest/robots.ts) is honored on every fetch but its own:
 * same-origin scope means ONE file governs a whole crawl, so it is read once,
 * first, and every URL — the root, each discovered link, each sitemap entry,
 * each child sitemap, and the FINAL URL of a redirect — is checked against
 * it. A disallowed root is a source failure whose text names the rule; a
 * disallowed link or entry is a `skipped` EVENT the worker records for the
 * dashboard, so a tenant sees WHY a page is missing instead of inferring it
 * from a count. Its Crawl-delay is honored up to a cap (below). What the
 * crawler still never does, and that is scope rather than a missing feature:
 * off-origin crawling.
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
  /** A page that could not be fetched or parsed — one broken link. */
  | { kind: "error"; url: string; message: string }
  /** A page deliberately NOT fetched, and why — today always robots.txt.
   *  A separate kind from `error` because it is not a failure of anything:
   *  the site asked, and the crawler listened. Both land in the same
   *  per-job list the dashboard shows (worker.ts). */
  | { kind: "skipped"; url: string; reason: string }

interface CrawlerOptions {
  maxPages?: number
  fetchDelayMs?: number
  /** Ceiling on the Crawl-delay honored from robots.txt (see the constant). */
  maxCrawlDelayMs?: number
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
/** How much of a robots.txt Crawl-delay is honored. The directive is not in
 *  RFC 9309 (Google ignores it; most other crawlers honor it, usually
 *  capped) and a site may write "Crawl-delay: 3600" — taken literally, a
 *  100-page crawl would run for four days. Five seconds honors every
 *  common value (1–5) exactly and clamps the rest; at the cap a full crawl
 *  is ~8 minutes, which is why the worker renews its lease per page
 *  (worker.ts) — a slow-but-polite crawl must not read as a crashed one. */
const DEFAULT_MAX_CRAWL_DELAY_MS = 5_000
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
/** The machinery both crawl modes share, built once per crawl (below). */
interface CrawlContext {
  origin: string
  visited: Set<string>
  /** null when the URL may be fetched, otherwise the reason it may not —
   *  robots.txt's verdict, worded for the dashboard. */
  refusal: (url: string) => string | null
  fetchPage: (url: string) => Promise<PageResult>
  /** Politeness: waits the effective delay if anything has been fetched
   *  yet, and marks that something now has. Every request goes through it. */
  pace: () => Promise<void>
}

/** What a page that was not ingested has to say for itself. */
type PageIssue = Extract<CrawlEvent, { kind: "error" | "skipped" }>

type PageResult =
  | { ok: true; url: string; doc: ParsedDocument }
  /** Not ingested; `event` is what to report — an error (broken link) or a
   *  skip (robots.txt refused the FINAL url of a redirect) — or null for a
   *  duplicate after redirect, which is not news to anyone. */
  | { ok: false; url: string; event: PageIssue | null }

async function* crawl(source: CrawlSource, options: CrawlerOptions = {}): AsyncGenerator<CrawlEvent> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const fetchDelayMs = options.fetchDelayMs ?? DEFAULT_FETCH_DELAY_MS
  const maxCrawlDelayMs = options.maxCrawlDelayMs ?? DEFAULT_MAX_CRAWL_DELAY_MS
  const fetchOptions = options.fetchOptions ?? {}

  const root = normalizeUrl(source.location)
  if (root === null) throw new CrawlError(`source location is not a crawlable URL: ${source.location}`)
  const origin = new URL(root).origin

  // robots.txt FIRST — before the root, before anything. One file per crawl
  // (same-origin scope), read through the same guarded client as every page.
  // Its own fetch is the one request robots.txt does not govern. Whatever it
  // asks in Crawl-delay is honored up to the cap, and never below the
  // crawler's own politeness delay.
  const robots = await fetchRobotsPolicy(origin, fetchOptions)
  const delayMs = Math.max(fetchDelayMs, Math.min((robots.crawlDelaySeconds ?? 0) * 1000, maxCrawlDelayMs))

  //#region Shared page-fetch machinery
  // Dedupe is by REQUESTED and FINAL URL both: two links that redirect to
  // the same page yield it once, under its final identity.
  const visited = new Set<string>()
  let fetchedAny = true // the robots.txt request counts: the root waits its turn too

  const pace = async (): Promise<void> => {
    if (fetchedAny && delayMs > 0) await sleep(delayMs)
    fetchedAny = true
  }

  const refusal = (url: string): string | null => {
    const verdict = robots.check(url)
    return verdict.allowed ? null : verdict.reason
  }

  const fetchPage = async (url: string): Promise<PageResult> => {
    await pace()
    let res
    try {
      res = await safeFetch(url, fetchOptions)
    } catch (err) {
      return { ok: false, url, event: { kind: "error", url, message: err instanceof Error ? err.message : String(err) } }
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, url, event: { kind: "error", url, message: `HTTP ${res.status}` } }
    }
    const finalUrl = normalizeUrl(res.finalUrl) ?? url
    if (finalUrl !== url) {
      if (visited.has(finalUrl)) return { ok: false, url, event: null }
      visited.add(finalUrl)
    }
    if (new URL(finalUrl).origin !== origin) {
      return { ok: false, url, event: { kind: "error", url, message: `redirected off-origin to ${finalUrl}` } }
    }
    // A redirect lands somewhere the discovery check never saw. The fetch
    // was spent (safeFetch follows hops internally), but the content is
    // still not ingested: robots.txt speaks about the URL that answered.
    const refused = finalUrl !== url ? refusal(finalUrl) : null
    if (refused !== null) {
      return { ok: false, url: finalUrl, event: { kind: "skipped", url: finalUrl, reason: refused } }
    }
    try {
      const doc = await parseResource({ url: finalUrl, contentType: res.contentType, charset: res.charset, body: res.body })
      return { ok: true, url: finalUrl, doc }
    } catch (err) {
      const message = `unparseable: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, url: finalUrl, event: { kind: "error", url: finalUrl, message } }
    }
  }
  //#endregion

  const ctx: CrawlContext = { origin, visited, refusal, fetchPage, pace }
  if (source.kind === "sitemap") {
    yield* crawlSitemap(root, maxPages, ctx, fetchOptions)
  } else {
    yield* crawlBfs(root, source.crawlDepth, maxPages, ctx)
  }
}

/** The root could not be ingested: nothing was crawlable, which is a SOURCE
 *  failure. Worded from the event, so a robots.txt refusal reads as one. */
function rootFailure(result: Extract<PageResult, { ok: false }>): CrawlError {
  const event = result.event
  if (event === null) return new CrawlError("root fetch failed: duplicate")
  if (event.kind === "skipped") return new CrawlError(`nothing crawlable — ${event.reason}`)
  return new CrawlError(`root fetch failed: ${event.message}`)
}

/** Breadth-first over same-origin links. BFS (not DFS) so depth means "link
 *  distance from the root" — the intuitive meaning of a crawl_depth knob. */
async function* crawlBfs(
  root: string,
  crawlDepth: number,
  maxPages: number,
  ctx: CrawlContext,
): AsyncGenerator<CrawlEvent> {
  const { origin, visited, refusal, fetchPage } = ctx

  // A root robots.txt refuses is a source failure before a single page is
  // spent — the tenant sees the rule, not a crawl of zero pages that "worked".
  const rootRefusal = refusal(root)
  if (rootRefusal !== null) throw new CrawlError(`nothing crawlable — ${rootRefusal}`)

  const queue: Array<{ url: string; depth: number }> = [{ url: root, depth: 0 }]
  visited.add(root)
  let yielded = 0

  while (queue.length > 0 && yielded < maxPages) {
    const { url, depth } = queue.shift() as { url: string; depth: number }
    const result = await fetchPage(url)
    if (!result.ok) {
      // A dead ROOT means nothing was crawlable — that is a source failure,
      // not a page error. Anything later is one broken link among many.
      if (url === root && yielded === 0) throw rootFailure(result)
      if (result.event !== null) yield result.event
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
      // robots.txt is consulted at DISCOVERY, so a disallowed link costs no
      // fetch and no queue slot — and is reported exactly once, here.
      const refused = refusal(next)
      if (refused !== null) {
        yield { kind: "skipped", url: next, reason: refused }
        continue
      }
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
  maxPages: number,
  ctx: CrawlContext,
  fetchOptions: SafeFetchOptions,
): AsyncGenerator<CrawlEvent> {
  const { origin, visited, refusal, fetchPage, pace } = ctx

  const fetchXml = async (url: string): Promise<string> => {
    await pace()
    const res = await safeFetch(url, fetchOptions)
    if (res.status < 200 || res.status >= 300) throw new CrawlError(`sitemap fetch failed: HTTP ${res.status} for ${url}`)
    return res.body.toString("utf8")
  }

  // The sitemap file is a fetch like any other: a site whose robots.txt
  // disallows it has said, however oddly, that it is not for crawlers.
  const rootRefusal = refusal(root)
  if (rootRefusal !== null) throw new CrawlError(`nothing crawlable — ${rootRefusal}`)

  let rootXml: string
  try {
    rootXml = await fetchXml(root)
  } catch (err) {
    throw err instanceof CrawlError ? err : new CrawlError(`sitemap fetch failed for ${root}`, err)
  }

  const pageUrls: string[] = []
  const skipped: CrawlEvent[] = []
  const collectLocs = (xml: string): void => {
    for (const loc of extractLocs(xml)) {
      const url = normalizeUrl(loc)
      if (url === null || visited.has(url)) continue
      if (new URL(url).origin !== origin) continue
      visited.add(url)
      // Refused entries are reported and left out of the PLAN, so the
      // progress the dashboard shows counts only pages that will be fetched.
      const refused = refusal(url)
      if (refused !== null) {
        skipped.push({ kind: "skipped", url, reason: refused })
        continue
      }
      pageUrls.push(url)
    }
  }

  if (/<sitemapindex[\s>]/i.test(rootXml)) {
    const children = extractLocs(rootXml)
      .map((loc) => normalizeUrl(loc))
      .filter((url): url is string => url !== null && new URL(url).origin === origin)
      .slice(0, MAX_CHILD_SITEMAPS)
    for (const child of children) {
      const refused = refusal(child)
      if (refused !== null) {
        yield { kind: "skipped", url: child, reason: refused }
        continue
      }
      try {
        collectLocs(await fetchXml(child))
      } catch (err) {
        yield { kind: "error", url: child, message: err instanceof Error ? err.message : String(err) }
      }
    }
  } else {
    collectLocs(rootXml)
  }

  for (const event of skipped) yield event
  const plan = pageUrls.slice(0, maxPages)
  yield { kind: "plan", total: plan.length }
  for (const url of plan) {
    const result = await fetchPage(url)
    if (!result.ok) {
      if (result.event !== null) yield result.event
      continue
    }
    yield { kind: "page", url: result.url, doc: result.doc }
  }
}
//#endregion

//#region Exports
export { crawl, CrawlError, normalizeUrl }
export type { CrawlSource, CrawlEvent, CrawlerOptions, PageIssue }
//#endregion
