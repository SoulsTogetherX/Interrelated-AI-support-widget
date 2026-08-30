//#region Why this surface
// The server-to-server API the dashboard proxies through — the ONLY surface
// that ever handles a tenant provider key in plaintext, and only in
// transit: web POSTs the pasted key over TLS, this file tests it against
// the real provider, encrypts it (credentials/vault.ts), and stores it.
// Browsers never call these routes; there is deliberately no CORS here, so
// a browser cannot even read a response cross-origin.
//
// Auth is ONE shared secret (INTERNAL_API_SECRET, set identically on
// Render and Vercel), compared in constant time. A shared secret rather
// than signed requests because both ends are our own servers over TLS —
// the ticket ceremony (M4's socket auth) buys nothing between two
// backends holding the same env var. Every failure is a uniform 401 with
// an empty body: which part was wrong is not information this surface
// shares.
//
// The whole surface MOUNTS ONLY when the secret is configured (app.ts):
// a deployment that has not opted in has these routes 404 like any other
// unknown path — indistinguishable from not existing, which is exactly the
// posture an admin surface should have. The smoke probe asserts the 404-
// when-unconfigured state.
//#endregion

//#region Imports
import type { Express } from "express"

import { registerCredentialRoutes } from "./credentials"
import { buildGuards } from "./guards"
import { registerHandoffRoutes } from "./handoffs"
import {
  registerSourceMaintenanceRoutes,
  registerSourceRoutes,
  registerUploadRoute,
} from "./sources"
import type { InternalRouteOptions } from "./types"
//#endregion

//#region Routes
/** One registrar per resource since the 2026-08 org overhaul: the
 *  955-line single file was ~12 independent handlers — a directory
 *  wearing a filename. Registration order is preserved exactly;
 *  behavior is pinned by internal.test.ts + internalSources.test.ts,
 *  which import this path unchanged. */
function configureInternalRoutes(app: Express, options: InternalRouteOptions): void {
  const guards = buildGuards(options)
  registerCredentialRoutes(app, options, guards)
  registerSourceRoutes(app, options, guards)
  registerUploadRoute(app, options, guards)
  registerSourceMaintenanceRoutes(app, options, guards)
  registerHandoffRoutes(app, options, guards)
}
//#endregion

//#region Exports
export { configureInternalRoutes }
export type { InternalRouteOptions } from "./types"
//#endregion
