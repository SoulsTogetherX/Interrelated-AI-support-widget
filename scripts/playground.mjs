#!/usr/bin/env node
//#region Why this file
// `npm run playground` — the whole product, locally, in one command.
//
// Booting this stack by hand takes ~6 coordinated steps with wiring that is
// easy to get silently wrong: realtime's dev server does not read .env (its
// CLIs do — the asymmetry is documented in §3.11), the dashboard's inbox and
// providers pages degrade to setup notices unless INTERNAL_API_SECRET /
// REALTIME_INTERNAL_URL / NEXT_PUBLIC_WIDGET_API_URL are all set and AGREE
// across two processes, the seeded demo org has no dashboard login, and the
// /demo page's own origin is never allowlisted by seed-demo. This script
// owns all of that: preflight → database → widget build → three dev servers
// → two seeds → a banner with the URLs and credentials. Ctrl-C tears the
// servers down; the database container deliberately stays.
//
// Zero dependencies (node stdlib only), the scripts/ house rule. The pure
// logic — env layering, secret generation, dotenv parsing — lives in
// playground-core.mjs where the root vitest suite pins it; this file is the
// I/O glue around it.
//
// Child processes are spawned as DIRECT node entrypoints (tsx's cli.mjs,
// next's bin), never through npm scripts: an npm.cmd shim on Windows makes
// the recorded pid a wrapper whose death orphans the real servers — the
// exact failure mode that has left :3000/:3001 haunted in past sessions.
// With the true supervisor pid recorded, `taskkill /T` clears the tree.
//#endregion

//#region Imports
import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  parseDotenv,
  reconcileSecrets,
  assembleEnv,
  parseSeedResult,
  buildBanner,
} from "./playground-core.mjs"
//#endregion

//#region Constants
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SECRETS_PATH = join(ROOT, ".playground", "secrets.json")
const IS_WINDOWS = process.platform === "win32"

const PORTS = [
  { port: 3000, what: "realtime" },
  { port: 3001, what: "the dashboard" },
  { port: 4400, what: "the widget fixtures" },
]

/** Every path preflight requires, with the command that fixes its absence.
 *  Checked up front so the user gets ONE complete list instead of a new
 *  failure per re-run. fastembed is probed at the ROOT because
 *  providers/embedding/local.ts dynamic-imports it and resolution walks up
 *  from providers/ into the root package (§2.4.5c). */
const REQUIRED_PATHS = [
  { path: join(ROOT, "realtime", "node_modules", "tsx", "dist", "cli.mjs"), fix: "npm ci   (in realtime/)" },
  { path: join(ROOT, "web", "node_modules", "next", "dist", "bin", "next"), fix: "npm ci   (in web/)" },
  { path: join(ROOT, "web", "node_modules", "tsx", "dist", "cli.mjs"), fix: "npm ci   (in web/)" },
  { path: join(ROOT, "widget", "node_modules", "esbuild"), fix: "npm ci   (in widget/)" },
  { path: join(ROOT, "node_modules", "fastembed"), fix: "npm ci   (at the repo root)" },
]
//#endregion

//#region Child supervision
/** Live children, tracked for teardown. Entries: {tag, child}. */
const children = []
let shuttingDown = false

/** Prefixes each output line so four interleaved processes stay readable.
 *  Buffers partial lines: a chunk boundary mid-line would otherwise split a
 *  log statement across two prefixes. */
function pump(tag, stream, out, sink) {
  let buffer = ""
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let newline
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      out.write(`[${tag}] ${line}\n`)
      if (sink) sink.push(line)
      buffer = buffer.slice(newline + 1)
    }
  })
  stream.on("end", () => {
    if (buffer.length > 0) {
      out.write(`[${tag}] ${buffer}\n`)
      if (sink) sink.push(buffer)
    }
  })
}

/** Spawns a long-running child as a direct node entrypoint and registers it
 *  for teardown. Any child exiting while the playground is up tears the
 *  whole thing down — half a stack is worse than none. */
function startChild(tag, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  pump(tag, child.stdout, process.stdout)
  pump(tag, child.stderr, process.stderr)
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n[playground] ${tag} exited unexpectedly (code ${code}) — shutting down`)
      teardown(1)
    }
  })
  children.push({ tag, child })
  return child
}

/** Runs a one-shot child to completion, teeing its output through the
 *  prefixed pump while collecting stdout (the seed's PLAYGROUND_RESULT line
 *  travels in it). */
function runToCompletion(tag, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const lines = []
    pump(tag, child.stdout, process.stdout, lines)
    pump(tag, child.stderr, process.stderr)
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout: lines.join("\n") }))
  })
}

/** Kills one child's whole tree. On Windows, taskkill /T walks the tree from
 *  the recorded pid — which works precisely BECAUSE the pid is the real tsx/
 *  next supervisor, not an npm shim. Failures are ignored on purpose: a
 *  console Ctrl-C is delivered to every process in the group, so by the time
 *  this runs the pids are often already gone. */
function killTree(child) {
  if (child.exitCode !== null) return
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    try {
      child.kill("SIGTERM")
    } catch {
      // Already gone.
    }
  }
}

function teardown(code) {
  if (shuttingDown) process.exit(code)
  shuttingDown = true
  console.log("\n[playground] shutting down (the database container stays up)…")
  for (const { child } of children) killTree(child)
  if (!IS_WINDOWS) {
    // Give SIGTERM five seconds, then make sure. On Windows taskkill /F was
    // already unconditional.
    setTimeout(() => {
      for (const { child } of children) {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {
            // Already gone.
          }
        }
      }
      process.exit(code)
    }, 5000).unref()
  }
  setTimeout(() => process.exit(code), IS_WINDOWS ? 1500 : 6000).unref()
}

process.on("SIGINT", () => teardown(0))
process.on("SIGTERM", () => teardown(0))
// Last resort for paths that skip the handlers (mintty hard-kill, an
// uncaught throw): synchronously sweep whatever is still tracked.
process.on("exit", () => {
  for (const { child } of children) killTree(child)
})
//#endregion

//#region Preflight
function fail(lines) {
  console.error("\n[playground] cannot start:\n")
  for (const line of lines) console.error(`  ${line}`)
  console.error("")
  process.exit(1)
}

/** True if something is LISTENING on the port. A connect probe rather than a
 *  bind probe, because Windows lets a specific-address bind coexist with
 *  another process's wildcard listener — the bind would succeed while the
 *  port is very much taken. Orphaned dev servers accept connections, which
 *  is exactly the signal wanted. */
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const done = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1500, () => done(false))
  })
}

async function preflight() {
  const problems = []

  // Docker first: everything else is moot without it, and on this machine
  // Docker Desktop is routinely not running at session start.
  const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15000 })
  if (docker.status !== 0) {
    problems.push("Docker is not reachable. Start Docker Desktop, wait for the engine, and re-run.")
  }

  // .env: compose interpolates POSTGRES_* from it with no defaults of its
  // own, so its absence would fail later in a far less legible way. Copying
  // the example is byte-for-byte the README's step 1, and its placeholder
  // password provisions a working LOCAL container on a fresh volume.
  if (!existsSync(join(ROOT, ".env"))) {
    copyFileSync(join(ROOT, ".env.example"), join(ROOT, ".env"))
    console.log("[playground] no .env found — copied .env.example (placeholder values, fine for local use)")
  }

  const missing = REQUIRED_PATHS.filter(({ path }) => !existsSync(path))
  if (missing.length > 0) {
    problems.push("dependencies are not installed:")
    for (const { fix } of new Set(missing.map((m) => m.fix))) problems.push(`  ${fix}`)
  }

  for (const { port, what } of PORTS) {
    if (await portBusy(port)) {
      problems.push(
        `port ${port} (${what}) is already in use — likely an orphaned dev server. Find and kill it:`,
      )
      problems.push(
        IS_WINDOWS
          ? `  netstat -ano | findstr :${port}    then    taskkill /pid <PID> /T /F`
          : `  lsof -i :${port}    then    kill <PID>`,
      )
    }
  }

  if (problems.length > 0) fail(problems)
}
//#endregion

//#region Steps
function ensureSecrets() {
  let existing = null
  try {
    existing = readFileSync(SECRETS_PATH, "utf8")
  } catch {
    // First run.
  }
  const { secrets, changed } = reconcileSecrets(existing, randomBytes)
  if (changed) {
    mkdirSync(dirname(SECRETS_PATH), { recursive: true })
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2) + "\n")
    console.log(`[playground] wrote ${existing === null ? "new" : "updated"} secrets to .playground/secrets.json (gitignored)`)
  }
  return secrets
}

async function startDatabase(env) {
  console.log("[playground] starting the database container…")
  const up = spawnSync("docker", ["compose", "up", "-d", "database"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    timeout: 120000,
  })
  if (up.status !== 0) fail(["`docker compose up -d database` failed — see its output above."])

  // pg_isready inside the container: container-name-agnostic (compose picks
  // the name) and true readiness rather than merely an open TCP port, which
  // Postgres exposes during startup before it will take connections.
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const probe = spawnSync("docker", ["compose", "exec", "-T", "database", "pg_isready"], {
      cwd: ROOT,
      env,
      stdio: "ignore",
      timeout: 10000,
    })
    if (probe.status === 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  fail(["the database container never became ready (90s). `docker compose logs database` has the story."])
}

function buildWidget() {
  console.log("[playground] building the widget bundle…")
  // The one npm-shim spawn, acceptable because it EXITS: the esbuild arg
  // list should keep living in widget/package.json rather than drifting
  // into a second copy here.
  const build = spawnSync("npm run build", { cwd: join(ROOT, "widget"), stdio: "inherit", shell: true, timeout: 120000 })
  if (build.status !== 0) fail(["the widget build failed — see its output above."])
}

/** Polls an HTTP URL until `accept` passes, racing the child's own exit so a
 *  crash surfaces as "it exited" (with its output already pumped above)
 *  instead of a silent timeout. */
async function waitFor(url, { child, accept, timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail([`${label} exited (code ${child.exitCode}) before becoming ready — its output is above.`,
        "If it died at migrate with a Postgres auth error, your .env's POSTGRES_PASSWORD does not",
        "match the existing database volume: restore the old password, or `docker compose down -v`",
        "(DESTROYS local data) and re-run."])
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (await accept(response)) return
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  fail([`${label} did not become ready within ${timeoutMs / 1000}s (${url}).`])
}
//#endregion

//#region Main
async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help")) {
    console.log([
      "usage: npm run playground [-- --skip-seed]",
      "",
      "Boots the whole product locally: database (Docker) + realtime (:3000) +",
      "dashboard (:3001) + widget fixtures (:4400), seeds the Fastify demo corpus",
      "and a dashboard login, and prints where everything is.",
      "",
      "  --skip-seed   keep the existing corpus and login (faster re-boot;",
      "                seeding re-embeds ~660 chunks with the local model)",
    ].join("\n"))
    return
  }
  const skipSeed = argv.includes("--skip-seed")

  await preflight()
  const secrets = ensureSecrets()

  let dotenvText = ""
  try {
    dotenvText = readFileSync(join(ROOT, ".env"), "utf8")
  } catch {
    // preflight copies .env.example, so this is unreachable in practice.
  }
  const { env, warnings } = assembleEnv({
    processEnv: process.env,
    dotenv: parseDotenv(dotenvText),
    secrets,
  })
  for (const warning of warnings) console.log(`[playground] note: ${warning}`)

  await startDatabase(env)
  buildWidget()

  console.log("[playground] starting realtime (:3000)…")
  const realtime = startChild(
    "rt",
    [join(ROOT, "realtime", "node_modules", "tsx", "dist", "cli.mjs"), "watch", "src/server.ts"],
    join(ROOT, "realtime"),
    env,
  )
  // Realtime first and alone: it runs the migrations, and both seeds and the
  // dashboard need the schema to exist.
  await waitFor("http://localhost:3000/api/ready", {
    child: realtime,
    accept: async (r) => r.ok && (await r.json()).ok === true,
    timeoutMs: 120000,
    label: "realtime",
  })
  console.log("[playground] realtime is ready (migrations applied)")

  console.log("[playground] starting the dashboard (:3001) and fixtures (:4400)…")
  const web = startChild(
    "web",
    [join(ROOT, "web", "node_modules", "next", "dist", "bin", "next"), "dev", "-p", "3001"],
    join(ROOT, "web"),
    env,
  )
  const fixtures = startChild(
    "fx",
    [join(ROOT, "widget", "scripts", "serve.mjs")],
    join(ROOT, "widget"),
    env,
  )

  let seed = null
  if (!skipSeed) {
    console.log("[playground] seeding the demo corpus (31 Fastify docs pages, local embeddings — first run also downloads the ~30 MB model)…")
    const startedAt = Date.now()
    const demo = await runToCompletion(
      "seed",
      [join(ROOT, "realtime", "node_modules", "tsx", "dist", "cli.mjs"), "scripts/seedWidgetDemo.ts", "--corpus", "fastify"],
      join(ROOT, "realtime"),
      env,
    )
    if (demo.code !== 0) fail(["seed-demo failed — its output is above."])
    const play = await runToCompletion(
      "seed",
      [join(ROOT, "web", "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.json", "scripts/seedPlayground.ts"],
      join(ROOT, "web"),
      env,
    )
    if (play.code !== 0) fail(["seed-playground failed — its output is above."])
    seed = parseSeedResult(play.stdout)
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    console.log(`[playground] seeded in ${seconds}s${seconds > 45 ? " — next time, `npm run playground -- --skip-seed` skips this" : ""}`)
  }

  await waitFor("http://localhost:4400/fixtures/tailwind.html", {
    child: fixtures,
    accept: async (r) => r.ok,
    timeoutMs: 20000,
    label: "the fixture server",
  })
  await waitFor("http://localhost:3001/", {
    child: web,
    accept: async (r) => r.status < 500,
    timeoutMs: 180000,
    label: "the dashboard",
  })

  console.log(buildBanner({ seed, llmProvider: env.LLM_PROVIDER, skippedSeed: skipSeed }))
  // From here the pumps narrate and the exit handlers supervise.
}

void main().catch((error) => {
  console.error("[playground]", error)
  teardown(1)
})
//#endregion
