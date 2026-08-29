//#region Type Defs
// Byte-level IP address classification for the SSRF guard (safeFetch.ts).
//
// Hand-rolled parsers instead of a dependency because the whole job is
// "16 bytes, then prefix checks" — and because this is a security boundary:
// every line here is reviewable, and the failure mode is FAIL CLOSED (an
// address we cannot parse is treated as non-public, never the reverse).
//
// The question this module answers is deliberately narrow: "is this address
// affirmatively public-routable?" Everything else — loopback, RFC1918,
// link-local (which includes 169.254.169.254, the cloud metadata endpoint),
// CGNAT, TEST-NETs, benchmarking, multicast, reserved, and the IPv6
// transition ranges that EMBED an IPv4 address — answers no.
//#endregion

//#region Helpers
/** Parses dotted-quad IPv4 into 4 octets, or null if malformed. Strict on
 *  purpose: no octal, no hex, no shorthand ("127.1") — those alternate
 *  spellings are classic SSRF-filter bypasses, so anything but the canonical
 *  form is simply not recognized (and therefore not public). */
function parseV4(text: string): number[] | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    // Leading zeros are rejected (not just normalized) because "010.0.0.1"
    // means 8.0.0.1 to some resolvers and 10.0.0.1 to others — ambiguity in
    // a security check is an answer of "no".
    if (part.length > 1 && part.startsWith("0")) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/** Parses IPv6 (including "::" compression and an embedded IPv4 tail like
 *  "::ffff:10.0.0.1") into 16 bytes, or null if malformed. Zone indexes
 *  ("%eth0") are rejected outright — they only name local interfaces, which
 *  a public URL has no business referencing. */
function parseV6(text: string): Uint8Array | null {
  if (text.includes("%")) return null
  const halves = text.split("::")
  if (halves.length > 2) return null

  const parseGroups = (chunk: string): number[] | null => {
    if (chunk === "") return []
    const groups: number[] = []
    for (const raw of chunk.split(":")) {
      if (raw.includes(".")) {
        // Embedded IPv4 — legal only as the final group pair.
        const v4 = parseV4(raw)
        if (!v4) return null
        groups.push(((v4[0] as number) << 8) | (v4[1] as number))
        groups.push(((v4[2] as number) << 8) | (v4[3] as number))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null
        groups.push(parseInt(raw, 16))
      }
    }
    return groups
  }

  const head = parseGroups(halves[0] as string)
  const tail = halves.length === 2 ? parseGroups(halves[1] as string) : null
  if (head === null || (halves.length === 2 && tail === null)) return null

  let groups: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - (tail as number[]).length
    if (fill < 1) return null // "::" must stand for at least one zero group
    groups = [...head, ...Array.from({ length: fill }, () => 0), ...(tail as number[])]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null

  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8
    bytes[i * 2 + 1] = group & 0xff
  })
  return bytes
}

/** IPv4 classification over octets. See the range list in the header. */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function isPublicV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number]
  if (a === 0 || a === 10 || a === 127) return false // "this" net, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a === 169 && b === 254) return false // link-local (incl. metadata endpoints)
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918 172.16/12
  if (a === 192 && b === 168) return false // RFC1918 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF special + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast 224/4, reserved 240/4, broadcast
  return true
}

/** IPv6 classification over 16 bytes. Transition ranges that embed an IPv4
 *  address (v4-mapped, NAT64) defer to the v4 verdict of the embedded
 *  address; ranges that merely tunnel (6to4, Teredo) are rejected wholesale
 *  because the guard cannot see through them. */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- grandfathered at the 2026-08 org overhaul: pre-existing hot spot, simplify when next touched; do not add branches
function isPublicV6(bytes: Uint8Array): boolean {
  const b = bytes as unknown as number[] // indexed reads only

  const allZeroThrough = (end: number): boolean => {
    for (let i = 0; i <= end; i++) if (b[i] !== 0) return false
    return true
  }

  // :: (unspecified) and ::1 (loopback)
  if (allZeroThrough(14) && ((b[15] as number) === 0 || (b[15] as number) === 1)) return false
  // ::ffff:a.b.c.d — v4-mapped: the verdict is the embedded address's
  if (allZeroThrough(9) && b[10] === 0xff && b[11] === 0xff) {
    return isPublicV4([b[12] as number, b[13] as number, b[14] as number, b[15] as number])
  }
  // 64:ff9b::/96 — NAT64: likewise embeds a v4 address in the last 4 bytes
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    for (let i = 4; i <= 11; i++) if (b[i] !== 0) return true // not the /96 — plain global
    return isPublicV4([b[12] as number, b[13] as number, b[14] as number, b[15] as number])
  }
  if (((b[0] as number) & 0xfe) === 0xfc) return false // ULA fc00::/7
  if (b[0] === 0xfe && (((b[1] as number) & 0xc0)) === 0x80) return false // link-local fe80::/10
  if (b[0] === 0xff) return false // multicast ff00::/8
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false // doc 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x02) return false // 6to4 2002::/16
  return true
}
//#endregion

//#region Exports
/**
 * True only when `address` parses as a canonical IPv4 or IPv6 literal AND
 * falls in publicly-routable space. Fail-closed by construction: malformed,
 * ambiguous, or exotic spellings return false, which the caller treats as
 * "refuse to connect".
 */
function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const bytes = parseV6(address)
    return bytes !== null && isPublicV6(bytes)
  }
  const octets = parseV4(address)
  return octets !== null && isPublicV4(octets)
}

export { isPublicAddress }
//#endregion
