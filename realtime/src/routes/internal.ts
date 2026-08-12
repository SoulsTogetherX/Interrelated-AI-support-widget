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
import { timingSafeEqual } from "node:crypto"

import { newId, isId } from "@shared/utils/ids"

import { db } from "@/db/pool"
import { assertPublicUrl } from "@/ingest/safeFetch"
import {
  buildCredentialProvider,
  checkCredentialInput,
  testGenerationRoundTrip,
} from "@/credentials/validate"
import { encryptProviderKey, keySuffix } from "@/credentials/vault"

import type { Express, Request, Response, NextFunction } from "express"
import type { UrlVet } from "@/credentials/validate"
//#endregion

//#region Types
interface InternalRouteOptions {
  /** The shared secret. app.ts only mounts this surface when present;
   *  server.ts refuses a secret shorter than 32 chars at boot. */
  secret: string
  /** Injectable URL vet, applied to credential base URLs AND source
   *  locations alike (tests reach loopback fakes; production default
   *  rejects anything non-public). */
  vetBaseUrl?: UrlVet
  /** Round-trip timeout override for tests. */
  testTimeoutMs?: number
  /** Called after a source is enqueued — server.ts wires this to the
   *  ingest worker's wake(), which is the whole production scheduling
   *  mechanism (wake-driven mode has no poll to fall back on). */
  onEnqueue?: () => void
}
//#endregion

//#region Auth
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  // Length inequality returns early, which leaks only the LENGTH of the
  // secret — 32+ random chars make that worthless.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
//#endregion

//#region Routes
function configureInternalRoutes(app: Express, options: InternalRouteOptions): void {
  const vet = options.vetBaseUrl

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

  /** Save (or test) a credential. `save: false` runs the identical
   *  validation + live round-trip and stores NOTHING — the dashboard's
   *  Test button, sharing one code path with Save so the two can never
   *  drift on what "valid" means. */
  app.post(
    "/internal/orgs/:orgId/credentials",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const checked = await checkCredentialInput(body, vet)
      if (!checked.ok) {
        res.status(422).json({ ok: false, error: checked.error })
        return
      }

      const provider = buildCredentialProvider(checked.value)
      const trip = await testGenerationRoundTrip(provider, options.testTimeoutMs)
      if (!trip.ok) {
        res.status(422).json({ ok: false, error: trip.error })
        return
      }

      const summary = `${trip.model}, ${trip.latencyMs}ms`
      if (body.save === false) {
        res.json({ ok: true, saved: false, model: trip.model, latencyMs: trip.latencyMs })
        return
      }

      const id = newId("prv")
      const input = checked.value
      // Replace-by-delete inside one transaction: the UNIQUE(org_id, role)
      // row simply ceases to exist for the old key (migration 004 explains
      // why superseded ciphertexts are not retained).
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("org_provider_credentials")
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", input.role)
          .execute()
        await trx
          .insertInto("org_provider_credentials")
          .values({
            id,
            org_id: res.locals.orgId as string,
            role: input.role,
            provider: input.provider,
            model: input.model ?? null,
            base_url: input.baseUrl ?? null,
            key_ciphertext: input.apiKey !== undefined ? encryptProviderKey(input.apiKey, id) : null,
            key_suffix: input.apiKey !== undefined ? keySuffix(input.apiKey) : null,
            last_validated_at: new Date(),
            last_validation: summary,
          })
          .execute()
      })

      res.json({
        ok: true,
        saved: true,
        model: trip.model,
        latencyMs: trip.latencyMs,
        suffix: input.apiKey !== undefined ? keySuffix(input.apiKey) : null,
      })
    },
  )

  /** Credential status for the dashboard. Returns EVERYTHING EXCEPT key
   *  material — no ciphertext, no plaintext, only the stored display
   *  suffix. The read-back denial test lives on this route. */
  app.get(
    "/internal/orgs/:orgId/credentials",
    requireSecret,
    requireOrg,
    async (_req: Request, res: Response) => {
      const rows = await db
        .selectFrom("org_provider_credentials")
        .select([
          "role",
          "provider",
          "model",
          "base_url",
          "key_suffix",
          "last_validated_at",
          "last_validation",
        ])
        .where("org_id", "=", res.locals.orgId as string)
        .orderBy("role")
        .execute()
      res.json({ ok: true, credentials: rows })
    },
  )

  /** Connect a source and enqueue its first crawl (M3.6). The location is
   *  a tenant-typed URL this server will fetch — the same SSRF shape as
   *  credential base URLs, vetted with the same seam (and re-vetted at
   *  every actual fetch by safeFetch, which owns the connect-time layer).
   *  After the transaction commits, onEnqueue wakes the worker: in
   *  production the enqueue IS the scheduler. */
  app.post(
    "/internal/orgs/:orgId/sources",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Record<string, unknown>

      if (b.kind !== "url" && b.kind !== "sitemap") {
        res.status(422).json({ ok: false, error: "kind must be 'url' or 'sitemap'." })
        return
      }
      const location = typeof b.location === "string" ? b.location.trim() : ""
      let parsed: URL
      try {
        parsed = new URL(location)
      } catch {
        res.status(422).json({ ok: false, error: "location is not a valid URL." })
        return
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(422).json({ ok: false, error: "location must be http(s)." })
        return
      }
      if (parsed.username !== "" || parsed.password !== "") {
        res.status(422).json({ ok: false, error: "location must not embed credentials." })
        return
      }
      try {
        await (vet ?? ((url: URL) => assertPublicUrl(url)))(parsed)
      } catch {
        res.status(422).json({ ok: false, error: "location must resolve to a public address." })
        return
      }

      let crawlDepth: number | undefined
      if (b.crawlDepth !== undefined) {
        // Mirrors the schema CHECK (≤ 3) so the tenant sees a sentence, not
        // a constraint violation.
        if (typeof b.crawlDepth !== "number" || !Number.isInteger(b.crawlDepth) || b.crawlDepth < 0 || b.crawlDepth > 3) {
          res.status(422).json({ ok: false, error: "crawlDepth must be an integer from 0 to 3." })
          return
        }
        crawlDepth = b.crawlDepth
      }

      const sourceId = newId("src")
      const jobId = newId("job")
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("sources").values({
          id: sourceId,
          org_id: res.locals.orgId as string,
          kind: b.kind as "url" | "sitemap",
          location: parsed.href,
          ...(crawlDepth !== undefined ? { crawl_depth: crawlDepth } : {}),
        }).execute()
        await trx.insertInto("ingest_jobs").values({
          id: jobId,
          org_id: res.locals.orgId as string,
          source_id: sourceId,
        }).execute()
      })
      options.onEnqueue?.()

      res.json({ ok: true, sourceId, jobId })
    },
  )

  /** Remove a role's credential. Hard delete — see migration 004. */
  app.delete(
    "/internal/orgs/:orgId/credentials/:role",
    requireSecret,
    requireOrg,
    async (req: Request, res: Response) => {
      const role = typeof req.params.role === "string" ? req.params.role : ""
      if (role !== "generation" && role !== "embedding") {
        res.status(404).end()
        return
      }
      await db
        .deleteFrom("org_provider_credentials")
        .where("org_id", "=", res.locals.orgId as string)
        .where("role", "=", role)
        .execute()
      res.json({ ok: true })
    },
  )
}
//#endregion

//#region Exports
export { configureInternalRoutes }
export type { InternalRouteOptions }
//#endregion
