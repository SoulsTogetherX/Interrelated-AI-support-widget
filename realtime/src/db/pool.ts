//#region Imports
import { Kysely, PostgresDialect } from "kysely"
import { Pool } from "pg"

import type { Database } from "@/db/schema"
//#endregion

//#region Constants
// One process-wide pool. Config is read from env at module load, at point of
// use (house style: no central config object — each module reads what it
// needs, and .env.example is the single documented registry of variables).
//
// connectionTimeoutMillis matters twice: it bounds how long /api/ready can
// hang when Postgres is down, and on Neon it covers the ~0.5–1s autosuspend
// wake without failing the first query after an idle period.
//
// max: 5 — Neon's free tier is one small compute; a bigger local pool just
// queues server-side. Render's single instance means this is also the
// process-global ceiling on DB concurrency, which is a feature: backpressure
// happens here, visibly, rather than inside Postgres.
const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "interrelated",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB ?? "interrelated",
  // Neon requires TLS; local Docker Postgres doesn't speak it. Flag rather
  // than sniffing the hostname, so the prod requirement is explicit.
  ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 5,
  connectionTimeoutMillis: 3_000,
})

// All application code queries through Kysely against the typed Database
// contract. Nothing issues raw pool.query — the typed builder is the whole
// point, and raw SQL lives only in migrations where DDL should be explicit.
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
//#endregion

//#region Exports
export { db }
// The raw pool is exported ONLY for shutdown (server.ts calls pool.end())
// and test teardown. If you find yourself importing it anywhere else, the
// answer is a typed query on `db`.
export default pool
//#endregion
