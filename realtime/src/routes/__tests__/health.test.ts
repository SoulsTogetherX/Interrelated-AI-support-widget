//#region Imports
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import { createApp } from "@/app"
//#endregion

//#region Test Setup
// The app is driven over real HTTP on an ephemeral port (listen(0)) rather
// than through a request-mocking library: what we ship is an HTTP server,
// so the test exercises the actual listener, parser, and JSON serialization.
//
// DB_CONFIGURED mirrors the convention used by the integration tests: when
// POSTGRES_PASSWORD is set (CI's service container, or a local dev DB), the
// readiness probe is expected to succeed; when it is not, readiness must
// fail FAST and CLEANLY — a 503, not a hang and not a crash. Both branches
// are real behavior worth pinning; which one runs depends on environment.
const DB_CONFIGURED = Boolean(process.env.POSTGRES_PASSWORD)

// fetch().json() is typed `unknown` under current Node types — correct for
// production code, noise for tests that immediately assert the shape. One
// narrowing helper keeps the assertions honest without per-call casts.
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json()
  if (typeof body !== "object" || body === null) throw new Error("non-object body")
  return body as Record<string, unknown>
}

let server: Server
let base: string

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})
//#endregion

describe("GET /api/health", () => {
  it("returns 200 with ok:true and an uptime", async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.ok).toBe(true)
    expect(typeof body.uptime_s).toBe("number")
  })

  it("responds without a database", async () => {
    // The liveness route's entire contract is that it never touches
    // Postgres. There is no way to assert "did not query" from out here, so
    // this test pins the observable half: sub-second response regardless of
    // DB state. If someone adds a DB call to /api/health, the no-DB CI leg
    // turns this into a 3-second connection-timeout stall and the assertion
    // fails. Crude, but it guards the free-tier keepalive design.
    const started = Date.now()
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("GET /api/ready", () => {
  it.skipIf(!DB_CONFIGURED)("returns 200 when Postgres is reachable", async () => {
    const res = await fetch(`${base}/api/ready`)
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).ok).toBe(true)
  })

  it.skipIf(DB_CONFIGURED)("returns 503, not a hang, when Postgres is absent", async () => {
    const res = await fetch(`${base}/api/ready`)
    expect(res.status).toBe(503)
    const body = await jsonOf(res)
    expect(body.ok).toBe(false)
    // The 503 body must not leak WHY readiness failed — this endpoint is
    // public, and failure detail is reconnaissance. ok:false is the entire
    // permitted vocabulary.
    expect(Object.keys(body)).toEqual(["ok"])
  })
})
