# Interrelated — dataflow traces

End-to-end walks of every path through the system, naming the actual file and
function at each hop. `CLAUDE.md` describes what each file *is*; this
document describes what *happens*, in order, when something occurs. Updated
as part of every step's definition of done.

**Current milestone: M1 — in progress.** Four paths exist: boot (§2), the
health probes (§1), the full ingest pipeline (§3): source → crawl → parse
→ chunk → embed → store, and — as of M1.4 — retrieval (§4): query → dense
+ lexical arms → RRF fusion → ranked chunks. Coming after: widget
question → grounded answer (M2, which puts an LLM and a citation verifier
on top of §4), dashboard auth (M3), handoff (M4).

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
      4. if INGEST_WORKER=1:             realtime/src/server.ts
           → buildEmbedder()             mock, or local via dynamic import
           → new IngestWorker({...}).start()
                                         realtime/src/ingest/worker.ts
             (poll loop begins — §3. Opt-in: compose stacks set the flag,
              render.yaml pins "0" so the poll can't hold Neon awake)
      5. signal handlers installed
```

### §2.1 Shutdown

```
SIGTERM (Render deploy / docker stop) or SIGINT (Ctrl+C)
  → shutdown()                           realtime/src/server.ts
      1. worker.stop()    — no new ticks; an in-flight job is requeued
                            between pages (§3.4) so no work is lost
      2. server.close()   — stop accepting; in-flight requests finish
      3. pool.end()       — release Postgres connections (after 1 resolves)
      4. exit(0)          (exit(1) if the drain itself errored)
  second signal while draining → exit(1) immediately
```

Two prerequisites make the signal actually arrive: the prod CMD is plain
`node` (npm would swallow SIGTERM — `realtime/Dockerfile`), and compose runs
with `init: true` so PID 1 forwards signals.

---

## §3 Ingest — source → crawl → parse → chunk → embed → store

The full pipeline, from a queued job to retrievable chunks. Today jobs are
enqueued by `npm run enqueue` (realtime/scripts/enqueueSource.ts) or by
tests; the M3 dashboard becomes the real producer.

### §3.1 The scheduling round (every INGEST_POLL_MS while idle)

```
IngestWorker poll timer fires
  → tick()                               realtime/src/ingest/worker.ts
      1. reclaim stale leases:
           running AND locked_at older than staleLockMs
             · attempts < max → back to 'queued' (crashed worker; retry)
             · attempts ≥ max → 'failed', error="lease expired…"
      2. claim: single UPDATE over
           (SELECT … WHERE state='queued' ORDER BY created_at
            LIMIT 1 FOR UPDATE SKIP LOCKED)
           → state='running', locked_by=<workerId>, attempts+1
           · no row → tick ends; sleep one poll interval
      3. #runJob(job)                    → §3.2
```

### §3.2 One job

```
#runJob                                  realtime/src/ingest/worker.ts
  → load sources row; kind='upload' → fail loudly (uploads are parsed at
    upload time in M3, never crawled)
  → sources.status = 'crawling'
  → for await (event of crawl(source))   realtime/src/ingest/crawler.ts
      · stop() requested?  → job back to 'queued', source 'pending', return
      · {plan, total}      → ingest_jobs.docs_total = total   (sitemaps)
      · {error, url, msg}  → console.warn; crawl continues
      · {page, url, doc}   → #processPage (§3.3) → docs_done++
  → soft-delete live documents of this source NOT seen this crawl
    (page removed from the site → retrieval must stop seeing it)
  → ingest_jobs: docs_total=docs_done, state='done', locked_by=NULL
  → sources: status='ready', last_crawled_at=NOW()
  · any thrown error (CrawlError from a dead root, etc.)
      → job 'failed' + error text; source 'failed'
```

### §3.3 One page (inside the crawl loop)

```
crawl() yields a page                    realtime/src/ingest/crawler.ts
  ← safeFetch(url)                       realtime/src/ingest/safeFetch.ts
      per hop: assertPublicUrl           scheme, no credentials, ALL DNS
                                         answers public (ip.ts) — redirects
                                         re-vetted per hop, manually
      connect: guarded Agent lookup      re-classifies the addresses
                                         actually dialed (DNS rebinding)
      body: streamed, size-capped, one timeout across the redirect chain
  ← parseResource                        realtime/src/ingest/parsers/index.ts
      detect: magic bytes → media type → extension → sniff → markdown
      decode: charset, BOM strip, CRLF→LF (BEFORE offsets exist)
      → parseHtml | parseMarkdown   (PDFs: detected, rejected, page
                                     skipped — no PDF parser until M3)
        contract: block.text === text.slice(charStart, charEnd)
      (html only) links harvested for the BFS frontier — same-origin,
      non-binary, deduped, FINAL-url checked

#processPage                             realtime/src/ingest/worker.ts
  → content_hash = sha256(doc.text)
  → existing live document for (source_id, url)?
      · same hash → refresh title/fetched_at. DONE — no chunking, no
        embedding. (The recrawl short-circuit: embedding quota is the
        scarcest resource in the pipeline.)
  → chunkBlocks(doc.blocks)              shared/chunking/chunker.ts
  → embedder.embed(batches of 32)        providers/embedding/*
      input per chunk: heading_path + "\n" + text (trail gives the vector
      section context; STORED text stays trail-free)
  → padVector → toPgvector               shared/utils/vectors.ts
  → ONE transaction                      (opened only after embedding —
      · update document + DELETE old       external network stays outside
        chunks (cascades embeddings)       transactions; Neon pool is 5)
        or insert new document
      · insert chunks + chunk_embeddings (batched)
```

### §3.4 Worker lifecycle

```
start()   chained setTimeout loop — a long job can never overlap a tick
stop()    flag + await in-flight tick; the job requeues between pages
          (attempts already counted by the claim, so a job that can only
           ever half-finish still converges to 'failed' instead of cycling)
```

## §4 Retrieval — query → ranked chunks

The read path over what §3 wrote. No HTTP surface yet — M2's chat route
becomes the caller; today it is driven by `npm run search`
(realtime/scripts/searchDev.ts) and the integration tests.

### §4.1 Hybrid search (the production entry point)

```
caller (searchDev CLI | tests | M2 chat route later)
  → embed the query                      providers/embedding/* .embed([q])
      (MUST be the same model that embedded the chunks — different models
       are different vector spaces; searchDev warns when the org has no
       embeddings under the chosen model)
  → hybridSearch(db, {orgId, queryText, queryVector, model, k})
                                         realtime/src/retrieval/search.ts
      both arms run CONCURRENTLY at poolSize (50) depth:
      ├─ denseSearch                     §4.2
      └─ lexicalSearch                   §4.3
  → rrfFuse([denseIds, lexicalIds])      shared/retrieval/rrf.ts
      score(chunk) = Σ 1/(60 + rank) over the arms that returned it —
      ranks only, never the raw scores (cosine distance and ts_rank_cd
      are on incomparable scales). Deterministic tie-break.
  → slice to k
  → hydrate metadata                     one query: chunks ⋈ documents for
                                         ONLY the k survivors (arm queries
                                         stay pure index work)
  → RetrievedChunk[]                     text, url, heading trail, char
                                         span, fused score, per-arm ranks
```

The fused score rides along into M2: it is the number the refusal
threshold cuts on ("don't answer" is a numeric decision on this value,
not a model self-assessment).

### §4.2 Dense arm

```
denseSearch                              realtime/src/retrieval/search.ts
  → padVector → toPgvector               shared/utils/vectors.ts (query
                                         padded to the stored 1024 dims)
  → BEGIN                                (transaction = the scope of the
                                          pgvector knobs below)
      set_config('hnsw.ef_search', …, is_local => true)
      set_config('hnsw.iterative_scan', 'relaxed_order', is_local => true)
        (set_config, not SET LOCAL: SET cannot take bind parameters.
         relaxed_order is what makes tenant filtering correct — HNSW
         yields ~ef_search candidates then FILTERS; without iterative
         scans a small tenant inside a big index gets fewer than k rows.
         The 20-org regression test exists because this fails only in
         production shapes.)
      SELECT … FROM chunk_embeddings ce
        JOIN chunks c    ON c.id = ce.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE ce.org_id = $org           ← on the INDEXED relation
          AND ce.model  = $model         ← matches the partial index
          AND d.deleted_at IS NULL       ← vanished pages stay invisible
        ORDER BY ce.embedding <=> $query ← exactly the index expression
        LIMIT k
  → COMMIT                               knobs die with the transaction
```

### §4.3 Lexical arm

```
lexicalSearch                            realtime/src/retrieval/search.ts
  → websearch_to_tsquery('english', $q)  never throws on end-user syntax;
                                         stop-word-only queries parse to
                                         an empty tsquery and match nothing
  → chunks.tsv @@ query                  GIN index; tsv is GENERATED, so
                                         it cannot drift from the text
  → ts_rank_cd(tsv, query)               cover density — rewards terms
                                         appearing NEAR each other
  → ORDER BY score DESC, id              id tie-break: identical texts
                                         rank identically, and eval runs
                                         must reproduce byte-for-byte
  → LIMIT k                              (soft-deleted documents filtered
                                          through the same join as §4.2)
```

## §5 The test and CI flows (how the above gets verified)

```
local, no DB     npm test (root, realtime)
                   → shared (incl. RRF fusion) + providers + health tests,
                     plus the DB-free ingest suites (safeFetch, parsers,
                     crawler — loopback fixture servers, no Postgres) and
                     retrieval input validation; DB-gated suites
                     self-skip (POSTGRES_PASSWORD unset)

local, with DB   docker compose up -d database
                   → export .env vars → npm test in realtime/
                   → full suite: migrations, pgvector, constraint
                     boundaries, the worker suite driving §3 end to end
                     against a loopback fixture site (three crawls of a
                     changing site; SKIP LOCKED contention; stale leases;
                     stop-requeue), and the retrieval suite driving §4
                     (20-tenant iterative-scan regression, cross-tenant
                     isolation, soft-delete filtering, fusion ranks)

CI verify job    pgvector service container → same full suite, keyless

CI e2e job       docker compose -f docker-compose.prod.yaml up --wait
                   → boots §2 for real (bundle, non-root, healthcheck,
                     ingest worker polling — INGEST_WORKER=1 in the stack)
                   → scripts/smoke-test.mjs walks §1.1, §1.2, and a 404
                   → logs dumped on failure; stack torn down always
```
