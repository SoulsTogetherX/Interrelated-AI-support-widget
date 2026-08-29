//#region Why this file
// The READ side of the vault: org → configured, ready-to-call provider.
// This is where "per-org encrypted credentials replace the LLM_PROVIDER
// env stopgap" (§3.15.4's promise) actually happens: the widget chat route
// calls this per ANSWER, the key decrypts in memory for exactly the
// lifetime of the request, and the constructed adapter is discarded with
// it. Since M3.6b the embedding role resolves the same way, for the ingest
// worker (per job) and the query path (per answer).
//
// Per-call on purpose, NO cache: a rotated or removed credential must
// take effect on the very next question (a cache would serve a revoked key
// until eviction — the exact window rotation exists to close), and the
// cost is one indexed row read plus an AES-GCM decrypt of <1 KB —
// nanoseconds against the provider's own network latency.
//
// Absence is a NORMAL state (the demo org, a fresh org): callers fall back
// to the app-level provider. Decrypt failure is NOT normal — a stored
// credential that cannot decrypt means key rotation broke or the row was
// tampered with — so it throws loudly rather than silently degrading to
// the mock, which would look like the product working while serving
// nonsense.
//#endregion

//#region Imports
import { buildEmbeddingProvider, buildGenerationProvider } from "./validate"
import { decryptProviderKey } from "./vault"

import type { Kysely } from "kysely"
import type { Database } from "@shared/db/schema"
import type { LLMProvider } from "@providers/llm/types"
import type { EmbeddingProvider } from "@providers/embedding/types"
import type { CredentialInput } from "./validate"
//#endregion

//#region Row → input
/** Fetches one role's credential and turns it into the shape the builders
 *  take. Returns null when the org has none — the fallback path. */
async function loadCredential(
  db: Kysely<Database>,
  orgId: string,
  role: "generation" | "embedding",
): Promise<{ input: CredentialInput; dim: number | null } | null> {
  const row = await db
    .selectFrom("org_provider_credentials")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("role", "=", role)
    .executeTakeFirst()
  if (!row) {
    return null
  }
  // Since M7.8 the schema's provider union and the adapters that exist are
  // the SAME five, so there is no unimplemented-provider branch here any
  // more — the row is handed to the builder whatever it names, and a
  // pairing the builders cannot serve (an anthropic EMBEDDING row) is
  // already unrepresentable: checkCredentialInput refuses it by name and
  // buildEmbeddingProvider throws by name if a row ever appears anyway.
  return {
    input: {
      role,
      provider: row.provider,
      apiKey:
        row.key_ciphertext !== null ? decryptProviderKey(row.key_ciphertext, row.id) : undefined,
      baseUrl: row.base_url ?? undefined,
      model: row.model ?? undefined,
    },
    dim: row.dim,
  }
}
//#endregion

//#region Resolution
export async function resolveGenerationProvider(
  db: Kysely<Database>,
  orgId: string,
): Promise<LLMProvider | null> {
  const loaded = await loadCredential(db, orgId, "generation")
  return loaded === null ? null : buildGenerationProvider(loaded.input)
}

/**
 * The org's embedding provider, or null to fall back to the app-level one.
 *
 * The stored dim is passed straight through: it was measured by the Test
 * round-trip, so from here on every response is checked against it rather
 * than trusted (providers/embedding/http.ts's assertBatch). A row without
 * one is unrepresentable — §3.3.3's CHECK ties dim to the embedding
 * role — so the fallback is defensive only, and lets the adapter
 * rediscover rather than refuse.
 *
 * The load-bearing property this function buys: the ingest worker and the
 * query path both call it, so a tenant's chunks and their visitors'
 * questions land in the SAME vector space by construction. Nothing else in
 * the system enforces that agreement.
 */
export async function resolveEmbeddingProvider(
  db: Kysely<Database>,
  orgId: string,
): Promise<EmbeddingProvider | null> {
  const loaded = await loadCredential(db, orgId, "embedding")
  if (loaded === null) {
    return null
  }
  return buildEmbeddingProvider(loaded.input, loaded.dim ?? undefined)
}
//#endregion
