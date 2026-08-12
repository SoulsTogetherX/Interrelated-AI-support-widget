//#region Why this file
// The READ side of the vault: org → configured, ready-to-call LLMProvider.
// This is where "per-org encrypted credentials replace the LLM_PROVIDER
// env stopgap" (§3.15.4's promise) actually happens: the widget chat route
// calls this per ANSWER, the key decrypts in memory for exactly the
// lifetime of the request, and the constructed adapter is discarded with
// it.
//
// Per-answer on purpose, NO cache: a rotated or removed credential must
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
import { buildCredentialProvider } from "./validate"
import { decryptProviderKey } from "./vault"

import type { Kysely } from "kysely"
import type { Database } from "@shared/db/schema"
import type { LLMProvider } from "@providers/llm/types"
import type { CredentialInput } from "./validate"
//#endregion

//#region Resolution
export async function resolveGenerationProvider(
  db: Kysely<Database>,
  orgId: string,
): Promise<LLMProvider | null> {
  const row = await db
    .selectFrom("org_provider_credentials")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("role", "=", "generation")
    .executeTakeFirst()
  if (!row) {
    return null
  }
  // The schema's provider union is wider than the adapters that exist
  // (anthropic is forward provision — migration 004); a row naming an
  // unimplemented provider is unreachable through validate.ts, so hitting
  // one here is corruption worth a loud stop.
  if (row.provider === "anthropic") {
    throw new Error("anthropic credentials have no adapter yet")
  }
  const input: CredentialInput = {
    role: "generation",
    provider: row.provider,
    apiKey:
      row.key_ciphertext !== null
        ? decryptProviderKey(row.key_ciphertext, row.id)
        : undefined,
    baseUrl: row.base_url ?? undefined,
    model: row.model ?? undefined,
  }
  return buildCredentialProvider(input)
}
//#endregion
