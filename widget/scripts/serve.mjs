#!/usr/bin/env node
// Fixture server — serves widget/ (fixtures + dist) on :4400 so the three
// host pages run under a real http origin. file:// would send
// `Origin: null`, which the allowlist rightly rejects; the whole point of
// the fixtures is exercising the widget under the SAME origin rules
// production enforces. Zero dependencies, sibling convention.
//
//   npm run fixtures     then open http://localhost:4400/fixtures/tailwind.html

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve, dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const port = Number(process.env.FIXTURE_PORT ?? 4400)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
}

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0])
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
  console.log(`fixtures at http://localhost:${port}/fixtures/{tailwind,bootstrap,hostile}.html`)
  console.log(`(build first: npm run build; seed the API: npm run seed-demo in realtime/)`)
})
