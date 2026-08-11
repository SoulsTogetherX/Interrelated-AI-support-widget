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

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`)
  process.exit(1)
}
console.log("\nall smoke checks passed")
