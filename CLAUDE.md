# Interrelated — architecture reference

This is the file-by-file deep dive. It exists so Xavier can understand every
part of the system without reverse-engineering it from source, and so code
comments and the README can cite sections by number ("see CLAUDE.md §3.2").
It is updated as part of every step's definition of done — if a file exists
and is not described here, that is a documentation bug.

Companion documents:
- `DATAFLOW.md` — end-to-end traces of each request path.
- `~/.claude/plans/ticklish-forging-clover.md` — the approved project plan
  (milestones, metrics, risks). This file describes what IS; the plan
  describes what WILL BE.

**Current milestone: M0 (skeleton, CI, deploy).** Everything below exists and
is tested. Packages that appear in the plan but not here (web/, widget/,
providers/, eval/, loadtest/) do not exist yet — they arrive in M1–M4.

---

## §1 Project rules

### §1.1 Git
Exactly two branches: `main` and `dev`. All commits land on `dev`, only when
Xavier asks for them; `main` advances only by a merge he requests. No
force-push, no history rewriting.

### §1.2 Build discipline
Additive increments on a green tree. Nothing proceeds on a red build; every
new behavior lands with a test that would fail without it. A step that can't
finish cleanly is reverted, not parked.

### §1.3 House style
2-space indent, no semicolons, double quotes, `//#region` folding markers,
PascalCase component directories (later, in web/), camelCase modules,
comments that explain WHY (including rejected alternatives), and hand-written
DB types kept in lockstep with raw-SQL migrations (§3.1).

---

## §2 Repo root

### §2.1 `package.json` + `vitest.config.ts` (root)
The root is a tooling package only: it owns the test runner for `shared/`
(which deliberately has no package.json, §2.4) and nothing else. Application
packages own their dependencies individually — this repo is a *flat* layout
joined by TypeScript path aliases, **not** an npm workspace. Rejected
alternative: Turborepo/pnpm workspaces — a new failure surface with zero
benefit at this scale, and the flat shape matches the proven OnlineWhiteboard
structure.

### §2.2 `.gitattributes`
Forces LF endings everywhere. Load-bearing, not boilerplate: a CRLF ending
inside `.env` once corrupted a Postgres password inside a Linux container on
a sibling project (the password became `value\r`). Docker bind mounts do not
normalize line endings; the repo does.

### §2.3 `.gitignore` / `.dockerignore`
Standard, with two deliberate entries: `PHASE_NOTES.md` (private working
notes never reach the public repo) and — in `.dockerignore` — `.env`,
because the realtime image builds with the repo root as context, and secrets
in a build context can end up in image layers, which leak.

### §2.4 `shared/`
Cross-package code with **no package.json and no build step**. Consumers
import it through the `@shared/*` path alias; whatever compiles the consumer
(tsx in dev, esbuild for the bundle, Next/Vite later) compiles shared/ along
with it. This is why `shared/tsconfig.json` is the strictest in the repo —
there is no build boundary to catch its errors before a consumer does. It is
also why shared/ must stay **dependency-free**: it can't declare
dependencies, so it must not need any.

#### §2.4.1 `shared/utils/ids.ts`
Entity id generation: `<prefix>_<32 chars Crockford base32>`, 160 bits of
entropy. Prefixed ids (`org_…`, `usr_…`) make logs and foreign keys
self-describing — in a multi-tenant system, a mixed-up id is a cross-tenant
bug, and the prefix turns that into a loud failure (`isId("org", userId)` is
false). Crockford base32 (no `i l o u`) survives case-insensitive contexts
and double-click selection; the fixed total length lets the schema enforce
`char_length` CHECKs against hand-fabricated ids. The encoder is hand-rolled
(15 lines) because shared/ is dependency-free by construction.
`newId`'s prefix union is **closed** — adding an entity type means touching
this file, keeping the registry in one reviewable place.

### §2.5 `.env.example`
The single documented registry of every environment variable the system
reads. Rule: a module reading an env var not documented here is a bug in the
module. Note the `POSTGRES_PORT` comment — on machines with a native
Postgres on 5432 (like Xavier's), the compose database publishes on 5433;
containers always use `database:5432` internally (§4.2).

---

## §3 `realtime/` — the data plane

Express 5 + Kysely + pg, CommonJS, bundled to a single `dist/server.js` by
esbuild. This package will grow the SSE chat path (M2), ingest worker (M1),
and handoff WebSocket (M4); at M0 it is the boot spine those will hang off.

### §3.1 `src/db/schema.ts`
Hand-written Kysely types for every table. **kysely-codegen was rejected**
while the schema is young: regenerating churns diffs and can't carry the WHY
comments. The contract: any migration touching a table updates this file in
the same change. Notable typing choices: timestamps are
`ColumnType<Date, string | Date, …>` (pg returns Date; JSON callers insert
ISO strings); `plan` and `role` are string-literal unions so a typo is a
compile error rather than a runtime constraint violation; `created_at`
insert type includes `undefined` because the DB default owns it.

### §3.2 `src/db/pool.ts`
One process-wide `pg.Pool` wrapped in one Kysely instance. Config read from
env at point of use (house style — `.env.example` is the registry, §2.5).
`connectionTimeoutMillis: 3000` bounds both `/api/ready` under a dead DB and
Neon's autosuspend wake. `max: 5` because Neon free tier is one small
compute — a larger client pool would just queue server-side; keeping the
queue client-side makes backpressure visible. The raw pool is exported for
shutdown/teardown only; **all queries go through the typed `db`**.

### §3.3 `src/db/migrations/001_initial_schema.ts`
Raw SQL DDL via Kysely's `sql` tag (the builder is for application queries;
DDL should read as the SQL it is). Typed `Kysely<unknown>` so migrations
stay frozen while `schema.ts` evolves. Creates:

| Table | Purpose | Notable constraint |
|---|---|---|
| `organizations` | tenants | `plan` CHECK; `char_length(id) = 36` |
| `users` | dashboard logins | email stored encrypted + blind index (code in M3; columns now because retrofitting encryption is a data migration) |
| `org_members` | user↔org + role | **partial unique index: one owner per org** |
| `sessions` | dashboard sessions | id IS sha256(cookie token) — a DB leak can't be replayed as logins |
| `api_keys` | widget pk/sk credentials | one CHECK makes kind/column mismatches unrepresentable; uniqueness among live keys only (`WHERE revoked_at IS NULL`) so rotation revokes instead of deletes |
| `allowed_origins` | widget origin allowlist | regex CHECK rejects paths/trailing slashes — a stored `https://a.com/` would silently never match a browser `Origin` header |

Also `CREATE EXTENSION IF NOT EXISTS vector` — in migration 001 even though
no vector column exists until M1, so a Postgres without pgvector fails at
deploy time, not at first ingest weeks later.

### §3.4 `src/db/migrate.ts`
An `ExplicitMigrationProvider`: migrations are registered by import in a
`MIGRATIONS` record, not discovered from disk. Kysely's stock
`FileMigrationProvider` would find nothing in production, because the prod
artifact is one esbuild bundle with no migrations directory. The registry
doubles as the ordered, reviewable list; the migrate test counts bookkeeping
rows against it, so forgetting to register a migration fails CI.
(`Kysely<any>` in the signature: Kysely's type parameter is invariant, so
`Kysely<Database>` doesn't flow into `Kysely<unknown>`; `any` is the escape
hatch Kysely's own docs use for migrators.)

### §3.5 `src/routes/health.ts`
Two probes with deliberately different contracts:
- **`GET /api/health` — liveness, NEVER touches Postgres.** Render's health
  check and the keepalive cron (§5.2) both depend on that property; the
  whole free-tier design hinges on it (a DB-touching keepalive would burn
  Neon's ~100 CU-hour monthly budget).
- **`GET /api/ready` — readiness, `SELECT 1`.** Proves the service↔DB path
  (and therefore that migrations ran). Bounded to a fast 503 by the pool's
  connection timeout. The 503 body says `ok:false` and nothing else —
  failure detail on a public endpoint is reconnaissance.

### §3.6 `src/app.ts`
Builds the Express app without binding a port, so tests can drive it on an
ephemeral port while server.ts owns boot. `trust proxy: 1` (Render sits one
proxy hop away; needed for honest `req.ip` when rate limits arrive in M2);
JSON bodies capped at 64 KB (no route needs more; a big limit is a free
memory-pressure lever).

### §3.7 `src/server.ts`
Boot order is a contract: **migrate, then listen** — a process that can't
reach the schema it was built for must not accept traffic; a migration
failure exits nonzero so the orchestrator restarts with backoff. The http
server is created explicitly (not `app.listen`) because M4 attaches the
WebSocket upgrade handler to the same server object. Shutdown: SIGTERM →
stop accepting → drain pool → exit; a second signal force-exits.

### §3.8 Tests (`src/**/__tests__/`)
- `routes/__tests__/health.test.ts` — drives the real HTTP listener via
  `fetch` on an ephemeral port. Environment-adaptive: with
  `POSTGRES_PASSWORD` set, `/api/ready` must 200; without, it must 503
  *fast* (the sub-second health assertion also guards "someone added a DB
  call to the liveness route").
- `db/__tests__/migrate.test.ts` — integration suite, self-gated on
  `POSTGRES_PASSWORD` (green on a machine with no DB, lights up in compose/
  CI). Asserts: all tables exist, pgvector installed, idempotent re-run,
  bookkeeping matches the registry, and the three interesting constraints
  reject invalid rows **at their boundaries** (second owner rejected while
  second agent accepted; mismatched api_key kind; origin with a trailing
  slash).

### §3.9 `realtime/Dockerfile`
Multi-stage on node:22-alpine, **build context = repo root** (shared/ must
exist inside the image). `deps → dev → build → prod`. Prod runs
`npm ci --omit=dev` + the bundle, as `USER node`, with a busybox-wget
healthcheck on `/api/health`, and `CMD ["node", "dist/server.js"]` — plain
node, not `npm start`, because npm swallows SIGTERM and would turn graceful
shutdown into a 10-second kill.

---

## §4 `database/` and compose

### §4.1 `database/Dockerfile`
`FROM pgvector/pgvector:pg18` — the pgvector project's official layer over
Postgres 18. One line of intent; compiling the extension into
postgres:18-alpine ourselves was rejected as maintenance for no gain.

### §4.2 `docker-compose.yaml` (dev)
Hot-reload stack: database + realtime (target `dev`, tsx watch) with
`./realtime/src` and `./shared` bind-mounted. Postgres publishes
`${POSTGRES_PORT:-5432} → 5432` so host-side `npm test` can reach it;
containers always use `database:5432` internally. Two hard-won details:
- The data volume mounts at **`/var/lib/postgresql`** (not `…/data`): the
  PG18 image moved the convention up a level; the old path makes the
  container refuse to initialize.
- `depends_on.condition: service_healthy` — realtime migrates immediately at
  boot, and racing Postgres init would make every `up` a coin flip.

### §4.3 `docker-compose.prod.yaml`
Production shape: prod image target, no bind mounts, Postgres **not**
published to the host. This is the stack CI's e2e job boots — the artifact
probed is the artifact shipped.

---

## §5 `.github/workflows/`

### §5.1 `ci.yml`
`verify` (10-min timeout): pgvector service container + per-package
`npm ci` → typecheck → test; the DB-gated suites run for real here. `e2e`
(needs verify): generates a throwaway `.env`, `compose -f prod up --build
--wait`, runs `scripts/smoke-test.mjs` against the live stack, dumps logs on
failure, always tears down. **No API keys anywhere in CI, by design** — fork
PRs get the full pipeline.

### §5.2 `keepalive.yml`
Every 10 minutes, curl `RENDER_URL/api/health` — defeats Render's 15-minute
free-tier spin-down so a recruiter never eats a 60-second cold start. Pings
the DB-free liveness route on purpose (§3.5); Neon is woken later by the
widget's open-handshake (M2), not by this cron. Gated on the `RENDER_URL`
repo variable so it no-ops until the service exists.

---

## §6 `scripts/`

### §6.1 `scripts/smoke-test.mjs`
Zero-dependency probe (Node 22 stdlib only — runs without `npm install`,
pointable at any base URL including production). Checks health, readiness,
and that unknown routes 404. Failures are counted rather than thrown so one
broken endpoint doesn't mask the state of the rest; every fetch carries a
timeout because a probe that can hang turns a dead service into a stuck CI
job.
