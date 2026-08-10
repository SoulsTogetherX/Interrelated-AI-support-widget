#!/usr/bin/env node
// Neon credential tester — verifies the four connection values in ../.env.neon
// against the live Neon database, and prints a diagnosis that NEVER contains
// the password. Run from the realtime/ directory:
//
//   node scripts/check-neon.mjs
//
// Why this exists: a failed Render deploy takes minutes per attempt and its
// logs can't tell you WHICH value is wrong. This tests locally in seconds and
// names the broken field. It lives in realtime/scripts (not the zero-dep
// probe folder) because it needs the pg driver from realtime's node_modules.

//#region Imports
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import pg from "pg"
//#endregion

//#region Parse .env.neon
const here = dirname(fileURLToPath(import.meta.url))
// Optional path argument so the script's own checks can be exercised against
// fixture files without touching the real .env.neon.
const envPath = process.argv[2] ?? join(here, "..", "..", ".env.neon")

/** Neon passwords look like npg_…; anything of that shape is masked in ALL
 *  output regardless of which field it sits in — a value in the wrong slot
 *  is exactly when accidental disclosure happens. */
function display(value) {
  return /^npg_/.test(value) ? `npg_… (${value.length} chars, not shown)` : value
}

let raw
try {
  raw = readFileSync(envPath, "utf8")
} catch {
  console.error(`could not read ${envPath}\nFill in .env.neon at the repo root first (see its comments).`)
  process.exit(1)
}

const values = {}
const warnings = []
for (const line of raw.split("\n")) {
  const stripped = line.replace(/\r$/, "")
  if (!stripped || stripped.startsWith("#")) continue
  const eq = stripped.indexOf("=")
  if (eq === -1) continue
  const key = stripped.slice(0, eq).trim()
  const rawValue = stripped.slice(eq + 1)
  const value = rawValue.trim()
  // Whitespace that trim() removed is EXACTLY the class of invisible bug
  // that produces 28P01 with a "correct" password — surface it loudly.
  if (value !== rawValue) {
    warnings.push(`${key}: had leading/trailing whitespace (removed here — if you pasted the same value into Render, re-paste it without the space)`)
  }
  values[key] = value
}

const host = values.POSTGRES_HOST
const user = values.POSTGRES_USER
const password = values.POSTGRES_PASSWORD
const database = values.POSTGRES_DB

//#region Sanity checks before touching the network
const fatals = []
for (const [key, v] of Object.entries({ POSTGRES_HOST: host, POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database })) {
  if (!v || v.startsWith("paste-")) fatals.push(`${key}: still the placeholder — fill it in`)
}
if (password) {
  if (password.startsWith("postgresql://")) fatals.push("POSTGRES_PASSWORD: you pasted the WHOLE connection string — the password is only the part between ':' and '@'")
  if (/^["'].*["']$/.test(password)) fatals.push("POSTGRES_PASSWORD: wrapped in quotes — remove them; the quotes became part of the password")
  if (password.includes("@") || password.includes(":")) fatals.push("POSTGRES_PASSWORD: contains ':' or '@' — looks like a fragment of the connection string, not the bare password")
}
if (host && (host.includes("@") || host.includes("/") || host.startsWith("postgresql"))) {
  fatals.push("POSTGRES_HOST: should be ONLY the hostname (ep-…aws.neon.tech) — no protocol, no '@', no '/'")
}
// Swap detection: a password-shaped value in any non-password slot means the
// fields were mapped wrong, and connecting would both fail AND risk printing
// a secret under a non-secret label.
if (database?.startsWith("npg_")) {
  fatals.push("POSTGRES_DB looks like a PASSWORD (npg_…) — the database and password values appear SWAPPED. In postgresql://USER:PASSWORD@HOST/DB, the password sits before the '@', the database name after the final '/'. (The database is usually 'neondb'.)")
}
if (user?.startsWith("npg_")) {
  fatals.push("POSTGRES_USER looks like a PASSWORD (npg_…) — fields appear swapped; the user is usually 'neondb_owner'.")
}
if (host && host.includes("-pooler")) {
  warnings.push("POSTGRES_HOST: this is the POOLED host (-pooler). Use the direct host for this project (remove '-pooler')")
}
if (fatals.length) {
  console.log("Problems found before even connecting:\n")
  for (const f of fatals) console.log("  ✗ " + f)
  process.exit(1)
}
//#endregion

//#region Connect
console.log(`host:     ${display(host)}`)
console.log(`user:     ${display(user)}`)
console.log(`database: ${display(database)}`)
console.log(`password: (${password.length} chars, never shown)`)
for (const w of warnings) console.log("  ⚠ " + w)
console.log("\nconnecting…")

const client = new pg.Client({
  host, user, password, database,
  port: 5432,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 8_000,
})

try {
  await client.connect()
  const who = await client.query("SELECT current_user, version()")
  console.log(`\n✓ AUTH OK — connected as ${who.rows[0].current_user}`)
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  )
  if (tables.rows.length === 0) {
    console.log("✓ database is empty (expected before the first successful deploy)")
  } else {
    console.log(`✓ tables present: ${tables.rows.map((r) => r.table_name).join(", ")}`)
  }
  console.log("\nThese exact four values are correct. Paste them into Render's")
  console.log("Environment tab (re-type, don't assume they match), save, and deploy.")
} catch (err) {
  console.log("\n✗ connection failed — diagnosis:")
  const code = err.code ?? ""
  if (code === "28P01") {
    console.log("  password authentication failed: host, user, and TLS are all FINE;")
    console.log("  the PASSWORD is wrong. Re-copy it from Neon (copy button, current")
    console.log("  connection string — a reset invalidates every older string).")
  } else if (code === "3D000") {
    console.log(`  the database name '${database}' does not exist on this server — re-check POSTGRES_DB`)
  } else if (code === "28000") {
    console.log(`  the user '${user}' was rejected — re-check POSTGRES_USER`)
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    console.log(`  the host '${host}' does not resolve — re-check POSTGRES_HOST.`)
    console.log("  If you deleted and recreated the Neon project, the host CHANGED.")
  } else if (code === "ETIMEDOUT" || err.message?.includes("timeout")) {
    console.log("  connection timed out — network problem, or the host is wrong")
  } else {
    console.log(`  unexpected error (code ${code || "none"}): ${err.message}`)
  }
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
//#endregion
