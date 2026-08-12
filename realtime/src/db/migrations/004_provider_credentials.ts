//#region Why this migration
// The BYO-provider feature's storage: one row per (org, role) holding the
// tenant's AI provider configuration with the API key AES-256-GCM encrypted
// under a server-held master key (credentials/vault.ts). The dashboard
// writes these through realtime's internal API — the ONLY surface that ever
// sees the plaintext, and only in transit; nothing web-side stores it.
//
// Two deliberate choices worth their comments below:
//   * UNIQUE(org_id, role) with HARD DELETE on replace/remove, not the
//     revoked_at soft-state api_keys uses. A widget pk is OUR credential —
//     an audit trail of rotations is an asset. A provider key is SOMEONE
//     ELSE'S credential — retaining superseded ciphertexts of a tenant's
//     Groq key is pure liability (one more thing a master-key compromise
//     unlocks), so replacement destroys the old row. The plan sketched a
//     partial unique over active rows; this is that intent with less
//     retained secret material.
//   * CHECKs make invalid provider shapes unrepresentable (the api_keys
//     pattern): ollama is unauthenticated so it must NOT carry a key;
//     everything else must. Self-hosted shapes (ollama, openai_compatible)
//     must carry a base_url; hosted ones must not (their endpoints are
//     pinned in code — a writable base_url on a hosted provider would be a
//     request-forgery lever, not a feature).
//#endregion

//#region Imports
import { sql } from "kysely"

import type { Kysely } from "kysely"
//#endregion

//#region Migration
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE org_provider_credentials (
      id             TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role           TEXT NOT NULL CHECK (role IN ('generation', 'embedding')),
      provider       TEXT NOT NULL CHECK (provider IN
                       ('groq', 'gemini', 'ollama', 'openai_compatible', 'anthropic')),
      -- NULL means "the provider's default model" where one exists; the
      -- validate layer requires an explicit model where no sane default
      -- does (openai_compatible, ollama).
      model          TEXT,
      base_url       TEXT,
      -- v1.<iv>.<tag>.<ciphertext> base64, AAD = this row's id (a ciphertext
      -- moved to another row fails to decrypt — same binding as email-at-rest).
      key_ciphertext TEXT,
      -- Last 4 characters of the plaintext key, for "…a3f9" display. The
      -- ONLY fragment of the key that exists outside the ciphertext.
      key_suffix     TEXT,
      last_validated_at TIMESTAMPTZ,
      -- Human-readable summary of the last successful validation round-trip
      -- ("llama-3.3-70b-versatile, 412ms") — dashboard display, never parsed.
      last_validation   TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (org_id, role),
      -- Key presence by provider: ollama is unauthenticated (a key would be
      -- a lie); hosted providers require one; openai_compatible goes either
      -- way (hosted compat APIs use keys, self-hosted vLLM/LM Studio often
      -- run keyless).
      CHECK (
        CASE provider
          WHEN 'ollama' THEN key_ciphertext IS NULL
          WHEN 'openai_compatible' THEN TRUE
          ELSE key_ciphertext IS NOT NULL
        END
      ),
      CHECK ((key_ciphertext IS NULL) = (key_suffix IS NULL)),
      -- Self-hosted shapes need an endpoint; hosted endpoints are pinned in
      -- code and must not be overridable per-row.
      CHECK ((provider IN ('ollama', 'openai_compatible')) = (base_url IS NOT NULL))
    )
  `.execute(db)

  await sql`
    CREATE INDEX org_provider_credentials_org
      ON org_provider_credentials (org_id)
  `.execute(db)
}
//#endregion
