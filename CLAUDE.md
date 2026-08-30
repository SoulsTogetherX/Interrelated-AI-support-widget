# Interrelated — working rules

An embeddable AI support widget SaaS whose defining decision is that the
model's claims are **verified by code, not trusted**. This file is the
always-loaded constitution: the rules, the map, and where everything else
lives. It is deliberately small (2026-08 org overhaul — research target:
<200 lines). Depth lives in `docs/reference/`; history in
`docs/history.md`.

## The documents

| Doc                                          | What it is                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `docs/`                                      | The guided reading path: purpose, architecture, flows, usage, glossary                  |
| `docs/reference/`                            | The §-numbered file-by-file architecture reference (lookup table below)                 |
| `docs/history.md`                            | The milestone narrative. **Append-only**: new milestones are recorded there, never here |
| `DATAFLOW.md`                                | Function-level traces of every request path                                             |
| `README.md`                                  | The public face — claims no number a committed script does not produce                  |
| `PLAYGROUND.md`                              | Hands-on local tour, no API keys                                                        |
| `~/.claude/plans/ticklish-forging-clover.md` | The project plan (what WILL be; these docs are what IS)                                 |

## Project rules (canonical text: §1, `docs/reference/01-project-rules.md`)

- **Git**: exactly two branches, `main` and `dev`. All commits to `dev`,
  only when Xavier asks; `main` advances only by a squash-merge he
  requests. No force-push, no history rewriting.
- **Build discipline**: additive increments on a green tree. Every new
  behavior lands with a test that would fail without it. A step that
  cannot finish cleanly is reverted, not parked.
- **The verification ladder** per increment: typecheck + `npm run lint` →
  unit tests → integration tests against real Postgres → and for anything
  touching migrations, boot, Dockerfiles or compose: rebuild the prod
  compose stack and re-run the smoke probe. Anything touching a public
  surface, the trust model, or the answer path also re-runs the security
  and injection probes exactly as CI's e2e job does (commands: §4.4).
- **Docs are part of done**: a source file not described in
  `docs/reference/` is a documentation bug. Milestone summaries append to
  `docs/history.md`.

## The enforcement layer (the linter is the law; docs explain why — §11)

Root scripts: `format` · `format:check` · `lint` · `lint:fix` ·
`depcruise` · `knip`. The CI job `quality` gates format, lint,
architecture and dead code; lefthook runs format:check and lint on
pre-push.

- **Style is Prettier's** (`semi: false`, double quotes, 2-space, width 100) — never hand-argue with it. Beyond the formatter: `//#region`
  folding markers, comments explain WHY (including rejected alternatives),
  camelCase modules, PascalCase component directories.
- **Complexity is an error** (cyclomatic 15, cognitive 15, params 4,
  depth 4). **Size is a warn budget** (1000/file, 200/function, comments
  excluded) — a breach is a signal to look; the split criterion is
  cohesion ("two audiences or two reasons to change"), never the number
  alone. 25 pre-existing hot spots carry dated inline disables: simplify
  them when touched, never grow them.
- **Architecture is `.dependency-cruiser.cjs`**: shared/ is
  dependency-free (type-only imports allowed) · providers/ imports only
  shared/ · widget/ takes types only from shared/ (sole value exception:
  `shared/handoff/protocol.ts`) · web/ never imports providers/ or
  realtime/ · production never imports `__tests__` · value cycles
  forbidden.
- **Tests are exempt from size rules on purpose** (DAMP over DRY);
  `vitest/no-focused-tests` is the error class there. Probes and
  measurement harnesses are exempt from complexity/size: single-file
  zero-dependency design is their point.
- **Escape hatch**: `eslint-disable-next-line` WITH a dated reason after
  `--`. Never a silent config widening.
- **Applied migrations are frozen** — `.claude/hooks/guard-migrations.mjs`
  (PreToolUse) blocks edits to existing files in
  `realtime/src/db/migrations/`; add a new `NNN_*.ts`, register it in
  `migrate.ts`, update `shared/db/schema.ts` in the same change.
- Per-area conventions load contextually from `.claude/rules/*.md`.

## Repo map

| Dir          | What                                                                                                                          | Runtime deps                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `realtime/`  | Express 5 data plane: widget API, SSE answers, WebSocket handoff, ingest worker, migrations (sole schema owner), internal API | express, pg+kysely, undici, htmlparser2, ws, unpdf |
| `web/`       | Next.js 16 dashboard (Vercel): auth, orgs, credentials, sources, transcripts, inbox, metrics, billing                         | next, react, pg+kysely                             |
| `widget/`    | Vanilla-TS chat bubble → one IIFE, 6.5 KB gz, 15 KB CI budget                                                                 | **zero**                                           |
| `shared/`    | Cross-package contracts: claims+verifier, chunker, RRF, protocol, schema types, plans, pricing, ids                           | **zero** (no package.json — by design)             |
| `providers/` | LLMProvider/EmbeddingProvider + adapters (mock, Groq, Gemini, Ollama, OpenAI-compat, Anthropic; local bge)                    | zero (heavy deps via dynamic import)               |
| `eval/`      | Frozen corpus (**never reformat `eval/corpus/`** — its bytes anchor the golden set), golden sets, scorers, RESULTS.md         | —                                                  |
| `loadtest/`  | Socket load harness + RESULTS.md                                                                                              | —                                                  |
| `scripts/`   | Zero-dependency probes: smoke, security, injection, widget-size, TTFT, playground                                             | —                                                  |
| `database/`  | Postgres 18 + pgvector image                                                                                                  | —                                                  |

Flat layout joined by tsconfig aliases (`@shared/*`, `@providers/*`,
`@/*`); deliberately **not** npm workspaces.

## Commands

```
npm run playground                # whole product, one command, keyless
docker compose up -d database     # just Postgres (:5433 on the host)
cd realtime && npm run dev        # data plane :3000 (worker needs INGEST_WORKER=1)
cd web && npm run dev             # dashboard :3001
npm test / npm run typecheck:*    # root: shared+providers+eval+loadtest suites
```

Vitest does NOT read `.env` — export it for DB-gated suites, with only the
`database` compose service up (a live realtime container steals queued
jobs). `.env.example` is the registry of every env var; a module reading an
undocumented variable is a bug in that module.

## § lookup — where the reference sections live

| §                                                                                                                                          | File                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| §1 project rules                                                                                                                           | `docs/reference/01-project-rules.md`        |
| §2 repo root, `shared/`, `providers/` (adapters §2.4.5\*)                                                                                  | `docs/reference/02-shared-and-providers.md` |
| §3 realtime: db §3.1–3.4 · ingest §3.10 · retrieval §3.12 · answers §3.15 · routes §3.18/§3.22 · handoff §3.23–3.25 · harnesses §3.29–3.31 | `docs/reference/03-realtime.md`             |
| §4 database image, compose stacks, probe stack §4.4                                                                                        | `docs/reference/04-database-and-compose.md` |
| §5 CI + keepalive workflows                                                                                                                | `docs/reference/05-ci.md`                   |
| §6 probes: smoke §6.1 · size §6.2 · security §6.3 · injection §6.4 · playground §6.5 · TTFT §6.6                                           | `docs/reference/06-scripts.md`              |
| §7 corpus, golden sets, scorers, provider comparison §7.9–7.10                                                                             | `docs/reference/07-eval.md`                 |
| §8 widget internals + fixtures                                                                                                             | `docs/reference/08-widget.md`               |
| §9 web: auth §9.4–9.6 · pages §9.7–9.12 · metrics §9.13 · billing §9.15 · keys §9.17/§9.19                                                 | `docs/reference/09-web.md`                  |
| §10 loadtest                                                                                                                               | `docs/reference/10-loadtest.md`             |
| §11 the enforcement layer (configs, thresholds, grandfathering)                                                                            | `docs/reference/11-enforcement.md`          |

Section numbers are stable forever: ~350 code comments and both trace
documents cite them. New reference content gets new numbers; renumbering
is forbidden.
