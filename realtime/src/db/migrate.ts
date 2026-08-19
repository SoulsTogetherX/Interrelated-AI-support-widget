//#region Imports
import { Migrator } from "kysely"
import type { Kysely, Migration, MigrationProvider, MigrationResultSet } from "kysely"

import * as migration001 from "@/db/migrations/001_initial_schema"
import * as migration002 from "@/db/migrations/002_handoff"
import * as migration003 from "@/db/migrations/003_answer_tokens"
import * as migration004 from "@/db/migrations/004_usage_daily"
import * as migration005 from "@/db/migrations/005_billing"
import * as migration006 from "@/db/migrations/006_origin_daily"
import * as migration007 from "@/db/migrations/007_secret_keys"
import * as migration008 from "@/db/migrations/008_skipped_pages"
import * as migration009 from "@/db/migrations/009_source_uploads"
//#endregion

//#region Type Defs
// Kysely ships a FileMigrationProvider that discovers migrations by reading
// a directory at runtime. That is exactly wrong for this deployment: the
// production artifact is ONE esbuild bundle, and there is no migrations
// directory on disk to discover. So migrations are registered here by
// explicit import — esbuild inlines them into the bundle, and the registry
// doubles as a reviewable, ordered list. Forgetting to register a new
// migration is caught by the migrate test, which counts applied migrations.
class ExplicitMigrationProvider implements MigrationProvider {
  constructor(private readonly registry: Record<string, Migration>) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    return this.registry
  }
}
//#endregion

//#region Constants
// Keys sort lexicographically to determine execution order — keep the
// NNN_ prefix zero-padded. Add new migrations at the bottom, never reorder.
//
// 001 is a FLATTENED baseline: the five migrations that built the schema
// through M3 were collapsed into it (001_initial_schema explains the trade
// and the one-time reset an already-migrated database needs). That was a
// one-off; from 002 onward this list only ever grows.
const MIGRATIONS: Record<string, Migration> = {
  "001_initial_schema": migration001,
  "002_handoff": migration002,
  "003_answer_tokens": migration003,
  "004_usage_daily": migration004,
  "005_billing": migration005,
  "006_origin_daily": migration006,
  "007_secret_keys": migration007,
  "008_skipped_pages": migration008,
  "009_source_uploads": migration009,
}
//#endregion

//#region Exports
/**
 * Applies every unapplied migration, in order, inside Kysely's migration
 * bookkeeping (it maintains its own kysely_migration table). Called from
 * server.ts BEFORE listen(): a process that cannot reach the schema it was
 * built against must not accept traffic, so a migration failure throws and
 * aborts boot rather than limping.
 *
 * Kysely<any>, not Kysely<unknown>: Kysely's type parameter is invariant, so
 * the application's Kysely<Database> is not assignable to Kysely<unknown>.
 * `any` is the escape hatch Kysely's own migration docs use — the migrator
 * runs raw SQL and never touches the typed query surface, so nothing is
 * actually lost.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: new ExplicitMigrationProvider(MIGRATIONS) })
  const resultSet = await migrator.migrateToLatest()
  if (resultSet.error) throw resultSet.error
  return resultSet
}

export { migrateToLatest, MIGRATIONS }
//#endregion
