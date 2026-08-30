//#region Imports
import type { Express, Request, Response } from "express"
import { sql } from "kysely"

import { isAnonymousVisitorId, newAnonymousVisitorId } from "@shared/utils/visitorIds"
import { mintSessionToken } from "@/widgetAuth/sessionToken"
//#endregion

import { corsHeaders } from "./shared"
import type { WidgetContext, WidgetRouteOptions } from "./types"

//#region Route
/** The publishable key's only moment — trust layers 1–3 (§3.18).
 *  Handler body verbatim from the pre-split file. */
function registerSessionRoute(app: Express, options: WidgetRouteOptions, ctx: WidgetContext): void {
  const { mintLimiter, countOrigin } = ctx

  // ── Session mint: the publishable key's ONLY moment ──────────────────────
  app.post("/v1/widget/session", async (req: Request, res: Response) => {
    try {
      const origin = req.headers.origin
      if (typeof origin !== "string" || origin.length === 0) {
        // No Origin, no session: every browser sends it on cross-origin
        // POSTs, so its absence means a script — which layer 3 exists for,
        // but there is no reason to hand scripts sessions for free.
        res.status(403).json({ error: "origin header required" })
        return
      }
      if (!mintLimiter.take(req.ip ?? "unknown")) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const publishableKey = body["publishableKey"]
      if (typeof publishableKey !== "string" || !publishableKey.startsWith("pk_")) {
        res.status(401).json({ error: "invalid publishable key" })
        return
      }
      // A browser may hand back ONLY an anonymous id (vis_<hex>, the shape
      // this route itself mints and the widget stores). Any other id is
      // refused: an IDENTIFIED visitor — a customer's own user id, which is
      // guessable — can be minted only by that customer's server through
      // POST /v1/sessions below, and letting a page claim one would let
      // anyone on an allowlisted origin impersonate user 42 to the support
      // agent reading the inbox (shared/utils/visitorIds.ts).
      const givenVisitor = body["visitorId"]
      if (
        givenVisitor !== undefined &&
        (typeof givenVisitor !== "string" || !isAnonymousVisitorId(givenVisitor))
      ) {
        res.status(400).json({ error: "invalid visitorId" })
        return
      }

      // A key is live while revoked_at is NULL — or still in the FUTURE:
      // rotation (web/src/lib/keys, M7.1) schedules the old key's revocation
      // at the end of a grace window rather than killing it on the click, so
      // a snippet the customer has not yet updated keeps working. Postgres's
      // clock decides, not this process's: the dashboard wrote that instant
      // with NOW() on Neon, and Render's clock is a different machine's.
      const key = await options.db
        .selectFrom("api_keys")
        .select(["id", "org_id"])
        .where("kind", "=", "public")
        .where("public_id", "=", publishableKey)
        .where((eb) =>
          eb.or([eb("revoked_at", "is", null), eb("revoked_at", ">", sql<Date>`NOW()`)]),
        )
        .executeTakeFirst()
      if (!key) {
        // Unknown, revoked, and past-its-grace collapse into one answer —
        // key state is not probeable from the outside.
        res.status(401).json({ error: "invalid publishable key" })
        return
      }

      const allowed = await options.db
        .selectFrom("allowed_origins")
        .select("origin")
        .where("org_id", "=", key.org_id)
        .where("origin", "=", origin)
        .executeTakeFirst()
      if (!allowed) {
        // No CORS headers on this path: an unlisted site's browser cannot
        // even read this error. Copy-pasted snippets die here — and are
        // COUNTED here (layer 4, §3.28): the key named the org, so the
        // tenant gets to see which origin presented it. Refusals for a
        // missing Origin or a bad key are not counted: neither names an org
        // without a lookup this route deliberately does not spend on them.
        await countOrigin(key.org_id, origin, "refused")
        res.status(403).json({ error: "origin not allowed" })
        return
      }

      // Stamped on Postgres's clock: the dashboard shows "last used" beside
      // "accepted until", and the latter is NOW() on Neon (§9.17), so the
      // two must be read off the same clock or a retiring key can look used
      // after it stopped being accepted.
      await options.db
        .updateTable("api_keys")
        .set({ last_used_at: sql`NOW()` })
        .where("id", "=", key.id)
        .execute()
      await countOrigin(key.org_id, origin, "minted")

      // This handshake fires at bubble-open, which is ALSO what warms Neon
      // during the seconds a human spends typing (the free-tier design:
      // the keepalive cron never touches the DB; the widget does, here).
      const visitorId = givenVisitor ?? newAnonymousVisitorId()
      const minted = mintSessionToken(
        { org: key.org_id, origin, visitor: visitorId },
        options.tokenSecret,
      )
      corsHeaders(res, origin)
      res.json({ token: minted.token, expiresAt: minted.expiresAt, visitorId })
    } catch (err) {
      console.error("[widget] session mint failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })
}
//#endregion

//#region Exports
export { registerSessionRoute }
//#endregion
