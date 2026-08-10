//#region Imports
import express from "express"
import type { Express } from "express"

import { configureHealthRoutes } from "@/routes/health"
//#endregion

//#region App Def
/**
 * Builds the Express app without binding a port. Separated from server.ts so
 * tests can construct the app and drive it on an ephemeral port (or via
 * fetch) without touching the boot path — migrations, signal handlers, and
 * listen() are server.ts concerns, not app concerns.
 */
function createApp(): Express {
  const app = express()

  // Behind Render's proxy the client address arrives in X-Forwarded-For.
  // Trusting exactly one hop means req.ip is the real client, while a
  // client-forged X-Forwarded-For chain cannot spoof past the proxy. This
  // matters from M2 on, when per-IP rate limits key off req.ip.
  app.set("trust proxy", 1)

  // JSON bodies capped small. Nothing in this API accepts large payloads
  // (uploads get their own bounded route in M1) — a big default limit is
  // just a free memory-pressure lever for whoever finds the endpoint.
  app.use(express.json({ limit: "64kb" }))

  configureHealthRoutes(app)

  return app
}
//#endregion

//#region Exports
export { createApp }
//#endregion
