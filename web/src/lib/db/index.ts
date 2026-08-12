//#region Why this file
// One pg Pool wrapped in one Kysely instance — the same shape as
// realtime/src/db/pool.ts, tuned for where THIS process runs. On Vercel a
// "process" is a warm serverless instance: several can exist concurrently,
// each holding its own pool, and none is long-lived. Consequences:
//   * `max` is 3 where realtime uses 5. Neon's free tier is one small
//     compute, and the real ceiling is N warm instances × max — production
//     should point web at Neon's POOLED connection string (the -pooler
//     host), which multiplexes serverless clients server-side.
//   * Constructed eagerly at module load, like realtime. This is safe in a
//     Next build: pg defers actual connections until the first query, so
//     importing this module during `next build`'s page evaluation costs
//     nothing and needs no environment.
//   * Never explicitly ended. Serverless instances are frozen or killed by
//     the platform; idle connections are reaped by idleTimeoutMillis on our
//     side and by Neon's autosuspend on the other.
//
// Types come from @shared/db/schema — the SAME contract realtime queries
// against, moved to shared/ in M3.2 precisely so the two services cannot
// drift apart on what a table looks like. web never migrates the database;
// realtime's boot owns that (realtime/src/server.ts).
//#endregion

//#region Imports
import { Kysely, PostgresDialect } from "kysely"
import { Pool } from "pg"

import type { Database } from "@shared/db/schema"
//#endregion

//#region Pool + Kysely
// Env read at point of use, same house rule as realtime (§2.6: .env.example
// is the registry). In dev the values arrive via next.config.ts's repo-root
// .env loader; on Vercel via project env; in vitest via the shell.
const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "interrelated",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB ?? "interrelated",
  ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 3,
  idleTimeoutMillis: 30_000,
  // Bounds a dead database AND Neon's autosuspend wake, so an auth check
  // against a sleeping Neon fails fast instead of hanging a render.
  connectionTimeoutMillis: 5_000,
})

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})
//#endregion
