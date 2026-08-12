//#region Why this file
// The dashboard's READ side for provider credentials, straight from
// Postgres. The iron rule this file exists to make greppable: NO query in
// web/ ever selects key_ciphertext. The column list below is the complete
// set of things the dashboard may know about a credential — the suffix is
// the only fragment of the key among them, stored separately at save time
// precisely so display never touches ciphertext. (The internal API has a
// matching status route for ops/curl use; page renders read the database
// directly so a realtime outage cannot blank the settings page.)
//#endregion

//#region Imports
import { db } from "@/lib/db"
//#endregion

//#region Types
export interface CredentialDisplay {
  role: "generation" | "embedding"
  provider: string
  model: string | null
  baseUrl: string | null
  suffix: string | null
  lastValidatedAt: Date | null
  lastValidation: string | null
}
//#endregion

//#region Queries
export async function listCredentialDisplay(orgId: string): Promise<CredentialDisplay[]> {
  const rows = await db
    .selectFrom("org_provider_credentials")
    .select(["role", "provider", "model", "base_url", "key_suffix", "last_validated_at", "last_validation"])
    .where("org_id", "=", orgId)
    .orderBy("role")
    .execute()
  return rows.map((r) => ({
    role: r.role,
    provider: r.provider,
    model: r.model,
    baseUrl: r.base_url,
    suffix: r.key_suffix,
    lastValidatedAt: r.last_validated_at,
    lastValidation: r.last_validation,
  }))
}
//#endregion
