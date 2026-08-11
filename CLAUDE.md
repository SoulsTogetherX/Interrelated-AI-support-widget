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

**Current milestone: M1 (ingest, retrieval, eval) — in progress.** M0 is
complete; M1.1 (content-pipeline schema), M1.2 (chunker, vectors, embedding
providers), M1.3 (crawler, parsers, ingest worker — §3.10), and M1.4
(hybrid retrieval — §2.4.3, §3.12) are done. Content flows in end to end
(source → crawl → parse → chunk → embed → store) and back out again
(query → dense + lexical arms → RRF fusion → ranked chunks). Next: the
eval harness (golden set, recall@k/MRR/nDCG, CI floor). Everything below
exists and is tested. Packages that appear in the plan but not here
(web/, widget/, eval/, loadtest/) do not exist yet — they arrive across
M1–M4.

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

Verification ladder per increment: typecheck → unit tests → integration
tests against real Postgres → and, for any increment touching migrations,
boot, Dockerfiles, or compose, **re-boot the prod compose stack and re-run
the smoke probe** (`docker compose -f docker-compose.prod.yaml up --wait`
then `node scripts/smoke-test.mjs`). Unit-level green is not "the project
runs"; the prod boot is.

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

#### §2.4.0 `shared/chunking/chunker.ts`
The heading-aware chunker — the policy layer between parsers and embedding.
Input is a parsed document: ordered blocks (`heading` / `paragraph` /
`code`) honoring the parser contract `block.text === source.slice(charStart,
charEnd)`; output is chunks shaped for the `chunks` table. Splitting parse
from chunk means one chunking policy serves every source format alike,
and the chunker is tested with hand-built blocks instead of fixture files.

Key behaviors, each pinned by a test: headings close the running chunk (a
chunk never straddles a section boundary — a hit mixing two sections cites
both wrongly); the heading trail is a stack where a sibling heading evicts
its predecessor *and* that predecessor's children; pieces pack to
`targetTokens` (default 400 — the eval harness ablates 400 vs 800); an
oversized paragraph splits at sentence bounds, code at line bounds, and a
single indivisible run hard-cuts rather than exceed `maxTokens`. Character
offsets survive every split, which is what makes deep-linking citations
possible. Token counts are `ceil(chars/4)` — an approximation used only for
budgeting, chosen so shared/ stays dependency-free (a real tokenizer is a
model-specific dependency for a number where ±10% changes nothing).

#### §2.4.2 `shared/utils/vectors.ts`
`PADDED_DIM` (1024 — the constant the schema's `halfvec(1024)` mirrors),
`padVector` (zero-padding, with the norm/dot-preservation argument in the
comment and *executed* as a property test), and `toPgvector`/`fromPgvector`
— the ONE place pgvector's text format is written or parsed.

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

#### §2.4.3 `shared/retrieval/rrf.ts`
Reciprocal Rank Fusion — how the two retrieval arms become one ranking.
Hand-written (~20 lines) because retrieval is this project's technical
content; the anti-tutorial rules exist precisely so this isn't a framework
call. Why rank fusion and not score fusion: cosine distance and ts_rank_cd
live on incomparable scales (bounded [0,2] vs unbounded), so any weighted
sum needs per-corpus calibration that drifts — ranks are always comparable.
k=60 from Cormack, Clarke & Buettcher (2009); its job is damping the
rank-1-vs-rank-2 gap so one arm's head pick can't steamroll consensus.
Two contracts pinned by tests: ties break by first appearance
(**deterministic output** — the eval harness diffs ranked lists across
runs, and nondeterministic tie order would read as a retrieval
regression), and a duplicate id within one ranking throws (both arms
return each chunk at most once by construction, so a duplicate is an
upstream bug worth a loud failure). The fused score is EXPOSED, not just
the order: it is the number M2's refusal threshold cuts on.

### §2.4.5 `providers/`
The model-provider abstraction — the BYO-provider feature's foundation.
Same no-package-json pattern as shared/ (consumers compile it through the
`@providers/*` alias; the root runner owns its tests), with one extra rule:
**implementations that need real dependencies load them with a dynamic
import**, and the dependency is declared by whichever package actually runs
that code. That is what lets every consumer import the *files* freely while
only the eval/CI path pays for onnxruntime.

#### §2.4.5a `embedding/types.ts`
`EmbeddingProvider`: `model` (the value stored in `chunk_embeddings.model`
and the predicate of that model's partial HNSW index), `dim` (native
dimension, pre-padding), and batch-first `embed(texts)` — batch-first
because free tiers rate-limit per REQUEST, and a single-text convenience
method is how N-requests-for-N-chunks code gets written.

#### §2.4.5b `embedding/mock.ts`
Deterministic fake embeddings (`mock-384`): FNV-1a hash seeds an xorshift32
PRNG per text → unit vectors, identical forever on every machine, with no
imports at all. Exists so plumbing tests (storage, padding, tenant
filtering) run in milliseconds with zero downloads. Deliberately has NO
semantic similarity — using it in a quality eval is a bug, and the eval
harness will refuse it by name.

#### §2.4.5c `embedding/local.ts`
Real local embeddings (`bge-small-en-v1.5`, 384-d) via fastembed/ONNX — the
keyless implementation the eval harness and CI use. Dynamic-imported (see
§2.4.5); ~30 MB model cached under the gitignored `local_cache/` on first
use. **Never runs on Render**: onnxruntime wants ~250–400 MB of RAM in a
512 MB instance — production embedding is remote per-org providers.
Verified by a gated test (`FASTEMBED_TEST=1 npm test`) that asserts the one
semantic property everything depends on: related texts closer than
unrelated ones.

### §2.5 `render.yaml`
The Render deployment as code (a "Blueprint"): one free-tier Docker web
service building `realtime/Dockerfile` with the repo root as context,
health-checked on the DB-free `/api/health`, deploying the `dev` branch on
every push (flip to `main` when the demo should track releases). Neon
connection values are marked `sync: false` — Render prompts for them in its
dashboard; secrets never enter the repo. Exactly ONE service by design: the
free tier's ~750 instance-hours/month keep one service always warm, not two
(the M3 dashboard goes to Vercel instead). `INGEST_WORKER` is pinned to "0"
here: the worker's poll loop would hold Neon's compute awake (§3.7), and
production has no way to enqueue a job until M3 anyway.

### §2.6 `.env.example`
The single documented registry of every environment variable the system
reads. Rule: a module reading an env var not documented here is a bug in the
module. Note the `POSTGRES_PORT` comment — on machines with a native
Postgres on 5432 (like Xavier's), the compose database publishes on 5433;
containers always use `database:5432` internally (§4.2).

---

## §3 `realtime/` — the data plane

Express 5 + Kysely + pg, CommonJS, bundled to a single `dist/server.js` by
esbuild. As of M1.4 it contains the full ingest pipeline (§3.10) and the
retrieval layer (§3.12) alongside the boot spine; the SSE chat path (M2)
and handoff WebSocket (M4) still hang off later milestones. Runtime dependencies grew by two, each earning
its place: `undici` (the guarded HTTP agent — §3.10.2) and `htmlparser2`
(HTML tokenization — §3.10.3). A third, `pdf-parse`, was built, tested, and
then REMOVED on review: crawled docs sites are HTML/Markdown, and nothing
can hand the product a PDF until file uploads exist (M3) — 21 MB of image
weight and a large third-party parsing surface for a feature with no
caller. It returns with uploads; §3.10.3 records how PDFs are skipped
meanwhile.

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
no vector column exists until 002, so a Postgres without pgvector fails at
deploy time, not at first ingest weeks later.

### §3.3.1 `src/db/migrations/002_content_pipeline.ts`
The content pipeline: what the ingest worker (next increments) reads and
writes, and what retrieval queries.

| Table | Purpose | Notable decision |
|---|---|---|
| `sources` | crawl targets / uploads per org | status lifecycle CHECK; crawl_depth capped at 3 |
| `documents` | one fetched page / uploaded file | `content_hash` (sha256 of normalized text) short-circuits recrawls — identical hash skips re-chunk + re-embed, protecting embedding quota; soft delete + **partial** unique `(source_id, url) WHERE deleted_at IS NULL` so re-added pages don't collide with tombstones |
| `chunks` | the retrieval unit | `heading_path` travels with every chunk (citations show where a claim lives); `char_start/char_end` deep-link into the source; `tsv` is a **GENERATED** column so the lexical index can never drift from the text; unique `(document_id, ord)` makes a buggy re-chunk loud |
| `chunk_embeddings` | one embedding per (chunk, model) | the three big decisions — see below |
| `ingest_jobs` | Postgres-backed work queue | `FOR UPDATE SKIP LOCKED` consumer shape; partial index over queued rows only; CHECK `(state='running') = (locked_by IS NOT NULL)` makes an unowned running job unrepresentable |

The three load-bearing decisions on `chunk_embeddings`:

1. **`halfvec(1024)`**, not `vector(1024)`: 2 bytes/dim halves row and index
   size — ~78k chunks instead of ~39k inside Neon's 0.5 GB free tier. fp16
   recall cost is negligible and will be *measured* by the eval harness.
2. **Partial HNSW index per model** (`WHERE model = '…'`), never IVFFlat:
   different models' vectors live in different spaces, so one shared index
   wastes traversal on foreign rows; and IVFFlat degrades silently under
   continuous ingest while HNSW builds incrementally. Registered today:
   `bge-small-en-v1.5` (local/eval) and `mock-384` (deterministic tests).
   A new provider model ships its index in a new migration.
3. **`org_id` denormalized onto the table**: HNSW searches then filters, so
   the tenant filter must live on the indexed relation or small tenants can
   get fewer than k results. Pairs with pgvector iterative scans at query
   time (arrives with the retrieval code).

Shorter models are **zero-padded** to 1024: padding preserves dot products
and L2 norms exactly among padded vectors (the extra coordinates contribute
zeros), so cosine/L2 rankings within a model are unchanged. `dim` records
the true pre-padding dimension.

Rejected alternative for the queue: Redis/BullMQ — a second stateful service
to run and secure, when the queue's real throughput ceiling is embedding-API
rate limits, not Postgres.

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
failure exits nonzero so the orchestrator restarts with backoff. The port is
`BACKEND_PORT ?? PORT ?? 3000`: BACKEND_PORT is this repo's explicit
convention (compose, render.yaml); PORT is the generic convention PaaS
routers inject, honored so the service binds correctly on platforms that
only speak that. The http
server is created explicitly (not `app.listen`) because M4 attaches the
WebSocket upgrade handler to the same server object.

After listen, the ingest worker (§3.10.5) starts **only when
`INGEST_WORKER=1`**. Opt-in because the worker polls Postgres: free against
compose's local database (both stacks set the flag), but on Neon a few-second
poll would hold compute awake around the clock against the ~100 CU-hour
monthly budget — the same budget the DB-free health route protects. So
render.yaml pins it to "0" until M3, which is also when production first
GAINS a way to enqueue a job; flipping it on arrives together with an
in-process wake-on-enqueue so polling becomes the fallback, not the
mechanism. `EMBEDDING_PROVIDER` picks mock (default) or local — mock is an
honest placeholder until per-org BYO providers (M3): its vectors carry no
semantics, which costs nothing while no retrieval exists, and it is what
lets CI drive the full pipeline keylessly.

Shutdown: SIGTERM → stop accepting, stop the worker (it requeues an
in-flight job between pages — §3.10.5) → drain pool → exit; a second signal
force-exits.

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
- `db/__tests__/contentPipeline.test.ts` — migration 002 integration suite,
  same gating. The first end-to-end vector proof lives here: hand-picked
  3-d vectors, zero-padded to 1024, must come back in exact cosine order
  through `halfvec`; an EXPLAIN assertion pins that the planner actually
  uses the partial HNSW index; the generated `tsv` column must satisfy a
  full-text query. Boundary rejections: wrong-dimension vector, duplicate
  `(chunk_id, model)` (while a second model for the same chunk is legal),
  duplicate `(document_id, ord)`, inverted char span, live-URL collision
  (and non-collision with a tombstone), unowned running job.
- `ingest/__tests__/safeFetch.test.ts` — no DB needed. The address
  classifier's blocked/allowed table is tested **at range edges** (172.15
  vs 172.16 vs 172.32, CGNAT bounds, NAT64 with public vs loopback
  payloads) plus the fail-closed cases: exotic spellings (`0x7f000001`,
  `127.1`, octal) that bypass naive filters by parsing differently in
  different resolvers. URL vetting runs against an injected resolver; live
  behavior (redirect chains and per-hop re-vetting, both size-cap paths,
  timeout) runs against an in-test loopback server — including the pinned
  security default that loopback itself is REJECTED without an explicit
  hostGuard.
- `ingest/__tests__/parsers.test.ts` — no DB. Every fixture is checked
  against the offset contract (`block.text === text.slice(...)`). One test
  chains parseMarkdown → chunkBlocks to prove the heading trail survives
  the whole path; another pins that two HTML formattings of the same
  content extract identical text (what makes content_hash meaningful); a
  third pins that a detected PDF is REJECTED rather than garbled into
  markdown paragraphs (PDF support is deferred to M3 — §3.10.3).
- `ingest/__tests__/crawler.test.ts` — no DB. An in-test fixture site with
  every scope hazard: fragments, duplicate links, redirects, cross-origin
  links, binary assets, broken pages, markdown served as text/plain,
  sitemap + sitemapindex. Asserts what was and was NOT requested (the
  server records paths), not just what was yielded.
- `retrieval/__tests__/search.test.ts` — DB-gated, plus an always-on
  input-validation block (limit guards fire before any query, so they run
  keylessly). The centerpiece is the multi-tenant regression test from the
  plan: 20 orgs × 30 chunks share one HNSW index, and every org must
  retrieve exactly k — through a dedicated SINGLE-connection Kysely with
  `enable_seqscan = off`, because on the shared pool the session SET and
  the search could land on different connections, and a seqscan (exact,
  unstarvable) would pass the test without exercising what it guards. Its
  companion asserts that with iterative scans OFF some tenant starves —
  20×k=100 > ef_search=40, so by pigeonhole the fixture MUST bite; if that
  ever fails, the planner stopped using HNSW and the regression test has
  gone vacuous. Also pinned: soft-deleted documents invisible to both arms
  even when the query is the deleted chunk's exact text; cross-tenant
  isolation under byte-identical texts (same mock vector, same tsv — only
  the org filter separates them); hostile lexical syntax never throws;
  stop-word-only queries return empty; equal-score ties order by chunk id
  reproducibly; hybrid fusion reports per-arm ranks with exact RRF scores;
  k beyond corpus size returns the whole corpus.
- `ingest/__tests__/worker.test.ts` — DB-gated. The first suite where the
  ENTIRE pipeline runs against real Postgres and a real (loopback) site,
  through three crawls of a two-version fixture: initial ingest (documents,
  chunks with heading paths, embeddings, statuses), identical recrawl
  (zero embed calls — the content_hash short-circuit observed, not
  assumed), changed recrawl (chunks replaced, vanished page soft-deleted).
  Queue semantics get their own tests: two workers claiming concurrently
  under SKIP LOCKED (held open by gated fake crawlers), stale-lease
  reclaim on both sides of the attempts cap, stop() requeuing between
  pages, crawl failure and upload-source failure paths.

### §3.9 `realtime/Dockerfile`
Multi-stage on node:22-alpine, **build context = repo root** (shared/ must
exist inside the image). `deps → dev → build → prod`. Prod runs
`npm ci --omit=dev` + the bundle, as `USER node`, with a busybox-wget
healthcheck on `/api/health`, and `CMD ["node", "dist/server.js"]` — plain
node, not `npm start`, because npm swallows SIGTERM and would turn graceful
shutdown into a 10-second kill.

### §3.10 `src/ingest/` — the ingest pipeline (M1.3)

Source → crawl → parse → chunk → embed → store, traced end to end in
DATAFLOW.md §3. Layering is strict and each layer is testable alone:
`safeFetch` knows nothing about crawling, the crawler knows nothing about
the database, the worker owns ALL persistence. The chunker sits in shared/
(§2.4.0) because policy is cross-package; everything here is data-plane
mechanics.

#### §3.10.1 `src/ingest/ip.ts`
Byte-level IP classification for the SSRF guard: "is this address
affirmatively public-routable?" Hand-rolled v4/v6 parsers (16 bytes, then
prefix checks) because this is a security boundary that must FAIL CLOSED —
anything unparseable is non-public by definition, and the alternate
spellings resolvers interpret creatively (`0x7f000001`, `127.1`, leading
zeros) are deliberately *not recognized* rather than normalized, since
"ambiguous" is an answer of no. Blocks loopback, RFC1918, link-local
(which is what makes 169.254.169.254 — the cloud metadata endpoint —
unreachable), CGNAT, TEST-NETs, benchmarking, multicast/reserved, ULA, and
the v6 transition ranges: v4-mapped and NAT64 defer to the verdict of the
EMBEDDED v4 address; 6to4/Teredo are rejected wholesale because the guard
cannot see through a tunnel.

#### §3.10.2 `src/ingest/safeFetch.ts`
The SSRF-guarded HTTP client every ingest fetch goes through — crawl
targets are user-supplied URLs this server then fetches, the textbook SSRF
shape. Three layers that must move together: (1) per-hop vetting — scheme,
no embedded credentials, and ALL DNS answers public (one private A record
taints the set, since the socket layer may dial any of them); (2) the
undici Agent's connect-time lookup hook re-classifies the addresses
actually dialed, which closes DNS rebinding (resolve-public-then-answer-
private hits the hook, not our network); (3) redirects followed MANUALLY so
layer 1 applies to every `location` — a literal-IP redirect target never
touches DNS, which is exactly why URL vetting exists alongside the hook.
Bodies are size-capped while STREAMING (Content-Length is attacker-
supplied, checked but never trusted) and the timeout budget spans the whole
redirect chain. `hostGuard` is the one seam: passing a custom guard also
routes through an unguarded agent (tests reaching loopback fixtures; later,
tenant-declared Ollama base URLs in M3). `undici` became an explicit
dependency for its typed `dispatcher` option — the global fetch cannot
carry a custom agent.

#### §3.10.3 `src/ingest/parsers/`
One contract rules all of them (`types.ts`):
`block.text === text.slice(charStart, charEnd)` — the identity that makes
span-verified citations (M2) able to deep-link into source text. `text` is
the parser's normalized extraction; it is also exactly what
`documents.content_hash` fingerprints, so parsers must be deterministic
functions of content (the HTML whitespace-collapse test pins this).

- `markdown.ts` — hand-written line scanner. Hand-written BECAUSE of the
  contract: every Markdown library returns a transformed AST, and
  recovering verbatim source offsets from one is more and worse code than
  classifying lines ourselves. The canonical text is the source itself.
  Recognized: ATX headings, fenced code (fence lines excluded), list items
  (marker stripped via offsets, each item its own block), paragraphs.
  Deliberately not: setext headings (ambiguous with rules), inline markup
  stripping (would desync offsets; `**` noise costs retrieval nothing).
- `html.ts` — htmlparser2 streaming callbacks; the canonical text is
  CONSTRUCTED during extraction, so the contract holds by construction.
  htmlparser2 is a dependency where Markdown got hand-rolled because
  tokenizing real-world HTML is a swamp with a well-maintained boring
  answer — HTML parsing is infrastructure, not the thesis. Chrome subtrees
  (nav/header/footer/script/style/forms/svg) are dropped wholesale — a
  support answer citing a nav menu is worse than none — but their `<a
  href>` values ARE collected: nav menus are how docs sites interlink.
  `<pre>` preserves whitespace as a code block; prose whitespace collapses
  (HTML's own rendering rule, and what makes extraction deterministic).
- PDF — deliberately ABSENT until M3. A `pdf-parse` implementation was
  built and then removed on review: no caller can supply a PDF before file
  uploads exist, and the dependency cost 21 MB of image plus a browser-
  sized parsing surface. What remains is the honest edge handling: PDFs
  are still DETECTED (magic bytes / media type) and rejected with a clear
  error the crawler reports as a skipped page, and the crawler's
  extension filter never spends a fetch on an obvious `.pdf` link —
  detection without parsing is what keeps a crawled PDF from being
  garbled into "paragraphs" of binary soup by the markdown fallback.
- `index.ts` — decode + dispatch. Detection in trust order: magic bytes
  (`%PDF-`, unfakeable) → declared media type → URL extension → sniff →
  markdown as fallback (it degrades to plain-text paragraphs; the HTML
  parser would strip nothing). Decoding
  strips the BOM and normalizes CRLF→LF BEFORE any parser runs, so server
  line-ending churn can never change a content_hash.

#### §3.10.4 `src/ingest/crawler.ts`
Source → stream of parsed pages, as an async GENERATOR: a crawl is minutes
of network, so the worker persists page-by-page, reports progress, and can
stop between pages — none of which an awaited array allows. Memory is
bounded by one page, not one site. Scope is enforced here, not trusted to
callers: same-origin only (checked against the FINAL URL, so an on-origin
link that redirects off-origin is skipped), every fetch through safeFetch,
maxPages cap, politeness delay, depth from the schema-capped `crawl_depth`.
BFS rather than DFS so depth means "link distance from the root" — the
intuitive meaning of the knob. Failure policy: a dead ROOT throws
`CrawlError` (nothing was crawlable → source failed); a dead PAGE is an
`error` event and the crawl continues (one broken link must not abort a
100-page ingest). Sitemaps (plus one level of sitemapindex nesting) are
parsed with a regex over `<loc>` — legitimate here because the sitemap
schema forbids the nesting and attributes that make regex-over-XML a trap.
Not yet implemented, stated honestly: robots.txt (belongs with the M3
dashboard, where a customer can see WHY a page was skipped; the cap and
delay bound our footprint meanwhile).

#### §3.10.5 `src/ingest/worker.ts`
The queue consumer that ties the pipeline together; runs IN-PROCESS on a
poll loop (a separate worker service was rejected: Render's free tier funds
one instance, and the throughput ceiling is embedding rate limits, not
CPU). The claim is one atomic UPDATE over a `FOR UPDATE SKIP LOCKED`
subquery — concurrent workers skip each other's rows instead of blocking,
so "a second worker is a deploy, not a rewrite" is literally true and
tested. Crashed workers leave stale leases; the reclaim pass requeues them
under the attempts cap and FAILS them visibly past it — work is never lost
silently. `stop()` requeues an in-flight job between pages so deploys don't
burn attempts on healthy work.

Per page: sha256 the normalized text; an unchanged hash refreshes
bookkeeping and spends NOTHING (the recrawl short-circuit — embedding
quota is the scarcest resource in the pipeline); otherwise chunk, embed
with the heading trail PREPENDED (the stored chunk text stays trail-free —
the trail is retrieval context, not quotable content), then one SHORT
transaction for document + chunks + embeddings. Embedding happens BEFORE
the transaction: it is seconds of external network, and holding a
connection (Neon pool: 5) across it buys no atomicity — a failed embed
just leaves the previous document version standing. Pages live last crawl
but absent now are soft-deleted, so retrieval stops seeing them while
history survives.

### §3.11 `realtime/scripts/enqueueSource.ts`
Dev-only CLI (`npm run enqueue -- <url> [--depth N] [--sitemap]`):
registers a source and queues a job so the worker can be watched end to end
before the M3 dashboard exists. Deliberately glue over the same inserts the
integration tests make — no logic of its own to drift. Falls back to
reading the repo-root `.env` when Postgres vars are unset (already-set env
always wins) — which requires the DEFERRED imports both CLIs use: the pool
reads env at module load, and a hoisted top-level import would construct it
before the fallback ran, silently pointing at the wrong Postgres.

### §3.12 `src/retrieval/search.ts`
The query side of the content pipeline (traced in DATAFLOW.md §4): three
public entry points, because the eval harness measures each arm alone
against the fusion — the delta is the case for hybrid.

- `denseSearch` — cosine nearest-neighbor through the per-model partial
  HNSW index. Runs in a transaction because the pgvector knobs are applied
  via `set_config(…, is_local => true)`: transaction-scoped so nothing
  leaks onto a pooled connection, and set_config rather than SET LOCAL
  because SET cannot take bind parameters (the values travel as parameters
  instead of being spliced into SQL text). `hnsw.iterative_scan =
  'relaxed_order'` is the load-bearing setting: without it HNSW yields
  ~ef_search candidates, the org filter discards other tenants' rows, and
  a small tenant silently gets fewer than k results. `"off"` is accepted
  because the eval harness measures the with/without delta — the number
  that justifies the setting. The ORDER BY is exactly the index's distance
  expression, no secondary tie-break key — the planner abandons HNSW for a
  full sort otherwise (fp16 ties are harmless; fusion re-ranks).
- `lexicalSearch` — `ts_rank_cd` (cover density: rewards query terms NEAR
  each other, the reason tsv keeps positions) over the GIN-indexed
  generated column, parsed by `websearch_to_tsquery` — identical to
  plainto for prose but never throws on hostile syntax, a requirement once
  M2 feeds it end-user text. Ties order by chunk id for reproducibility.
- `hybridSearch` — both arms concurrently at poolSize depth (50: deeper
  arms let RRF surface consensus neither arm ranked highly), RRF-fused,
  cut to k, then ONE metadata hydration query for the survivors — arm
  queries stay pure index-shaped work. Returns `RetrievedChunk` with the
  quotable text, its location (url + heading trail + char span), the fused
  score (M2's refusal threshold input), and per-arm ranks for
  observability.

Both arms exclude chunks of soft-deleted documents through the documents
join: the worker soft-deletes a vanished page but leaves its chunks for
history, so "deleted" lives on documents alone and retrieval must look
through the join or it would keep answering from pages a site removed.
Limits are validated as if they were already user input (M2 makes them so).

### §3.13 `realtime/scripts/searchDev.ts`
Dev-only CLI (`npm run search -- "<question>" [--org N] [--k N]
[--dense-only]`): hybrid retrieval against ingested content, so the whole
M1 loop — enqueue → crawl → embed → retrieve — is drivable by hand before
M2's chat surface exists. Same glue-only rule as §3.11. Picks its embedder
from EMBEDDING_PROVIDER exactly as the worker does, and warns when the org
has no embeddings under that model — the routine dev mistake is ingesting
under one provider and querying under another, which otherwise looks like
retrieval returning nothing.

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

Both compose stacks set `INGEST_WORKER: "1"` — polling a LOCAL Postgres is
free, and the dev loop (`npm run enqueue`, §3.11) depends on a live worker.

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
