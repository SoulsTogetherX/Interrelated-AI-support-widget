//#region Imports
import { safeFetch, SafeFetchError, USER_AGENT_PRODUCT } from "@/ingest/safeFetch"
import type { SafeFetchOptions } from "@/ingest/safeFetch"
//#endregion

//#region Type Defs
/**
 * robots.txt — the Robots Exclusion Protocol (RFC 9309), parsed and applied.
 *
 * A source is any PUBLIC URL a tenant types, not necessarily their own site
 * (the demo corpus is fastify.dev's documentation), so honoring robots.txt is
 * not a courtesy the product may skip: it is what separates a crawler from a
 * scraper. The crawler fetches one robots.txt per crawl — same-origin scope
 * means exactly one file governs every fetch of a job — and asks this module
 * two questions: may I fetch this URL, and how fast.
 *
 * Hand-written rather than a dependency, for RRF's reason (§2.4.3): the whole
 * protocol is a few pages of RFC and the interesting decisions — how a group
 * is chosen, how a tie between Allow and Disallow resolves, what an
 * unreachable file means — are exactly the ones worth being able to point at
 * in code. Every one of them below cites the section it implements.
 *
 * What the parser does NOT do, and says so: it ignores `Sitemap:` lines (a
 * "url" source follows links, a "sitemap" source names its own file), and it
 * treats `Crawl-delay` — not part of the RFC, honored by most crawlers other
 * than Google — as a request the CRAWLER decides how much of to honor; this
 * file only reports it. There is no cache across crawls: a robots.txt is
 * re-read on every job, which is rarer than the 24 hours the RFC allows a
 * cached copy to live.
 */
interface RobotsRule {
  allow: boolean
  /** The path pattern as written in the file (trimmed) — quoted back to the
   *  tenant in a skip reason, so it must read the way the site wrote it. */
  pattern: string
  /** The pattern in comparison form (§2.2.2's percent-encoding rules). */
  normalized: string
}

interface RobotsGroup {
  /** Product tokens this group's user-agent lines name, lowercased; "*" is
   *  the wildcard group. A run of consecutive user-agent lines is one group. */
  agents: string[]
  rules: RobotsRule[]
  /** Seconds between fetches the group asked for, if any. */
  crawlDelaySeconds: number | null
}

interface RobotsFile {
  groups: RobotsGroup[]
}

type RobotsVerdict =
  | { allowed: true }
  /** `reason` is a self-contained clause the crawler passes on verbatim and
   *  the dashboard shows: "disallowed by robots.txt (User-agent: *,
   *  Disallow: /private/)" names the rule that decided it; for a file that
   *  could not be read, it says so and why nothing may be fetched. */
  | { allowed: false; reason: string }

interface RobotsPolicy {
  /** Where the policy came from, in one clause: "robots.txt (HTTP 200)",
   *  "no robots.txt (HTTP 404)", "robots.txt unreachable (HTTP 503)". */
  readonly source: string
  /** The matched group's Crawl-delay in seconds, or null. Reported, never
   *  applied here — the crawler caps and honors it (crawler.ts). */
  readonly crawlDelaySeconds: number | null
  check(url: string | URL): RobotsVerdict
}
//#endregion

//#region Constants
/** RFC 9309 §2.4: a crawler MUST parse at least 500 KiB. Past this cap the
 *  fetch is refused as too large and the file counts as UNREACHABLE (below)
 *  — fail-closed, and a size no real robots.txt approaches. */
const ROBOTS_MAX_BYTES = 512 * 1024
const WILDCARD_AGENT = "*"
//#endregion

//#region Parsing
/** RFC 9309 §2.2.1: a product token is letters, `_` and `-`. The value on a
 *  user-agent line is matched by that token alone — "InterrelatedBot/0.1"
 *  names InterrelatedBot — case-insensitively. Anything else on the line
 *  (a version, a URL) is not part of the name. */
function productToken(value: string): string {
  if (value === WILDCARD_AGENT) return WILDCARD_AGENT
  const match = /^[A-Za-z_-]+/.exec(value)
  return match ? match[0].toLowerCase() : ""
}

/**
 * The comparison form of a path (RFC 9309 §2.2.2): octets outside ASCII are
 * percent-encoded (UTF-8, uppercase hex — what `new URL()` already does to a
 * pathname, applied here to PATTERNS too so "/café" in a robots.txt matches
 * the "/caf%C3%A9" a browser would request), percent-escapes of UNRESERVED
 * characters (RFC 3986 §2.3: letters, digits, `-._~`) are decoded because
 * "%7Efoo" and "~foo" are one resource, and every remaining escape has its
 * hex uppercased so "%2f" and "%2F" compare equal. Reserved characters stay
 * as written: "/a%2Fb" and "/a/b" are DIFFERENT paths and must not be
 * conflated. Applied identically to both sides, so the two can only agree
 * on what they mean.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function normalizeForMatch(input: string): string {
  let out = ""
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (ch === "%") {
      const hex = input.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        const code = parseInt(hex, 16)
        out += isUnreserved(code) ? String.fromCharCode(code) : `%${hex.toUpperCase()}`
        i += 2
        continue
      }
      out += ch // a bare "%" that escapes nothing stays a literal, as URL parsing leaves it
      continue
    }
    const codePoint = input.codePointAt(i) as number
    if (codePoint <= 0x20 || codePoint >= 0x7f) {
      // Space, controls, DEL and everything non-ASCII: encode the UTF-8 bytes.
      for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      }
      if (codePoint > 0xffff) i++ // astral code points occupy two UTF-16 units
      continue
    }
    out += ch
  }
  return out
}

function isUnreserved(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e // - . _ ~
  )
}

/**
 * Parses a robots.txt body into its groups. Tolerant where the RFC says to be
 * (§2.2.4: unknown fields ignored, lines that are not `field: value` ignored,
 * comments from `#` to end of line, CR / LF / CRLF endings, a leading BOM) and
 * faithful where it matters:
 *   - a run of consecutive user-agent lines forms ONE group (a site writing
 *     "User-agent: a\nUser-agent: b\nDisallow: /x" means /x for both), and
 *     any other line ends the run, so the next user-agent line starts a new
 *     group;
 *   - rules before any user-agent line belong to no group and are dropped;
 *   - an EMPTY Disallow (the idiom for "everything allowed") is a rule that
 *     matches nothing, so it is simply not kept — likewise an empty Allow;
 *   - Crawl-delay attaches to the current group; a value that is not a
 *     non-negative number is ignored.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function parseRobotsTxt(text: string): RobotsFile {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  let inAgentRun = false

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf("#")
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim()
    if (line === "") continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === "user-agent") {
      if (!inAgentRun || current === null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null }
        groups.push(current)
      }
      current.agents.push(productToken(value))
      inAgentRun = true
      continue
    }

    inAgentRun = false
    if (current === null) continue // no group yet: nothing to attach to (§2.2.1)
    if (field === "allow" || field === "disallow") {
      if (value === "") continue
      current.rules.push({ allow: field === "allow", pattern: value, normalized: normalizeForMatch(value) })
    } else if (field === "crawl-delay") {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds
    }
    // sitemap, host, and anything unknown: ignored, and the group survives.
  }
  return { groups }
}
//#endregion

//#region Matching
/**
 * RFC 9309 §2.2.3: `*` matches any run of characters (including none) and a
 * TRAILING `$` anchors the pattern to the end of the path; a pattern without
 * `$` matches any path it is a prefix of. Written as the classic
 * two-pointer glob match instead of a compiled RegExp on purpose: a pattern
 * is untrusted text from a fetched file, and "/*a*a*a*a*a*b" against a long
 * path would send a backtracking regex engine exponential, whereas this
 * loop is bounded by pattern length × path length. A `$` anywhere but the
 * end is a literal dollar sign, as the RFC's grammar has it.
 */
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$")
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`
  let i = 0 // path cursor
  let j = 0 // glob cursor
  let star = -1 // position of the last `*` seen, or -1
  let mark = 0 // path position that `*` was matched up to
  while (i < path.length) {
    if (j < glob.length && glob[j] === "*") {
      star = j
      mark = i
      j++
    } else if (j < glob.length && glob[j] === path[i]) {
      i++
      j++
    } else if (star >= 0) {
      // Mismatch after a `*`: let the star absorb one more character and retry.
      j = star + 1
      mark++
      i = mark
    } else {
      return false
    }
  }
  while (j < glob.length && glob[j] === "*") j++
  return j === glob.length
}

/**
 * The verdict for one path under a set of rules (RFC 9309 §2.2.2): among the
 * rules that match, the most specific — the one with the most octets — wins,
 * and when an Allow and a Disallow tie, Allow wins ("if an allow and disallow
 * rule are equivalent, then the allow SHOULD be used"). No matching rule
 * means allowed: robots.txt lists what may NOT be fetched.
 */
function evaluate(rules: RobotsRule[], url: URL, agentLabel: string): RobotsVerdict {
  const path = normalizeForMatch(url.pathname + url.search)
  let best: RobotsRule | null = null
  for (const rule of rules) {
    if (!matchesPattern(rule.normalized, path)) continue
    if (
      best === null ||
      rule.normalized.length > best.normalized.length ||
      (rule.normalized.length === best.normalized.length && rule.allow && !best.allow)
    ) {
      best = rule
    }
  }
  if (best === null || best.allow) return { allowed: true }
  return { allowed: false, reason: `disallowed by robots.txt (User-agent: ${agentLabel}, Disallow: ${best.pattern})` }
}
//#endregion

//#region Policy
/**
 * The rules that apply to one crawler (RFC 9309 §2.2.1): every group naming
 * its product token, merged into one; failing that, every group naming `*`,
 * merged; failing that, no rules at all. Case-insensitive on the token. The
 * merge is the RFC's ("if more than one group matches the user-agent, the
 * matching groups' rules MUST be combined into one group"), and it is why a
 * site can add "User-agent: InterrelatedBot / Disallow: /drafts" at the
 * bottom of a long file and have it apply. A group that names us
 * specifically REPLACES the wildcard rules rather than adding to them —
 * that is what naming a crawler in robots.txt is for.
 */
function robotsPolicy(file: RobotsFile, agent: string, source: string): RobotsPolicy {
  const wanted = agent.toLowerCase()
  let matched = file.groups.filter((group) => group.agents.includes(wanted))
  let label = agent
  if (matched.length === 0) {
    matched = file.groups.filter((group) => group.agents.includes(WILDCARD_AGENT))
    label = WILDCARD_AGENT
  }
  const rules = matched.flatMap((group) => group.rules)
  const crawlDelaySeconds = matched.map((group) => group.crawlDelaySeconds).find((d) => d !== null) ?? null
  return {
    source,
    crawlDelaySeconds,
    check: (url) => {
      let parsed: URL
      try {
        parsed = url instanceof URL ? url : new URL(url)
      } catch {
        return { allowed: true } // not a URL — nothing this file can say about it; the fetch will refuse it
      }
      return evaluate(rules, parsed, label)
    },
  }
}

function allowAll(source: string): RobotsPolicy {
  return { source, crawlDelaySeconds: null, check: () => ({ allowed: true }) }
}

function disallowAll(source: string): RobotsPolicy {
  return { source, crawlDelaySeconds: null, check: () => ({ allowed: false, reason: source }) }
}
//#endregion

//#region Fetching
/**
 * Reads `<origin>/robots.txt` through the same guarded client every crawl
 * fetch uses, and turns the OUTCOME — not just the body — into a policy, per
 * RFC 9309 §2.3.1:
 *   - 2xx: parse it. (safeFetch follows up to five redirects first, which
 *     is §2.3.1.2's "SHOULD follow at least five consecutive redirects".)
 *   - 3xx it would not follow, and every 4xx: the file is UNAVAILABLE and
 *     "the crawler MAY access any resources on the server" — the common
 *     case for a small docs site with no robots.txt at all.
 *   - 5xx, or a request that never produced a status (network, timeout, DNS,
 *     the SSRF guard, the size cap): the file is UNREACHABLE and "the
 *     crawler MUST assume complete disallow". Fail-closed, and visibly: the
 *     crawler turns this into a source failure whose text names the cause,
 *     so a tenant learns their robots.txt is returning 503 rather than
 *     watching a crawl of zero pages succeed.
 */
async function fetchRobotsPolicy(
  origin: string,
  fetchOptions: SafeFetchOptions = {},
  agent: string = USER_AGENT_PRODUCT,
): Promise<RobotsPolicy> {
  const url = `${origin}/robots.txt`
  let res
  try {
    res = await safeFetch(url, { ...fetchOptions, maxBytes: ROBOTS_MAX_BYTES })
  } catch (err) {
    const detail =
      err instanceof SafeFetchError && err.reason === "too-large"
        ? `larger than ${ROBOTS_MAX_BYTES / 1024} KiB`
        : err instanceof Error
          ? err.message
          : String(err)
    return disallowAll(`robots.txt unreachable (${detail}), which RFC 9309 says means disallow-all`)
  }
  if (res.status >= 200 && res.status < 300) {
    return robotsPolicy(parseRobotsTxt(res.body.toString("utf8")), agent, `robots.txt (HTTP ${res.status})`)
  }
  if (res.status >= 500) {
    return disallowAll(`robots.txt returned HTTP ${res.status}, which RFC 9309 says means disallow-all`)
  }
  return allowAll(`no robots.txt (HTTP ${res.status})`)
}
//#endregion

//#region Exports
export { parseRobotsTxt, robotsPolicy, matchesPattern, normalizeForMatch, fetchRobotsPolicy, ROBOTS_MAX_BYTES }
export type { RobotsFile, RobotsGroup, RobotsRule, RobotsPolicy, RobotsVerdict }
//#endregion
