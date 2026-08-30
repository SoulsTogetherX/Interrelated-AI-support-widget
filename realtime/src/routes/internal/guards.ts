//#region Imports
import { timingSafeEqual } from "node:crypto"

import { isId } from "@shared/utils/ids"

import { db } from "@/db/pool"

import type { Request, Response, NextFunction } from "express"
//#endregion

import type { InternalGuards, InternalRouteOptions } from "./types"

//#region Auth
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  // Length inequality returns early, which leaks only the LENGTH of the
  // secret — 32+ random chars make that worthless.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
//#endregion

//#region Guard factory
/** The two middlewares every internal route runs behind, closed over the
 *  configured secret. Verbatim from the pre-split closure (§3.22). */
function buildGuards(options: InternalRouteOptions): InternalGuards {
  const requireSecret = (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.header("x-internal-secret")
    if (typeof supplied !== "string" || !constantTimeEquals(supplied, options.secret)) {
      res.status(401).end()
      return
    }
    next()
  }

  // Resolve + guard the org param once for every route below; the verified
  // id rides res.locals so handlers never re-read (or re-trust) req.params.
  const requireOrg = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.params.orgId
    const orgId = typeof raw === "string" ? raw : ""
    if (!isId("org", orgId)) {
      res.status(404).end()
      return
    }
    const org = await db
      .selectFrom("organizations")
      .select("id")
      .where("id", "=", orgId)
      .executeTakeFirst()
    if (!org) {
      res.status(404).end()
      return
    }
    res.locals.orgId = orgId
    next()
  }
  return { requireSecret, requireOrg }
}
//#endregion

//#region Exports
export { buildGuards }
//#endregion
