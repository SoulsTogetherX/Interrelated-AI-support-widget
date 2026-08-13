# Interrelated — dataflow traces

End-to-end walks of every path through the system, naming the actual file and
function at each hop. `CLAUDE.md` describes what each file *is*; this
document describes what *happens*, in order, when something occurs. Updated
as part of every step's definition of done.

**Current milestone: M2 — COMPLETE.** Six paths exist: boot (§2), the
health probes (§1), the full ingest pipeline (§3): source → crawl → parse
→ chunk → embed → store, retrieval (§4): query → dense + lexical arms →
RRF fusion → ranked chunks, the evaluation harness (§4.4) that scores §4
against a golden set and gates CI on the result, and — new in M2.3 — the
grounded answer pipeline (§5): question → retrieval → groundedness gate →
LLM → claim verification → stripped, cited answer. As of M2.5 the
pipeline HAS its HTTP surface (§5.3): the widget session mint (origin
allowlist → HMAC token) and the token-authenticated SSE chat route that
serializes §5's events verbatim. As of M2.6 the surface has its CLIENT
(§5.4): the embeddable widget — script-tag config, shadow-DOM UI,
SSE consumption — verified live on the three fixture host pages. M2.7
closed the milestone: the gate's threshold is eval-derived (§4.4's
--sweep-threshold mode; analysis in eval/RESULTS.md), and GET /demo +
GET /widget.js (realtime/src/routes/demo.ts) put the whole loop on one
public URL. M3 (the dashboard) is underway: the web/ package exists
(§7.1), as of M3.2 it authenticates — sign-up, sign-in, sign-out, and
the gated page are traced in §7.2–§7.5 — as of M3.3 it onboards
organizations (§7.6) with every org page behind the membership guard
(§7.7), and as of M3.4 it connects BYO provider keys through realtime's
internal API (§7.8): live-tested, encrypted at rest, suffix-only ever
after. As of M3.5 those credentials ANSWER: the chat route resolves the
org's generation credential per request (§5.3's resolve hop) with the
env mock as fallback, so a saved key changes what model speaks on the
very next question. As of M3.6a the dashboard is also the ingest
producer (§7.9): connect a source → SSRF vet → source + job in one
transaction → the worker WAKES (production has no poll timer at all —
§3.1) → progress auto-refreshes on the sources page. As of M3.7 the
transcripts are readable (§7.10), stripped claims included, and as of
M3.8 the allowlist and install snippet are managed from the UI (§7.11)
— the dashboard no longer needs SQL by hand for anything. M3.6b closed
the BYO loop: an org's own EMBEDDING model now indexes its corpus (§3.2's
resolve hop) and embeds its visitors' questions (§5.3), from one
credential row, with a model change re-queueing the corpus in the same
transaction that changed it (§7.8) — **M3 COMPLETE.** M4 (handoff) is
underway: as of M4.1 a conversation can be handed to a person (§8), which
is one idempotent state change and one deliberate silence — the bot stops
answering that thread while still keeping every word the visitor types —
and as of M4.2 the two of them can actually talk (§8.3): a single-use
60-second ticket settles identity BEFORE the WebSocket handshake
completes, an agent attaching claims the handoff, and every message is
persisted before it is broadcast.

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
             (001_initial_schema — the flattened baseline; new work adds
              002 onward. realtime/src/db/migrations/)
           → Kysely Migrator compares against its kysely_migration
             bookkeeping table, applies anything unapplied, in key order
           · error → throw → start().catch → console.error → exit(1)
             (orchestrator restarts with backoff; a process that cannot
              reach its schema must not accept traffic. A database that
              applied the PRE-flatten 001–005 fails here by design —
              "corrupted migrations" — and needs the one-time reset the
              migration's header spells out)
      2. createApp()                     realtime/src/app.ts
           → trust proxy, 64 KB JSON cap, configureHealthRoutes()
      3. createServer(app)
           → createHandoffServer({db, ticketSecret})
                                         realtime/src/handoff/socket.ts
           → server.on("upgrade", …)     the reason this is an explicit
                                         http server and not app.listen:
                                         the handoff socket attaches to
                                         THIS object (§8.3)
           → .listen(BACKEND_PORT ?? PORT ?? 3000)
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
      1b. handoff.close() — terminate open WebSockets FIRST: http.Server
                            .close() waits for every live connection, and
                            a socket is one, so a deploy would otherwise
                            hang until the platform's kill timeout
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

The full pipeline, from a queued job to retrievable chunks. Producers:
the dashboard (§7.9 — the real one since M3.6a), `npm run enqueue`
(realtime/scripts/enqueueSource.ts), and tests.

### §3.1 The scheduling round

Triggered by the poll timer (dev compose: every INGEST_POLL_MS while
idle) or — production's whole mechanism, INGEST_POLL_MS=0 — by
`worker.wake()` from the enqueue route, plus one tick at boot for jobs a
deploy stranded. A wake landing mid-tick queues exactly one follow-up
tick (worker.ts #loop).

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
  → resolveEmbeddingProvider(db, org)    realtime/src/credentials/resolve.ts
      the org's BYO embedding model, decrypted for this job; null → the
      app-level embedder. Resolved ONCE per job: a rotation landing
      mid-crawl would split one source across two vector spaces.
      A decrypt failure throws → job 'failed' (never a silent wrong model)
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
      · same hash AND its chunks already carry vectors under THIS job's
        model → refresh title/fetched_at. DONE — no chunking, no
        embedding. (The recrawl short-circuit: embedding quota is the
        scarcest resource in the pipeline.)
      · same hash, no vectors under this model → fall through and
        re-embed: the tenant switched embedding providers, so identical
        text still has to move into the new space (M3.6b)
  → chunkBlocks(doc.blocks)              shared/chunking/chunker.ts
  → embedder.embed(batches of 32, {task:"document"})
                                         providers/embedding/*
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
caller (searchDev CLI | tests | the answer pipeline §5)
  → embed the query                      providers/embedding/*
                                         .embed([q], {task:"query"})
      (MUST be the same model that embedded the chunks — different models
       are different vector spaces; the chat route gets that by resolving
       the SAME credential row the ingest worker did (§5.3), and searchDev
       warns when the org has no embeddings under the chosen model.
       task:"query" is what an asymmetric model needs to place a question
       in the same space as a passage; symmetric models ignore it)
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

### §4.4 The evaluation harness — golden set → scores → CI verdict

```
npm run eval                             realtime/scripts/runEval.ts
  → refuse EMBEDDING_PROVIDER=mock       quality over semantics-free
                                         vectors is noise, by design
  → migrateToLatest                      a fresh CI container self-prepares
  → ingest eval/corpus/ into the eval org
      per file: read → BOM/CRLF-normalize → parseMarkdown → chunkBlocks
        → embed (bge-small local, heading trail prepended) → store
      content_hash short-circuit: repeat runs skip unchanged files
      (targetTokens is hashed too, so ablation runs re-chunk)
  → resolve golden anchors               eval/resolve.ts resolveAnchor()
      (url → live document → chunks whose squashed text contains the
       squashed mustContain; ANY zero-match anchor → report all → exit 1)
  → embed all 80 questions
  → for each strategy (dense | lexical | hybrid):
      retrieve k=10 per question         realtime/src/retrieval/search.ts
      → scoreRun                         eval/metrics.ts
        (recall@1/5/10, MRR@10, nDCG@10, retrieval-only p50/p95)
  → print table + every hybrid miss with its top hit
  → write eval/results/latest.json      (gitignored; RESULTS.md is the
                                         published, human-argued version)
  → floor check                          eval/floor.json
      hybrid recall@5 < floor → exit 1 → CI red

npm run eval -- --sweep-threshold        (M2.7 — the gate's calibration)
  → same ingest + golden load, then:
      gate signal per question           evaluateGroundedness on REAL
                                         hybrid retrievals (the production
                                         code path, not a copy)
      golden vs eval/noanswer.jsonl      answerable vs off_topic/adjacent/
                                         absent_detail
  → correct-refusal vs false-refusal     per threshold 0.30…1.00 → CSV
  → frontier points printed              FR=0 and FR=1/80, with category
                                         breakdowns; the CHOICE lives in
                                         answer/gate.ts + RESULTS.md
```

## §5 Grounded answers — question → verified claims

The M2 core: what happens between a visitor's question and the claims they
are allowed to see. Today the callers are `npm run ask`
(realtime/scripts/askDev.ts, mock LLM in responder mode) and the pipeline
integration tests; the SSE widget route becomes the production caller in
M2.5 — deliberately AFTER widget session auth exists, so an
unauthenticated LLM-spending route never reaches the auto-deploying dev
branch.

### §5.1 The pipeline

```
caller (askDev CLI | tests | M2.5 SSE route later)
  → answerQuestion({db, embedder, llm, orgId, visitorId, question, …})
                                         realtime/src/answer/pipeline.ts
      1. conversation: validate the supplied id against the ORG (a foreign
         conversation id is a cross-tenant write → throw), or create one
      2. persist the visitor message + bump last_message_at
         (before retrieval: a model failure never erases the question, and
          a thread whose answer FAILED should surface in the dashboard)
      3. emit {meta, conversationId, messageId}
      4. embed the question              providers/embedding/* .embed([q])
      5. hybridSearch(k=10)              → §4.1
      6. evaluateGroundedness            realtime/src/answer/gate.ts
           cut on MIN dense cosine distance across the retrieved set —
           NOT the fused RRF score (rank-based ⇒ relevance-blind: every
           non-empty retrieval has a rank 1, so it cannot gate; the M1
           docs said otherwise and were corrected here). Threshold 0.75
           provisional until M2.7 derives it from the eval set.
           · refuse → persist assistant row (refused=true, model=NULL —
             ZERO tokens spent, that is the point of gating pre-call,
             gate signal recorded in retrieval_score for tuning data)
             → emit {refusal} {done} → return
      7. buildAnswerMessages             realtime/src/answer/prompt.ts
           system = STATIC instructions (+ org persona) — the cacheable
           prefix; retrieved text rides in the USER turn inside <context>
           delimiters, declared as DATA-not-instructions (the injection
           boundary: crawled pages are untrusted input)
      8. llm.stream({messages, temperature: 0, maxTokens, responseSchema,
                     signal})            providers/llm/*
           mock (tests/CI) | groq/openai-compatible (json_object mode) |
           gemini (schema enforced server-side) | ollama (native format)
           deltas collected; TTFT measured at first delta, in the
           pipeline (not per-provider) so every provider measures alike
      9. parseAnswerText                 shared/grounding/claims.ts
           as-is → fenced → first-{-to-last-} (each still fully validated)
           · invalid → buildRetryMessages: replay + EVERY validator error,
             ONE retry only; second failure → AnswerSchemaError (visitor
             message stays, NO assistant row — a transient model failure
             is not conversation history)
     10. verifyClaims                    shared/grounding/verify.ts
           each claim's quote must occur (whitespace-normalized, case-
           sensitive) in the chunk it NAMES, among the chunks the model
           was SHOWN; raw span offsets captured
     11. displayableClaims               the strip policy: verified only
     12. ONE transaction                 realtime/src/answer/pipeline.ts
           assistant message (content = shown claims joined, or the
           nothing-verified fallback) + ALL citation verdicts (stripped
           ones included — the strip-rate data) + recency bump
     13. emit {claim}×N (with url + heading for the widget's citations)
           or {refusal} — then {done, claimsTotal, claimsShown}
```

### §5.2 What each failure looks like

```
gate refuses            assistant row: refused=true,  model=NULL,  0 citations
nothing verifies        assistant row: refused=false, model set,   citations all
                        stripped (strip rate 100%) — content is the fallback
schema failure ×2       NO assistant row; AnswerSchemaError to the caller;
                        visitor message + conversation remain
abort (visitor gone)    provider throws mid-stream; nothing persisted past
                        the visitor message
```

### §5.3 The HTTP surface — bubble-open → session → SSE answer (M2.5)

```
widget (M2.6) or curl-with-headers
  → POST /v1/widget/session            realtime/src/routes/widget.ts
      Origin header required           absent → 403 (a script; no free
                                       sessions — layer 3 bounds scripts)
      per-IP token bucket              realtime/src/widget/rateLimit.ts
      api_keys lookup                  kind=public, live; unknown and
                                       revoked → ONE uniform 401
      allowed_origins exact match      miss → 403 with NO CORS headers —
                                       an unlisted site's browser cannot
                                       even read the error
      api_keys.last_used_at = NOW()    ← this handshake is also what warms
                                       Neon while the visitor types
      → mintSessionToken               realtime/src/widget/sessionToken.ts
        {org, origin, visitor, exp}    HMAC-signed, 30 min TTL
      → 200 {token, expiresAt, visitorId} + CORS echo of the origin

  → POST /v1/widget/chat  (Authorization: Bearer <token>)
      verifySessionToken               tampered/expired/foreign → uniform 401
      token.origin === live Origin     mismatch → 403 (replay from another
                                       site dies even before rate limits)
      per-IP + per-visitor buckets     429 WITH CORS — the widget renders
                                       a "one moment" state
      per-org daily ceiling            COUNT assistant messages today via
                                       the (org_id, created_at) index,
                                       BEFORE any model call
      validate question (≤2000 chars) and conversationId shape
      → SSE headers flush              TTFB paid before retrieval starts
      → resolveGenerationProvider      realtime/src/credentials/resolve.ts
        + resolveEmbeddingProvider     (M3.5 / M3.6b): the org's saved BYO
                                       credentials — decrypted for this
                                       request only — outrank the
                                       app-level fallbacks; no cache, so
                                       rotation bites on the very next
                                       question. The embedding one is not
                                       a preference but a REQUIREMENT: the
                                       question has to be embedded by the
                                       model that embedded the chunks, and
                                       the ingest worker reads this same row
      → answerQuestion(§5.1)           visitorId = token.visitor — the
                                       binding that stops one visitor
                                       continuing another's thread
          each AnswerEvent             → `data: <json>\n\n`
      req 'close' → AbortController    a closed tab stops the token spend
      any failure past the SSE start   → one opaque {type:"error"} event
```

### §5.4 The widget client — snippet → bubble → answer (M2.6)

```
customer pastes the snippet anywhere in their page
  <script src=".../widget.js" async data-key="pk_…" data-api="https://…">
  → boot()                               widget/src/index.ts
      window.fetch CAPTURED at evaluation (before analytics wrappers)
      config from the script tag's own data- attributes
      double-mount guard; DOMContentLoaded-safe body append
      → mountWidget(host, new ApiClient(…))
                                         widget/src/ui.ts
          shadow root (mode open) + :host { all: initial } armor
          styles via adoptedStyleSheets  (CSP-exempt; <style> fallback)

visitor clicks the bubble
  → ensureSession()                      widget/src/api.ts
      POST /v1/widget/session (→ §5.3)   ALSO the Neon-warming handshake;
      visitor id from guarded localStorage; token held in memory

visitor asks
  → ask(question, conversationId?)       widget/src/api.ts
      POST /v1/widget/chat, Bearer token
      401 → ONE silent re-mint + retry   30-min expiry, invisible
      429 → QuotaError | RateLimitError  distinct visitor-facing states
      → readAnswerEvents(body)           widget/src/sse.ts
  → per event                            widget/src/ui.ts
      meta    → conversation id threads into the NEXT ask
      claim   → textContent paragraph + http(s)-vetted citation link
                (NEVER innerHTML — claim text is model output)
      refusal → ordinary assistant bubble
      error   → notice + input recovery (the widget never bricks)
```

## §6 The test and CI flows (how the above gets verified)

```
local, no DB     npm test (root, realtime)
                   → shared (incl. RRF fusion) + providers + eval scorer/
                     resolver tests, plus the DB-free ingest suites
                     (safeFetch, parsers, crawler — loopback fixture
                     servers, no Postgres) and retrieval input validation;
                     DB-gated suites self-skip (POSTGRES_PASSWORD unset)

local, with DB   docker compose up -d database   ← DATABASE ONLY, not the
                   full stack: a running realtime container polls this
                   same Postgres with its ingest worker and can adopt a
                   job the worker suite just requeued (it bit for real —
                   the stop()-requeue test fails on its park update)
                   → export .env vars → npm test in realtime/
                   → full suite: migrations, pgvector, constraint
                     boundaries, the worker suite driving §3 end to end
                     against a loopback fixture site (three crawls of a
                     changing site; SKIP LOCKED contention; stale leases;
                     stop-requeue), and the retrieval suite driving §4
                     (20-tenant iterative-scan regression, cross-tenant
                     isolation, soft-delete filtering, fusion ranks)

CI verify job    pgvector service container → same full suite, keyless;
                   plus web/: typecheck, tests, and `next build` (which
                   runs Next's own TypeScript pass over the generated
                   route types tsc cannot see on a fresh checkout —
                   web/tsconfig.json explains). ORDER MATTERS: web's
                   DB-gated auth suite assumes the schema realtime's
                   test step already migrated into the same container —
                   web never migrates (ci.yml carries the warning)

CI eval job      pgvector service container + cached fastembed model
                   → npm run eval walks §4.4 for real: corpus ingest,
                     anchor resolution, three-strategy scoring, and the
                     recall floor — a retrieval-quality regression fails
                     the merge, keylessly

CI e2e job       docker compose -f docker-compose.prod.yaml up --wait
                   → boots §2 for real (bundle, non-root, healthcheck,
                     ingest worker polling — INGEST_WORKER=1 in the stack)
                   → scripts/smoke-test.mjs walks §1.1, §1.2, and a 404
                   → logs dumped on failure; stack torn down always
```

---

## §7 Dashboard — `web/` (M3, underway)

The control plane (CLAUDE.md §9). One path exists so far.

### §7.1 Landing — `GET /`

```
Vercel edge (or `next start` locally)
  → serves the STATIC prerender of web/src/app/page.tsx
    (layout.tsx shell + globals.css + page.css, inlined at build time)
```

`next build` prerenders `/` at build time — the page is a Server
Component with no dynamic input — so serving it executes no server code
and touches no database: the deployed dashboard's front door cannot 500
and costs nothing.

### §7.2 Sign-up — POST (Server Action) from `/signup`

```
AuthForm submit (components/AuthForm, useActionState)
  → signupAction                         web/src/lib/auth/actions.ts
    → registerUser                       web/src/lib/auth/user.ts
      → validateEmail / validatePassword     (trim+lowercase; 8–200)
      → checkPasswordBreached            breachedPassword.ts
          5-char SHA-1 prefix → HIBP range API; fails OPEN on trouble
      → newId("usr")                     shared/utils/ids.ts
          id BEFORE row: it is the AAD binding the email ciphertext
      → emailBlindIndex + hashPassword       (concurrently)
      → encryptEmail(email, userId)      emailCrypto.ts
      → INSERT INTO users                — UNIQUE(email_index) is the
          duplicate authority; 23505 → "already registered" (no
          check-then-insert race)
    → createSessionForUser               web/src/lib/auth/session.ts
        random 256-bit token; INSERT sessions(id = sha256(token))
    → setSessionCookie                   web/src/lib/auth/cookies.ts
        httpOnly, SameSite=Lax, Secure+__Host- in prod
    → redirect("/dashboard")                 (throws NEXT_REDIRECT — last)
  validation/breach/duplicate errors return as form state instead;
  the form shows them inline and keeps the visitor's input
```

### §7.3 Sign-in — POST (Server Action) from `/login`

```
AuthForm submit
  → loginAction                          web/src/lib/auth/actions.ts
    → authenticateUser                   web/src/lib/auth/user.ts
      → validateEmail (malformed → decoy path, not a different error)
      → SELECT users WHERE email_index = emailBlindIndex(email)
      → found:  verifyPassword against the stored scrypt hash
        absent: verifyPassword against a DECOY hash — burns the same
                scrypt work, so timing can't reveal account existence
      → every failure is ONE string: "Incorrect email or password."
    → createSessionForUser → setSessionCookie → redirect("/dashboard")
```

### §7.4 Sign-out — POST (Server Action) from the dashboard header

```
form action
  → logoutAction                         web/src/lib/auth/actions.ts
    → destroySession(readSessionToken())     server-side revocation FIRST
    → clearSessionCookie                     cookie second (worst case on
                                             a crash: dead-session cookie,
                                             never a live orphan session)
    → redirect("/login")
```

### §7.5 Any authenticated page — e.g. GET `/dashboard`

```
page RSC render
  → requireUser                          web/src/lib/auth/requireUser.ts
    → readSessionToken                   cookies.ts (next/headers jar)
    → resolveSessionUser                 session.ts
        SELECT sessions ⋈ users
          WHERE sessions.id = sha256(token)
            AND expires_at > now()           ← DATABASE clock, not app's
        → decryptEmail(ciphertext, userId)   ← the one read-path decrypt
    → null → redirect("/login"); user → page renders
```

There is deliberately no middleware doing a cookie-presence pre-check —
it cannot reach the database cheaply, so the page-level check is the only
one (requireUser.ts's header explains).

### §7.6 Org creation — POST (Server Action) from `/dashboard` or `/dashboard/new`

```
CreateOrgForm submit
  → createOrgAction                      web/src/lib/orgs/actions.ts
    → currentUser (cached)                   actions are their own trust
      · null → redirect("/login")            boundary: a POST can arrive
                                             without the page rendering
    → validateOrgName                    web/src/lib/orgs/index.ts (2–64, trimmed)
    → createOrgForUser                   web/src/lib/orgs/index.ts
        ONE transaction:
          INSERT organizations (id = org_…, plan by DB default)
          INSERT org_members   (role 'owner' — the partial unique
                                index allows exactly one per org)
          INSERT api_keys      (kind 'public',
                                public_id = newPublishableKey()
                                           shared/utils/ids.ts pk_live_…)
        an org missing any of the three is corruption, so the three
        rows are indivisible
    → redirect("/dashboard/<orgId>")
```

### §7.7 Any org-scoped page — e.g. GET `/dashboard/[orgId]`

```
page RSC render
  → requireOrgMember(orgId)              web/src/lib/orgs/index.ts
    → requireUser                            §7.5's session resolve
    → getOrgForMember(orgId, user.id)
        isId("org", orgId) fails fast on malformed ids (no query)
        SELECT org_members ⋈ organizations
          WHERE org_id = … AND user_id = …   ← membership IS the tenant
                                               boundary; there is no
                                               unscoped org lookup
    → no row → notFound()                    404, NOT a redirect: a
                                             non-member probe must not
                                             learn whether the org exists
  → page renders (overview: getPublishableKey among live keys, the
    other-orgs switcher via listOrgsForUser)
```

### §7.8 Provider credential test/save — POST (Server Action) from `/dashboard/[orgId]/providers`

The one flow where a tenant's provider key exists in plaintext, end to
end; every hop it does NOT persist at is the point.

```
ProviderForm submit (Test or Test & save — intent from the pressed button)
  → submitProviderAction                 web/src/lib/providers/actions.ts
    → currentUser → getOrgForMember → role must be OWNER
    → submitCredential(orgId, payload, save)
                                         web/src/lib/realtime/index.ts
        POST {REALTIME_INTERNAL_URL}/internal/orgs/<id>/credentials
          x-internal-secret: INTERNAL_API_SECRET   (constant-time checked)
          body: { role, provider, apiKey?, baseUrl?, model?, save }
      → requireSecret → requireOrg       realtime/src/routes/internal.ts
      → checkCredentialInput             realtime/src/credentials/validate.ts
          shape per provider AND per role (groq has no embeddings — refused
          by name) + SSRF vet: assertPublicUrl(base_url)
          (resolves DNS, rejects private/loopback — fail closed)
      → role='generation':
          buildGenerationProvider → testGenerationRoundTrip
          ONE real 16-token completion against the tenant's provider;
          latency measured to done; failure → 422 with a message that
          never contains the key (LLMHttpError strips by construction)
        role='embedding'  (M3.6b):
          buildEmbeddingProvider → testEmbeddingRoundTrip
          ONE real embedding of one short text; reports the DIMENSION the
          provider actually returned. > 1024 → 422 naming both numbers
          (halfvec(1024) is the storage contract; truncating a
          non-Matryoshka embedding would destroy it)
      → save:false → report + STOP (nothing written — the Test button)
      → save:true  → one transaction:
            SELECT old (org, role) row      ← its model, for the compare
            DELETE old (org, role) row      ← superseded ciphertext
                                              ceases to exist
            INSERT { key_ciphertext: AES-GCM(key, master, aad=row id),
                     key_suffix: last 4, dim: measured (embedding only),
                     last_validation: "model, [N-d,] Nms" }
                                         realtime/src/credentials/vault.ts
            embedding role AND the model changed → enqueueReindex:
              one queued ingest_jobs row per source (skipping sources with
              work already queued, and uploads) — the corpus has to follow
              the model or the dense arm goes blind, and the same
              transaction that changed the credential is the only honest
              place to decide that
      → reindexed > 0 → onEnqueue() → worker.wake()   (production's
                                       scheduler, §7.9)
    → success → revalidatePath(providers + sources pages) → status card
      re-renders from web/src/lib/providers/queries.ts — which can never
      select key_ciphertext; the suffix is all the dashboard will ever show
```

DELETE `/internal/orgs/<id>/credentials/embedding` runs the same re-index
for the same reason: removing a credential reverts the org to the
platform's built-in model, which is a model change like any other.

### §7.9 Source connect → crawl → visible progress (M3.6a)

```
AddSourceForm submit
  → addSourceAction                    web/src/lib/sources/actions.ts
    → currentUser → getOrgForMember → OWNER
    → createSource                     web/src/lib/realtime/index.ts
        POST {REALTIME_INTERNAL_URL}/internal/orgs/<id>/sources
      → requireSecret → requireOrg     realtime/src/routes/internal.ts
      → shape checks + SSRF vet        assertPublicUrl on the location —
                                       the same seam as credential base
                                       URLs; safeFetch re-vets every hop
                                       at crawl time anyway
      → ONE transaction: INSERT sources (pending)
                         INSERT ingest_jobs (queued)
      → onEnqueue()                    server.ts wired this to
        → worker.wake()                realtime/src/ingest/worker.ts —
                                       in production this call IS the
                                       scheduler (no poll exists)
          → tick → claim → §3.2 runs the crawl
    → revalidatePath(sources page)

meanwhile, in the browser:
  sources page renders from            web/src/lib/sources/queries.ts
    (sources + each one's LATEST job + live document counts)
  a queued/running job mounts          components/AutoRefresh — 4s
    router.refresh() until the job settles; idle pages poll nothing
```

### §7.10 Reading a transcript — GET `/dashboard/[orgId]/conversations/[id]`

The read path that closes the loop §5 opened: what the pipeline verified
and stripped becomes what the tenant can audit.

```
page RSC render
  → requireOrgMember(orgId)            §7.7's membership guard
  → getConversation(orgId, id)         web/src/lib/conversations/queries.ts
      isId("con", id) → malformed short-circuits before any query
      SELECT conversations WHERE id = … AND org_id = …
        → null for a foreign tenant's id AND for a fabricated one —
          indistinguishable by construction; the page 404s both
      SELECT messages       ORDER BY created_at ASC
      SELECT message_citations FOR those messages, ORDER BY ord
        → EVERY citation row, verified and stripped alike (migration
          003 stores both; a filter here would make the product's core
          promise unauditable)
  → render: message.content = what the VISITOR saw
            citations      = per-claim verdicts underneath, each with
                             its quote and source link, the stripped
                             ones labelled with WHY (quote not found /
                             chunk never retrieved)
            assistant rows also show model, refused, ttft_ms, total_ms
```

### §7.11 Allowlisting an origin — POST (Server Action) from `/dashboard/[orgId]/widget`

The dashboard half of trust-model layer 1; §5.3's session mint is the
half that enforces it.

```
OriginForm submit
  → addOriginAction                    web/src/lib/origins/actions.ts
    → currentUser → getOrgForMember → OWNER
    → validateOrigin                   web/src/lib/origins/index.ts
        new URL(input).origin — the BROWSER's own definition of the
        string its Origin header will carry, so a pasted page URL,
        trailing slash, mixed-case host, or default port all collapse
        to the one value that can actually match
        rejects: bare host (scheme is the tenant's decision, not ours),
                 "null" (file:// and sandboxed iframes), credentials,
                 non-http schemes
    → INSERT allowed_origins ON CONFLICT DO NOTHING   (idempotent: the
        tenant's intent is already satisfied)
        └ schema CHECK ^https?://[^/]+$ is the backstop behind the
          validator, not a duplicate of it
    → revalidatePath(install page) → the list re-renders from Postgres

…and the effect, on the very next widget request (§5.3):
  POST /v1/widget/session with Origin: <that origin>
    → allowed_origins lookup hits  → token minted (200)
  removal is equally immediate: the same origin → 403, no CORS headers,
  so an unlisted site's browser cannot even read the error
```

---

## §8 Handoff — bot → human (M4, underway)

M4.1 is the transition itself: the moment a conversation stops being the
bot's — the state change, the queue row it writes, and the silence it
imposes on the bot. M4.2 is the socket that carries the human's replies,
M4.3 completes its protocol with replay and typing, and M4.4 is the
visitor's end of it (§8.5). What is still missing is the agent's: the
dashboard inbox that answers.

### §8.1 Escalation — POST `/v1/widget/escalate`

```
widget "talk to a person"           (the widget UI renders the button)
  → POST /v1/widget/escalate        realtime/src/routes/widget.ts
      Origin + Bearer token         the SAME authenticate() ladder chat
                                    uses: uniform 401 on a bad token, 403
                                    on a token replayed from another site
      per-IP + per-visitor buckets  deliberately the CHAT buckets, not new
                                    ones — escalation is cheap for us and
                                    expensive for the tenant, so a spent
                                    question budget must not leave a
                                    separate allowance for summoning staff
      conversationId shape check    isId("con", …) before any query
  → requestHandoff                  realtime/src/handoff/escalate.ts
      conversation scoped by org AND visitor
        · miss → { ok:false, not_found } → 404
          (unknown / another org's / another visitor's are ONE answer;
           distinguishing them on a public route is an oracle)
      already open? → return it, created:false        ← the common retry
      else ONE transaction:
            INSERT handoff_sessions (pending, reason='visitor_request')
            UPDATE conversations SET status='escalated'
              (the coarse state and the record move together, or a
               visitor waits in a queue nobody can see)
        · unique violation (23505) → another request won the race in the
          microseconds since the read → read back the winner, created:false
          — idempotence lives in the partial unique index over OPEN rows
            (§3.3.4), not in application deduplication
  → 200 { status: "pending" | "active", created }
```

### §8.2 What the bot does afterwards

```
POST /v1/widget/chat (next question in that thread)     §5.3
  → answerQuestion                  realtime/src/answer/pipeline.ts
      conversation resolved, VISITOR MESSAGE PERSISTED, meta emitted
      → getOpenHandoff(db, conversationId)
          · open → emit {type:"handoff", status}
                   emit {type:"done", claimsTotal:0, claimsShown:0}
                   RETURN — no retrieval, no model call, no assistant row
          · none → the ordinary answer path continues (§5.1)
```

The persist-then-stop order is the point: the visitor's words are exactly
what the waiting agent needs to read, and someone who keeps typing while
queued must not have those turns dropped. Answering anyway would put two
voices in one conversation and bill the tenant for it.

### §8.3 The socket — ticket → upgrade → two-way conversation (M4.2)

Neither end can put its real credential in a WebSocket handshake (browsers
set no headers there), so both spend it on an ordinary POST first:

```
VISITOR                                 AGENT
POST /v1/widget/handoff-ticket          POST /internal/orgs/<id>/handoff-tickets
  Bearer <session token>                  x-internal-secret  (from a Next
  realtime/src/routes/widget.ts            Server Action that already
                                           established the user's session)
  → conversation must be THEIRS and      → user must be a MEMBER, and the
    have an open handoff, else 404         handoff open, else 404
  → mintHandoffTicket(role:"visitor")    → mintHandoffTicket(role:"agent")
                                         realtime/src/routes/internal.ts
        both: realtime/src/handoff/ticket.ts — 60s, single use, signed with
        a key DERIVED from WIDGET_TOKEN_SECRET so a session token can never
        be spent as a ticket
```

Then the upgrade, where identity is settled before a WebSocket exists:

```
GET /v1/handoff?ticket=…  (Upgrade: websocket)
  → server.on("upgrade")             realtime/src/server.ts
  → handleUpgrade                    realtime/src/handoff/socket.ts
      path mismatch                  → 404 + FIN
      verifyHandoffTicket            → 401 + FIN   (forged, expired, shape)
      tickets.consume(jti)           → 401 + FIN   (REPLAY — spent before
                                       any database work, so a replayed
                                       ticket costs what a forged one does)
      handoff still open? org match? visitor's own conversation?
                                     → 404 + FIN
      ── only now ──> wss.handleUpgrade → a WebSocket exists
  → onConnection
      join room (keyed by conversation)   ← BEFORE the history read, so
                                            nothing said meanwhile is lost
      agent + status 'pending' → UPDATE … SET status='active',
        claimed_by, claimed_at WHERE status='pending'
        (attaching IS claiming; the guard makes two agents arriving
         together one claim and two participants)
      → send  {type:"ready", role, conversationId, status}
      → replay (§8.4)  → send {type:"history", messages[]}
                       → flush anything buffered meanwhile
      → broadcast {type:"presence", agents, visitors}
```

And the relay, which is the same in both directions:

```
client → {type:"message", text}
  → onFrame                          realtime/src/handoff/socket.ts
      JSON? shape? 1..4000 chars?    → {type:"error", reason} and the
                                       socket STAYS OPEN
      → ONE transaction: INSERT messages (role from the TICKET, never
                           from the frame) RETURNING created_at
                         UPDATE conversations.last_message_at
      → broadcast {type:"message", id, role, text, at} to the whole room,
        sender included        ← `at` is the RETURNED created_at, so this
                                 frame and §8.4's backlog agree on when
      → was this sender typing? → broadcast {type:"typing", active:false}
                                  to everyone else (sending ends composing)
close / heartbeat timeout
  → was it typing? → broadcast {type:"typing", active:false} to the others
  → leave room → broadcast presence  (a phantom agent would otherwise
                                      leave the visitor waiting forever)
```

### §8.4 Replay and typing (M4.3)

Replay is a read the socket performs on attach — the transcript was always
complete in Postgres (§9.10 renders it); what was missing was handing it to
a client that just reconnected.

```
onConnection, after `ready`
  → replay(attachment)               realtime/src/handoff/socket.ts
      SELECT id, role, content, created_at FROM messages
        WHERE conversation_id = …
        ORDER BY created_at DESC, id DESC LIMIT 50   ← the newest window,
          walking messages_conversation (conversation_id, created_at, id)
          backwards instead of sorting a long thread to discard most of it
      reverse() → reading order
      → send {type:"history", messages:[{id, role, text, at}, …]}
          role widens to include 'assistant': the bot's turns are most of
          what an arriving agent needs, and relabelling them would
          misattribute them
      · read failed → {type:"error", reason:"history unavailable"} and the
        socket stays open — a lost backlog must not cost the LIVE
        conversation
  → flush the buffer:
      messages broadcast since the room join are sent now, minus any id
      the backlog already carried
```

The buffer is the whole correctness argument, and both naive orderings are
wrong without it:

```
read history, THEN join   → a message committed in between is broadcast to
                            a room this client is not in yet → LOST
join, THEN read (no buf)  → a message committed in between is in the
                            backlog AND arrives live → DUPLICATED (or
                            delivered, then rendered over by the backlog)
join, buffer, read, flush → in the backlog or in the flush, never both,
                            never neither
```

Typing never touches a table:

```
client → {type:"typing", active}
  → onFrame → relayTyping
      not a boolean?               → {type:"error", …} (the two things it
                                     could mean are opposites)
      < 250 ms since last relay    → DROPPED silently (an error per
                                     keystroke is a worse storm)
      same state, < 2 s            → DROPPED (a repeat only earns the wire
                                     when it refreshes a receiver's TTL)
      otherwise → broadcast {type:"typing", role, active} to EVERYONE ELSE
                  (role from the ticket; the sender knows it is typing)
receiver
  → shows the indicator, drops it after TYPING_TTL_MS (6 s) without a
    refresh — so a socket dying mid-sentence cannot leave "typing…" on
    screen, with no server-side timer to own it
```

### §8.5 The visitor's end (M4.4)

The widget half, from the refusal that offers a person to the socket that
replaces the bot.

```
answer stream ends with {type:"refusal"}      widget/src/ui.ts
  → offerEscalation()  → "Talk to a person" (once; never while a person
                          already owns the thread)
click
  → client.escalate(conversationId)           widget/src/api.ts
      POST /v1/widget/escalate  (bearer session token, one silent re-mint
                                 on 401 — the same #authed path as chat)
      ← {status, created}       created:false = already queued, say nothing
  → enterHandoff(status)                      ui.ts
      status bar above the log (it must not scroll away)
      composer switches: placeholder, maxLength = MAX_HANDOFF_MESSAGE_CHARS
      → client.openHandoff(conversationId, handlers)
          → new HandoffSocket(...).open()     widget/src/handoff.ts
```

Connecting, and re-connecting, are the same path — which is the point:

```
HandoffSocket#connect
  → onStatus("connecting")
  → client.handoffTicket(conversationId)
      POST /v1/widget/handoff-ticket
      ← {ticket}   → wss://…/v1/handoff?ticket=…
      ← null       → onStatus("ended"), loop STOPS (an agent closing the
                     conversation is a decision, not an outage)
      ← throws     → backoff (500ms ×2 … 8s, jittered) and try again
  → socket frames:
      ready     → backoff reset (authenticated, not merely connected)
                  → "waiting" | "connected"
      history   → renderTranscript(): the log is REBUILT from it
      message   → one bubble, class = role (visitor | agent | assistant)
      presence  → agents > 0 ? "connected" : "waiting"
      typing    → indicator, expired by the RECEIVER after TYPING_TTL_MS
  → socket closes (server restart, laptop sleep, network switch)
      → clear the indicator, schedule a reconnect: a NEW mint, because a
        ticket is single-use — nothing is kept to replay
```

Sending, and the deliberate absence of an optimistic render:

```
submit (handoff mode)                          ui.ts
  → handoff.send(text)
      not attached → false → the text STAYS in the box + a notice
      sent         → nothing rendered locally
  ← the server broadcasts the message back to its sender (§8.3)
      → onMessage → the bubble appears
  (one order from one source of truth, and nothing to reconcile against
   the replay that may arrive later)
keystroke → handoff.hintTyping() → at most one frame per
            TYPING_HINT_INTERVAL_MS; the server floors it again at 250 ms
```

The bot's own answer can also start this, with no click at all:

```
ask() → {type:"handoff", status}               (§8.2: a person owns it)
  → enterHandoff(status)
```

That is how a second tab, or a tab that reloaded, catches up. **The honest
limit:** the widget keeps its conversation id in memory only, so a RELOAD
starts a new conversation rather than rejoining the handoff — the visitor
would have to ask once more to be told a person owns the thread. Replay
therefore serves reconnects within a page load and the agent arriving
mid-conversation, both of which are real; resuming across a reload needs a
stored conversation id with an expiry and a recovery path for a stale one,
and is named as future work rather than half-built.
