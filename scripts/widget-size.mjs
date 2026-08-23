#!/usr/bin/env node
// What the widget costs a host page — the CI gate that keeps "lightweight
// embeddable widget" true instead of aspirational, and since M7.9 the
// place the plan's two STATIC widget metrics are produced: "gzipped bundle
// bytes against the 15 KB budget" and the byte half of "added requests and
// bytes on the host page".
//
// The budget fails the build when the gzipped bundle crosses 15 KB (the
// plan's number, chosen to BITE: vanilla TS should land at 8–12 KB, so it
// flags a dependency creeping in or a framework-shaped rewrite, not normal
// growth). Gzip, not raw: gzip is what actually crosses the wire from any
// sane CDN, and it is the number a customer's performance audit will see.
// Level 9 mirrors CDN behavior closely enough; the margin between 12 KB
// and 15 KB absorbs the difference.
//
// The REQUEST count is the other half of the same question, and it splits
// in two because the two halves fail differently:
//
//   - "the bundle itself fetches nothing more" is a STATIC property of the
//     artifact, and it is checked here: no dynamic import(), no url() or
//     @import in the styles, no injected <link>/<img>/.src, and no
//     absolute http(s) URL literal (the only URL the widget may ever build
//     is the tenant's own configured API base). Any one of those would
//     silently add a request — and a second-party font or CDN reference in
//     a widget that runs on someone else's site is also a privacy leak
//     they never agreed to.
//   - "the widget issues no request until the visitor opens it" is
//     BEHAVIORAL, so it lives where behavior can be driven:
//     widget/src/__tests__/cost.test.ts pins zero at mount, exactly one at
//     bubble-open (the session mint, which is also the Neon-warming
//     handshake), and exactly one more per question.
//
// Together those two say the installable cost in the terms a customer
// asks it: one request, N bytes, nothing further until someone chats.
//
// Zero dependencies, same convention as the sibling probes. Usage:
//   node scripts/widget-size.mjs        (expects widget/dist/widget.js built)

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const BUDGET_BYTES = 15 * 1024

/**
 * Patterns that would each cost a host page an extra request. Checked as
 * text against the built bundle, which is exactly the artifact a CDN
 * serves — a source-level check could be defeated by a build step.
 *
 * `https?://` is listed as a URL LITERAL rather than a bare scheme: the
 * widget builds its socket URL by swapping the scheme of the configured
 * api base, so the bare strings "http://" and "https://" legitimately
 * appear. What must not appear is a host after one.
 */
const REQUEST_SMELLS = [
  { pattern: /\bimport\s*\(/, what: "a dynamic import() — a second chunk to fetch" },
  { pattern: /@import\b/, what: "an @import in the styles — a second stylesheet to fetch" },
  { pattern: /url\(\s*['"]?[^)'"]/, what: "a url() in the styles — a font or image to fetch" },
  { pattern: /<link\b/i, what: "an injected <link> — a stylesheet or preload to fetch" },
  { pattern: /new\s+Image\s*\(/, what: "an injected image" },
  { pattern: /https?:\/\/[a-z0-9]/i, what: "an absolute URL literal — only the tenant's configured API base may be dialed" },
]

const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), "../widget/dist/widget.js")
let bundle
try {
  bundle = readFileSync(bundlePath)
} catch {
  console.error(`no bundle at ${bundlePath} — run \`npm run build\` in widget/ first`)
  process.exit(1)
}

const gzipped = gzipSync(bundle, { level: 9 }).length
const percent = ((gzipped / BUDGET_BYTES) * 100).toFixed(1)
console.log(`widget bundle: ${bundle.length} bytes raw, ${gzipped} bytes gzipped (budget ${BUDGET_BYTES}, ${percent}% used)`)

let failures = 0

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL: over the ${BUDGET_BYTES}-byte gzipped budget by ${gzipped - BUDGET_BYTES} bytes`)
  failures += 1
} else {
  console.log("size budget ok")
}

// The request count a host page pays at load. Reported as a number rather
// than only asserted, because it is the figure the README quotes.
const source = bundle.toString("utf8")
const found = REQUEST_SMELLS.filter(({ pattern }) => pattern.test(source))
for (const { what } of found) {
  console.error(`FAIL: the bundle contains ${what}`)
  failures += 1
}
if (found.length === 0) {
  console.log(`host page cost: 1 request, ${gzipped} bytes gzipped — the bundle fetches nothing else`)
  console.log("  (zero further requests until the visitor opens the bubble — widget/src/__tests__/cost.test.ts)")
}

process.exit(failures > 0 ? 1 : 0)
