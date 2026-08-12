//#region Imports
import { Migrator } from "kysely"
import type { Kysely, Migration, MigrationProvider, MigrationResultSet } from "kysely"

import * as migration001 from "@/db/migrations/001_initial_schema"
import * as migration002 from "@/db/migrations/002_content_pipeline"
import * as migration003 from "@/db/migrations/003_chat"
import * as migration004 from "@/db/migrations/004_provider_credentials"
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
const MIGRATIONS: Record<string, Migration> = {
  "001_initial_schema": migration001,
  "002_content_pipeline": migration002,
  "003_chat": migration003,
  "004_provider_credentials": migration004,
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
