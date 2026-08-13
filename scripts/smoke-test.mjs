#!/usr/bin/env node
// Smoke probe — drives the LIVE stack (compose prod locally, or the deployed
// Render service) over plain HTTP and exits nonzero on the first failure.
//
// Zero dependencies on purpose: this file runs with nothing but Node 22's
// standard library, so CI can execute it without an npm install, and it can
// be pointed at production from any machine ("node scripts/smoke-test.mjs
// https://interrelated.onrender.com"). The same convention as the
// OnlineWhiteboard probe scripts.
//
// Usage: node scripts/smoke-test.mjs [baseUrl]   (default http://localhost:3000)

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "")

let failures = 0

/** Runs one named check; failures are reported and counted, not thrown, so a
 *  single broken endpoint doesn't hide the state of the others. */
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}: ${err.message}`)
  }
}

/** fetch with a timeout — a probe that can hang is worse than no probe,
 *  because it turns a dead service into a stuck CI job. */
async function get(path, ms = 10_000) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(ms) })
  return res
}

console.log(`smoke-test against ${base}`)

// ── Liveness ─────────────────────────────────────────────────────────────────
await check("GET /api/health returns 200 ok:true", async () => {
  const res = await get("/api/health")
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const body = await res.json()
  if (body.ok !== true) throw new Error(`body ${JSON.stringify(body)}`)
})

// ── Readiness (proves the service ↔ database path, i.e. migrations ran) ─────
await check("GET /api/ready returns 200 ok:true", async () => {
  const res = await get("/api/ready")
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const body = await res.json()
  if (body.ok !== true) throw new Error(`body ${JSON.stringify(body)}`)
})

// ── Unknown routes 404 (Express default; pins that no catch-all crept in) ───
await check("GET /api/definitely-not-a-route returns 404", async () => {
  const res = await get("/api/definitely-not-a-route")
  if (res.status !== 404) throw new Error(`status ${res.status}`)
})

// ── Widget surface is mounted AND closed (M2.5) ─────────────────────────────
// No seeded org exists in a fresh stack, so what a probe can verify is the
// security posture: the session route answers (mounted) and refuses a
// request with no Origin (closed). A 404 here means the widget routes fell
// off the app; a 200 would mean the origin gate fell off the route.
await check("POST /v1/widget/session without Origin returns 403", async () => {
  const res = await fetch(`${base}/v1/widget/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publishableKey: "pk_smoke_probe" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status !== 403) throw new Error(`status ${res.status}`)
})

await check("POST /v1/widget/chat without a session returns 401", async () => {
  const res = await fetch(`${base}/v1/widget/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://smoke.example" },
    body: JSON.stringify({ question: "probe" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status !== 401) throw new Error(`status ${res.status}`)
})

// The handoff socket (M4.2). fetch cannot speak WebSocket, so this sends the
// handshake by hand — which is the point: it proves the upgrade handler is
// attached to the SHIPPED server AND that it refuses an unticketed client
// before any WebSocket exists. A 101 here would mean the upgrade
// authenticates after the handshake, which is the bug the design avoids.
await check("WebSocket upgrade without a ticket is refused, not accepted", async () => {
  const { request } = await import(base.startsWith("https") ? "node:https" : "node:http")
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/v1/handoff`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      timeout: 10_000,
    })
    req.on("response", (res) => { res.resume(); resolve(res.statusCode) })
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101) })
    req.on("timeout", () => { req.destroy(); reject(new Error("timed out")) })
    req.on("error", reject)
    req.end()
  })
  if (status !== 401) throw new Error(`status ${status}`)
})

// Same posture check for the second token-authenticated route (M4.1): a 404
// would mean it fell off the app, a 200 that its auth did.
await check("POST /v1/widget/escalate without a session returns 401", async () => {
  const res = await fetch(`${base}/v1/widget/escalate`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://smoke.example" },
    body: JSON.stringify({ conversationId: "con_probe" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status !== 401) throw new Error(`status ${res.status}`)
})

// ── Demo surface (M2.7) ─────────────────────────────────────────────────────
// /demo must answer 200 in BOTH states (configured → the widget page;
// unconfigured → setup instructions) — a recruiter must never see a 500.
// /widget.js proves the bundle actually shipped inside the image.
await check("GET /demo returns 200 html", async () => {
  const res = await get("/demo")
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const body = await res.text()
  if (!body.includes("Interrelated")) throw new Error("unexpected body")
})

await check("GET /widget.js serves the bundle", async () => {
  const res = await get("/widget.js")
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const type = res.headers.get("content-type") ?? ""
  if (!type.includes("javascript")) throw new Error(`content-type ${type}`)
})

// The M3.4 internal API must be CLOSED from the outside in every state:
// unconfigured stacks (the e2e compose) don't mount it at all → 404;
// configured deployments (Render with INTERNAL_API_SECRET set) reject a
// secretless request → 401. Anything else means the admin surface leaks.
await check("internal credential API is closed to outsiders", async () => {
  const res = await get("/internal/orgs/org_probe/credentials")
  if (res.status !== 404 && res.status !== 401) {
    throw new Error(`status ${res.status} — internal surface reachable without a secret`)
  }
})

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`)
  process.exit(1)
}
console.log("\nall smoke checks passed")
