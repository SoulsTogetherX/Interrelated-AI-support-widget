//#region Imports
import { sql } from "kysely"
import type { Kysely } from "kysely"
//#endregion

//#region Migration
// Migration 001 — tenancy, auth, and widget-credential tables, plus the
// pgvector extension.
//
// Raw SQL via the sql tag, not the Kysely schema builder: DDL should be
// explicit and reviewable as the SQL it actually is. The query builder is
// for application queries, where the type system earns its keep.
//
// The extension is created HERE, in the very first migration, even though no
// vector column exists until M1. Rationale: boot fails immediately on any
// Postgres that lacks pgvector (wrong Docker image, misconfigured Neon
// project), at deploy time, instead of failing at first ingest three weeks
// from now. Fail-fast beats fail-later, and the extension is idempotent.
//
// Typed as Kysely<unknown>: migrations must not import the application's
// Database types, because a migration is frozen at the moment it ships while
// schema.ts keeps evolving. Coupling them would make old migrations fail to
// compile against future types.

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db)

  // ── Tenancy ──────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE organizations (
      id             TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      plan           TEXT NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'starter', 'pro')),
      system_persona TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // ── Auth (columns now, code in M3 — encryption at rest cannot be
  //    retrofitted without a data migration, so the shape is right from
  //    day one) ─────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE users (
      id               TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      email_index      TEXT NOT NULL UNIQUE,
      email_ciphertext TEXT NOT NULL,
      password_hash    TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE TABLE org_members (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    )
  `.execute(db)

  // Exactly one owner per organization. A partial unique index states the
  // business rule in the schema, where it cannot be forgotten by a code
  // path; application code that tries to add a second owner gets a loud
  // constraint violation instead of silently corrupting ownership.
  await sql`
    CREATE UNIQUE INDEX org_members_one_owner
      ON org_members (org_id) WHERE role = 'owner'
  `.execute(db)

  // Session id IS sha256(cookie token): a leaked database cannot be replayed
  // as logins, because the raw token never touches the server's storage.
  await sql`
    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY CHECK (char_length(id) = 64),
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX sessions_user ON sessions (user_id)`.execute(db)

  // ── Widget credentials ───────────────────────────────────────────────────
  // The kind/column pairing is enforced with one CHECK: public keys carry a
  // public_id and no secret_hash; secret keys the reverse. A row violating
  // that is not "unusual data", it is a bug — so it is unrepresentable.
  await sql`
    CREATE TABLE api_keys (
      id           TEXT PRIMARY KEY CHECK (char_length(id) = 36),
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK (kind IN ('public', 'secret')),
      public_id    TEXT,
      secret_hash  TEXT CHECK (secret_hash IS NULL OR char_length(secret_hash) = 64),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (kind = 'public' AND public_id IS NOT NULL AND secret_hash IS NULL) OR
        (kind = 'secret' AND public_id IS NULL     AND secret_hash IS NOT NULL)
      )
    )
  `.execute(db)

  // Uniqueness among LIVE public keys only: rotation revokes rather than
  // deletes (audit trail + grace window), and a revoked row must not block
  // the namespace forever.
  await sql`
    CREATE UNIQUE INDEX api_keys_public_id_live
      ON api_keys (public_id) WHERE revoked_at IS NULL
  `.execute(db)

  await sql`CREATE INDEX api_keys_org ON api_keys (org_id)`.execute(db)

  // ── Origin allowlist ─────────────────────────────────────────────────────
  // Exact origins only. The CHECK rejects trailing slashes and paths at the
  // boundary, because "https://a.com/" !== "https://a.com" in a string
  // comparison and that mismatch would read as "allowlist mysteriously
  // doesn't work" in production.
  await sql`
    CREATE TABLE allowed_origins (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      origin     TEXT NOT NULL CHECK (origin ~ '^https?://[^/]+$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, origin)
    )
  `.execute(db)
}

async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse dependency order. The extension is left installed: other
  // databases on the same server may use it, and DROP EXTENSION is the kind
  // of collateral damage a down() should never risk.
  await sql`DROP TABLE IF EXISTS allowed_origins`.execute(db)
  await sql`DROP TABLE IF EXISTS api_keys`.execute(db)
  await sql`DROP TABLE IF EXISTS sessions`.execute(db)
  await sql`DROP TABLE IF EXISTS org_members`.execute(db)
  await sql`DROP TABLE IF EXISTS users`.execute(db)
  await sql`DROP TABLE IF EXISTS organizations`.execute(db)
}
//#endregion

//#region Exports
export { up, down }
//#endregion
