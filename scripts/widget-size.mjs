#!/usr/bin/env node
// Widget size budget — the CI gate that keeps "lightweight embeddable
// widget" true instead of aspirational. Fails the build when the gzipped
// bundle crosses 15 KB (the plan's number, chosen to BITE: vanilla TS
// should land at 8–12 KB, so the budget flags a dependency creeping in or
// a framework-shaped rewrite, not normal growth).
//
// Gzip, not raw: gzip is what actually crosses the wire from any sane CDN,
// and it is the number a customer's performance audit will see. Level 9
// mirrors CDN behavior closely enough; the margin between 12 KB and 15 KB
// absorbs the difference.
//
// Zero dependencies, same convention as the sibling probes. Usage:
//   node scripts/widget-size.mjs        (expects widget/dist/widget.js built)

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const BUDGET_BYTES = 15 * 1024

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

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL: over the ${BUDGET_BYTES}-byte gzipped budget by ${gzipped - BUDGET_BYTES} bytes`)
  process.exit(1)
}
console.log("size budget ok")
