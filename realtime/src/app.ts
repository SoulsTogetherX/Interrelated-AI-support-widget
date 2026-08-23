//#region Imports
import express from "express"
import type { Express } from "express"

import { configureHealthRoutes } from "@/routes/health"
import { configureWidgetRoutes } from "@/routes/widget"
import type { WidgetRouteOptions } from "@/routes/widget"
import { configureDemoRoutes } from "@/routes/demo"
import type { DemoRouteOptions } from "@/routes/demo"
import { configureInternalRoutes } from "@/routes/internal"
import type { InternalRouteOptions } from "@/routes/internal"
//#endregion

//#region App Def
/**
 * Builds the Express app without binding a port. Separated from server.ts so
 * tests can construct the app and drive it on an ephemeral port (or via
 * fetch) without touching the boot path — migrations, signal handlers, and
 * listen() are server.ts concerns, not app concerns.
 *
 * The widget surface mounts only when its dependencies are supplied:
 * server.ts always supplies them; tests that only probe health build the
 * bare app and never construct providers they won't use.
 */
interface CreateAppOptions {
  widget?: WidgetRouteOptions
  demo?: DemoRouteOptions
  /** The dashboard's server-to-server surface (M3.4). Mounts only when a
   *  secret is configured — an unconfigured deployment 404s these paths,
   *  indistinguishable from the surface not existing. */
  internal?: InternalRouteOptions
}

function createApp(options: CreateAppOptions = {}): Express {
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
  if (options.widget !== undefined) configureWidgetRoutes(app, options.widget)
  if (options.demo !== undefined) configureDemoRoutes(app, options.demo)
  if (options.internal !== undefined) configureInternalRoutes(app, options.internal)

  return app
}
//#endregion

//#region Exports
export { createApp }
export type { CreateAppOptions }
//#endregion
