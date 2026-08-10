//#region Imports
import type { ColumnType, Generated } from "kysely"
//#endregion

//#region Type Defs
// Hand-written schema types, kept in lockstep with the raw-SQL migrations by
// review rather than by codegen. kysely-codegen was considered and rejected
// while the schema is young: regenerating on every migration churns diffs,
// and the generator's output can't carry the WHY comments these types do.
// The deal: any migration that touches a table updates this file in the same
// change, or the change doesn't merge.
//
// Timestamp columns use ColumnType<Date, string | Date, string | Date>:
// pg returns Date on select, but inserts/updates may pass ISO strings
// (e.g. from JSON payloads) without a lying cast.

/** A dashboard tenant. Everything in the system hangs off an organization. */
interface OrganizationsTable {
  id: string
  name: string
  /** Billing tier. Enforced by CHECK in the migration; typed here so a typo
   *  like "prem" is a compile error, not a runtime constraint violation. */
  plan: Generated<"free" | "starter" | "pro">
  /** Optional tone/persona text prepended to the org's answer prompts. Lives
   *  on the org (not per-source) because it is part of the CACHEABLE prompt
   *  prefix — see the prompt-assembly notes in CLAUDE.md when M2 lands. */
  system_persona: string | null
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** A dashboard login. Email is encrypted at rest (AES-GCM) with a separate
 *  deterministic blind index for lookups — the same at-rest scheme as the
 *  provider keys, so one leaked backup discloses neither. Auth code arrives
 *  in M3; the columns exist from migration 001 because retrofitting
 *  encryption onto plaintext emails means a data migration under load. */
interface UsersTable {
  id: string
  /** HMAC of the normalized email under a server-held key. UNIQUE. Lookups
   *  compute the HMAC and match this column; the ciphertext is never scanned. */
  email_index: string
  /** AES-256-GCM ciphertext of the email, nonce prepended, base64. */
  email_ciphertext: string
  /** scrypt hash in the Node crypto format (N=2^15,r=8,p=1 baked into the
   *  stored string so parameters can be raised without a rehash migration). */
  password_hash: string
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Membership joins users to organizations. Exactly one owner per org,
 *  enforced by a partial unique index in the migration. */
interface OrgMembersTable {
  org_id: string
  user_id: string
  role: "owner" | "agent"
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Dashboard sessions. The id IS the sha256 of the cookie token — the raw
 *  token exists only in the user's cookie, so a database leak alone cannot
 *  be replayed as a login. */
interface SessionsTable {
  id: string
  user_id: string
  expires_at: ColumnType<Date, string | Date, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Widget credentials. Two kinds:
 *  - "public": the pk_… value pasted into the customer's <script> tag.
 *    Identifies the org; deliberately not a secret (see the trust-model
 *    section of CLAUDE.md).
 *  - "secret": the sk_… value for server-side session minting. Only its
 *    sha256 is stored, same reasoning as sessions.id.
 *  Revocation is a timestamp, not a delete, so rotation keeps an audit trail
 *  and old keys can serve through a grace window. */
interface ApiKeysTable {
  id: string
  org_id: string
  kind: "public" | "secret"
  /** The literal pk_… value. NULL for secret keys. Uniqueness among live
   *  keys is a partial index (WHERE revoked_at IS NULL) so a rotated-out
   *  value could in principle be reissued later without a conflict. */
  public_id: string | null
  /** sha256 hex of the sk_… value. NULL for public keys. */
  secret_hash: string | null
  last_used_at: ColumnType<Date | null, never, string | Date>
  revoked_at: ColumnType<Date | null, never, string | Date>
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** Origin allowlist: the set of exact origins allowed to mint widget
 *  sessions for an org. Exact match only — wildcard matching is a common
 *  source of allowlist bypasses (e.g. a suffix check that admits
 *  evil-example.com for example.com), so it is unrepresentable here. */
interface AllowedOriginsTable {
  org_id: string
  /** Scheme + host + optional port, e.g. "https://docs.example.com". */
  origin: string
  created_at: ColumnType<Date, string | Date | undefined, never>
}

/** The Kysely database contract. Every query in the codebase is typed
 *  against this interface — a column typo is a compile error. */
interface Database {
  organizations: OrganizationsTable
  users: UsersTable
  org_members: OrgMembersTable
  sessions: SessionsTable
  api_keys: ApiKeysTable
  allowed_origins: AllowedOriginsTable
}
//#endregion

//#region Exports
export type {
  Database,
  OrganizationsTable,
  UsersTable,
  OrgMembersTable,
  SessionsTable,
  ApiKeysTable,
  AllowedOriginsTable,
}
//#endregion
