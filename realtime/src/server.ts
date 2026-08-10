//#region Imports
import { createServer } from "node:http"

import { createApp } from "@/app"
import pool, { db } from "@/db/pool"
import { migrateToLatest } from "@/db/migrate"
//#endregion

//#region Boot
// Boot order is a contract (traced in DATAFLOW.md §2):
//   1. migrate — the process must not accept traffic against a schema it
//      wasn't built for. A failure here throws, and the catch below exits
//      loudly. Kysely's migrator takes a session-level advisory lock via its
//      bookkeeping table semantics; even so, this deployment runs exactly
//      one instance (Render free tier), so concurrent-migrator races are
//      out of scope by design and documented rather than half-handled.
//   2. listen — only after the schema is current.
//
// The http server is created explicitly (rather than app.listen) because M4
// attaches the WebSocket upgrade handler to this same server object; doing
// it now costs nothing and avoids reshaping boot later.
// BACKEND_PORT first (this repo's own convention, set by compose and
// render.yaml), then PORT (the convention Render and most PaaS routers
// inject), then 3000. Honoring PORT means the service still binds correctly
// on a platform that only speaks the generic convention.
const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 3000)

async function start(): Promise<void> {
  const applied = await migrateToLatest(db)
  const names = applied.results?.map((r) => r.migrationName).join(", ") || "none"
  console.log(`[boot] migrations applied: ${names}`)

  const app = createApp()
  const server = createServer(app)

  server.listen(port, () => {
    console.log(`[boot] realtime listening on :${port}`)
  })

  //#region Shutdown
  // SIGTERM is what Render (and docker stop) sends. Drain in order: stop
  // accepting connections, then release the pool. A second signal while
  // draining forces exit — an operator mashing Ctrl+C outranks graceful.
  let draining = false
  const shutdown = (signal: string): void => {
    if (draining) process.exit(1)
    draining = true
    console.log(`[shutdown] ${signal} received, draining`)
    server.close(() => {
      pool.end().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
  //#endregion
}

start().catch((err) => {
  // A failed boot must be loud and terminal. Exiting nonzero makes Render /
  // compose restart us with backoff, which is the correct behavior for a
  // transient DB outage and the visible behavior for a real defect.
  console.error("[boot] fatal:", err)
  process.exit(1)
})
//#endregion
