//#region Imports
import { sql } from "kysely"
import type { Express, Request, Response } from "express"

import { db } from "@/db/pool"
//#endregion

//#region Routes
/**
 * Two probes with deliberately different contracts:
 *
 * GET /api/health — liveness. Answers "is the process up?" and NEVER touches
 * Postgres. Two callers depend on that property:
 *   1. Render's health check — a DB blip must not make Render restart a
 *      perfectly healthy process.
 *   2. The GitHub Actions keepalive cron that defeats Render's 15-minute
 *      free-tier spin-down. If this route queried the DB, the cron would
 *      also keep Neon awake ~730 h/month and blow through its ~100
 *      compute-hour free budget mid-month. The whole free-tier deployment
 *      design hinges on this route staying DB-free — see DATAFLOW.md §1.
 *
 * GET /api/ready — readiness. Answers "can the process serve real traffic?"
 * with a SELECT 1. Used by the smoke probe and by humans debugging; bounded
 * by the pool's 3 s connectionTimeoutMillis, so a down database yields a
 * prompt 503 rather than a hang.
 */
function configureHealthRoutes(app: Express): void {
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, uptime_s: Math.floor(process.uptime()) })
  })

  app.get("/api/ready", async (_req: Request, res: Response) => {
    try {
      await sql`SELECT 1`.execute(db)
      res.json({ ok: true })
    } catch {
      // The failure reason is deliberately not echoed to the client — this
      // endpoint is public, and "what exactly is broken" is reconnaissance.
      // Operators get the real error from the server log.
      res.status(503).json({ ok: false })
    }
  })
}
//#endregion

//#region Exports
export { configureHealthRoutes }
//#endregion
