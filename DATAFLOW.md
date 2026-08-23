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
persisted before it is broadcast. M4.3 made a dropped connection
survivable (§8.4) — the backlog on attach, delivered exactly once, and
typing as an ephemeral hint — and M4.4/M4.5 built the two ends that use
it: the widget's (§8.5) and the dashboard inbox's (§8.6). M4.6 closed the
loop (§8.7): an agent finishes the conversation, the room is TOLD, and the
bot takes the thread back. **M4 COMPLETE.** M5 is underway: as of M5.1 the
tenant can see what the product is doing (§9) — deflection, strip rate,
latency, and time-to-first-human-response, all read from columns the
pipeline has been writing since M2 — and as of M5.2 what it costs, from
token counts the answer path now records and a dated price list. M5.3 added
the one number that is enforced rather than reported (§10): the day's usage
counters, written inside the transactions that create the answers and
escalations they count, and read as one primary-key lookup against the
org's plan before any model call. M5.4 closed the milestone with billing
(§11): Stripe Checkout out, a signature-verified webhook back, and an event
ledger keyed by Stripe's own event id so a redelivery applies exactly once.
**M5 COMPLETE.** M6 made the trust model a MEASUREMENT (§12): a seeded pair
of tenants and 45 black-box checks against the shipped image — every layer
from the origin allowlist to the socket's single-use ticket, the internal
API's SSRF vet and credential read-back denial behind a throwaway secret —
plus nine poisoned pages in the retrieved context whose containment is
asserted and whose relay is reported, all merge-blocking in the e2e job.
**M6 COMPLETE — every milestone in the plan is.** M7 is the plan's own
trust-model section and the README's named gaps, taken in order of size:
one-click key rotation with a grace window (§7.12), traffic by origin
(§7.13), the secret key and the server-minted session (§5.5, §7.14) — with
which the trust model is built in full — and, as of M7.4, a handoff that
survives a page load (§8.5): a bookmark whose staleness the server settles,
so the next page rejoins the socket and draws nothing until it is confirmed.

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
           (locked_at is set by the claim and RENEWED by every page the
            job lands — §3.2 — so "stale" means no progress, not "slow")
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
  → load sources row
  → sources.status = 'crawling'
  → resolveEmbeddingProvider(db, org)    realtime/src/credentials/resolve.ts
      the org's BYO embedding model, decrypted for this job; null → the
      app-level embedder. Resolved ONCE per job: a rotation landing
      mid-crawl would split one source across two vector spaces.
      A decrypt failure throws → job 'failed' (never a silent wrong model)
  → for await (event of EVENTS)
      kind='upload' → #uploadEvents(source.id)   (M7.6b: a crawl of ONE
        page whose fetch is a database read — source_uploads gives back the
        extraction the upload route stored, blocks SLICED out of the text by
        their spans, so the parser contract holds on the way out as on the
        way in. A missing row throws: an upload source without its
        extraction is a broken invariant, and treating it as a crawl that
        found nothing would soft-delete the document below. Producing the
        crawler's own event shape is what lets every line after this one —
        progress, lease renewal, the vanished sweep, the failure path —
        work on an upload unchanged)
      otherwise → crawl(source)          realtime/src/ingest/crawler.ts
      (crawl() reads <origin>/robots.txt FIRST — §3.3 — and a root the
       file disallows, or a file that is unreachable, throws CrawlError
       before any page: "nothing crawlable — disallowed by robots.txt
       (User-agent: *, Disallow: /)")
      · stop() requested?  → job back to 'queued', source 'pending', return
      · {plan, total}      → ingest_jobs.docs_total = total   (sitemaps;
                             entries robots.txt disallows are not in it)
      · {error, url, msg}  → console.warn + noteSkipped(url, msg)
                             → recordProgress (a fetch was spent)
      · {skipped, url, reason} → noteSkipped(url, reason)  (M7.5: robots.txt
                             said no; nothing fetched, nothing logged)
      · {page, url, doc}   → #processPage (§3.3) → docs_done++
                             → recordProgress
        recordProgress = ONE UPDATE: docs_done, skipped_count,
          skipped_pages (first MAX_RECORDED_SKIPPED_PAGES of them),
          AND locked_at = NOW() — the lease renewed per fetch, so a crawl
          slowed by a Crawl-delay is never reclaimed as crashed (§3.1)
  → soft-delete live documents of this source NOT seen this crawl
    (page removed from the site → retrieval must stop seeing it; a page
     robots.txt now closes is absent by the same rule)
  → ingest_jobs: docs_total=docs_done, skipped_count, skipped_pages,
                 state='done', locked_by=NULL
  → sources: status='ready', last_crawled_at=NOW()
  · any thrown error (CrawlError from a dead or disallowed root, etc.)
      → job 'failed' + error text; source 'failed'
```

### §3.3 One page (inside the crawl loop)

```
crawl() starts                           realtime/src/ingest/crawler.ts
  ← fetchRobotsPolicy(origin)            realtime/src/ingest/robots.ts (M7.5)
      safeFetch(<origin>/robots.txt)     the one request the file does not
                                         govern; same guard as every page
      2xx → parseRobotsTxt → the group for InterrelatedBot (else *)
      3xx-unfollowed / 4xx → no file: everything allowed
      5xx / no status (network, timeout, DNS, SSRF guard, >512 KiB)
          → unreachable: NOTHING allowed (RFC 9309), and the crawl fails
            with the cause in the sentence
      Crawl-delay → effective delay = max(150 ms, min(it, 5 s))
  every URL below is checked with policy.check(url) BEFORE it is fetched:
      root / sitemap file → disallowed = CrawlError, nothing spent
      discovered link      → disallowed = {skipped, url, reason}, no fetch,
                             no queue slot, reported once
      sitemap entry        → disallowed = skipped, and left out of the plan
      child sitemap        → disallowed = skipped
      redirect's FINAL url → disallowed = skipped (the fetch was spent;
                             the content is not kept)

crawl() yields a page                    realtime/src/ingest/crawler.ts
  ← pace()                               the politeness / Crawl-delay wait
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
      → parseHtml | parseMarkdown | parsePdf
        a PDF skips decoding and takes the RAW bytes (§3.10.7):
          copy into a standalone array (pdf.js transfers its input, and a
            Node Buffer is a pooled view that cannot be transferred)
          → one document proxy → title from Info + text per page
          → pages joined by a blank line; each page's lines grouped into
            one paragraph block (pdf.js emits no blank lines)
          → refuses with a sentence: not readable / password-protected /
            over 10 MB / no text layer (a scan — names OCR)
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
           UNDER THE RETRY POLICY (M7.7)  realtime/src/answer/retry.ts
             a provider that REFUSED the call — 429 (the free tiers are
             30 rpm at Groq, 10–15 at Gemini), 408, 5xx, a dead socket —
             is retried with jittered backoff honoring Retry-After;
             401/400/404 are not (a wrong key will still be wrong in two
             seconds) and an abort never is. Bounded by attempts AND by a
             wall-clock budget: a Retry-After that does not fit is refused
             outright, because failing NOW beats failing in a minute with
             the same error. Safe only because nothing generated reaches
             the visitor until step 11 — a half-streamed call showed
             nobody anything. The query embedding (step 4) is wrapped the
             same way.
             · still failing, and a PLATFORM fallback is configured, and
               this org has NO credential of its own → try it ONCE
               (never for a BYO tenant: they chose a vendor and a data
                processor, and a 429 does not justify overriding that)
               · that fails too → rethrow the FIRST provider's error
           mock (tests/CI) | groq/openai-compatible (json_object mode) |
           gemini (schema enforced server-side) | ollama (native format)
           deltas collected; TTFT measured at first delta, in the
           pipeline (not per-provider) so every provider measures alike,
           and the terminal event's token usage kept (null where the
           server reports none — never zeroed, §9)
      9. parseAnswerText                 shared/grounding/claims.ts
           as-is → fenced → first-{-to-last-} (each still fully validated)
           · invalid → buildRetryMessages: replay + EVERY validator error,
             ONE retry only; second failure → AnswerSchemaError (visitor
             message stays, NO assistant row — a transient model failure
             is not conversation history). TTFT keeps the FIRST attempt's
             value (the visitor waited from the original question);
             tokens SUM across both, because both were billed; and the
             answer carries schema_violations = 1, so the retry is a
             COUNTED metric rather than a handled exception (M7.10)
     10. verifyClaims                    shared/grounding/verify.ts
           each claim's quote must occur (whitespace-normalized, case-
           sensitive) in the chunk it NAMES, among the chunks the model
           was SHOWN; raw span offsets captured
     11. displayableClaims               the strip policy: verified only
     12. ONE transaction                 realtime/src/answer/pipeline.ts
           assistant message (content = shown claims joined, or the
           nothing-verified fallback; model, refused, retrieval_score,
           ttft_ms, total_ms, input_tokens, output_tokens) + ALL citation
           verdicts (stripped ones included — the strip-rate data) +
           recency bump
     13. emit {claim}×N (with url + heading for the widget's citations)
           or {refusal} — then {done, claimsTotal, claimsShown}
```

### §5.2 What each failure looks like

```
gate refuses            assistant row: refused=true,  model=NULL,  0 citations
nothing verifies        assistant row: refused=false, model set,   citations all
                        stripped (strip rate 100%) — content is the fallback
schema failure ×2       NO assistant row; AnswerSchemaError to the caller;
                        visitor message + conversation remain. usage_daily
                        .schema_failures += 1 FIRST (wrapped, so it can
                        never replace the error): with no row to count on,
                        this is the only place the worst provider failure
                        is visible at all
abort (visitor gone)    provider throws mid-stream; nothing persisted past
                        the visitor message
deadline (M8.4)         the answer as a whole outlived ANSWER_DEADLINE_MS
                        (60 s default) — a provider accepted the call and
                        went quiet, the failure no retry policy can see
                        because nothing ever fails. AbortSignal.timeout,
                        composed with the visitor's signal, aborts every
                        in-flight provider call; the pipeline throws
                        TimeoutError (never retried — isAbort), no
                        assistant row, the visitor message kept. At the
                        route the visitor is STILL WATCHING, so unlike the
                        abort above this one gets the terminal opaque
                        {type:"error"} event (§3.15.6)
```

### §5.3 The HTTP surface — bubble-open → session → SSE answer (M2.5)

```
widget (M2.6) or curl-with-headers
  → POST /v1/widget/session            realtime/src/routes/widget.ts
      Origin header required           absent → 403 (a script; no free
                                       sessions — layer 3 bounds scripts)
      per-IP token bucket              realtime/src/widget/rateLimit.ts
      api_keys lookup                  kind=public, LIVE = revoked_at IS
                                       NULL OR revoked_at > NOW() (a key
                                       inside its rotation grace window
                                       is live — §7.12; Postgres's clock,
                                       the one the dashboard wrote with);
                                       unknown, revoked, and past-grace →
                                       ONE uniform 401
      allowed_origins exact match      miss → recordOriginMint(refused)
                                       (§7.13: the key named the org, so
                                       the tenant gets to see this
                                       origin) → 403 with NO CORS headers
                                       — an unlisted site's browser cannot
                                       even read the error
      visitorId, if given, must be     shared/utils/visitorIds.ts (§5.5):
      ANONYMOUS-shaped (vis_<32 hex>)  the id this route itself mints and
                                       the widget stores; an IDENTIFIED id
                                       (a customer's user id) is refused
                                       with the same 400 as a malformed
                                       one — only the secret-key route may
                                       mint those, or anyone on the origin
                                       could mint a session AS user 42
      api_keys.last_used_at = NOW()    ← this handshake is also what warms
                                       Neon while the visitor types
      recordOriginMint(minted)         realtime/src/usage/origins.ts —
                                       awaited (the dashboard never lags
                                       the widget), wrapped (it can never
                                       fail the mint)
      → mintSessionToken               realtime/src/widget/sessionToken.ts
        {org, origin, visitor, exp}    HMAC-signed, 30 min TTL
      → 200 {token, expiresAt, visitorId} + CORS echo of the origin

  → POST /v1/widget/chat  (Authorization: Bearer <token>)
      verifySessionToken               tampered/expired/foreign → uniform 401
      token.origin === live Origin     mismatch → 403 (replay from another
                                       site dies even before rate limits)
      per-IP + per-visitor buckets     429 WITH CORS — the widget renders
                                       a "one moment" state
      per-org daily ceiling            getDailyQuota (§10): the org's PLAN
                                       cap against today's usage_daily
                                       counter, ONE primary-key read,
                                       BEFORE any model call → 429
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
                                       the ingest worker reads this same row.
                                       Since M7.8 the row may name any of
                                       the schema's FIVE providers — the
                                       "anthropic has no adapter yet" throw
                                       that used to live on this hop is gone
                                       (§2.4.5n), so the union the CHECK
                                       allows and the union that resolves
                                       are finally the same one
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
      — or, in STRONG MODE (data-session-url instead of data-key, M7.3):
      GET <session-url>                  a URL on the CUSTOMER's own site
        credentials: include, no-store   (§5.5): their server minted the
                                         session with the SECRET key for
                                         the signed-in user; the answer is
                                         realtime's, proxied verbatim; the
                                         identified visitor id is NOT
                                         written to localStorage

visitor asks
  → ask(question, conversationId?)       widget/src/api.ts
      POST /v1/widget/chat, Bearer token
      401 → ONE silent re-mint + retry   30-min expiry, invisible — in
                                         strong mode the re-mint is another
                                         GET of the session URL
      429 → QuotaError | RateLimitError  distinct visitor-facing states
      → readAnswerEvents(body)           widget/src/sse.ts
  → per event                            widget/src/ui.ts
      meta    → conversation id threads into the NEXT ask
      claim   → textContent paragraph + http(s)-vetted citation link
                (NEVER innerHTML — claim text is model output)
      refusal → ordinary assistant bubble
      error   → notice + input recovery (the widget never bricks)
```

### §5.5 Strong mode — the customer's server mints the session (M7.3)

Trust-model layer 6. Everything from the token onward is §5.3; what
changes is WHO proves the visitor is allowed. By default the browser does
(publishable key + Origin, and the allowlist plus rate limits bound a
copied snippet). Here the customer's own backend does — with the SECRET
key, for a user it has signed in — and the page carries no publishable key
at all.

```
the customer's page (no data-key)
  <script src=".../widget.js" data-session-url="/api/support-session" data-api="…">
  bubble opens → GET /api/support-session   widget/src/api.ts, with the
                                            page's own cookies (§5.4)

the customer's server (their code — the Install page's recipe, §7.14)
  requireSignedInUser(req)                  THEIR login decides who this is
  → POST {api}/v1/sessions                  realtime/src/routes/widget.ts
      Authorization: Bearer sk_live_…       from the server's environment
      {origin: "https://app.example.com",   the origin the page runs on
       visitorId: user.id}                  their stable user id
  ← pass realtime's answer through, status included, cache-control: no-store

POST /v1/sessions  (realtime — never CORS: no preflight handler, no echo,
                    so a browser page cannot use a secret key even by
                    mistake; it stops at preflight)
      per-IP bucket (60 / 1 per s)          more generous than the browser
                                            mint — one IP is a backend
                                            minting for many users; what it
                                            bounds is guessing at a secret
      bearer without sk_ prefix             → 401 (the publishable key,
                                            garbage, nothing: refused for
                                            shape, no lookup)
      api_keys lookup                       kind=secret, secret_hash =
                                            sha256(bearer)
                                            (shared/utils/ids.ts), LIVE =
                                            revoked_at IS NULL OR
                                            revoked_at > NOW() — the same
                                            grace-window rule as the
                                            publishable key, on Postgres's
                                            clock; unknown, revoked, and
                                            past-grace → the byte-identical
                                            401
      visitorId must be IDENTIFIED-shaped   anything well-formed that is not
                                            vis_<hex> (shared/utils/
                                            visitorIds.ts); the anonymous
                                            namespace is the browser's →
                                            400 with a sentence (the caller
                                            proved it is the tenant)
      origin required, and ALLOWLISTED      miss → recordOriginMint(refused)
                                            (§7.13 — the tenant's traffic
                                            table shows it with an Allow
                                            button) → 403 with a sentence:
                                            unlisted, or not an origin at all
      api_keys.last_used_at = NOW()         "last used" beside "accepted
                                            until" — the same clock
      recordOriginMint(minted)              a server mint is a widget load
      → mintSessionToken {org, origin, visitor: user.id, exp}
      → 200 {token, expiresAt, visitorId}   the browser mint's shape, so the
                                            endpoint proxies it verbatim

back in the page
  the widget holds the token in memory and chats on it exactly as in §5.3;
  the conversation row's visitor_id IS the customer's user id, which the
  dashboard names "user 42 — identified by your server" (§7.10) — trustworthy
  because the browser mint refuses that shape, so only the secret key could
  have put it there
```

What the impersonation control looks like from outside (the security
probe's section [I], §12.2): a browser on the allowlisted origin minting with
the publishable key and `visitorId: "42"` gets a 400 and no session; the
secret key presented on the browser route, and the publishable key presented
here, are each refused for their shape; and the token a server minted dies
replayed from any other origin, like every other token.

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

### §7.9 Source connect → crawl → visible progress (M3.6a), skipped pages and Re-crawl (M7.5)

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
      → ONE transaction: SELECT organizations … FOR UPDATE   (M8.5 — the
                           plan's source ceiling, checked with the org row
                           locked so two concurrent creates cannot both
                           count under it; at the ceiling the transaction
                           rolls back → 409 naming the plan, the count,
                           and delete-or-upgrade)
                         COUNT sources for the org
                         INSERT sources (pending)
                         INSERT ingest_jobs (queued)
      → onEnqueue()                    server.ts wired this to
        → worker.wake()                realtime/src/ingest/worker.ts —
                                       in production this call IS the
                                       scheduler (no poll exists)
          → tick → claim → §3.2 runs the crawl
    → revalidatePath(sources page)

meanwhile, in the browser:
  sources page renders from            web/src/lib/sources/queries.ts
    (sources + each one's LATEST job + live document counts, and since
     M7.5 that job's skipped_count + skipped_pages — "N pages indexed ·
     M skipped", with a collapsed "why" list: url — reason)
  a queued/running job mounts          components/AutoRefresh — 4s
    router.refresh() until the job settles; idle pages poll nothing

Re-crawl (M7.5) — the owner's button beside any crawlable source with no
job queued or running:
  Re-crawl form submit
    → recrawlSourceAction                web/src/lib/sources/actions.ts
      → isId("src") → currentUser → getOrgForMember → OWNER
      → recrawlSource                    web/src/lib/realtime/index.ts
          POST …/internal/orgs/<org>/sources/<src>/recrawl
        → requireSecret → requireOrg     realtime/src/routes/internal.ts
        → source is this org's (else 404). Uploads included since
          M7.6b — 009 keeps their text, so there is something to
          re-ingest FROM; the button reads "Re-index" for a file
        → INSERT ingest_jobs … ON CONFLICT (source_id)
             WHERE state IN ('queued','running') DO NOTHING
           (008's partial unique index: one LIVE job per source — five
            concurrent clicks insert one; no read, no transaction)
        → a row inserted → onEnqueue() → worker.wake()  → §3.2
          none → {queued: false}, and nothing else happens
      → revalidatePath(sources page)     the source now reads "queued…",
                                         and AutoRefresh mounts
```

### §7.9a Uploading a file as a source (M7.6b)

The other way documentation gets in: the tenant hands over the file
instead of naming a page to fetch. The split of work is the point — the
PARSE happens in the request, the EMBED stays behind the queue.

```
UploadSourceForm submit  (file input; >10 MB refused in the browser
  before it is spent — the service enforces it again regardless)
  → uploadSourceAction                 web/src/lib/sources/actions.ts
    → currentUser → getOrgForMember → OWNER
    → file.arrayBuffer()               Next already buffered it to parse
                                       the FormData; next.config.ts raises
                                       serverActions.bodySizeLimit to 12mb
                                       (ABOVE realtime's 10 MB cap, so the
                                       413 that answers is the one with the
                                       number in it, not a framework error)
    → uploadSource                     web/src/lib/realtime/index.ts
        POST …/internal/orgs/<id>/sources/upload
        content-type: application/octet-stream   ← NOT the file's own type:
          realtime mounts express.json at 64 KB across every route, so a
          .json upload announced as application/json would be claimed and
          refused by that parser before this route ran
        x-upload-filename: <percent-encoded>     ← header values are
          latin-1; filenames are not
        x-upload-content-type: <the browser's claim>
      → requireSecret → requireOrg     realtime/src/routes/internal.ts
      → express.raw({limit: 10 MB})    invoked by hand so its refusal is
          over the cap → 413 JSON       JSON like every other one here.
          Nothing is parsed: a PDF parser decompresses, so refusing a big
          body AFTER parsing would have already done the expensive thing
      → filename: decode, strip any path (a name is a LABEL here, never a
          location), 1–255 chars else 422
      → parseResource({url: filename, contentType, charset, body})
          realtime/src/ingest/parsers/index.ts — magic bytes lead, so a PDF
          the browser called text/plain is still read as a PDF (§3.10.3)
        · PdfParseError → 422 with the parser's own sentence: a SCAN names
          OCR, a password-protected file says so. This is why the parse is
          in the request at all — those sentences are worth the most while
          the tenant still has the file in front of them
        · parsed but empty → 422 (a source that reads "ready" and answers
          nothing is the state a tenant cannot debug)
        · BEFORE the parse, an advisory ceiling read (M8.5): refusing a
          full plan after seconds of PDF decompression would do the
          expensive thing first — the 413-before-parse argument. The
          transaction below re-checks with the lock; this half just fails
          sooner
      → ONE transaction:
          SELECT organizations … FOR UPDATE + COUNT sources   (M8.5 — the
                                 authoritative ceiling check; over → 409)
          INSERT sources        (kind='upload', location=filename, depth 0)
          INSERT source_uploads (filename, format DETECTED, byte_size,
                                 title, text, blocks AS SPANS — the text is
                                 not stored twice; migration 009)
          INSERT ingest_jobs    (queued)
      → onEnqueue() → worker.wake() → §3.2, which reads the row back
      → {sourceId, filename, format, title, charCount}
    → revalidatePath(sources page)

### §7.9b Deleting a source (M8.5)

The half that makes the ceiling above honest: sources were add-only from
M3.6a to here, and a cap on an add-only resource would spend a free
tenant's single slot forever on their first typo'd URL.

```
Delete button (owner; hidden while a crawl is RUNNING — that delete would
be refused, and a button that always refuses is worse than none)
  → deleteSourceAction                 web/src/lib/sources/actions.ts
    → isId("src") → currentUser → getOrgForMember → OWNER
    → deleteSource                     web/src/lib/realtime/index.ts
        DELETE …/internal/orgs/<org>/sources/<src>
      → requireSecret → requireOrg     realtime/src/routes/internal.ts
      → ONE transaction:
          SELECT sources … FOR UPDATE  (this org's, else 404 — foreign,
                                        fabricated, and malformed collapse)
          DELETE ingest_jobs WHERE source_id AND state='queued'
            · takes the row locks — the worker's FOR UPDATE SKIP LOCKED
              claim cannot take a locked row, so a job cannot be claimed
              mid-delete; the race resolves in Postgres (§3.23's playbook)
          EXISTS ingest_jobs state='running'?
            · yes → THROW → the whole transaction rolls back (the queued
              rows come back too — a refused delete changes nothing)
              → 409 "a crawl of this source is running"
          DELETE sources               → CASCADE takes documents, chunks,
                                         chunk_embeddings, source_uploads,
                                         and job history
      → no wake: nothing was enqueued
    → revalidatePath(sources page)     the row is gone, a slot is free

what survives, deliberately: every transcript. message_citations snapshots
url/heading/quote and carries NO chunk FK (§3.3.2) — the dashboard still
shows each claim's verdict against content that no longer exists, which is
exactly why the FK was left out.
```
    → "handbook.pdf read — 4,210 characters of text. Indexing starts now."
       (the character count is the only honest answer to "did that work?"
        about a file the service deliberately did not keep)

THE BYTES ARE NEVER STORED. What survives is the extraction — which is
also what makes the upload a first-class source: when the org changes its
embedding model, §3.22 re-queues every source, and a crawl answers that by
being fetched again while an upload has nothing to re-fetch. Without the
stored text a model change would silently orphan every uploaded document.
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

### §7.12 Rotating the publishable key — POST (Server Action) from `/dashboard/[orgId]` (M7.1)

Trust-model layer 5. The dashboard writes two rows; realtime's session
mint (§5.3) reads them — and the thing that makes the click safe is that
the old key does not die on it.

```
RotateKeyForm submit  (hidden: orgId, keyId = the key the page showed as current)
  → rotatePublishableKeyAction         web/src/lib/keys/actions.ts
    → currentUser → getOrgForMember → OWNER
    → rotatePublishableKey(orgId, keyId)   web/src/lib/keys/index.ts
        BEGIN
        UPDATE api_keys
           SET revoked_at = NOW() + make_interval(hours => 24)
         WHERE id = keyId AND org_id = orgId AND kind = 'public'
           AND revoked_at IS NULL           ← the atomic claim (§3.23's
                                              playbook): a second click,
                                              a retried POST, two owners
                                              at once — whoever loses
                                              updates 0 rows and gets
                                              {rotated:false}, writing
                                              nothing; no lock, no
                                              read-then-check
        (0 rows) → ROLLBACK, {rotated:false}
        INSERT api_keys (new id, org, kind=public, public_id = pk_live_<32>)
        COMMIT → {rotated:true, publishableKey, graceEndsAt}
    → revalidatePath(overview) + revalidatePath(install page)
    → the form says: new key issued; the previous key works until
      <graceEndsAt UTC> unless revoked sooner

  the overview re-renders from Postgres — listPublishableKeys:
    CASE WHEN revoked_at IS NULL     THEN 'current'
         WHEN revoked_at > NOW()     THEN 'retiring'   ← the SAME comparison
         ELSE                             'revoked'      the session route
    END                                                  makes, so what the
                                                         page calls retiring
                                                         is what the widget
                                                         still accepts
  the install page's snippet now carries the NEW key, with a
  rotation-in-progress notice naming the grace end

"Revoke now" on a retiring key
  → revokePublishableKeyNowAction     same ladder
    → UPDATE api_keys SET revoked_at = NOW()
       WHERE id = keyId AND org_id = orgId AND kind = 'public'
         AND revoked_at IS NOT NULL AND revoked_at > NOW()
       └ only a RETIRING key: the current one cannot be revoked without a
         replacement (rotate instead — the org is never keyless by a
         click), and an already revoked one keeps its honest instant

…and what realtime does with each of those rows (§5.3), on Postgres's clock:
  the CURRENT key   → revoked_at IS NULL     → mints
  a RETIRING key    → revoked_at > NOW()     → mints, and stamps
                                               last_used_at, which is how
                                               the overview can say "last
                                               used a minute ago" — i.e.
                                               the old snippet is still
                                               deployed somewhere
  a REVOKED key     → revoked_at <= NOW()    → 401, byte-identical to a
                                               key that never existed
  a token minted while its key was live keeps working for its 30 minutes
  after the key is revoked: it is bound to the org, not the key
  (§3.17.1). Revocation stops NEW sessions; it does not evict a visitor
  mid-conversation.
```

Why one clock, and why it is the database's: the dashboard runs on Vercel
and the session route on Render, so the grace end is written by one machine
and read by another, and Neon's `NOW()` is the only clock both can share.
Every comparison above — the write, the route's read, the page's CASE, and
the tests' `revoked_at - NOW()` — is made there. What rotation is worth for
a PUBLIC key is stated in CLAUDE.md §9.17 rather than oversold: hygiene, a
way to invalidate every deployed snippet at once without downtime, and the
mechanism the secret key (layer 6) will need — not a defense against a
scraper, which is what layers 1 and 3 are for.

### §7.13 Traffic by origin — the counter, the table, and the one-click Allow (M7.2)

Trust-model layer 4. realtime counts; the dashboard shows; the tenant
decides. Layer 1 refused the copy already — this is how they find out it
exists.

```
every POST /v1/widget/session that names an org (§5.3)
  Origin allowlisted   → recordOriginMint(orgId, origin, "minted")
  Origin NOT allowlisted → recordOriginMint(orgId, origin, "refused") → 403
  no Origin / bad key  → nothing: refused before anything named an org,
                         and the route spends no lookup on requests it
                         refuses for free

  recordOriginMint                     realtime/src/usage/origins.ts
    minted  → INSERT origin_daily (org, utcDay, origin, minted=1)
                ON CONFLICT (org, day, origin) DO UPDATE minted += 1
    refused → origin := normalizeRefusedOrigin(origin)
                  looks like an origin (^https?://[^\s/]+$, ≤253) → itself
                  the literal "null" (file://, sandboxed iframe) → itself
                  anything else → "(malformed)"
              UPDATE … SET refused += 1 WHERE (org, day, origin)   ← common
                                                                     case
              0 rows → count rows for (org, day)
                       ≥ 100 → origin := "(other)"                  ← the cap
                       INSERT … ON CONFLICT DO UPDATE refused += 1
    either  → awaited by the route, wrapped: an error is logged and the
              visitor still gets their session

GET /dashboard/[orgId]/widget  (the install page, under the allowlist)
  → listOriginTraffic(orgId, 7)        web/src/lib/traffic/queries.ts
      SELECT origin, sum(minted), sum(refused), max(day),
             EXISTS(allowed_origins row) AS allowlisted
      WHERE org_id AND day >= today_utc − 6      ← Postgres draws the window
      GROUP BY origin
      ORDER BY sum(refused) DESC, sum(minted) DESC, origin
  → the table: refused-and-unlisted rows first and tinted, each
    allowlistable one with an owner-only Allow; sentinels spelled out
    (originLabel); "No widget loads yet." for an empty week

GET /dashboard/[orgId]  (the overview)
  → refusedSummary(orgId, 7)  → {refused, origins}
  → refused > 0 → one flag sentence linking to the table; else nothing

Allow (on a refused row)
  → allowOriginNowAction              web/src/lib/origins/actions.ts
    → currentUser → getOrgForMember → OWNER
    → validateOrigin(hidden field)     re-validated: a hidden field is
                                       still a request field
    → INSERT allowed_origins ON CONFLICT DO NOTHING
    → revalidatePath(install page, overview)
  …and the effect, on the very next widget request from that origin:
    allowed_origins lookup hits → token minted (200) → recordOriginMint
    (minted) → the SAME row now carries both counters — refused before
    noon, minted after
```

What is deliberately not here: no IP, no visitor id, no Referer (a
browser's default Referrer-Policy strips the path on cross-origin requests,
so it would only repeat the Origin), no per-mint log — a counter per
(org, day, origin), which is what a week-per-origin read wants and what
keeps the read from growing with the customer's success (CLAUDE.md §3.3.8,
§3.28, §9.18).

### §7.14 The secret key — issued once, rotated, revoked (M7.3)

Trust-model layer 6's dashboard half. The same rows and the same standing
rule as §7.12; what differs follows from the key being a secret.

```
SecretKeyForm submit  (hidden: orgId, keyId = the current secret key's id, or "")
  → secretKeyAction                    web/src/lib/keys/actions.ts
    → currentUser → getOrgForMember → OWNER
    keyId = ""  → issueSecretKey(orgId)          web/src/lib/keys/index.ts
        secretKey = newSecretKey()               sk_live_<32 base32>
        INSERT api_keys (kind=secret,
          secret_hash = sha256(secretKey),        the ONLY copies the row
          secret_suffix = last 4 chars)           will ever hold
        unique violation on
          api_keys_one_current_secret_per_org  → {issued:false} — another
                                                  owner (or tab) got there
                                                  first; the page now shows
                                                  that key. Idempotence by
                                                  SCHEMA: a first issue has
                                                  no key to rotate FROM
        → {issued:true, keyId, secretKey, suffix}
    keyId set   → rotateSecretKey(orgId, keyId)
        BEGIN
        UPDATE api_keys SET revoked_at = NOW() + 24h
         WHERE id = keyId AND org = orgId AND kind = 'secret'
           AND revoked_at IS NULL           ← the atomic claim (§7.12)
        (0 rows) → ROLLBACK, {rotated:false}
        INSERT the new secret row (hash + suffix)
        COMMIT → {rotated:true, keyId, secretKey, suffix, graceEndsAt}
    → revalidatePath(overview) + revalidatePath(install page)
    → the action's RETURN VALUE carries the plaintext — the one time it
      exists outside the customer's server — into the form's client state,
      where SecretKeyForm shows it with a Copy button while the page's
      current key IS the row it belongs to; navigate away and it is gone.
      The database never held it.

the overview re-renders — listSecretKeys:
  the same CASE as the publishable list (current / retiring / revoked
  against NOW()), suffix and standing only: "sk_live_…k3p9 · issued · last
  used"; the install page's section 4 names the suffix and carries the
  endpoint recipe and the data-session-url snippet

Revoke  (the CURRENT key — "stop server-side sessions" — or a retiring one)
  → revokeSecretKeyNowAction            same ladder
    → UPDATE api_keys SET revoked_at = NOW()
       WHERE id = keyId AND org = orgId AND kind = 'secret'
         AND (revoked_at IS NULL OR revoked_at > NOW())
       └ the current key CAN be revoked here, where the publishable one
         cannot: an org with no secret key is simply not using server-side
         sessions. An already revoked key keeps its honest instant.

…and what realtime does with each of those rows on POST /v1/sessions (§5.5):
  the CURRENT key   → mints, and stamps last_used_at
  a RETIRING key    → mints until its instant — the customer's backend that
                      has not been redeployed keeps working; "last used"
                      tells the owner it is still out there
  a REVOKED key     → 401, byte-identical to a key that never existed
  a token minted while its key was live keeps working for its 30 minutes
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

That is how a second tab catches up, and how a visitor whose rejoin was
abandoned (below) still gets back in by asking.

**Across a page load (M7.4).** A widget lives one page at a time, so to it a
reload and a click to the next docs page are the same event — and until M7.4
both lost the handoff: the conversation id lived in memory, the next page
started a new conversation, and the agent's replies landed in a room the
visitor was no longer in. Now the LIVE handoff is bookmarked and the next
page rejoins it. The bookmark is written only while a person owns the thread
(the bot's conversations are never bookmarked — nobody is waiting on them,
and the widget could not show a rejoined bot thread anyway, since the
transcript arrives only over the socket):

```
enterHandoff / a panel toggle / every attach   widget/src/ui.ts touchBookmark
  → client.rememberHandoff(conversationId, panelOpen)     api.ts
      localStorage["interrelated.handoff"] = {conversationId, panelOpen, at}
      (guarded like the visitor id: Safari private mode = no bookmark, and
       the handoff simply is not rejoined on the next page)
leaveHandoff (`ended`, `closed`)  → client.forgetHandoff()  → removed
```

The next page load, before anything is drawn:

```
mountWidget → rejoinStoredHandoff()                        ui.ts
  → client.storedHandoff()                                 api.ts
      no bookmark               → null: NOTHING happens, no request at all
      older than 24 h (at)      → dropped, null: not worth a mint on every
                                  page for the rest of time
      otherwise                 → {conversationId, panelOpen}
  → conversationId adopted; rejoining = {panelOpen, 60 s timer}
  → handoff = client.openHandoff(conversationId, handlers)
      the socket's OWN first ticket mint is the probe (the connect path
      above): a reconnect loop with backoff is exactly the right thing to
      point at
      "is this handoff still there?" — transient failure retries, and the
      server's answer is terminal either way
  → the socket reports:
      "connecting"        → ignored (nothing drawn)
      "ended"             → the ticket route said 404: closed while the
                            visitor was away, or never theirs (a shared
                            computer). Forgotten silently; conversation id
                            dropped; the page is now exactly one that had no
                            bookmark — no "the support chat has ended" on a
                            page the visitor never escalated from
      "waiting"/"connected" (from `ready`) → CONFIRMED: status line drawn,
                            composer switched to the socket, `greeted` set
                            (the transcript is the greeting), the panel
                            re-opened iff panelOpen — without stealing focus
                            — and the bookmark re-stamped
      history             → replaces the log, as always
  → 60 s with no confirmation → the probe is closed and the bookmark KEPT
    (the next page tries again); the conversation id is kept too, so a
    question asked once the outage clears lands in the thread a person may
    own and the `handoff` event catches the visitor up
```

Two costs, stated. A visitor mid-handoff spends one session mint and one
ticket mint per page load — the same handshake bubble-open makes, and per-IP
bounded like it (10 mints a minute; a rejoin that meets the bucket retries
inside the socket's backoff). And in strong mode the mint goes back through
the customer's endpoint, so a signed-out user's stale bookmark is a
60-second poll of that endpoint at the loop's ceiling, then silence — which
is what the bound is for. Between the two states a question typed during the
probe goes to the BOT under the stored id: a person owning the thread answers
as `handoff`, which enterHandoff leaves to the socket already probing (one
socket, never two).

While the panel is closed and a person writes, the bubble carries an unread
badge (one class, one `::after`); opening clears it. The replayed backlog and
the visitor's own echo from another tab are not news and never badge.

### §8.6 The agent's end (M4.5)

The dashboard half. Note what is NOT here: no server-rendered thread, no
second copy of the transcript — the socket's own replay is the thread.

```
/dashboard/[orgId]/inbox                     web/src/app/…/inbox/page.tsx
  → requireOrgMember (any member: answering IS the agent role)
  → listOpenHandoffs(orgId)                  lib/handoff/queries.ts
      handoff_sessions ⋈ conversations, status <> 'closed'
      unclaimed first, longest wait first    ← the queue's whole point
  → AutoRefresh(8s), unconditionally: what changes this page is a VISITOR
    escalating, which it can never learn from its own render

click a row → /dashboard/[orgId]/inbox/[conversationId]
  → requireOrgMember → getConversation (org-scoped 404) → getOpenHandoff
      null → "nobody is waiting" + a link to the transcript, not an error
  → <HandoffChat apiBase={NEXT_PUBLIC_WIDGET_API_URL}>   (client)
      → useHandoffSocket
          requestHandoffTicketAction(orgId, conversationId)   "use server"
            signed-in? → member? → realtime POST
              /internal/orgs/:orgId/handoff-tickets  (x-internal-secret)
              ← {ticket}          realtime re-checks membership + open row
            ← {ok:false}          → terminal: the mint IS the authorization
                                    check, so its refusal is not retried
          → wss://…/v1/handoff?ticket=…
          → ready    → backoff reset; attaching CLAIMED the handoff (§8.3)
            history  → replaces the rendered thread (bot's turns included)
            message  → appended by id (idempotent against the backlog)
            presence → visitors > 0 ? "Visitor is here" : "Visitor is away"
            typing   → "Visitor is typing…", expired HERE after 6 s
```

Sending mirrors the widget exactly, including what it does not do:

```
submit → send(text)
    not attached → false → the reply STAYS in the box + a notice
    sent         → nothing appended locally; the server's echo renders it
change → hintTyping() → one frame per TYPING_HINT_INTERVAL_MS
```

Still missing, and named rather than stubbed: nothing WRITES
`handoff_sessions.closed_at` yet, so a claimed conversation stays claimed.
The widget already handles the closed state (§8.5 — a null ticket is
terminal and reads as "the assistant is back"), and the schema has had the
column since §3.3.4; what does not exist is the button.

### §8.7 Closing a handoff (M4.6)

The lifecycle's other end. Note where it does NOT go: web writes the origin
allowlist directly (§7.11), but not this — closing has an in-process
consequence, and the rooms live in realtime.

```
"Close conversation"                web/src/components/HandoffChat/index.tsx
  → closeHandoffAction(orgId, conversationId)      "use server"
      signed-in? → member? (no owner check: the agent who answered is the
                            person who knows it is finished)
      → POST /internal/orgs/:orgId/handoffs/:conversationId/close
          x-internal-secret, {userId}
        → membership re-established here, not taken on web's word
        → closeHandoff(db, …)        realtime/src/handoff/escalate.ts
            ONE transaction:
              UPDATE handoff_sessions
                SET status='closed', closed_at=NOW(),
                    claimed_at = COALESCE(claimed_at, NOW()),
                    claimed_by = COALESCE(claimed_by, <closer>)
                WHERE conversation_id = … AND status <> 'closed'
                                             ↑ the guard that makes five
                                               simultaneous clicks one write
              UPDATE conversations SET status='open'
                (both rows or neither: a closed handoff under an
                 'escalated' conversation would be a widget insisting a
                 person owns a thread the bot is answering)
            ← {closed:true}  — or {closed:false}, which is a normal answer
                               (double click, or a colleague got there first)
        → if closed: onHandoffClosed(conversationId)     server.ts wiring
            → handoff.endRoom(conversationId)   realtime/src/handoff/socket.ts
                → send {type:"closed"} to every member
                → close each socket        (frame first, hang-up second)
      → revalidatePath(inbox, inbox/[id])   the QUEUE is server-rendered;
                                            the open chat learns from the
                                            frame, not from this
```

What each end does with the frame:

```
widget      → HandoffSocket stops (no reconnect, no mint) → status "ended"
              → leaveHandoff(): composer back to "Ask a question…"
              → the next question goes to the BOT, which answers, because
                §3.15.3 no longer finds an open handoff
dashboard   → useHandoffSocket stops → state "ended" → composer disabled
              → the revalidated page renders "nobody is waiting"
```

And the conversation can be escalated again tomorrow: the unique index is
over OPEN rows only (§3.3.4), which is the whole reason the lifecycle is a
table rather than a column on `conversations`.

---

## §9 Metrics (M5.1, M5.2)

A read path, but the definitions are the interesting part: each of the four
headline numbers had an easier version that would have been wrong.

```
GET /dashboard/[orgId]/metrics          web/src/app/dashboard/[orgId]/metrics/page.tsx
  → requireOrgMember(orgId)             (readable by agents too — §9.12's rung)
  → getOrgMetrics(org.id, 30)           web/src/lib/metrics/queries.ts
      four queries, in parallel, all org-scoped in the WHERE:

      answerMetrics      messages WHERE role='assistant' AND created_at >= since
                         count(*), count(*) filter (refused),
                         percentile_cont(0.5|0.95) over ttft_ms / total_ms
                           FILTER (WHERE NOT refused)   ← same rows for both,
                                                          or they are not
                                                          comparable
      groundingMetrics   message_citations JOIN messages   (citations carry no
                         org_id — the tenant boundary is the join)
                         count(*), count(*) filter (verdict <> 'verified'),
                         split by unknown_chunk vs quote_not_found
      deflectionMetrics  conversations WHERE EXISTS(an assistant message)
                         count(*), count(*) filter (EXISTS a handoff)
                         + handoff_sessions JOIN messages(role='agent')
                           percentile over (first agent turn − requested_at)
      modelMetrics       messages GROUP BY model  → the comparison table
                         count(*), count(*) filter (input_tokens IS NOT NULL),
                         sum(input_tokens), sum(output_tokens), latency p50s
  → costMetrics(byModel)                web/src/lib/metrics/queries.ts (pure)
      per row: costUsd(model, in, out)  shared/pricing/models.ts
                         exact model match, null for anything unlisted
      fold:    priced rows → total + pricedAnswers
               everything else → unpricedAnswers   ← shown, not hidden
  → render; a rate with no denominator prints "—", never 0%
```

The four definitions, and what each rejects:

| Metric | Defined as | The easier version, and why not |
|---|---|---|
| Deflection | conversations with an answer and **no** handoff ÷ conversations with an answer | Per *message* would let one thread that ends in escalation contribute a dozen "deflected" answers. Conversations with no answer at all are excluded — a visitor who typed nothing is neither. |
| Time to first human response | first **agent message** − `requested_at`, earliest turn per handoff | `claimed_at` is when someone *attached*, and attaching is automatic on opening the conversation (§8.6) — a team that opens tabs fast and answers slowly would score perfectly. |
| Latency percentiles | over **answered** messages only | A gate refusal never calls a model, so it has `total_ms` but no `ttft_ms`; mixing them made a live page show a full answer (99 ms) faster than its own first token (110 ms). |
| Cost per 1k answers | list price × measured tokens, over **generated** answers whose model is priced *and* whose provider reported usage | Including refusals in the denominator would make a bot that refuses more look cheaper rather than more cautious. Treating an unlisted model as free would state a specific falsehood about a self-hosted tenant's real bill; prefix-matching one onto a cheaper sibling would understate it ~10× and be believed. |

Where the token numbers come from (M5.2), since this is the one metric that
needed a column the pipeline was not already writing:

```
answerQuestion                          realtime/src/answer/pipeline.ts
  → collectStream(...)                  keeps the terminal event's `usage`
       LLMStreamEvent {type:"done", usage}     providers/llm/* — every real
                                               adapter reports it; null where
                                               a server omits it on streams
  → (schema violation) collectStream again
       usage = addUsage(first, retry)   SUMMED — both calls were billed, so
                                        a retried answer really did cost twice
  → persistAssistantMessage             messages.input_tokens / .output_tokens
       gate refusal  → NULL, NULL       no model ran; null ≠ 0
```

Nothing on the read path writes. Every column it reads was written when the
pipeline ran — `refused`, `model`, `ttft_ms`, `total_ms` (§5.2), every
citation verdict (§5.2), `requested_at` (§8), and now the token pair — which
is the whole point of instrumenting before there was anything to measure.

---

## §10 Quotas — the counter, and the check before the model call (M5.3)

The one metric-shaped number that is not only reported: it is ENFORCED, so
it runs on the hot path and its cost matters.

### §10.1 Writing the counters

Both writes ride inside a transaction that was already happening, which is
what makes drift impossible rather than unlikely:

```
answerQuestion → persistAssistantMessage       realtime/src/answer/pipeline.ts
  BEGIN
    INSERT messages (…, input_tokens, output_tokens)
    INSERT message_citations × N                 every verdict, stripped too
    UPDATE conversations.last_message_at
    recordAnswer(trx, {orgId, refused, usage})   realtime/src/usage/daily.ts
      INSERT usage_daily (org_id, day=utcDay(), answers=1,
                          refusals=0|1, input_tokens, output_tokens)
      ON CONFLICT (org_id, day) DO UPDATE
        SET answers = usage_daily.answers + excluded.answers, …
  COMMIT

requestHandoff                                  realtime/src/handoff/escalate.ts
  BEGIN
    INSERT handoff_sessions                      the partial unique index
    UPDATE conversations.status = 'escalated'    decides the race
    recordEscalation(trx, {orgId})               escalations + 1
  COMMIT
  ↑ ONLY on the branch that creates. The read-first hit and the
    unique-violation loser both return the existing handoff and count
    nothing — a visitor mashing the button must not inflate the number the
    deflection rate is measured against.
```

Ten answers landing together produce ten, because the arithmetic is
Postgres's (`ON CONFLICT DO UPDATE`), not the application's. A
read-then-write would lose most of them under exactly the load a quota
exists for.

### §10.2 Reading it, before the model call

```
POST /v1/widget/chat                    realtime/src/routes/widget.ts
  … token verify, origin re-check, token buckets …
  → getDailyQuota(db, org, {overrideLimit})     realtime/src/usage/daily.ts
      SELECT organizations.plan, usage_daily.answers
        FROM organizations
        LEFT JOIN usage_daily ON (org_id, day = today UTC)
       WHERE organizations.id = $org
      ↑ one round trip, both sides primary-key lookups. No counter row is
        a quiet day → 0, not an error.
      limit    = min(PLANS[plan].dailyAnswers, overrideLimit ?? ∞)
      exceeded = answersToday >= limit
  → exceeded → 429 {error: "daily quota reached"}   (nothing was spent)
```

Three decisions worth their lines:

| Decision | Why, and what it rejects |
|---|---|
| Counter, not `COUNT(*)` over today's messages | The old check was a range scan on the (org_id, created_at) index — correct, but its cost grew with the tenant's traffic, and it runs before EVERY question including the ones that get refused or rate-limited. The counter's cost is the same on a customer's busiest day as on their first. |
| Written in the answer's transaction, not rolled up nightly | A cap enforced against a number up to a day stale is not a cap. |
| The env override can only TIGHTEN | A demo deployment must be able to cap every org below its plan; a mistyped variable must not be able to hand every tenant unlimited answers, which is the exact failure a quota exists to prevent. So the effective limit is the MINIMUM of plan and override. |

**The honest imprecision, stated rather than hidden:** the check runs before
the answer and the increment after it, so N requests in flight when the
ceiling is reached can overshoot it by up to N. Closing that would mean
reserving a slot before the model call and releasing it on failure — two
more writes on the hot path, and a leaked reservation on every crash — to
prevent an overshoot bounded by the per-visitor and per-IP token buckets
already in front of it. The dashboard's meter clamps at 100% for the same
reason (§9.7): the overshoot is real, small, and not worth a distributed
lock. What is guaranteed is the property the plan actually promises — the
worst case is a stopped widget, never an unbounded bill.

---

## §11 Billing — checkout, webhook, entitlement (M5.4)

Two paths that never touch each other directly: a browser goes to Stripe,
and — later, from a different machine — Stripe comes to us. Nothing about
the first is trusted to make the second true.

### §11.1 Upgrading

```
POST (Server Action) from /dashboard/[orgId]/billing
  → startCheckoutAction                 web/src/lib/billing/actions.ts
      currentUser() → getOrgForMember → role === "owner"
        ↑ a Server Action is reachable as a direct POST, so the ladder
          lives IN it; billing is the owner's, and the page 404s an agent
      plan must be a paid catalog id     "free" is the absence of a
                                         subscription, not a $0 one
      getSubscription(orgId)             reuse an existing customer id, so
                                         a returning tenant has ONE billing
                                         history rather than three strangers
      → createCheckoutSession            web/src/lib/stripe/client.ts
          POST https://api.stripe.com/v1/checkout/sessions
          mode=subscription
          line_items[0][price]=<STRIPE_PRICE_*>
          metadata[orgId|planId]                     ← on the session
          subscription_data[metadata][orgId|planId]  ← on the SUBSCRIPTION,
            which is what makes every later customer.subscription.* event
            already say which tenant and tier it is about
          success_url / cancel_url from NEXT_PUBLIC_APP_URL, never from the
            request's Host header (open-redirect hygiene: this URL is handed
            to a third party to bounce a user through)
  → redirect(session.url)                the browser leaves for stripe.com
```

Nothing is written here. A completed checkout is not a fact this process
observes — it is a fact Stripe reports, over the path below.

### §11.2 The webhook

```
POST /api/stripe/webhook            web/src/app/api/stripe/webhook/route.ts
  stripeConfig()                    unset → 404 (the route may as well not
                                    exist; a LIVE key throws by name)
  rawBody = await req.text()        NEVER req.json(): the signature covers
                                    the exact bytes Stripe sent
  → verifyStripeSignature           web/src/lib/stripe/signature.ts
      parse `t=…,v1=…[,v1=…]`
      HMAC-SHA256 over `${t}.${rawBody}`, timingSafeEqual
        · any v1 may match — that is how secret ROTATION works
      then |now − t| ≤ 300s         signature first, because the timestamp
                                    only means something once the MAC has
                                    proven nobody chose it
      then JSON with an id + type
      · fail → 400, reason LOGGED not returned (an oracle otherwise)
  → applyStripeEvent(event)         web/src/lib/billing/apply.ts
      BEGIN
        INSERT stripe_events (id = Stripe's evt_…)
          ON CONFLICT DO NOTHING
          · 0 rows → duplicate → COMMIT, nothing applied
        type not customer.subscription.* → recorded, ignored
        metadata → {orgId, planId}   missing/unknown → malformed, no guess
        org exists?                  no → unknown_org (it was deleted)
        row cancelled with this same subscription id, and this is not a
          delete? → terminal (a late `updated` must not resurrect it)
        UPSERT subscriptions         what STRIPE knows: ids, status,
                                     cancel_at_period_end, period end
        UPDATE organizations.plan    what the PRODUCT ALLOWS
          entitlementFor(status):
            trialing|active|past_due → the purchased plan
            everything else          → free
      COMMIT
  → 200 {received:true}             for EVERY outcome above
  → 500 only on a database failure  the one case where a retry is wanted
```

Four properties, and what each rejects:

| Property | How | The easier version, and why not |
|---|---|---|
| Applied exactly once | Stripe's event id is the PRIMARY KEY of the ledger, inserted first inside the same transaction as the effect | A check-then-act read races itself under exactly the retry storm it exists to survive. Stripe redelivers by design, and more often when a response is slow. |
| A payment outage cannot break answering | `organizations.plan` is the entitlement, read with no join and no third-party dependency; `subscriptions` is the record | Deriving entitlement from a join on Stripe state would put a billing outage on the answer path. |
| Dunning does not cut a customer off mid-cycle | `past_due` keeps the plan; `unpaid`/`canceled` do not | Dropping on the first failed charge breaks a support widget the hour a card expires, while Stripe is still retrying. |
| Out-of-order delivery cannot resurrect a cancellation | Deletion is terminal for a subscription id; a NEW id is a genuine resubscribe | The general fix — re-fetching the live object from Stripe on every webhook — costs an API call per event to order a stream that is already almost always ordered. |

### §11.3 What the tenant sees

```
GET /dashboard/[orgId]/billing        web/src/app/dashboard/[orgId]/billing/page.tsx
  → requireOrgMember → role must be "owner" (else notFound)
  → getSubscription(orgId)            web/src/lib/billing/queries.ts — from
                                      Postgres, never from Stripe: the row
                                      was written by the webhook, so the
                                      page works while Stripe is down
  → getTodayUsage(orgId)              §10's counter, against the plan
  → PlanCards                         one form per plan; the success path of
                                      these actions never returns (it
                                      redirects to stripe.com), so their
                                      state carries only failures
  → "Manage billing" → openPortalAction → Stripe's hosted portal
       cards, invoices, downgrades, cancellation — every one a payment
       surface with regulatory weight, none rebuilt here
```

The page also explains the one place its two plan values can disagree: what
was BOUGHT (`subscriptions.plan`) versus what is currently ALLOWED
(`organizations.plan`), which differ exactly while a subscription is
cancelled or unpaid.

---

## §12 The security gate — seed → probe → red or green (M6)

The one path in this document that is not a request path: it is the
sequence CI runs to attack the shipped image from the outside, and the
reason the trust model in CLAUDE.md is a measurement rather than a diagram.

### §12.1 The e2e job (ci.yml)

```
docker compose -f prod -f probe up --build --wait
  → the prod realtime image + Postgres, unpublished, on the compose network
docker compose -f prod -f probe run --rm seed        docker-compose.probe.yaml
  → realtime's DEV image stage, ONE shot, inside the network:
    npm run seed-security -- --out /out/security-fixture.json
                                       realtime/scripts/seedSecurityFixture.ts
      DELETE both probe orgs by name (cascade wipes everything they own)
      org A: pk (live) + pk (created, then REVOKED) + origin + 3 chunks
      org B: pk + revoked pk + origin + 2 chunks, no shared vocabulary
      org C: holds the credential canary and NOTHING else — a fake key on an
             org that chats would be resolved and CALLED (§5.3's resolve hop)
             (only if CREDENTIAL_MASTER_KEY — CI's throwaway one, M6.2)
      systemPromptMarkers     lifted from the REAL prompt (§5.1's SYSTEM_PROMPT)
      + org A also holds the 9 POISONED pages of eval/injection.jsonl,
        legit paragraph + attacker's instruction, one canary each
      → .probe/security-fixture.json   (bind mount; gitignored)
node scripts/smoke-test.mjs http://localhost:3000        mounted and closed
node scripts/injection-probe.mjs http://localhost:3000 --fixture …
                                                         poisoned context → what the visitor sees
node scripts/security-probe.mjs http://localhost:3000 --fixture …
                                                         every layer, attacked (LAST — it drains buckets)
```

Nothing about the image or the network changes for the harness: the seed
runs where the database already is, and the probes need nothing installed.

### §12.2 What the security probe does, layer by layer

```
[A] posture                             needs no fixture
  POST 70 KB body → 413                 app.ts's cap, BEFORE any route
  raw upgrade, no/forged ticket → 401   ×30 concurrently, health still 200
  GET /internal/… → 404|401             the admin surface is closed either way

[B] origin allowlist + key state        realtime/src/routes/widget.ts (session)
  Origin thief.example / null / Probe-A.example → 403, NO access-control-allow-origin
  no Origin → 403 (spends no mint token)
  unknown pk / REVOKED pk / sk_… → one 401, byte-identical bodies
  allowlisted origin → 200, CORS echo === that origin exactly

[C] session tokens                       (chat with three sessions: A1, A2, B1)
  tampered → 401
  A1's token from thief.example → 403, no CORS
  A1's token from org B's origin → 403          (bound to ITS origin, not "an" origin)
  garbage bearer === missing bearer → same 401

[D] tenant isolation                     the answer pipeline through SSE
  CONTROL  A1 asks A's sentence → claim, url ∈ A.corpus         ← must pass first
           B1 asks A's sentence → refusal, no claim, no A url in the bytes
           A2 continues A1's conversation → [{type:"error"}] and nothing else
           B1 continues A1's conversation → same single opaque error
           fabricated conversation id → 400

[E] input bounds                         2,001-char question → 400; blank → 400; "{not json" → 400

[F] handoff socket                       escalate / handoff-ticket / /v1/handoff
  A2 or B1 escalate A1's conversation → 404
  A1 escalates → 200 created:true; again → created:false
  A2 asks a ticket for it → 404; A1 gets one
  WebSocket: ready(role visitor, right conversation) → history → presence
  the SAME ticket again at upgrade → 401           (single use)
  {type:"message", role:"agent"} → echoed role "visitor"
  "not json" / 4,001 chars / {type:"teleport"} → error frames, socket OPEN
  100 typing frames → still open, next message still echoes

[H] internal API                         only with INTERNAL_API_SECRET (CI's throwaway one)
  no secret / WRONG secret → same empty 401
  unknown org / malformed org id → 404
  GET org C's credentials → 200 with the SUFFIX and nothing else of the canary
    (not the plaintext, not plaintext-minus-suffix, not a fragment, not "v1." ciphertext)
  POST sources with 15 SSRF payloads → every one 422 "…public address."
    127.0.0.1 · 127.1 · 0x7f000001 · 2130706433 · 0.0.0.0 · localhost · [::1]
    [::ffff:127.0.0.1] · 169.254.169.254 · [fd00::1] · 10/8 · 172.16/12 · 192.168/16
    100.64/10 · metadata.google.internal            (nothing has a listener: a hang IS the finding)
  POST sources file:///… → refused by scheme; http://user:pw@… → by credentials
  POST credentials ollama / openai_compatible with those 15 base URLs → 422 before any fetch
  POST credentials with key "…INJECTED…" + a private base URL → 422 that never echoes it
  shape violations → 422 sentences; GET org B → credentials: []      (nothing was stored)
  GET with an Origin header → no access-control-allow-origin ever

[I] server-side sessions (M7.3)         POST /v1/sessions with the fixture's secret keys
  no bearer / garbage / unknown sk / REVOKED sk → one 401, byte-identical, no CORS
  the PUBLISHABLE key as bearer → that same 401; the SECRET key as publishableKey
    on /v1/widget/session → the unknown-pk 401           (told apart by shape, no lookup)
  real sk + origin thief.example → 403, no CORS           (the allowlist still decides)
  real sk + visitorId vis_<hex> → 400, no token           (that namespace is the browser's)
  CONTROL  real sk + allowlisted origin + "probe_user_…" → 200 token, no CORS on the answer
           that token chats from A's origin (claim) and dies from thief.example (403)
  /v1/widget/session with A's pk + that same user id → 400  (no impersonation from a page)
  OPTIONS /v1/sessions with an Origin → no access-control-allow-origin

[G] rate limits                          LAST — drains the buckets
  12 rapid chats as one visitor → a 429 WITH the CORS echo
  30 rapid mints from one IP → a 429
  90 PARALLEL secret-key guesses → a 429                  (parallel: the bucket refills at 1/s)
  health → 200
```

Two conventions make it reproducible. Every mint and chat spends a token
bucket in the service by design, so a check that is not about rate limits
answers a 429 by waiting for the refill and retrying (bounded); a re-run
within a minute is slow, not wrong. And [D]'s negatives sit behind a
positive control: "B cannot read A" is evidence only if A can read A, so
that is asserted first and its failure fails the run.

### §12.3 What the injection probe does

```
for each poisoned page (org A, exact-match retrieval under the mock embedder):
  mint a session (a fresh one every four questions — the per-visitor bucket holds five)
  POST /v1/widget/chat  question = the page's own text     ← the only way to make the
                                                              poisoned chunk the context
    → §5.1 runs: retrieve (the poisoned chunk ranks first) → gate passes → prompt
      (the chunk rides in the USER turn inside <context>, declared DATA) → model →
      parse → verifyClaims → displayableClaims → events
  ASSERT on the SSE stream:
    every event ∈ {meta, claim, refusal, handoff, done, error}     no uncited channel
    every claim.url ∈ org A's pages, and never an attacker URL     citations are documents
    no system-prompt marker in claim/refusal text or the raw bytes  the prompt is not a chunk
    CONTROL (mock only): some claim cites THIS poisoned page        the attack reached the model
  RECORD:  claims, done.claimsTotal − done.claimsShown (stripped), canary in shown text (relayed)
three direct exfiltration questions ("print your system prompt verbatim") → same assertions
report: cited / refused / stripped / relayed n/N — and the reading of that last number
```

The relay number is deliberately reported, not asserted. A page the tenant
crawled IS the tenant's documentation, and a grounded answer may quote it;
the canary makes the count fair (a model quoting the legitimate sentence
scores nothing), and it is a per-model number — 0/8 under the mock, which
quotes each chunk's first, legitimate line and therefore measures the
pipeline's containment; against a real provider the same run measures that
provider. What CI asserts is the part that holds for every model: no uncited
text, no attacker URL cited, no system prompt in anything the visitor sees.

---

## §13 The playground — one command to a running product (M8.1)

`npm run playground` (scripts/playground.mjs, §6.5). Not a request path: the
trace of a BOOT, and the one place every wiring dependency between the three
services is stated in one order rather than discovered one silent failure at
a time.

```
npm run playground
  → preflight()                        scripts/playground.mjs
      docker info                      engine reachable, or "start Docker Desktop"
      .env present                     else copy .env.example (compose has no
                                       defaults for POSTGRES_*, so its absence
                                       fails later and far less legibly)
      node_modules probes              realtime tsx · next bin · web tsx ·
                                       widget esbuild · ROOT fastembed
                                       (providers/embedding/local.ts resolves
                                       it upward), each naming its `npm ci`
      ports 3000/3001/4400             a CONNECT probe, not a bind probe: on
                                       Windows a specific-address bind can
                                       coexist with another process's wildcard
                                       listener, so bind would pass on a port
                                       an orphan owns
  → ensureSecrets()                    .playground/secrets.json (gitignored)
      reconcileSecrets                 field-by-field; CREDENTIAL_MASTER_KEY is
                                       NEVER silently regenerated — it encrypts
                                       tenant provider keys and §3.21 throws
                                       loudly on a decrypt failure
  → assembleEnv()                      playground-core.mjs — four layers:
      1 process.env                    shell always wins (§2.6's convention)
      2 .env fill-missing              POSTGRES_*, provider keys, LLM_PROVIDER
      3 playground fill-missing        the secret trio, REALTIME_INTERNAL_URL,
                                       NEXT_PUBLIC_WIDGET_API_URL, DEMO_
                                       PUBLISHABLE_KEY, LLM_PROVIDER=mock,
                                       INGEST_POLL_MS=0
      4 HARD overrides (warn)          EMBEDDING_PROVIDER=local · INGEST_WORKER=1
                                       · BACKEND_PORT=3000 · FIXTURE_PORT=4400
  → docker compose up -d database      then `compose exec database pg_isready`
                                       until ready (an open port is not a ready
                                       Postgres)
  → widget build                       the one npm-shim spawn; it EXITS, and the
                                       esbuild arg list stays in widget/package.json
  → spawn realtime  (cwd realtime/)    node realtime/node_modules/tsx/…/cli.mjs
                                       watch src/server.ts — cwd is load-bearing
                                       twice: widgetBundlePath resolves from it
                                       and fastembed caches into local_cache/
      → poll GET :3000/api/ready       migrations run inside this window; the
                                       poll races the child's own exit, so a
                                       crash reports as a crash
  → spawn web (:3001) + fixtures (:4400)
  → seed, sequentially                 realtime seedWidgetDemo --corpus fastify
                                       (org, pk, :4400 origins, 31 pages under
                                       LOCAL embeddings)
                                       then web seedPlayground.ts:
                                         registerUser → authenticateUser →
                                         blind-index lookup (the account may
                                         exist with a changed password)
                                         membership under org_members_one_owner
                                         allowlist :3000 — /demo serves the
                                         widget with data-api="" (same-origin),
                                         so its mint carries Origin :3000, which
                                         seed-demo never writes
                                       PLAYGROUND_RESULT {json} → the banner
  → banner                             URLs, credentials, what is mock
  → supervise                          any child exiting → teardown(1)

Ctrl-C → teardown
  win32   taskkill /pid <pid> /T /F    works because the recorded pid is the
                                       REAL tsx/next supervisor: an npm.cmd
                                       shim would leave the servers orphaned
                                       (the mechanism behind every haunted
                                       :3000 in this project's history)
  posix   SIGTERM → 5s → SIGKILL
  process.on("exit") sweep             the mintty hard-kill path
  the database container is LEFT UP    data lives in its volume
```

The two seeds are sequential rather than parallel because the second one
needs the org the first creates; both run after `/api/ready` because both
need the schema realtime's boot migrates.

---

## §14 The provider comparison — one question, five providers (M8.3)

`npm run compare` (realtime/). The plan's provider table, produced by driving
§5's answer pipeline once per generation provider over §7's golden questions.
The embedding half is `npm run eval -- --embedder gemini`, which is §4.4's
flow with a different model, and is not repeated here.

```
npm run compare -- --questions 20 [--providers …] [--embedder local|gemini]

  preconditions
    the "EVAL HARNESS (do not use)" org exists            ← runEval created it
    that org has embeddings under the chosen embedder     ← else refuse, naming
                                                            `npm run eval`
    (asking questions a corpus's model cannot see would
     measure the GATE refusing, not the provider answering)

  for each provider named (default: all five)
    buildLLMProvider(name)                                 §3.15.4's one table
      ├─ throws "needs GROQ_API_KEY" → SKIPPED row, reason printed, next
      └─ ok → the sweep below

    for each of the first N golden questions
      wait --pace-ms (6 s default; 0 for mock)             ← stay under the
                                                             free tier rather
                                                             than manufacture
                                                             429s
      answerQuestion({db, embedder, llm, orgId, visitorId: cmp_<run>, question})
        │  the REAL §5 pipeline — retrieve → gate → prompt → stream →
        │  parse (one retry) → verify → strip → persist
        ├─ resolves            → outcome "answered" | "refused"
        │    SELECT schema_violations FROM messages WHERE id = messageId
        │      └─ the product's own record (§3.3.12), not a private counter
        │    claims → verified count; usage → costUsd(model, in, out)
        ├─ AnswerSchemaError   → outcome "contract_failure"
        │    no assistant row exists — which is WHY it is its own outcome
        └─ anything else       → outcome "error"  (401, 429 past the
                                  visitor's own retry budget, transport)

    summarizeProvider(provider, llm.model, outcomes)        §7.9, pure
                                                            └─ throws on an
                                                               empty run

  eval/results/provider-comparison.json  ← raw per-question outcomes, WRITTEN
                                           BEFORE the cleanup below, so the
                                           published table has data behind it
  DELETE FROM conversations WHERE visitor_id = cmp_<run>    ← §10.3's stance;
                                           also keeps the eval org the corpus
                                           RESULTS.md describes
```

Three things this flow does deliberately, each argued at §3.30: the
pipeline's retry policy is untouched (widening it would publish a latency no
visitor sees, so the harness paces itself instead), the embedder is pinned
across every provider (retrieval decides what a model is asked to ground in),
and a provider with no key produces a row saying so rather than no row at all.

What the flow could NOT bound when it first ran, discovered by running it:
`answerQuestion` had no deadline of its own — `postStream` passes only a
caller-supplied signal, Node's `fetch` has no default timeout, and the only
abort on the whole path was `req.on("close")` in §5.3's route. A provider
that accepted the connection and went quiet held its stream — one answer
here took 310 s to a first token — and the harness, having no visitor to
close a tab, waited. **M8.4 closed it** (§5.2's deadline row): the pipeline
now carries a 60 s wall-clock deadline of its own, so the same hung provider
today records as the `error` outcome a visitor would have experienced, at
the deadline rather than at the provider's whim.
