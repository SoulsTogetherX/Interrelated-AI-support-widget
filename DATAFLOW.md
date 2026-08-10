# Interrelated — dataflow traces

End-to-end walks of every path through the system, naming the actual file and
function at each hop. `CLAUDE.md` describes what each file *is*; this
document describes what *happens*, in order, when something occurs. Updated
as part of every step's definition of done.

**Current milestone: M1 — in progress.** Two request paths exist: boot and
the health probes. The schema (migration 002) and the library layer — the
chunker (`shared/chunking`), vector utilities (`shared/utils/vectors`), and
embedding providers (`providers/embedding`) — exist and are tested but are
not yet wired into any request path. They join here as one trace when the
ingest worker lands (M1.3): source → crawl → parse → chunk → embed → store.
Coming after: widget question → grounded answer (M2), dashboard auth (M3),
handoff (M4).

---

## §1 Health probes

### §1.1 Liveness — `GET /api/health`

```
caller (Render health check | keepalive cron | smoke probe | human)
  → Express routing                      realtime/src/app.ts createApp()
  → handler                              realtime/src/routes/health.ts configureHealthRoutes()
  → res.json({ ok: true, uptime_s })     no other calls — returns immediately
```

The handler touches nothing but `process.uptime()`. **No database, no
network, no disk.** Three consumers depend on exactly that:

1. **Render's health check** — a Postgres blip must not cause a restart of a
   healthy process.
2. **The keepalive cron** (`.github/workflows/keepalive.yml`) hits this every
   10 minutes to defeat Render's 15-minute spin-down. Because the route is
   DB-free, Neon stays asleep — pinging any DB-touching route on this
   schedule would keep Neon's compute awake ~730 h/month against a ~100
   CU-hour free budget.
3. **The Docker HEALTHCHECK** in `realtime/Dockerfile`.

### §1.2 Readiness — `GET /api/ready`

```
caller (smoke probe | compose --wait | human debugging)
  → Express routing                      realtime/src/app.ts createApp()
  → handler                              realtime/src/routes/health.ts configureHealthRoutes()
  → sql`SELECT 1`.execute(db)            realtime/src/routes/health.ts
      → Kysely acquires a connection     realtime/src/db/pool.ts (db)
        → pg.Pool: reuse idle conn, or dial POSTGRES_HOST:POSTGRES_PORT
          · success → 200 { ok: true }
          · failure (refused / timeout / bad auth)
              → caught in handler → 503 { ok: false }   ← reason logged
                                                          server-side only,
                                                          never echoed
```

Timing contract: the pool's `connectionTimeoutMillis: 3000`
(`realtime/src/db/pool.ts`) bounds the failure path — a dead database
produces a 503 in ≤3 s, never a hang. A 200 here proves the full
service → network → Postgres → auth → query path, which transitively proves
migrations ran (boot would have exited otherwise, §2).

On Neon, the first `/api/ready` after an idle period absorbs the ~0.5–1 s
autosuspend wake inside that same 3 s budget.

---

## §2 Boot

What happens between `node dist/server.js` (prod) / `tsx watch src/server.ts`
(dev) and the service accepting traffic:

```
process start
  → module loads                         realtime/src/server.ts
      → pool + db constructed             realtime/src/db/pool.ts
        (env read HERE, at module load: POSTGRES_HOST/PORT/USER/PASSWORD/DB/SSL —
         all documented in .env.example; no connection is dialed yet)
  → start()                              realtime/src/server.ts
      1. migrateToLatest(db)             realtime/src/db/migrate.ts
           → ExplicitMigrationProvider yields the MIGRATIONS registry
             (001_initial_schema, 002_content_pipeline —
              realtime/src/db/migrations/)
           → Kysely Migrator compares against its kysely_migration
             bookkeeping table, applies anything unapplied, in key order
           · error → throw → start().catch → console.error → exit(1)
             (orchestrator restarts with backoff; a process that cannot
              reach its schema must not accept traffic)
      2. createApp()                     realtime/src/app.ts
           → trust proxy, 64 KB JSON cap, configureHealthRoutes()
      3. createServer(app).listen(BACKEND_PORT ?? PORT ?? 3000)
           (explicit http server, not app.listen — M4 attaches the
            WebSocket upgrade handler to this same object)
      4. signal handlers installed
```

### §2.1 Shutdown

```
SIGTERM (Render deploy / docker stop) or SIGINT (Ctrl+C)
  → shutdown()                           realtime/src/server.ts
      1. server.close()   — stop accepting; in-flight requests finish
      2. pool.end()       — release Postgres connections
      3. exit(0)          (exit(1) if the drain itself errored)
  second signal while draining → exit(1) immediately
```

Two prerequisites make the signal actually arrive: the prod CMD is plain
`node` (npm would swallow SIGTERM — `realtime/Dockerfile`), and compose runs
with `init: true` so PID 1 forwards signals.

---

## §3 The test and CI flows (how the above gets verified)

```
local, no DB     npm test (root, realtime)
                   → shared tests + health tests; DB-gated suites self-skip
                     (POSTGRES_PASSWORD unset), ready-503 branch asserted

local, with DB   docker compose up -d database
                   → export .env vars → npm test in realtime/
                   → full suite: migrations, pgvector, constraint boundaries

CI verify job    pgvector service container → same full suite, keyless

CI e2e job       docker compose -f docker-compose.prod.yaml up --wait
                   → boots §2 for real (bundle, non-root, healthcheck)
                   → scripts/smoke-test.mjs walks §1.1, §1.2, and a 404
                   → logs dumped on failure; stack torn down always
```
