//#region Imports
import { lookup as dnsLookup } from "node:dns"
import { lookup as dnsLookupAsync } from "node:dns/promises"
import { isIP } from "node:net"

import { Agent, fetch as undiciFetch } from "undici"

import { isPublicAddress } from "@/ingest/ip"
//#endregion

//#region Type Defs
/**
 * The SSRF-guarded HTTP client every ingest fetch goes through. Crawl targets
 * are USER-SUPPLIED URLs that this server then fetches — the textbook SSRF
 * shape — so the guard is structural, not a validation sprinkled at call
 * sites:
 *
 *   1. Every hop (the original URL and each redirect target) is vetted
 *      BEFORE it is fetched: http/https only, no embedded credentials, and
 *      the host must be affirmatively public — a literal IP is classified
 *      directly, a hostname has ALL of its DNS answers classified (one
 *      private A record among public ones is a rejection, because the
 *      connector may pick any of them).
 *   2. The connection itself re-validates: the undici Agent's lookup hook
 *      classifies the addresses actually used at connect time. This closes
 *      DNS rebinding — a resolver that answered public during vetting and
 *      private at connect time hits the hook's rejection, not our network.
 *   3. Redirects are followed MANUALLY (fetch redirect: "manual") so step 1
 *      applies to every location header; a literal-IP redirect target never
 *      touches DNS, which is exactly why the per-hop URL check exists
 *      alongside the connect hook.
 *
 * Responses are size-capped while streaming and time-boxed end to end —
 * a crawl target must not be able to balloon memory or hang the worker.
 */
type HostGuard = (url: URL) => void | Promise<void>

/** Resolves a hostname to its addresses. Injectable so unit tests can
 *  exercise the guard logic without real DNS. */
type Resolver = (hostname: string) => Promise<string[]>

interface SafeFetchOptions {
  /** Whole-request budget (connect through last body byte). */
  timeoutMs?: number
  /** Response body cap, enforced while streaming. */
  maxBytes?: number
  maxRedirects?: number
  /**
   * Per-hop URL vetting. DEFAULT IS THE FULL PUBLIC-ADDRESS GUARD; passing a
   * custom guard replaces it AND routes the connection through an unguarded
   * agent — the two must move together, or a permissive guard would still be
   * blocked at connect time. Legitimate custom guards: tests fetching their
   * loopback fixture server, and (later, M3) self-hosted Ollama base URLs
   * where the tenant has explicitly pointed us at their own network.
   */
  hostGuard?: HostGuard
}

interface FetchedResource {
  /** URL of the response actually returned, after redirects. */
  finalUrl: string
  status: number
  /** Lowercased media type without parameters ("text/html"), "" if absent. */
  contentType: string
  /** charset parameter of the content-type, lowercased, null if absent —
   *  carried separately so the parser layer can decode correctly while
   *  format dispatch matches on the bare media type. */
  charset: string | null
  body: Buffer
}

type SafeFetchReason =
  | "invalid-url"
  | "blocked-scheme"
  | "credentials-in-url"
  | "non-public-address"
  | "dns-failure"
  | "too-large"
  | "too-many-redirects"
  | "timeout"
  | "network"

class SafeFetchError extends Error {
  readonly reason: SafeFetchReason
  constructor(reason: SafeFetchReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "SafeFetchError"
    this.reason = reason
  }
}

/** Thrown by the connect-time lookup hook; detected by unwrapping the cause
 *  chain of undici's generic "fetch failed" TypeError. */
class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlockedAddressError"
  }
}
//#endregion

//#region Constants
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // generous for HTML; callers can lower
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const USER_AGENT = "InterrelatedBot/0.1"
//#endregion

//#region Host vetting
/** Default resolver: dns.lookup with all:true — the same call path the
 *  socket layer uses, so vetting and connecting see the same answers. */
const systemResolver: Resolver = async (hostname) => {
  const results = await dnsLookupAsync(hostname, { all: true })
  return results.map((r) => r.address)
}

/**
 * Rejects (with a reasoned SafeFetchError) unless `url` is http/https,
 * credential-free, and hosted at an affirmatively public address. Exported
 * for direct unit testing with an injected resolver; safeFetch uses it as
 * the default hostGuard.
 */
async function assertPublicUrl(url: URL, resolver: Resolver = systemResolver): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("blocked-scheme", `refusing scheme ${url.protocol}`)
  }
  // Credentials in a crawl URL are either a mistake or an attempt to make
  // this server present someone's credentials — both are rejections.
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError("credentials-in-url", "URL must not embed credentials")
  }
  // URL.hostname wraps IPv6 literals in brackets; strip for classification.
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new SafeFetchError("non-public-address", `refusing non-public address ${hostname}`)
    }
    return
  }
  let addresses: string[]
  try {
    addresses = await resolver(hostname)
  } catch (err) {
    throw new SafeFetchError("dns-failure", `cannot resolve ${hostname}`, err)
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("dns-failure", `no addresses for ${hostname}`)
  }
  // ALL answers must be public: the socket layer may connect to any of them
  // (happy eyeballs tries several), so one private record taints the set.
  const blocked = addresses.find((address) => !isPublicAddress(address))
  if (blocked !== undefined) {
    throw new SafeFetchError(
      "non-public-address",
      `refusing ${hostname}: resolves to non-public address ${blocked}`,
    )
  }
}
//#endregion

//#region Agents
// The rebinding defense: this lookup hook runs inside the connector, on the
// addresses the socket will ACTUALLY dial — resolved at connect time, not at
// vetting time. Node's net layer calls it with either the classic single-
// address shape or (under autoSelectFamily) all:true; both are handled.
//
// Callback and option types are kept loose because Node overloads dns.lookup
// heavily and undici's connector forwards options opaquely; the narrow cast
// at the Agent construction site is the one place the mismatch is bridged.
function guardedLookup(
  hostname: string,
  options: { all?: boolean } & Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, ...args: unknown[]) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }]
    const blocked = list.find((entry) => !isPublicAddress(entry.address))
    if (blocked) {
      return callback(new BlockedAddressError(`refusing to connect to non-public address ${blocked.address} (${hostname})`))
    }
    if (options.all) return callback(null, list)
    const first = list[0]
    if (!first) return callback(new BlockedAddressError(`no addresses for ${hostname}`))
    callback(null, first.address, first.family)
  })
}

// Process-lifetime agents (same lifecycle as the pg pool — never closed).
// guardedAgent pairs with the default hostGuard; openAgent pairs with a
// caller-supplied guard, whose whole point is reaching hosts the default
// would block.
const guardedAgent = new Agent({ connect: { lookup: guardedLookup as never } })
const openAgent = new Agent()
//#endregion

//#region Body reading
/** Streams the body, counting bytes, aborting past the cap — a Content-Length
 *  header is checked first but never trusted (it is attacker-supplied). */
async function readBodyCapped(res: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel()
    throw new SafeFetchError("too-large", `declared ${declared} bytes exceeds cap ${maxBytes}`)
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new SafeFetchError("too-large", `body exceeds cap ${maxBytes}`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
//#endregion

//#region Exports
/**
 * GETs `url` under the full guard described in the header. Returns the final
 * response whatever its status (a 404 is the CALLER's decision, not a fetch
 * failure); throws SafeFetchError for everything that prevented one.
 */
async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<FetchedResource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const hostGuard: HostGuard = options.hostGuard ?? ((hop) => assertPublicUrl(hop))
  const dispatcher = options.hostGuard ? openAgent : guardedAgent

  // One clock for the WHOLE chain — redirects don't reset the budget, or a
  // slow-redirect loop would multiply it.
  const signal = AbortSignal.timeout(timeoutMs)

  let current: URL
  try {
    current = new URL(url)
  } catch {
    throw new SafeFetchError("invalid-url", `not a URL: ${url}`)
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await hostGuard(current)

    let res: Awaited<ReturnType<typeof undiciFetch>>
    try {
      res = await undiciFetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal,
        dispatcher,
        headers: { "user-agent": USER_AGENT },
      })
    } catch (err) {
      throw translateFetchError(err, current.href)
    }

    const location = res.headers.get("location")
    if (REDIRECT_STATUSES.has(res.status) && location !== null) {
      await res.body?.cancel() // release the socket; we never read redirect bodies
      try {
        current = new URL(location, current)
      } catch {
        throw new SafeFetchError("invalid-url", `redirect to unparseable URL: ${location}`)
      }
      continue
    }

    let body: Buffer
    try {
      body = await readBodyCapped(res, maxBytes)
    } catch (err) {
      throw translateFetchError(err, current.href)
    }
    const rawType = res.headers.get("content-type") ?? ""
    const contentType = rawType.split(";")[0]?.trim().toLowerCase() ?? ""
    const charsetMatch = /charset=["']?([^;"']+)/i.exec(rawType)
    const charset = charsetMatch?.[1]?.trim().toLowerCase() ?? null
    return { finalUrl: current.href, status: res.status, contentType, charset, body }
  }
  throw new SafeFetchError("too-many-redirects", `more than ${maxRedirects} redirects from ${url}`)
}

/** Maps undici's failure shapes onto SafeFetchError reasons. undici wraps
 *  connector errors in TypeError("fetch failed") with the real error as
 *  cause; timeouts surface as DOMException TimeoutError (sometimes as the
 *  cause of the wrapper). Walk the chain rather than trusting one layer. */
function translateFetchError(err: unknown, url: string): SafeFetchError {
  if (err instanceof SafeFetchError) return err
  let cursor: unknown = err
  for (let depth = 0; cursor && depth < 5; depth++) {
    if (cursor instanceof BlockedAddressError) {
      return new SafeFetchError("non-public-address", cursor.message, err)
    }
    if (cursor instanceof Error && (cursor.name === "TimeoutError" || cursor.name === "AbortError")) {
      return new SafeFetchError("timeout", `fetch of ${url} timed out`, err)
    }
    cursor = cursor instanceof Error ? cursor.cause : undefined
  }
  return new SafeFetchError("network", `fetch of ${url} failed`, err)
}

export { safeFetch, assertPublicUrl, SafeFetchError }
export type { SafeFetchOptions, FetchedResource, HostGuard, Resolver, SafeFetchReason }
//#endregion
