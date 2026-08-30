//#region Imports

import { newId } from "@shared/utils/ids"

import { sql } from "kysely"

import { db } from "@/db/pool"
import {
  buildEmbeddingProvider,
  buildGenerationProvider,
  checkCredentialInput,
  effectiveEmbeddingModel,
  testEmbeddingRoundTrip,
  testGenerationRoundTrip,
} from "@/credentials/validate"
import { encryptProviderKey, keySuffix } from "@/credentials/vault"

import type { Transaction } from "kysely"
import type { Express, Request, Response } from "express"
import type { Database } from "@/db/schema"
//#endregion

import type { InternalGuards, InternalRouteOptions } from "./types"

//#region Re-indexing
/**
 * Queues a fresh crawl of every source an org has, and returns how many.
 *
 * Why an embedding-credential change MUST do this: chunk vectors are stored
 * per (chunk, model), and retrieval's dense arm filters `model = …`. Change
 * the embedding model and the existing corpus does not become wrong — it
 * becomes INVISIBLE, and the groundedness gate then refuses every question
 * because no dense evidence exists (answer/gate.ts fails closed on
 * lexical-only retrievals, by design). That reads to a tenant as "the
 * widget stopped working", which is the worst way to learn about a
 * consequence the product could simply handle.
 *
 * The re-crawl is what pays for it, together with the worker's short-circuit
 * fix (§3.10.5): unchanged pages are re-embedded — and ONLY re-embedded —
 * when their chunks have no vectors under the current model.
 *
 * Sources that already have work queued are skipped (a second job would
 * crawl the same site twice for one outcome), and uploads are skipped
 * because the worker fails them by design — manufacturing a job that is
 * guaranteed to fail is not progress. The skip is decided by the read below
 * AND enforced by 008's one-live-job-per-source index with ON CONFLICT DO
 * NOTHING: a Re-crawl click landing between the read and the insert must not
 * turn a unique violation into a rolled-back credential save.
 */
async function enqueueReindex(trx: Transaction<Database>, orgId: string): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    SELECT s.id FROM sources s
    WHERE s.org_id = ${orgId}
      AND s.kind <> 'upload'
      AND NOT EXISTS (
        SELECT 1 FROM ingest_jobs j
        WHERE j.source_id = s.id AND j.state IN ('queued', 'running')
      )
  `.execute(trx)
  if (rows.length === 0) return 0
  const inserted = await trx
    .insertInto("ingest_jobs")
    .values(rows.map((row) => ({ id: newId("job"), org_id: orgId, source_id: row.id })))
    .onConflict((oc) =>
      oc.column("source_id").where("state", "in", ["queued", "running"]).doNothing(),
    )
    .returning("id")
    .execute()
  return inserted.length
}
//#endregion

//#region Routes
/** The credential vault's HTTP face: test-or-save, status, remove —
 *  §3.21/§3.22. Handler bodies are verbatim from the pre-split file. */
function registerCredentialRoutes(
  app: Express,
  options: InternalRouteOptions,
  guards: InternalGuards,
): void {
  const vet = options.vetBaseUrl
  const { requireSecret, requireOrg } = guards

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

      const input = checked.value
      // One branch, two roles: both build an adapter from the same checked
      // input and both spend one real call on the tenant's provider before
      // anything is stored. The embedding trip additionally reports the
      // dimension it observed — see testEmbeddingRoundTrip for why that
      // number is worth a column.
      const trip =
        input.role === "generation"
          ? await testGenerationRoundTrip(buildGenerationProvider(input), options.testTimeoutMs)
          : await testEmbeddingRoundTrip(buildEmbeddingProvider(input), options.testTimeoutMs)
      if (!trip.ok) {
        res.status(422).json({ ok: false, error: trip.error })
        return
      }

      const summary =
        trip.dim !== undefined
          ? `${trip.model}, ${trip.dim}-d, ${trip.latencyMs}ms`
          : `${trip.model}, ${trip.latencyMs}ms`
      if (body.save === false) {
        res.json({
          ok: true,
          saved: false,
          model: trip.model,
          latencyMs: trip.latencyMs,
          ...(trip.dim !== undefined ? { dim: trip.dim } : {}),
        })
        return
      }

      const id = newId("prv")
      let reindexed = 0
      // Replace-by-delete inside one transaction: the UNIQUE(org_id, role)
      // row simply ceases to exist for the old key (§3.3.3 explains
      // why superseded ciphertexts are not retained).
      await db.transaction().execute(async (trx) => {
        const previous = await trx
          .selectFrom("org_provider_credentials")
          .select(["provider", "model"])
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", input.role)
          .executeTakeFirst()
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
            dim: trip.dim ?? null,
            key_ciphertext:
              input.apiKey !== undefined ? encryptProviderKey(input.apiKey, id) : null,
            key_suffix: input.apiKey !== undefined ? keySuffix(input.apiKey) : null,
            last_validated_at: new Date(),
            last_validation: summary,
          })
          .execute()

        // A new embedding MODEL orphans everything already indexed (the
        // dense arm filters on model), so the corpus is re-queued in the
        // same transaction that changed the credential — never one without
        // the other. An unchanged model (re-pasting a rotated key for the
        // same model) costs nothing.
        if (input.role === "embedding") {
          const previousModel =
            previous !== undefined
              ? effectiveEmbeddingModel(previous.provider, previous.model)
              : null
          if (previousModel !== trip.model) {
            reindexed = await enqueueReindex(trx, res.locals.orgId as string)
          }
        }
      })
      if (reindexed > 0) options.onEnqueue?.()

      res.json({
        ok: true,
        saved: true,
        model: trip.model,
        latencyMs: trip.latencyMs,
        ...(trip.dim !== undefined ? { dim: trip.dim } : {}),
        reindexed,
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
          "dim",
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
      let reindexed = 0
      await db.transaction().execute(async (trx) => {
        const removed = await trx
          .deleteFrom("org_provider_credentials")
          .where("org_id", "=", res.locals.orgId as string)
          .where("role", "=", role)
          .executeTakeFirst()
        // Removing an embedding credential reverts the org to the
        // app-level model, which is a model CHANGE like any other — the
        // corpus has to follow it or the widget goes quiet. Only when a row
        // was actually deleted: a no-op delete must not queue crawls.
        if (role === "embedding" && Number(removed.numDeletedRows) > 0) {
          reindexed = await enqueueReindex(trx, res.locals.orgId as string)
        }
      })
      if (reindexed > 0) options.onEnqueue?.()
      res.json({ ok: true, reindexed })
    },
  )
}
//#endregion

//#region Exports
export { registerCredentialRoutes }
//#endregion
