//#region Why this surface
// The only routes an untrusted browser ever calls, implementing the trust
// model in layer order (§3.18; docs/reference/03-realtime.md). One
// registrar per route group since the 2026-08 org overhaul — the 672-line
// single file carried five independent routes. Registration order is
// preserved exactly; behavior is pinned by widget.test.ts, widgetByo,
// widgetDeadline and the security probe, none of which changed.
//#endregion

//#region Imports
import type { Express } from "express"

import { registerChatRoute } from "./chat"
import { registerHandoffRoutes } from "./handoff"
import { registerServerSessionRoute } from "./serverSessions"
import { registerSessionRoute } from "./session"
import { buildWidgetContext, preflight } from "./shared"
import type { WidgetRouteOptions } from "./types"
//#endregion

//#region Routes
function configureWidgetRoutes(app: Express, options: WidgetRouteOptions): void {
  const ctx = buildWidgetContext(options)

  app.options("/v1/widget/session", preflight)
  app.options("/v1/widget/chat", preflight)
  app.options("/v1/widget/escalate", preflight)
  app.options("/v1/widget/handoff-ticket", preflight)

  registerSessionRoute(app, options, ctx)
  registerServerSessionRoute(app, options, ctx)
  registerChatRoute(app, options, ctx)
  registerHandoffRoutes(app, options, ctx)
}
//#endregion

//#region Exports
export { configureWidgetRoutes }
export type { WidgetRouteOptions } from "./types"
//#endregion
