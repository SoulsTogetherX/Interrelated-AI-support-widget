//#region Why this file
// The pure half of the playground orchestrator (scripts/playground.mjs) —
// every decision that can be wrong in a way a unit test would catch, split
// from the half that spawns processes and opens sockets. The split is the
// eval/loadtest pattern (§7.3, §10.1) applied to a dev tool: the orchestrator
// is I/O glue, and the logic it delegates here — env layering, secret
// generation, dotenv parsing — is exactly where a silent mistake would cost
// someone an evening (a clobbered .env value, a regenerated master key that
// orphans every saved credential).
//
// Zero dependencies, like every root script: node stdlib only, and this
// module imports nothing at all so the tests need no setup.
//#endregion

//#region Dotenv
/**
 * Parses .env text with EXACTLY the semantics of web/next.config.ts's
 * loadRepoRootEnv — the loader the dashboard already trusts: skip blank and
 * #-comment lines, split on the FIRST "=", trim both halves, take values
 * verbatim (no quote stripping — the root .env never quotes, and a CRLF
 * there would already be a bug per .gitattributes; trim strips a stray \r
 * anyway). Mirroring matters because the playground injects what this
 * returns into children that ALSO run that loader: if the two parsers
 * disagreed about a line, the same variable could reach realtime and web
 * with different values.
 */
function parseDotenv(text) {
  const parsed = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const name = trimmed.slice(0, eq).trim()
    if (!name || parsed[name] !== undefined) continue
    parsed[name] = trimmed.slice(eq + 1).trim()
  }
  return parsed
}
//#endregion

//#region Secrets
/**
 * The three secrets the stack needs that .env.example ships empty, in the
 * exact shapes the services enforce:
 *   - CREDENTIAL_MASTER_KEY must decode to exactly 32 bytes of base64
 *     (realtime's vault refuses anything else at boot);
 *   - INTERNAL_API_SECRET must be ≥ 32 chars (server.ts refuses shorter);
 *   - WIDGET_TOKEN_SECRET must be ≥ 32 chars if set at all.
 * randomBytes is injected so tests can pin the output without stubbing
 * node:crypto globally.
 */
function generateSecrets(randomBytes) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    credentialMasterKey: randomBytes(32).toString("base64"),
    internalApiSecret: randomBytes(32).toString("base64url"),
    widgetTokenSecret: randomBytes(32).toString("base64url"),
  }
}

/**
 * Reads a persisted secrets file forward: a missing or unparseable file is
 * regenerated whole, and a file from an older version gains any missing
 * field without touching the ones that exist. The field that must NEVER be
 * silently regenerated is credentialMasterKey — it encrypts tenant provider
 * keys at rest, and credentials/resolve.ts throws loudly on a decrypt
 * failure, so a fresh key would break every answer for an org whose key was
 * saved in an earlier session. Field-by-field reconciliation is what lets a
 * future field arrive without invalidating that one.
 */
function reconcileSecrets(jsonText, randomBytes) {
  const fresh = generateSecrets(randomBytes)
  if (jsonText === null || jsonText === undefined) return { secrets: fresh, changed: true }
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { secrets: fresh, changed: true }
  }
  if (parsed === null || typeof parsed !== "object") return { secrets: fresh, changed: true }

  let changed = false
  const secrets = { ...parsed }
  for (const field of [
    "version",
    "createdAt",
    "credentialMasterKey",
    "internalApiSecret",
    "widgetTokenSecret",
  ]) {
    if (secrets[field] === undefined || secrets[field] === null || secrets[field] === "") {
      secrets[field] = fresh[field]
      changed = true
    }
  }
  return { secrets, changed }
}
//#endregion

//#region Env assembly
/**
 * The playground's one genuinely subtle decision: four layers into the env
 * map every child receives, with different rules per layer because the
 * variables mean different things.
 *
 *   1. process.env           — the shell always wins (the repo's stated
 *                              convention: web/next.config.ts and every
 *                              realtime CLI treat already-set as sacred).
 *   2. .env, fill-missing    — POSTGRES_*, provider keys, a deliberate
 *                              LLM_PROVIDER; the user's standing config.
 *   3. playground fill-missing — the persisted secret trio plus the wiring
 *                              (internal URL, public widget URL, demo key,
 *                              mock LLM, wake-driven worker). Fill-missing
 *                              because a user who configured any of these
 *                              deliberately owns the consequences.
 *   4. hard overrides        — the invariants of the playground itself,
 *                              applied even over the shell, each with a
 *                              warning naming old → new:
 *                              EMBEDDING_PROVIDER=local (the seed embeds
 *                              under this model and the chat route embeds
 *                              questions with the same app-level provider;
 *                              if they disagree the dense arm sees nothing
 *                              and every question refuses),
 *                              INGEST_WORKER=1 (crawls/uploads must ingest),
 *                              BACKEND_PORT=3000 and FIXTURE_PORT=4400 (the
 *                              fixture pages hardcode data-api=:3000 and the
 *                              seeded allowlist hardcodes :4400 — a moved
 *                              port silently 403s every mint).
 *
 * Returns warnings instead of printing them, so the caller owns the
 * console and the tests own the strings.
 */
const FILL_DEFAULTS = {
  DEMO_PUBLISHABLE_KEY: "pk_local_demo_widget_fixture_key0",
  REALTIME_INTERNAL_URL: "http://localhost:3000",
  NEXT_PUBLIC_WIDGET_API_URL: "http://localhost:3000",
  LLM_PROVIDER: "mock",
  INGEST_POLL_MS: "0",
  FORCE_COLOR: "1",
}

const HARD_OVERRIDES = {
  EMBEDDING_PROVIDER: "local",
  INGEST_WORKER: "1",
  BACKEND_PORT: "3000",
  FIXTURE_PORT: "4400",
}

function assembleEnv({ processEnv, dotenv, secrets }) {
  const warnings = []
  const env = { ...processEnv }

  for (const [name, value] of Object.entries(dotenv)) {
    if (env[name] === undefined) env[name] = value
  }

  const secretFills = {
    INTERNAL_API_SECRET: secrets.internalApiSecret,
    CREDENTIAL_MASTER_KEY: secrets.credentialMasterKey,
    WIDGET_TOKEN_SECRET: secrets.widgetTokenSecret,
  }
  // The divergence check runs BEFORE the fill: a master key the user set in
  // the shell or .env wins, but if it differs from the persisted one, any
  // provider key saved under the old key in a previous playground session
  // can no longer decrypt — resolve.ts throws rather than degrading, so the
  // symptom is every answer failing for that org. Name the fix.
  if (
    env.CREDENTIAL_MASTER_KEY !== undefined &&
    env.CREDENTIAL_MASTER_KEY !== "" &&
    env.CREDENTIAL_MASTER_KEY !== secrets.credentialMasterKey
  ) {
    warnings.push(
      "CREDENTIAL_MASTER_KEY is set in your environment and differs from .playground/secrets.json — " +
        "provider keys saved in earlier playground sessions cannot decrypt under it. " +
        "If the Providers page starts failing, delete and re-save the credential.",
    )
  }
  for (const [name, value] of Object.entries({ ...secretFills, ...FILL_DEFAULTS })) {
    // Empty string counts as unset for the secrets: .env.example ships
    // WIDGET_TOKEN_SECRET= (empty), and an empty secret is either refused at
    // boot (internal pair) or silently ephemeral (widget tokens) — neither
    // is what a playground wants.
    if (env[name] === undefined || env[name] === "") env[name] = value
  }

  for (const [name, value] of Object.entries(HARD_OVERRIDES)) {
    if (env[name] !== undefined && env[name] !== "" && env[name] !== value) {
      warnings.push(
        `${name}=${env[name]} overridden to ${value} — the playground's fixtures and seed depend on it`,
      )
    }
    env[name] = value
  }

  return { env, warnings }
}
//#endregion

//#region Seed-result protocol
/**
 * The web seed script prints one machine-readable line among its human
 * output: `PLAYGROUND_RESULT {json}`. Parsed from the LAST occurrence so a
 * re-run inside the same stream wins, and null (never a throw) on absence
 * or bad JSON — a seed that crashed mid-print should read as "no result",
 * and the orchestrator already surfaces the child's exit code and output.
 */
function parseSeedResult(stdout) {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith("PLAYGROUND_RESULT ")) continue
    try {
      return JSON.parse(line.slice("PLAYGROUND_RESULT ".length))
    } catch {
      return null
    }
  }
  return null
}
//#endregion

//#region Banner
/**
 * What the user sees once everything is up. A function of facts rather than
 * inline console.log calls so the round-trip is testable and the orchestrator
 * stays glue. `seed` is parseSeedResult's output or null (--skip-seed, or a
 * seed that failed soft).
 */
function buildBanner({ seed, llmProvider, skippedSeed }) {
  const credentialLine =
    seed === null
      ? "  sign in:    play@interrelated.local (seed skipped — credentials from your last run)"
      : seed.passwordChanged
        ? `  sign in:    ${seed.email} (with the password you set previously)`
        : `  sign in:    ${seed.email} / play-with-interrelated  (${seed.role} of the demo org)`

  return [
    "",
    "  ┌─────────────────────────────────────────────────────────────┐",
    "  │  Interrelated playground is up                              │",
    "  └─────────────────────────────────────────────────────────────┘",
    "",
    "  widget on a host page:  http://localhost:4400/fixtures/tailwind.html",
    "        other fixtures:   bootstrap.html · hostile.html · measure.html",
    "  dashboard:              http://localhost:3001",
    credentialLine,
    "  public demo page:       http://localhost:3000/demo",
    "",
    llmProvider === "mock"
      ? "  Answers come from a deterministic mock that quotes the retrieved docs —\n" +
        "  grounded, cited, and keyless. For real model answers, paste a free Groq\n" +
        "  or Gemini key in the dashboard's Providers page (that is the product's\n" +
        "  actual BYO flow), or set LLM_PROVIDER + a key in .env."
      : `  Answers come from LLM_PROVIDER=${llmProvider} (your .env).`,
    "",
    skippedSeed
      ? "  Seeding was skipped (--skip-seed): corpus and login are from your last run."
      : "  Seeded: the Fastify docs corpus (31 pages, real local embeddings).",
    "  The guided tour is in PLAYGROUND.md.",
    "",
    "  Stop with Ctrl-C (the database container stays up; stop it with",
    "  `docker compose stop database` — your data lives in its volume).",
    "",
  ].join("\n")
}
//#endregion

//#region Exports
export {
  parseDotenv,
  generateSecrets,
  reconcileSecrets,
  assembleEnv,
  parseSeedResult,
  buildBanner,
  FILL_DEFAULTS,
  HARD_OVERRIDES,
}
//#endregion
