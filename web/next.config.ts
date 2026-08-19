import type { NextConfig } from "next"
import { readFileSync } from "node:fs"
import path from "node:path"

//#region Repo-root .env loader
// The repo keeps ONE .env at its root (.env.example is the documented
// registry, CLAUDE.md §2.6), but Next only reads env files inside web/. A
// second env file per package would drift, so dev loads the root one here —
// next.config is evaluated at the very start of `next dev`/`next build`,
// before any worker forks, and children inherit the mutated process.env.
// Rules, matching realtime's CLI fallback (§3.11): already-set variables
// ALWAYS win (so Vercel project env and shell overrides are untouched), and
// a missing file is a silent no-op (on Vercel it does not exist). Values are
// taken verbatim — no quote stripping, because the root .env never quotes
// (and a CRLF would already be a bug there, per .gitattributes).
function loadRepoRootEnv(): void {
  let text: string
  try {
    text = readFileSync(path.join(__dirname, "..", ".env"), "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const name = trimmed.slice(0, eq).trim()
    if (!name || process.env[name] !== undefined) continue
    process.env[name] = trimmed.slice(eq + 1).trim()
  }
}

loadRepoRootEnv()
//#endregion

// The config itself is deliberately near-empty: the defaults are correct for
// this app, and every option added here is one more thing to explain. Two
// exceptions:
//
// outputFileTracingRoot points at the REPO root, not this package. shared/
// lives one directory up and is imported through the @shared/* alias with no
// build step of its own (CLAUDE.md §2.4) — Next's standalone output tracing
// has to be told the true project root or traced files outside web/ would be
// dropped. It also silences Next's "multiple lockfiles" root-inference
// warning, which this flat multi-package layout triggers by construction.
//
// serverActions.bodySizeLimit: a Server Action request is capped at 1 MB by
// default, and the file-upload action (M7.6b, §9.9) carries the file itself.
// Deliberately set ABOVE realtime's 10 MB upload cap rather than at it: when
// Next enforces this limit the action never runs, so the tenant would get a
// framework error instead of the sentence naming the actual number. The
// headroom leaves realtime's 413 — and the form's own client-side check —
// as the things that answer an oversized file.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, ".."),
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
}

export default nextConfig
