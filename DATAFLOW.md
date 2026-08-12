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
(§7.1), and as of M3.2 it authenticates — sign-up, sign-in, sign-out,
and the gated page are traced in §7.2–§7.5. Coming after: org
onboarding (M3.3), handoff (M4).

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
             (001_initial_schema, 002_content_pipeline, 003_chat —
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
caller (searchDev CLI | tests | the answer pipeline §5)
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
