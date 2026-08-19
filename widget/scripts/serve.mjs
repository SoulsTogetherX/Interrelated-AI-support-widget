#!/usr/bin/env node
// Fixture server — serves widget/ (fixtures + dist) on :4400 so the host
// pages run under a real http origin. file:// would send `Origin: null`,
// which the allowlist rightly rejects; the whole point of the fixtures is
// exercising the widget under the SAME origin rules production enforces.
// Zero dependencies, sibling convention.
//
//   npm run fixtures     then open http://localhost:4400/fixtures/tailwind.html
//
// Since M7.3 it is also a stand-in for a CUSTOMER'S BACKEND: the strong-mode
// fixture (fixtures/strong.html) carries no publishable key and instead names
// GET /api/support-session, which this server answers the way the dashboard's
// Install page tells a customer to — one authenticated POST to realtime's
// /v1/sessions with the SECRET key from the environment, the JSON passed
// through verbatim. It "signs the user in" with a fixed id, because the
// point of the fixture is the widget's half of the exchange, not a login
// form. Configure it with:
//
//   INTERRELATED_SECRET_KEY=sk_live_…   the org's secret key (dashboard overview)
//   INTERRELATED_API=http://localhost:3000   realtime (default shown)
//   INTERRELATED_ORIGIN=http://localhost:4400   the origin this page runs on
//                                                (must be allowlisted; default shown)
//   INTERRELATED_USER=user_42               the "signed-in" user id (default shown)
//
// Without the secret key the endpoint answers 503 with a sentence, and the
// widget on strong.html says it could not start — which is exactly what a
// customer would see with an unconfigured server.

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve, dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const port = Number(process.env.FIXTURE_PORT ?? 4400)

const secretKey = process.env.INTERRELATED_SECRET_KEY || null
const apiBase = (process.env.INTERRELATED_API ?? "http://localhost:3000").replace(/\/$/, "")
const pageOrigin = process.env.INTERRELATED_ORIGIN ?? `http://localhost:${port}`
const signedInUser = process.env.INTERRELATED_USER ?? "user_42"

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
}

/** The customer-backend half of strong mode: the recipe from the Install
 *  page, minus the login (a fixture has no users to sign in). What is worth
 *  noticing is what this handler never does — it never sends the secret key
 *  to the browser, and it never touches the widget's response beyond
 *  passing it through. */
async function supportSession(res) {
  if (secretKey === null) {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify({ error: "INTERRELATED_SECRET_KEY is not set on the fixture server — generate a secret key on the dashboard overview and export it" }))
    return
  }
  try {
    const upstream = await fetch(`${apiBase}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ origin: pageOrigin, visitorId: signedInUser }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = await upstream.text()
    // Passed through verbatim — status included, so a 403 "origin not
    // allowed" from realtime reaches the browser console legibly.
    res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(body)
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify({ error: `could not reach ${apiBase}: ${err instanceof Error ? err.message : String(err)}` }))
  }
}

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0])
  if (path === "/api/support-session") {
    await supportSession(res)
    return
  }
  const file = normalize(join(rootDir, path === "/" ? "/fixtures/tailwind.html" : path))
  // Path traversal guard — dev-only server, but "dev-only" is how these
  // things end up exposed; the guard is one line.
  if (!file.startsWith(rootDir + sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
    res.end(body)
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${path}`)
  }
}).listen(port, () => {
  console.log(`fixtures at http://localhost:${port}/fixtures/{tailwind,bootstrap,hostile,strong,measure}.html`)
  console.log(`(build first: npm run build; seed the API: npm run seed-demo in realtime/)`)
  console.log(secretKey
    ? `strong mode: /api/support-session mints via ${apiBase}/v1/sessions for ${signedInUser} on ${pageOrigin}`
    : "strong mode: INTERRELATED_SECRET_KEY unset — /api/support-session answers 503")
})
