//#region Imports
import type { Express, Request, Response } from "express"
import { sql } from "kysely"

import { hashSecretKey } from "@shared/utils/ids"
import { isIdentifiedVisitorId } from "@shared/utils/visitorIds"
import { looksLikeOrigin } from "@/usage/origins"
import { mintSessionToken } from "@/widgetAuth/sessionToken"
//#endregion

import type { WidgetContext, WidgetRouteOptions } from "./types"

//#region Route
/** POST /v1/sessions — strong mode, layer 6 (§3.18). Never CORS.
 *  Handler body verbatim from the pre-split file. */
function registerServerSessionRoute(
  app: Express,
  options: WidgetRouteOptions,
  ctx: WidgetContext,
): void {
  const { serverMintLimiter, countOrigin } = ctx

  // ── Server-side session mint: the SECRET key's only moment (M7.3) ────────
  // Trust-model layer 6, "the strong mode". The customer's backend — never a
  // browser — presents the sk_… key to mint a session for a user IT has
  // authenticated, then hands the token to its page (the widget fetches it
  // from an endpoint on the customer's own site, widget/src/api.ts). The
  // page carries no publishable key at all, so there is nothing on it worth
  // copying, and only that customer's logged-in users can open a chat. Same
  // token as the browser mint, same chat route, same everything after — the
  // ONLY difference is who proves what at the mint:
  //
  //   · identity: the visitorId is the customer's own stable user id, and it
  //     must be IDENTIFIED-shaped (anything but vis_<hex>) — the anonymous
  //     namespace belongs to the browser route, and the two never overlap,
  //     which is what lets an agent trust that "user 42" is user 42.
  //   · origin: the customer's server names the origin its page runs on
  //     (a server sends no Origin header of its own), the token binds to it
  //     like any other, and it must be allowlisted — the allowlist is the
  //     one statement of where the widget may run, and layer 4 counts the
  //     attempt either way, so a forgotten allowlist entry shows up in the
  //     dashboard with an Allow button rather than as a mystery 403.
  //   · CORS: never. There is no preflight handler and no echo, so a browser
  //     page cannot use this route even if a customer mistakenly put their
  //     secret key in it — the browser refuses to read the response, which
  //     is the right feedback. A secret key belongs on a server.
  //
  // Refusals are uniform where an outsider could probe them (missing,
  // malformed, unknown, revoked, and past-grace keys are ONE 401 — key
  // state is not probeable, exactly as for the publishable key) and
  // helpful where the caller has already proven who they are: an
  // authenticated tenant's server gets a sentence saying why its origin or
  // visitor id was refused, because that is its own configuration to fix.
  //
  // Named /v1/sessions rather than under /v1/widget/ on purpose: the
  // /v1/widget/* routes are the ones a browser calls (Origin-gated, CORS);
  // this one is called by a server with a bearer credential — a different
  // caller and a different posture, and a path that says so.
  app.post("/v1/sessions", async (req: Request, res: Response) => {
    try {
      if (!serverMintLimiter.take(req.ip ?? "unknown")) {
        res.status(429).json({ error: "too many requests" })
        return
      }

      const auth = req.headers.authorization
      const secretKey =
        typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
      if (!secretKey.startsWith("sk_")) {
        // The publishable key presented here, garbage, or nothing at all: a
        // shape refusal that never reaches the database — and byte-identical
        // to the unknown-key answer below.
        res.status(401).json({ error: "invalid secret key" })
        return
      }
      // Live means the same thing it means for the publishable key: revoked_at
      // NULL, or still in the FUTURE — a rotation's grace window keeps the
      // old secret working until the customer has redeployed their backend
      // with the new one (§9.17), decided on Postgres's clock.
      const key = await options.db
        .selectFrom("api_keys")
        .select(["id", "org_id"])
        .where("kind", "=", "secret")
        .where("secret_hash", "=", hashSecretKey(secretKey))
        .where((eb) =>
          eb.or([eb("revoked_at", "is", null), eb("revoked_at", ">", sql<Date>`NOW()`)]),
        )
        .executeTakeFirst()
      if (!key) {
        res.status(401).json({ error: "invalid secret key" })
        return
      }

      const body = (req.body ?? {}) as Record<string, unknown>
      const visitorId = body["visitorId"]
      if (typeof visitorId !== "string" || !isIdentifiedVisitorId(visitorId)) {
        res.status(400).json({
          error: "invalid visitorId",
          detail:
            "visitorId must be your own stable identifier for the signed-in user " +
            "(1-100 characters of A-Z a-z 0-9 _ -); the vis_… form is reserved for " +
            "anonymous browser sessions. Send a user id, not an email address.",
        })
        return
      }
      const origin = body["origin"]
      if (typeof origin !== "string" || origin.length === 0) {
        res.status(400).json({
          error: "invalid origin",
          detail:
            "origin is required: the exact origin your page runs on, e.g. https://app.example.com",
        })
        return
      }

      const allowed = await options.db
        .selectFrom("allowed_origins")
        .select("origin")
        .where("org_id", "=", key.org_id)
        .where("origin", "=", origin)
        .executeTakeFirst()
      if (!allowed) {
        // Counted (layer 4): the key named the org, and a server naming an
        // unlisted origin is the tenant's OWN configuration to see and fix —
        // the dashboard's traffic table gets the row and the Allow button.
        await countOrigin(key.org_id, origin, "refused")
        res.status(403).json({
          error: "origin not allowed",
          detail: looksLikeOrigin(origin)
            ? "this origin is not on the organization's allowlist — allow it on the dashboard's Install page"
            : "origin must be a browser origin: scheme://host[:port] with no path or trailing slash, e.g. https://app.example.com",
        })
        return
      }

      // last_used_at, on the database's clock as above: for a retiring
      // secret key this is how the owner can see their OLD backend config
      // is still out there before revoking it early.
      await options.db
        .updateTable("api_keys")
        .set({ last_used_at: sql`NOW()` })
        .where("id", "=", key.id)
        .execute()
      await countOrigin(key.org_id, origin, "minted")

      // The same response shape as the browser mint, so the customer's
      // endpoint can proxy it to the widget verbatim.
      const minted = mintSessionToken(
        { org: key.org_id, origin, visitor: visitorId },
        options.tokenSecret,
      )
      res.json({ token: minted.token, expiresAt: minted.expiresAt, visitorId })
    } catch (err) {
      console.error("[widget] server session mint failed:", err)
      res.status(500).json({ error: "internal error" })
    }
  })
}
//#endregion

//#region Exports
export { registerServerSessionRoute }
//#endregion
