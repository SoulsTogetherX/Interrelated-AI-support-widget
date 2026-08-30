<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §3 realtime/ — the data plane

## §3 `realtime/` — the data plane

Express 5 + Kysely + pg, CommonJS, bundled to a single `dist/server.js` by
esbuild. As of M1.4 it contains the full ingest pipeline (§3.10) and the
retrieval layer (§3.12) alongside the boot spine; the SSE chat path (M2)
and handoff WebSocket (M4) still hang off later milestones. Runtime dependencies grew to three, each earning
its place: `undici` (the guarded HTTP agent — §3.10.2), `htmlparser2`
(HTML tokenization — §3.10.3), and since M7.6 `unpdf` (PDF text extraction
— §3.10.7).

That third one has a history worth keeping, because it is why the file it
lives in looks the way it does. A `pdf-parse` implementation was built at
M1, tested, and then REMOVED on review: 21 MB of image weight and a
browser-sized parsing surface, for a feature with no caller — crawled docs
sites are HTML/Markdown, and nothing could hand the product a PDF. Both
halves of that objection had to be answered before the format came back,
and both are. The caller exists — a docs site's linked datasheet since M7.6a, and since
M7.6b a file the tenant uploads — and the dependency is a different one: `unpdf` is 2.1 MB
with ZERO dependencies of its own, against pdf-parse's 21 MB and its two
(`pdfjs-dist` plus a native canvas). It is also loaded by DYNAMIC IMPORT,
so a stack that never meets a PDF never pays for it.

### §3.1 `src/db/schema.ts`

Since M3.2 a thin re-export of `shared/db/schema.ts` (§2.4.6), which is
where the hand-written Kysely types live now that web/ queries the same
tables — every realtime-internal `@/db/schema` import reads unchanged.
The original design notes travel with the types: **kysely-codegen was
rejected** while the schema is young (regenerating churns diffs and can't
carry the WHY comments); any migration touching a table updates the shared
file in the same change; timestamps are `ColumnType<Date, string | Date,
…>` (pg returns Date; JSON callers insert ISO strings); `plan` and `role`
are string-literal unions so a typo is a compile error rather than a
runtime constraint violation; `created_at` insert type includes
`undefined` because the DB default owns it.

### §3.2 `src/db/pool.ts`

One process-wide `pg.Pool` wrapped in one Kysely instance. Config read from
env at point of use (house style — `.env.example` is the registry, §2.5).
`connectionTimeoutMillis: 3000` bounds both `/api/ready` under a dead DB and
Neon's autosuspend wake. `max: 5` because Neon free tier is one small
compute — a larger client pool would just queue server-side; keeping the
queue client-side makes backpressure visible. The raw pool is exported for
shutdown/teardown only; **all queries go through the typed `db`**.

### §3.3 `src/db/migrations/001_initial_schema.ts` — the whole schema

Raw SQL DDL via Kysely's `sql` tag (the builder is for application queries;
DDL should read as the SQL it is). Typed `Kysely<unknown>` so migrations
stay frozen while `schema.ts` evolves.

**FLATTENED at the end of M3** from the five migrations that built it up
(tenancy/auth/keys, content pipeline, chat, provider credentials, embedding
credentials). Their history is in git. The trade: a migration series exists
to carry EXISTING databases forward, and this product has none worth
carrying — pre-launch, the only deployed data a demo corpus `npm run
seed-demo` recreates in seconds, and every integration suite already drops
and re-migrates from scratch. Against that, five files whose deltas nobody
will ever replay cost real legibility: `chunk_embeddings` was spread across
three of them, so reading the current schema meant replaying its own history
in your head.

The consequence, which bites exactly once and is written at the top of the
file: Kysely's migrator refuses a bookkeeping table containing names the
registry no longer has ("corrupted migrations"), so any database that
applied the old 001–005 — a dev box, the Neon instance behind the deployed
demo — must be reset with `DROP SCHEMA public CASCADE; CREATE SCHEMA
public;` before it boots again. From here the rule is the ordinary one:
additive migrations only, 002 onward, never a rewrite of this file. The
subsections below describe the schema by table GROUP (the same groupings
the old migrations had, so the §3.3.x anchors code comments cite still
resolve).

`CREATE EXTENSION IF NOT EXISTS vector` runs first, before any table needs
it, so a Postgres without pgvector fails at deploy time rather than at first
ingest weeks later.

| Table             | Purpose                  | Notable constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `organizations`   | tenants                  | `plan` CHECK; `char_length(id) = 36`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `users`           | dashboard logins         | email stored encrypted + blind index (columns predate the code because retrofitting encryption is a data migration)                                                                                                                                                                                                                                                                                                                                                                                          |
| `org_members`     | user↔org + role          | **partial unique index: one owner per org**                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sessions`        | dashboard sessions       | id IS sha256(cookie token) — a DB leak can't be replayed as logins                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `api_keys`        | widget pk/sk credentials | one CHECK makes kind/column mismatches unrepresentable; uniqueness among live keys only (`WHERE revoked_at IS NULL`) so rotation revokes instead of deletes. Since M7.1 `revoked_at` may sit in the FUTURE — that is the grace window (§9.17): both session routes accept a key while `revoked_at IS NULL OR revoked_at > NOW()`, on Postgres's clock. Since M7.3 (007, §3.3.9) secret rows also carry `secret_suffix`, their hash is unique across every row, and an org has at most one CURRENT secret key |
| `allowed_origins` | widget origin allowlist  | regex CHECK rejects paths/trailing slashes — a stored `https://a.com/` would silently never match a browser `Origin` header                                                                                                                                                                                                                                                                                                                                                                                  |

### §3.3.1 The content pipeline tables

What the ingest worker reads and writes, and what retrieval queries.

| Table              | Purpose                          | Notable decision                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`          | crawl targets / uploads per org  | status lifecycle CHECK; crawl_depth capped at 3                                                                                                                                                                                                                                                                                         |
| `documents`        | one fetched page / uploaded file | `content_hash` (sha256 of normalized text) short-circuits recrawls — identical hash skips re-chunk + re-embed, protecting embedding quota; soft delete + **partial** unique `(source_id, url) WHERE deleted_at IS NULL` so re-added pages don't collide with tombstones                                                                 |
| `chunks`           | the retrieval unit               | `heading_path` travels with every chunk (citations show where a claim lives); `char_start/char_end` deep-link into the source; `tsv` is a **GENERATED** column so the lexical index can never drift from the text; unique `(document_id, ord)` makes a buggy re-chunk loud                                                              |
| `chunk_embeddings` | one embedding per (chunk, model) | the three big decisions — see below                                                                                                                                                                                                                                                                                                     |
| `ingest_jobs`      | Postgres-backed work queue       | `FOR UPDATE SKIP LOCKED` consumer shape; partial index over queued rows only; CHECK `(state='running') = (locked_by IS NOT NULL)` makes an unowned running job unrepresentable. Since 008 (§3.3.10): `skipped_count` + `skipped_pages` (what the crawl left out and why, the list capped by CHECK), and at most one LIVE job per source |

The three load-bearing decisions on `chunk_embeddings`:

1. **`halfvec(1024)`**, not `vector(1024)`: 2 bytes/dim halves row and index
   size — ~78k chunks instead of ~39k inside Neon's 0.5 GB free tier. fp16
   recall cost is negligible and will be _measured_ by the eval harness.
2. **Partial HNSW index per model** (`WHERE model = '…'`), never IVFFlat:
   different models' vectors live in different spaces, so one shared index
   wastes traversal on foreign rows; and IVFFlat degrades silently under
   continuous ingest while HNSW builds incrementally. Registered:
   `bge-small-en-v1.5` (local/eval), `mock-384` (deterministic tests), and
   `gemini-embedding-001` (the hosted BYO default) — the three whose names
   the schema can know. A tenant's self-hosted or OpenAI-compatible model
   carries a name no migration can enumerate; those still WORK (exact
   sequential scan), they are just slower, and a future migration registers
   one when a model earns it. Creating indexes at runtime from application
   code was rejected outright: DDL on a shared table, from a request
   handler, to save a scan over a corpus that fits in Neon's free tier.
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

### §3.3.2 The chat tables

Chat persistence: what the answer pipeline (§3.15.3) writes and the
dashboard (§9.10) reads.

| Table               | Purpose                | Notable decision                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversations`     | one widget chat thread | `status` carries `'escalated'` from day one (M4 adds the mechanism; the M2 widget must already render the state, and enum growth is a migration); `(org_id, last_message_at DESC)` index IS the dashboard's conversation list                                                                                                                                |
| `messages`          | one turn               | `org_id` denormalized (M5's pre-flight usage cap counts answers per org per day — the hot path can't afford a join); three role CHECKs pin model/refused/score/latency to the assistant role, making mismatches unrepresentable (the api_keys pattern); `ttft_ms`/`total_ms` instrumented from day one, `input_tokens`/`output_tokens` added by 003 (§3.3.5) |
| `message_citations` | one verdict per claim  | see below — the snapshot decision                                                                                                                                                                                                                                                                                                                            |

The load-bearing decision: **`message_citations` snapshots what it cites
instead of referencing it.** `chunk_id` has deliberately NO foreign key,
and url/heading_path/quote are copies taken at answer time. Chunks are
MUTABLE pipeline state — every re-chunk deletes and recreates them — while
a support transcript is IMMUTABLE history; an FK would force either
cascade-deleting citations (history rots on every recrawl) or blocking
re-chunks (ingest hostage to chat history). A test pins the FK's absence:
a citation naming a chunk that never existed must INSERT cleanly.

EVERY claim is stored, verified and stripped alike — the strip rate is a
published metric and the dashboard shows what the visitor did NOT see.
`(verdict = 'verified') = (span_start IS NOT NULL)` plus a span-pairing
CHECK tie offsets to verified rows exactly; `content` on messages is what
the visitor actually SAW (verified claims after stripping, or the refusal
fallback), never raw model output. Composite `(message_id, ord)` key, like
chunk_embeddings — nothing references a citation row individually.

### §3.3.3 The BYO-provider credential table

`org_provider_credentials`, one row per (org, role), the key as AES-GCM
ciphertext (vault §3.21, AAD = row id) with `key_suffix` the only
plaintext fragment. Deliberate deviation from the plan's partial-unique
sketch: **UNIQUE(org_id, role) with HARD DELETE on replace** — a widget pk
is OUR credential (rotation audit trail = asset); a provider key is
SOMEONE ELSE'S (retained superseded ciphertexts = liability, one more
thing a master-key compromise unlocks). Shape CHECKs in the api_keys
style: ollama must NOT carry a key (unauthenticated), hosted providers
must, openai_compatible goes either way (self-hosted vLLM/LM Studio run
keyless); self-hosted shapes require base_url, hosted ones forbid it (a
writable endpoint on a hosted provider is a request-forgery lever, not a
feature).

`dim` is the embedding model's true dimension, measured by the Test
round-trip (M3.6b) and stored beside the credential. Without it an adapter
built from a stored row would not know its own dimension until its first
response, which is precisely when the worker needs it
(`chunk_embeddings.dim` is written in the same transaction as the
vectors). Storing it also turns every later call into an ASSERTION rather
than a discovery (§2.4.5j's assertBatch) — the detection §3.3.1 said its
own `dim` column existed for. A CHECK ties the pairing exactly in the
api_keys style: `role = 'embedding'` ⇔ `dim IS NOT NULL`, with the 1..1024
range mirroring `chunk_embeddings.dim` and PADDED_DIM.

### §3.3.4 `src/db/migrations/002_handoff.ts` — the handoff table

The first migration after the flatten, and the shape every later one
follows: additive, its own file, never a rewrite of 001.

`handoff_sessions` is one row per escalation of a conversation from the bot
to a person. A table rather than a column on `conversations` because an
escalation has its own lifecycle (requested → claimed → closed), its own
actors, and its own timestamps — and M5's headline product metric,
time-to-first-human-response, is a duration BETWEEN two of them. A
conversation can also be escalated more than once over its life (resolved,
re-opened later), which a column would overwrite the moment it happened.
`conversations.status` stays the coarse state the widget renders; this
table is the record.

The load-bearing constraint is the partial unique index: **at most one OPEN
handoff per conversation** (`WHERE status <> 'closed'`). Double-escalation
— a visitor mashing the button, a retry racing itself, an auto-escalation
colliding with the button — is then unrepresentable rather than
deduplicated in application code, which is what lets §3.23 be idempotent by
construction instead of by a check-then-insert that races. Because the
index covers only open rows, a closed handoff never blocks a later one.

One CHECK is worth its comment, and a test caught it: `active` is tied to
`claimed_at`, NOT `claimed_by`. The two say different things — WHEN it was
taken (a fact about the handoff, permanent) versus BY WHOM (a fact about an
account, which can be deleted). `claimed_by` is `ON DELETE SET NULL` so
history outlives employment; tying the CHECK to it instead would have made
that self-contradictory, and deleting a departing employee would fail on a
constraint in a table nobody remembers exists.

### §3.3.5 `src/db/migrations/003_answer_tokens.ts` — what an answer cost

Two columns on `messages`: `input_tokens` and `output_tokens`, the persisted
form of `LLMUsage` (§2.4.5d) and the input to cost per 1k answers (§9.13).
Columns rather than a usage table because they are facts ABOUT one answer,
at exactly its grain, written in the same transaction — a side table would
need its own key, a join on every cost query, and would make "an answer
whose tokens went missing" representable. `usage_daily` is a different
thing (a rolled-up counter read pre-flight) and is derived from these.

Nullable on purpose, and the null is load-bearing: some OpenAI-compatible
servers omit usage on streamed responses, and a gate refusal never calls a
model at all. NULL means "not reported"; 0 would mean "a model ran and
consumed nothing", and the cost metric would average that in as free. Named
`input_`/`output_` after the provider interface rather than OpenAI's
`prompt_`/`completion_` dialect, which the adapter already translated. Three
CHECKs in the 001 style: non-negative, assistant-only (a visitor turn with
token counts would be a pipeline bug that doubled every cost figure), and
PAIRED — a provider reports usage as one object or not at all, so half a
record is a parsing bug, and storing it would quietly under-report output
tokens, the expensive half on every model in the price list.

### §3.3.6 `src/db/migrations/004_usage_daily.ts` — the counters

One row per org per UTC day: `answers`, `refusals`, `escalations`, and the
day's token totals. What the pre-flight quota check reads (§3.18) and what
a billing period sums (M5.4).

The objection first, because it is the right one: `messages` already holds
every one of these facts, and M2.5's cap counted them with a range scan
over the (org_id, created_at) index. That works. What it is not is
CONSTANT — the cost of the check grows with the tenant's traffic, and it
runs before every question, including ones that get refused or rate-limited.
A counter makes the most frequent query on the hot path a single
primary-key lookup whose cost does not depend on how successful the
customer is; the same row is also what a billing period sums, where
re-deriving a month from `messages` on every page load is that scan
repeated.

The counters are written in the SAME transaction as the rows they count
(§3.15.3's persist step, §3.23's insert), which is why this is not a
nightly rollup: a cap enforced against a number up to a day stale is not a
cap. UTC days, not org-local — a per-org timezone would make the primary
key depend on a setting a tenant can change, silently re-bucketing history
the moment they moved offices; the boundary being arbitrary but FIXED is
what keeps yesterday's number true tomorrow. `answers` counts refusals: a
refusal spends no generation tokens but does spend an embedding call and a
retrieval query, and a ceiling that exempted the cheapest questions is one
an off-topic flood runs straight through. Token columns are BIGINT where
`messages` uses INT, because one row here sums a whole day and a counter
that overflows silently corrupts a bill. Two CHECKs make a disagreement
between writers unrepresentable rather than merely unlikely: counters never
go negative, and `refusals <= answers`.

### §3.3.7 `src/db/migrations/005_billing.ts` — subscriptions and the event ledger

Two tables, and one separation that is the whole design: **entitlement and
billing record are different things.** `organizations.plan` is what the
product ALLOWS, read on the hot path before every model call (§3.18) — one
column, no join, no dependency on a third party. `subscriptions` is what
STRIPE knows: their customer and subscription ids, the status, when the
period ends. The webhook moves the first when the second changes, and in
between they are independent — so Stripe being down cannot stop a tenant's
widget from answering, and reading a quota never requires knowing anything
about payments. Collapsing the two would put a billing outage on the answer
path, which is the one place it must never be.

`subscriptions` is keyed by `org_id` (one per organization; nothing
references a row individually — the natural-key argument again), with
`stripe_subscription_id` UNIQUE so a copied checkout link or a replayed
webhook cannot entitle a second tenant quietly. `status` carries STRIPE's
own vocabulary rather than a translation: inventing our word for "unpaid"
versus "past_due" would only make a support conversation held with their
dashboard open harder.

`stripe_events` has Stripe's event id as its PRIMARY KEY, and that single
choice IS the idempotency mechanism (§9.15). Retention is stated in the
migration rather than assumed: the table only grows, Stripe retries for
about three days so a week-old row can never be needed again, and there is
no cron here to prune it — the index is what a prune would use when volume
justifies writing one.

Worth noting: realtime owns these tables (it owns every migration) but has
NO billing code at all. The dashboard writes them; realtime reads the
entitlement column and nothing else.

### §3.3.8 `src/db/migrations/006_origin_daily.ts` — traffic by origin

One row per org per UTC day per ORIGIN: `minted` (sessions issued to an
allowlisted origin) and `refused` (mints turned away because the origin was
not allowlisted). Trust-model layer 4, M7.2: "every session mint records
its Origin, and the dashboard breaks traffic down by origin, so
unauthorized use is visible rather than inferred from a bill".

What the row is FOR decides its shape. Layer 1 already stops an unlisted
site — no unlisted origin ever gets a session — so the interesting number is
not what got through but what was turned away: "https://thief.example
presented your key 340 times this week" is how a tenant learns a copy of
their snippet exists, or that they forgot to allowlist their own staging
domain, which looks identical from here and is the commoner case. Minted
counts per allowlisted origin ride along for the same upsert. A counter
table rather than a log of mints, for 004's reason: the dashboard wants a
week per origin, and rows that grew with traffic would make that read grow
with the customer's success. Nothing identifies a visitor — origin and a
count; no IP, no visitor id, no Referer (a browser's default
Referrer-Policy strips the path cross-origin, so it would only repeat the
Origin).

`origin` is attacker-supplied text when the mint was refused, hence the
length CHECK here (253, the DNS ceiling, which the allowlist's own validator
also enforces) and the shape and volume rules in §3.28. Natural composite
key `(org_id, day, origin)`; unlike 004 there is no second index, because
the key's leading columns are exactly the range read (this org, last N days)
the dashboard scans. UTC days, as usage_daily.

### §3.3.9 `src/db/migrations/007_secret_keys.ts` — what the secret key needs

Three statements about `api_keys` that the publishable key never needed
(M7.3, layer 6). `api_keys` has carried `kind = 'secret'` and `secret_hash`
since 001, and M7.1's rotation already writes every row a secret key's
lifecycle needs; what was missing was schema, not a table:

1. **`secret_suffix`** — the last four characters, the ONLY fragment of the
   value kept in plaintext, because the dashboard shows a secret key exactly
   once and stores only its hash, and an owner with a current key and a
   retiring one could otherwise not tell which their server holds (the
   provider-credential table keeps `key_suffix` for the same reason). A
   CHECK pairs it with the kind exactly — present iff `kind = 'secret'`, and
   then of length 4 — in the api_keys style where a mismatch is
   unrepresentable rather than merely unusual.
2. **A UNIQUE index on `secret_hash`** — the lookup `POST /v1/sessions`
   makes on every mint, which without an index would scan the table for
   every request a customer's server sends. Unique across ALL rows, live or
   revoked, unlike public_id's live-only index: a secret key is 160 random
   bits, so two rows sharing a hash could only mean the same key issued
   twice, and re-issuing a rotated-out SECRET — a value that may have leaked,
   which is why it was rotated — is precisely what must never happen. NULLs
   (every public row) do not collide, so no partial predicate is needed.
3. **At most one CURRENT secret key per org** — a partial unique index over
   `(org_id) WHERE kind = 'secret' AND revoked_at IS NULL`. Rotation is
   guarded by the key it rotates FROM (§9.17's playbook), but the FIRST issue
   has nothing to guard on: two owners clicking "Generate" together would
   otherwise both succeed and leave the org with two current secret keys,
   each shown once to a different person. The index makes the second insert
   a unique violation the action reports as "already issued" — idempotence
   by schema, the handoff table's argument (§3.3.4). Deliberately NOT
   applied to public keys: the security fixture inserts an org's live and
   to-be-revoked public keys in one statement, and the public key's
   invariant is already held by rotation's guarded UPDATE.

Additive and safe on every deployed database: no row of kind 'secret'
existed before it, so the CHECK had nothing to disagree with. One
consequence the widget suite ran into and now documents: any test (or seed)
that wants an org with a revoked or retiring secret key beside a current one
must write the older keys FIRST — which is the order real history writes
them, an older key being rotated out before a newer one is issued.

### §3.3.10 `src/db/migrations/008_skipped_pages.ts` — what a crawl left out, and one live job per source

Two things about `ingest_jobs` (M7.5). First, the record of what a crawl did
NOT ingest: `skipped_count` (the TRUE total — robots.txt refusals, dead
links, off-origin redirects, unparseable bodies) and `skipped_pages`, a
JSONB list of `{url, reason}` holding the first `MAX_RECORDED_SKIPPED_PAGES`
(50) of them in the order they were met, so the dashboard can show a tenant
WHY a page is missing instead of a count that looks like forty fewer links.
Columns on the job rather than a table of pages, for 003's reason: facts
about one crawl at its own grain, read with the job by the one page that
shows the job. CAPPED because a docs site with an API reference under
`Disallow: /api/` discovers thousands of disallowed links, and a value that
grows with a site's link count is a row that grows with the customer's
success — the count stays true past the cap, so "and 1,240 more" is
arithmetic. The cap is enforced by CHECK as well as by the worker (the
api_keys stance): a second writer that forgot it fails loudly. The literal
lives here and the constant in shared/db/schema.ts (§2.4.6) — the
PADDED_DIM / halfvec(1024) arrangement, since a migration is frozen once
applied. Both columns default, so a job that predates the migration reads as
"nothing skipped", which is the honest answer: nothing was recorded.

Second, a partial unique index — **at most one LIVE job (queued or running)
per source** — for the Re-crawl button (§3.22): two owners clicking together,
or a click racing the re-index a credential change queues, would otherwise
insert two jobs that crawl one site twice for one outcome, and a
check-then-insert cannot close that window. Partial, so history is untouched
(a source accumulates one done/failed row per crawl); safe to add to a
deployed database because every existing writer already respected it by
construction — the enqueue route creates a fresh source, the re-index skips
busy sources, the worker's requeue moves the SAME row. Both job-inserting
routes now say ON CONFLICT DO NOTHING and read the row count, which is the
handoff table's argument (§3.3.4) applied to the queue.

### §3.3.11 `src/db/migrations/009_source_uploads.ts` — what an uploaded file leaves behind

One row per upload source (M7.6b), holding what the parser extracted rather
than the file. `sources.kind` allowed 'upload' from 001 and nothing could
produce one; this is the missing half.

**The bytes are never stored.** They are parsed in the upload request and
dropped, for two reasons that both point the same way. The file has nowhere
to go — there is no object storage in this deployment, and a 10 MB PDF in
Neon's 0.5 GB (which holds ~78k chunks) would cost more than the ~800 chunks
extracted from it, as a second copy of the same content in the more
expensive form, that nothing would ever read again: retrieval reads chunks,
and a citation deep-links by character offset into text we already have. And
keeping a customer's file is a liability with no matching asset — the
`org_provider_credentials` argument (§3.3.3), where retaining superseded
ciphertexts was rejected on exactly that ground.

**The text is not transient, and that is what forced a table** rather than a
parse-and-forget route. When an org changes its embedding model, §3.22
re-queues every source, because vectors are stored per (chunk, model) and a
new model makes the old corpus invisible rather than wrong. A crawl source
survives that by being fetched again. An upload has nothing to re-fetch — so
unless the extraction is kept, a model change would silently orphan every
uploaded document and the widget would stop answering from them with no
error anywhere. Keeping it is also what makes an upload a first-class
source: re-indexable, re-chunkable, and re-crawlable in the one sense that
means anything for a file.

`blocks` holds SPANS ONLY — `{kind, level?, charStart, charEnd}`. The parser
contract is `block.text === text.slice(charStart, charEnd)`, so storing the
text again inside the JSONB would double the row to record what the offsets
already determine, and would introduce the one way the two copies could
disagree; the worker slices them back out, so the contract holds on the way
out as on the way in. `format` is what the parser actually READ (detected
from the bytes, since magic bytes lead §3.10.3's order), not what the
browser claimed. `byte_size` is the original file's size — the one fact
about the bytes that outlives them, so the dashboard can say "2.1 MB PDF"
about something it no longer has. Keyed BY the source (nothing references an
upload row individually) with ON DELETE CASCADE, and one file per source: a
replacement is a new upload.

### §3.3.12 `src/db/migrations/010_schema_violations.ts` — counting the contract's failures

The plan's anti-tutorial rules name this one directly: structured output
differs per provider, weaker paths need validate-and-one-retry, and **schema
violations are a counted metric, not a swallowed exception**. The pipeline
has done the first half since M2.3 — validate, retry exactly once, give up
loudly — but nothing recorded WHETHER a given answer needed that retry, so
the rate was an exception being handled rather than a number anyone could
read. This migration is the counting half (M7.10), and it matters most as a
COMPARISON: four providers now enforce a schema four different ways
(§2.4.5n), and they should not produce the same violation rate. A number
that could only ever be zero would be decoration.

**`messages.schema_violations`** — how many times the model broke the
contract producing THIS message: 0 when it held first try, 1 when the retry
rescued it. An INT rather than a BOOLEAN because the cap is prompt.ts's
product decision rather than a schema fact, and a count is what the metric
sums. NULLABLE, and the null is load-bearing — 003's argument for the token
columns applied to the same distinction: NULL means NO MODEL RAN (a gate
refusal, a visitor's turn, an agent's reply), where 0 would claim a model ran
and held the contract, padding the rate's denominator with answers nobody
generated. A CHECK ties the pairing exactly in the 001 style — a row has a
model if and only if it has a count — and that constraint immediately earned
itself: it caught FOUR test fixtures building assistant rows the pipeline
cannot produce, which is the same class of bug as M5.2's per-model refusal
column that passed a test whose fixture did not match the pipeline.

The one-time imprecision is stated in the migration rather than smoothed
over: rows written BEFORE it are backfilled to 0, which claims those answers
held the contract when the truth is that nobody recorded it. Acceptable here
for the reason the schema was flattened at M3 — pre-launch, the only
deployed rows a demo corpus a seed recreates in seconds — and written down
so a future migration that needs the opposite trade (leave history NULL,
drop the pairing CHECK) knows this one was made deliberately.

**`usage_daily.schema_failures`** — the case the message column CANNOT hold,
and the one that matters most. When the retry ALSO fails the pipeline throws
and NO assistant row is written, so counting violations only on messages
would make a provider that fails systematically look PERFECT: its worst
outcome recorded as no outcome, which is exactly the swallowed exception the
plan warns about. Per (org, day) rather than per model, because there is no
message row to hang a model on — that is the whole problem; what it answers
is "did we fail to answer anything today?", an alerting question, while the
comparison lives on the messages column. Deliberately NOT folded into
`answers`: that counter is the quota's denominator, and charging a tenant's
daily allowance for a question the product failed to answer would let a
misbehaving model burn a customer's plan.

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
proxy hop away; what makes `req.ip` honest for the widget rate limits);
JSON bodies capped at 64 KB (no route needs more; a big limit is a free
memory-pressure lever). The widget surface (§3.18) mounts only when its
dependencies are passed in — server.ts always passes them; tests that only
probe health build the bare app and never construct providers they won't
use.

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

The ingest worker (§3.10.5) runs **only when `INGEST_WORKER=1`**, and
since M3.6a it is CONSTRUCTED before the app (the internal enqueue
route's onEnqueue is wired to its wake()) and STARTED after listen, as
before. `INGEST_POLL_MS` picks the mode: unset/positive → the poll loop
(dev compose, where local Postgres is free); "0" → wake-driven, which is
what render.yaml now ships — on Neon a few-second poll would hold
compute awake around the clock against the ~100 CU-hour monthly budget,
the same budget the DB-free health route protects, so production has NO
timer and the dashboard's enqueue is the scheduler.
`LLM_FALLBACK_PROVIDER` (M7.7) optionally names a SECOND provider, built the
same way and by the same table, so a bad name fails at BOOT like every other
provider selection rather than on the one request that needed it; unset in
every keyless stack, since a fallback that silently equalled the primary
would report as configured while buying nothing.
`EMBEDDING_PROVIDER` picks mock (default) or local — mock is an
honest placeholder until per-org BYO providers (M3): its vectors carry no
semantics, which costs nothing while no retrieval exists, and it is what
lets CI drive the full pipeline keylessly.

Since M2.5 boot also assembles the widget surface's dependencies: ONE
embedder instance shared by the worker and retrieval (the
ingest-and-query-must-agree-on-a-model rule enforced by construction, not
by two env reads happening to match), the LLM from `LLM_PROVIDER`
(default mock — §3.15.4), the token secret from `resolveTokenSecret`
(§3.17.1), and the optional ANSWER_MAX_DISTANCE / WIDGET_DAILY_ANSWER_CAP
overrides, all handed to createApp.

Shutdown: SIGTERM → stop accepting, stop the worker (it requeues an
in-flight job between pages — §3.10.5) → drain pool → exit; a second signal
force-exits.

### §3.8 Tests (`src/**/__tests__/`)

- `routes/__tests__/health.test.ts` — drives the real HTTP listener via
  `fetch` on an ephemeral port. Environment-adaptive: with
  `POSTGRES_PASSWORD` set, `/api/ready` must 200; without, it must 503
  _fast_ (the sub-second health assertion also guards "someone added a DB
  call to the liveness route").
- `db/__tests__/migrate.test.ts` — integration suite, self-gated on
  `POSTGRES_PASSWORD` (green on a machine with no DB, lights up in compose/
  CI). Asserts: all tables exist, pgvector installed, idempotent re-run,
  bookkeeping matches the registry, and the interesting constraints reject
  invalid rows **at their boundaries** (second owner rejected while second
  agent accepted; mismatched api_key kind; origin with a trailing slash;
  and 007's three statements — a secret key without its suffix or with one
  of the wrong length, a public key carrying one, a second CURRENT secret
  for the same org, and the same hash under another org, all refused, while
  the well-formed secret row is accepted; and 008's — a job that knows
  nothing of the columns reading as nothing skipped, a list at exactly the
  cap accepted while one past it, a non-array, and a negative count are
  refused, and one LIVE job per source: done and failed rows accumulating
  freely, one queued row fine, a second queued or running one refused, and
  another source unaffected. Both new cases delete their org in a `finally`
  because their surviving rows are QUEUED jobs, and a later suite's worker
  would otherwise claim and crawl them — which it did, once, on the way to
  writing this); and 010's — a message with a model and no violation count,
  and a count with no model, each refused by the pairing CHECK from its own
  side, while 0, 1 and NULL-with-no-model are all accepted, plus a negative
  count and a negative `schema_failures` refused.
- `db/__tests__/chat.test.ts` — the chat-schema integration suite, same
  gating. Role-consistency CHECKs probed from both sides (visitor with a
  model rejected, full assistant row accepted); the span/verdict equality
  CHECK at all three boundaries (verified without span, unverified with
  span, half a span); inverted/empty/minimum spans; duplicate `(message_id,
ord)`; the conversation→message→citation cascade; and the deliberate
  ABSENCE of a chunk FK (a citation naming a never-existing chunk inserts
  cleanly — that test failing means someone re-coupled transcripts to
  pipeline state).
- `db/__tests__/contentPipeline.test.ts` — the content-pipeline integration suite,
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
  third pins that a detected PDF reaches the PDF parser rather than the
  markdown fallback — the property that mattered when there was no parser
  at all, and still does (§3.10.7).
- `ingest/__tests__/pdf.test.ts` + `pdfFixtures.ts` — keyless (M7.6a). The
  fixtures are a minimal PDF WRITER, ~40 lines with a real xref table, so
  the suite ships no opaque blobs and a test can say "a two-page document
  whose second page wraps a sentence" — deliberately valid rather than
  broken-but-recoverable, or the tests would be measuring pdf.js's recovery
  path. Pinned: the offset contract on every document the suite produces;
  the Info title, and the first-line fallback when a PDF claims none; a
  page's wrapped lines staying in ONE block (with the MEASURED fact that
  pdf.js emits no blank lines, so a fixture's blank line is dropped
  entirely); pages separated by a blank line with the second page's offsets
  pointing PAST the separator; whitespace collapse making the text
  deterministic for `content_hash`; and parsing the SAME buffer twice, which
  is the regression test for pdf.js detaching its input. Refusals get their
  own describe: the scan (no text layer) named with OCR, truncated and
  non-PDF and empty bytes, and an oversized one refused before pdf.js sees
  it (a valid PDF plus padding, so only the cap can be what rejects it).
  Then through the DISPATCHER: a PDF mislabeled `text/plain` parsed anyway
  (magic bytes decide), a declared charset never applied to it, and a
  parse → chunk round trip like the worker's.
- `ingest/__tests__/crawler.test.ts` — no DB. An in-test fixture site with
  every scope hazard: fragments, duplicate links, redirects, cross-origin
  links, binary assets, broken pages, markdown served as text/plain,
  sitemap + sitemapindex. Asserts what was and was NOT requested (the
  server records paths), not just what was yielded. Since M7.6a the fixture
  also serves a REAL PDF (built by pdfFixtures.ts, sent as bytes rather
  than through the string substitution that would corrupt it) at a linked
  `.pdf` URL, and the assertion that used to say it was never requested now
  says the opposite: fetched, ingested, titled from its Info dictionary,
  and not among the crawl's errors. The M7.5 block gives the
  fixture a mutable `/robots.txt` (404 by default — the existing tests'
  world, and the common case) and a root whose links cross into areas a file
  may close: robots.txt read once, FIRST, and a disallowed link reported once
  with the rule and never requested; no file → everything crawled; a group
  naming InterrelatedBot winning over the wildcard's `Disallow: /`; a
  redirect that lands on a disallowed page (linked from NOWHERE directly, so
  only the arrival check can catch it) fetched but not ingested and reported
  under the URL that answered; a disallowed root and a 503 robots.txt each
  refusing the crawl with `/robots.txt` the only request made; sitemap
  entries the file disallows announced BEFORE a plan that excludes them; a
  disallowed sitemap file itself refused; and Crawl-delay pacing measured on
  the server's own clock (0.3 s → every gap ≥ 250 ms; 100 s under a 200 ms
  cap → gaps ≥ 150 ms and the crawl done in seconds).
- `ingest/__tests__/robots.test.ts` — keyless (M7.5). Group selection
  (wildcard when nothing names us; a specific group REPLACING the wildcard;
  the token case-insensitive and version-blind; a run of user-agent lines as
  one group; no group at all or only other crawlers' groups → allowed;
  several groups for one agent merged; rules before any user-agent line
  dropped; a Sitemap line ending the agent run but not the group); rule
  precedence (the RFC's own example per crawler; longest match, by pattern
  length; Allow winning an equal-length tie in either order; the empty
  Disallow; the deciding rule named in the reason; Crawl-delay from the
  matched group only); patterns (prefix vs `$`, `*` anywhere including
  consecutive stars, `$` mid-pattern literal, and the exponential-regex
  pattern answering in under half a second); the comparison form (non-ASCII
  encoded on both sides, hex case, a space, unreserved escapes decoded and
  reserved ones kept so `%2F` is not a slash, the query matched, an
  unparseable URL getting no verdict); parsing tolerance (comments, CRLF, a
  BOM, mixed-case fields, no spaces, lines with no colon, unknown fields);
  and the fetch semantics against a loopback server — 2xx parsed with the
  request identifying the crawler by its product token, our token's group
  selected by default, 404/403/410 → allowed, 503 → nothing allowed with the
  status and the RFC in the reason, a redirect followed to the file that
  ends the chain, a redirect with nowhere to go counting as no file, a port
  nobody listens on being unreachable rather than absent, and a file over
  the cap unreachable too, saying how big.
- `retrieval/__tests__/search.test.ts` — DB-gated, plus an always-on
  input-validation block (limit guards fire before any query, so they run
  keylessly). The centerpiece is the multi-tenant regression test from the
  plan: 20 orgs × 30 chunks share one HNSW index, and every org must
  retrieve exactly k — through a dedicated SINGLE-connection Kysely with
  `enable_seqscan = off` AND, since M7.1, `enable_sort = off`, because on
  the shared pool the session SET and the search could land on different
  connections, and an exact plan (unstarvable) would pass the test without
  exercising what it guards. Its
  companion asserts that with iterative scans OFF some tenant starves —
  20×k=100 > ef_search=40, so by pigeonhole the fixture MUST bite; if that
  ever fails, the planner stopped using HNSW and the regression test has
  gone vacuous. It DID fail, once, in M7.1's full ladder — green alone, red
  inside a full run — and the diagnosis is recorded in the file: a seqscan
  is not the only exact route. Every plan other than the HNSW scan has to
  SORT by distance, and at 612 rows those plans (a documents → chunks →
  embeddings-by-primary-key join under stale statistics; a scan of the
  whole primary-key index for the model plus a Sort under fresh ones,
  costed 215 against HNSW-with-LIMIT's ~209) sat at the planner's
  break-even, so autoanalyze timing decided which ran, and under the exact
  one 0/20 tenants starved (19/20 under HNSW). `enable_sort = off` closes
  every exact route at once, so the pigeonhole holds by construction rather
  than by luck. Also pinned: soft-deleted documents invisible to both arms
  even when the query is the deleted chunk's exact text; cross-tenant
  isolation under byte-identical texts (same mock vector, same tsv — only
  the org filter separates them); hostile lexical syntax never throws;
  stop-word-only queries return empty; equal-score ties order by chunk id
  reproducibly; hybrid fusion reports per-arm ranks with exact RRF scores;
  k beyond corpus size returns the whole corpus.
- `widget/__tests__/sessionToken.test.ts` + `rateLimit.test.ts` —
  keyless. Tokens: round-trip, the expiry boundary (valid at exp−1,
  rejected AT exp), tampered payload and signature, wrong secret,
  malformed garbage, and validly-signed-wrong-shape. Buckets: exactly
  capacity takes then denial, refill at the boundary, long-absence caps
  at capacity, key independence, hammering recovers on schedule, sweep.
  The signature tamper flips a character in the MIDDLE of the MAC since
  M6.4: it used to flip the last base64url character, whose two low bits
  are padding, so `A↔B` there decoded to the same bytes and the "tamper"
  was a no-op one run in sixteen — a latent flake this suite and
  ticket.test.ts both carried, found when the M6 probe made the identical
  mistake (§6.3) and then the full ladder hit it in the unit test.
- `routes/__tests__/widget.test.ts` — DB-gated, drives a REAL http
  listener. Session: allowlisted mint with CORS echo, unlisted origin
  rejected WITHOUT CORS, missing Origin, unknown/revoked keys collapse
  to one uniform 401 (revoked on the DATABASE's clock since M7.1, so a
  drifted container can never make the check pass by accident), the
  grace-window case — a key with a future `revoked_at` mints AND its
  token chats, its `last_used_at` is stamped, and once the window closes
  it is byte-identical to an unknown key while the token minted inside
  the window still chats, because a session is bound to the org and not
  to the key that opened it — the layer-4 counters (M7.2): one allowlisted
  mint adds one `minted` to its origin's row, two refused mints add two
  `refused` to the copy's, and a missing Origin or a bad key adds nothing
  anywhere and creates no row — preflight, per-IP mint flood; and since M7.3
  the visitor-id namespace: a stored anonymous id is honored, while a
  malformed one and an IDENTIFIED one (a customer's user id, which only the
  secret-key route may mint) get the same 400. **Server-side mint (M7.3, a
  describe of its own):** three secret keys seeded in the order real history
  writes them (revoked, retiring, current — 007 allows one current); the
  real key on the allowlisted origin with a user id mints a session with NO
  CORS header, and that token chats from that origin under exactly that
  identity (the conversation row's visitor_id), dies replayed from another,
  stamps the key's `last_used_at`, and counts the origin as minted; a
  missing, garbage, unknown, revoked, and PUBLISHABLE-key bearer are one
  byte-identical 401 while the live key still mints; the retiring key mints
  inside its window (stamping last_used_at) and is byte-identical to an
  unknown one after it, while its token still chats; an unlisted origin is
  403 (counted, no CORS) with the allowlist sentence, a trailing-slash origin
  gets the shape sentence, a missing one 400; an anonymous-shaped, malformed,
  or missing visitorId is 400 with no token; a preflight and a request
  carrying an Origin both get no CORS header; and the per-IP bucket bites
  before the key is looked at (401, 401, 429). Chat: the grounded
  SSE stream end to end (meta/claim/done with citations, persistence
  under the token's visitor), uniform 401 for missing/tampered/expired/
  wrong-secret tokens, token replay from a different origin, question
  length edges, own-conversation continuation vs the cross-visitor
  hijack probe (opaque error event, nothing to learn), malformed
  conversation ids, the daily cap 429 BEFORE the model call — with the
  M5.3 case that pins where the number comes from: fill today's counter to
  the FREE plan's ceiling with no override configured, watch the widget
  stop, upgrade the org, and watch the very next question be answered — and a
  rate-limit 429 that still carries CORS. Escalate (M4.1): the queue place
  taken once and reported idempotently with CORS on the real response, the
  bot falling silent on the next question, the cross-visitor hijack and a
  fabricated id both 404 with nothing written, and bad token / malformed
  id / replayed origin all rejected before any write.
- `usage/__tests__/daily.test.ts` — DB-gated (M5.3). The counters: a row
  created on the first answer and ADDED to after; ten CONCURRENT answers
  producing exactly ten (the reason it is an upsert, not a read-then-write);
  a refusal counted as an answer with zero tokens; days kept apart, so
  yesterday's quota does not follow a tenant into today; escalations
  counted without touching the answer count; and the CHECKs refusing a
  state that would mean two writers disagreed (`refusals > answers`, a
  negative counter, a second row for one org-day). The quota: the PLAN's
  ceiling, following a plan change, a deployment override that TIGHTENS but
  never widens, `exceeded` flipping AT the limit rather than past it, null
  for an org that does not exist — and the plan-catalog lockstep, which
  inserts an org at EVERY catalog id, so a tier added without a migration
  fails here instead of at a customer's upgrade.
  The M7.10 block adds the contract-failure counter: two failures counted
  without touching `answers` or `refusals` (a question the product failed to
  answer must not spend the tenant's quota), and five CONCURRENT failures
  adding as five, which is the upsert's reason for existing.
- `usage/__tests__/origins.test.ts` — the per-origin counters (M7.2,
  §3.28). Keyless: the shape rule keeps origins and the literal `null`,
  and collapses paths, schemes, whitespace, markup, and over-long hosts
  into the malformed sentinel. DB-gated: minted sessions summed per
  allowlisted origin; refused mints summed per unlisted one; the
  staging-domain day, where one row carries a refusal in the morning and a
  session in the afternoon; malformed values never stored as themselves;
  ten CONCURRENT mints adding as ten; the distinct-origin cap — a hundred
  forged origins admitted, the hundred-and-first and -second collapsing
  into `(other)` while a known origin still counts on its own row; days
  kept apart; the schema refusing an over-long origin and a negative
  counter; and the rows deleted with their organization.
- `handoff/__tests__/escalate.test.ts` — DB-gated. The transition and its
  record moving together; idempotence (a second request reports the first,
  and does not rewrite why the visitor is waiting, and adds NOTHING to the
  day's escalation counter — while a genuine re-escalation after a close
  does count); the CONCURRENT
  double-escalation — five simultaneous requests must yield one row, one
  `created: true`, and no error — which is the only way to show that
  idempotence comes from the index rather than from the read above it; the
  three not-found shapes collapsing to one; a closed handoff followed by a
  new one (the index is over OPEN rows precisely so a conversation can come
  back); and deleting an agent MID-handoff, which must succeed and leave
  the record intact — the test that caught the claimed_by/claimed_at
  invariant (§3.3.4). Plus the schema states that would corrupt the queue:
  active with nobody holding it, closed with no closing time, an unknown
  reason. The M4.6 block covers the other end: closing moves both rows and
  lets the conversation be escalated anew; five CONCURRENT closes produce
  exactly one closed_at and four honest `closed: false` answers; closing
  claims an unclaimed handoff but never reassigns one already claimed; and
  another org's conversation, a fabricated id, and one that was never
  escalated are answered distinctly here — this surface is internal, and
  both ends of it are ours.
- `handoff/__tests__/ticket.test.ts` — keyless. Round-trip, a distinct
  nonce per mint, the expiry boundary (valid at exp−1, rejected AT exp),
  tamper/wrong-secret/garbage/validly-signed-wrong-shape, KEY SEPARATION in
  both directions (a session token is not a ticket and vice versa), and
  single use: consumed once, refused forever, with the sweep proven to drop
  only entries whose tickets the verifier would already reject.
- `handoff/__tests__/socket.test.ts` — DB-gated, and the only suite that
  drives real WebSocket clients against a real listener. The upgrade
  boundary first: no ticket, a forged one, and the wrong path are refused
  with status codes rather than accepted-then-closed; a REPLAYED ticket is
  refused seconds later while still unexpired; another org's, another
  visitor's, and a closed handoff's tickets all 404. Then the behavior: an
  agent attaching flips the row to active with claimed_by set and both
  sides see presence change (and see it change back when they leave); the
  relay carries both ways with roles taken from the TICKET — a visitor
  frame claiming `role:"agent"` is stored as a visitor's — and both ends
  receive the identical broadcast; malformed, empty, and oversized frames
  are refused WITHOUT dropping the socket (hanging up on a visitor
  mid-support-conversation is not an error-handling strategy); and a
  message reaches only its own room. The M4.3 block covers replay and
  typing: the backlog carries the BOT's turns as well as the humans' (an
  arriving agent must not have to go find what the visitor was already
  told), a reconnecting client gets back what it said with a
  byte-identical timestamp (the one-clock property), the backlog is
  bounded to the NEWEST window, and a client attaching mid-conversation
  sees every message exactly once — the case that fails 3 runs of 3 with
  the buffer removed. Typing: relayed to the other side, coalesced from a
  five-keystroke burst into ONE frame, never echoed to the sender, never
  written to `messages`, cleared by sending, and cleared again by
  disconnecting mid-sentence. Every connection in the suite now also pins
  the opening order (ready → history → presence) through one shared
  helper, which asserts backlog and flushed ids are disjoint. M4.6 adds
  closing: `endRoom` sends `closed` to every member and THEN hangs up
  (both, in that order — the frame is what spares a client a pointless
  reconnect), DRAINS the room rather than holding dead entries — polled
  and bounded since M8.8, because entries are reaped in the server's
  close handler, which nothing orders against the client-side closes the
  test awaits; asserting the very next instant was a race the suite lost
  on its first shared-runner run — and touches no other conversation.
- `credentials/__tests__/vault.test.ts` — keyless. Round-trip, AAD swap,
  tamper/garbage rejection, and the NO-dev-fallback stance (missing or
  short CREDENTIAL_MASTER_KEY throws — pinned because email crypto makes
  the opposite choice and someone will one day "align" them).
- `credentials/__tests__/roundTrip.test.ts` — keyless and instant (M8.2):
  the Test button's attempt policy, which is a set of DECISIONS about
  failures rather than anything with real latency, so the providers are
  scripted and the file runs in milliseconds. Pinned: a transient 503 and a
  429 each earn a second attempt and succeed (the 503 is the failure this
  machine's free tier actually produced); a 401 and a 400 are attempted ONCE,
  because a wrong key is just as wrong a second later; two attempts is the
  cap rather than "until it works", since a person is watching a form; the
  budget-exhausted sentence names slowness rather than the key; the embedding
  twin follows the same policy; and an adapter's own contract violation
  (wrong vector count) is never retried, because it is a fact about the
  model and the message is already written for a human.
- `credentials/__tests__/resolve.test.ts` — DB-gated (M7.8), the vault's
  READ side, which had no suite of its own until this increment made a
  claim about it worth pinning: a row naming ANY of the schema's five
  providers resolves to a working adapter. An anthropic GENERATION row
  resolves (it THREW before — a provider the schema accepts could be stored
  and then break every answer for that tenant at question time) under the
  model the row named rather than the adapter's default, since that value
  is what lands in `messages.model` and therefore in the price lookup; a
  row with no model falls back to the default; an org with no credential is
  null on both roles, the normal fallback state; and an anthropic EMBEDDING
  row — unrepresentable through the route, so its presence means the row
  was written around us — throws by name rather than embedding a corpus
  with a provider that has no embeddings endpoint. No network: resolution
  ENDS at a constructed provider, and the call is the gated live suite's
  job.
- `credentials/__tests__/liveProviders.test.ts` — **key-gated**, the
  fastembed pattern (§2.4.5c) applied to providers: each provider's cases
  run only when ITS key is in the environment (`GROQ_API_KEY`,
  `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` — the same variables the CLI and
  server fallback read, §2.6; there is deliberately no test-only variable
  to keep in sync — plus, since M8.6, `XAI_API_KEY`, the one deliberate
  exception: nothing else reads it, because its job is to prove the
  GENERIC OpenAI-compatible adapter against a real hosted endpoint,
  api.x.ai, through the exact self-hosted credential shape a tenant would
  save — openai_compatible + base URL + explicit model, the base URL
  through the PRODUCTION SSRF vet, which no loopback test can run
  un-mocked. The entry's model default is NON-reasoning on purpose, and
  `XAI_MODEL` pins a run). What only a real provider can answer: does it
  accept the exact payload the Test button sends and report a resolved
  model; does the key still authenticate after an AES-GCM encrypt/decrypt
  cycle (a subtle encoding or AAD corruption would pass every loopback
  test and fail only here); and does its structured output honor the
  claims contract — since M8.6 under the PRODUCTION prompt
  (buildAnswerMessages, because the old hand-built prompt promised a
  schema it never provided, which only a natively-enforcing provider
  survives) with the pipeline's own one-retry mirror (buildRetryMessages;
  a violation and its rescue are both printed, so §2.4.5h's "enforcement
  ranges from real to advisory" stays an observation) — and a bounded
  60 s wait for a 429, because the suite's own three back-to-back calls
  can trip a fresh key's per-minute window, which is one of two limits
  the failure sentence now tells apart (per-minute: re-run in a minute;
  per-day: 20/model on the free tier, hard until rollover). With no keys
  the cases skip AND a guard test asserts the keyless default, so "gated
  off" can never be mistaken for "passed". CI sets no keys, by design.
  Since M3.6b Gemini — the only free tier serving both roles — also runs
  the EMBEDDING credential path: that the reduced output dimension we
  request is honored and storable (the whole basis for halfvec(1024)),
  that a batch comes back in order, and that a query embedding really is
  nearer its own passage than an unrelated one — which is both a semantic
  check the mock cannot make and the proof that taskType is doing
  something.
- `routes/__tests__/internal.test.ts` — DB-gated, real HTTP listener, a
  loopback OpenAI-compatible fake as the tenant's provider (recording
  every request so tests assert what left the process). Pinned: uniform
  empty 401s; 404 for unknown AND malformed org ids; test-without-save
  storing nothing while the round-trip really hit the upstream;
  encrypted-at-rest proof (ciphertext decrypts only under the row id);
  replace-destroys-the-old-ciphertext; the READ-BACK DENIAL (no key
  substring, no ciphertext in the status response); Groq AND Anthropic
  refused for the embedding role BY NAME with zero upstream calls (M7.8 —
  a tenant reads which provider they picked, not a generic refusal);
  shape violations rejected with zero upstream calls — including the two
  M7.8 added, a keyless Anthropic save and an Anthropic save carrying a
  base URL, the second being the rule that matters whenever a HOSTED
  provider is added; a failing upstream storing nothing and never
  echoing the key; the PRODUCTION url vet rejecting loopback (the SSRF
  default, asserted by NOT injecting the test seam); and the unconfigured
  app 404ing the whole surface. The M4.6 block adds closing a handoff:
  the room rung exactly ONCE (a second click answers `closed: false` and
  stays silent, since a later escalation of that conversation could be
  sitting in the room), plus the ticket route's refusal set repeated —
  outsider, malformed id, unknown conversation, no secret. The M3.6b
  block adds the embedding role
  end to end against a loopback embeddings endpoint: the dimension is
  MEASURED not declared (the form never asks for one) and stored on the
  row; a 1536-d model is refused with both numbers in the sentence while
  the previous valid credential stays untouched; and the re-index
  contract from all three sides — a changed model queues one job per
  source, a rotated key for the SAME model queues nothing, and removal
  queues a re-index exactly when a row was actually deleted.
- `routes/__tests__/widgetByo.test.ts` — DB-gated. Since M7.7 it also pins the
  rule the platform fallback lives under, which is the one worth a test of its
  own: with a fallback CONFIGURED and the BYO tenant's own provider answering
  503 through every retry, the visitor gets the route's opaque error, that
  tenant's provider is shown to have really been retried, ours is never
  called, and no assistant row is written. Per-org BYO generation
  in the LIVE chat path: a loopback OpenAI-compatible upstream wrapping
  the context-quoting responder, reached through the REAL adapter with
  the DECRYPTED tenant key (the Authorization header is asserted);
  claims survive the full verify/strip loop and the persisted message
  names the tenant's model. The multi-tenant cases are the point: a
  credential-less org falls back to the mock and never touches the other
  tenant's provider, and a removed credential stops being used on the
  very next question (no cache to serve it stale).
- `routes/__tests__/internalSources.test.ts` — DB-gated. The M7.6b upload
  block: a PDF uploaded as raw bytes with its name and type in headers,
  parsed IN the request (title from the Info dictionary, format from the
  MAGIC BYTES), its text and span-only blocks stored — every span sliced back
  out of the stored text and none of them carrying a `text` key — with the
  source at depth 0, the job queued, and the wake fired; a PDF the browser
  called `text/plain` parsed as a PDF anyway; a markdown upload keeping the
  heading structure a PDF cannot have; the refusals, each with a sentence and
  nothing stored (a scan named with OCR, bytes that only claim to be a PDF,
  an empty file, a nameless one, and one whose text is only whitespace) plus
  a filename that is a path, which is a legal upload once the path is
  stripped and must not keep its segments; an oversized file 413 before the
  parser sees a byte; a secretless upload 401 and an unknown org 404, neither
  enqueueing; and an upload RE-INDEXED from its stored text — the 422 that
  used to live in the recrawl route. The enqueue
  surface: source + queued job + the wake callback firing; malformed
  inputs (upload kind, non-URLs, embedded credentials, depth out of
  bounds) rejected with ZERO enqueues; the production vet refusing a
  metadata-endpoint crawl target; and the wake-driven worker proof — a
  pollMs-0 worker, idle after its start tick with NO timer in existence,
  runs a job if and only if wake() is called (an upload-kind source's
  fast loud failure is the no-network probe that the tick really ran). The
  M7.5 block covers Re-crawl: five CONCURRENT clicks on an idle source
  yielding one queued job, one wake, and four honest `queued: false`
  answers — the partial unique index deciding, not a read — then, once
  that job is done, a fresh re-crawl accepted; and the refusals: another
  org's source, a fabricated id, and a malformed one all 404, an upload 422
  with a sentence, no secret 401, and no wake fired by any of them. The
  suite parks the jobs it queues, because the wake-driven worker test after
  it runs one job per tick and would otherwise spend its wake on a crawl of
  `recrawl.example`. The M8.5 block covers the source ceiling and delete,
  each case in its own org deleted in a `finally` (the migrate suite's
  convention — a leftover queued job would eat the worker test's wake): the
  free plan's single slot refused at the second source with a sentence
  naming both ways out and nothing landed or woken; an upload held to the
  same ceiling with nothing stored; an upgrade opening the next slot (the
  limit is the PLAN's, read live); five CONCURRENT creates on a free org
  admitting exactly one — the org-row lock, not luck; delete freeing the
  slot without a wake; delete taking the whole subtree while the transcript
  KEEPS its verdict on the deleted chunk (§3.3.2's missing FK, exercised
  through a route for the first time); a RUNNING crawl refusing the delete
  while a QUEUED one dies with its source; and foreign, fabricated,
  malformed, and secretless deletes refused as elsewhere. The suite's shared
  org moved to `pro` in the same change (free's ceiling is one and this
  suite creates sources freely, because the ceiling is not what it is
  about), and the worker test's poll ceiling widened from 2 s to 10 s: the
  loop exits the moment the job fails, so the cap only binds when something
  is wrong, and the tight one converted an ordinary machine stall into a red
  run — observed once, green on every re-run, recorded rather than shrugged
  at.
- `routes/__tests__/demo.test.ts` — keyless and DB-free (the demo surface
  is static config → static responses). The configured page carries the
  snippet with same-origin data-api; the unconfigured page is honest
  setup instructions; a hostile publishable key renders escaped; the
  bundle serves with a JS content type and short cache; a missing bundle
  404s with the build hint.
- `answer/__tests__/retry.test.ts` — keyless and instant (M7.7): the sleep and
  the random are injected, so the arithmetic is pinned rather than sampled and
  the file runs in milliseconds instead of tens of seconds. Pinned: what is
  retryable (429/408/5xx/transport) versus what a retry cannot fix
  (401/400/404) versus an abort, which is never retried because stopping is
  the point; `Retry-After` honored verbatim while full jitter spreads two
  clients limited by the same burst; the exponential's cap; a 429 cleared on
  the second attempt; the provider's ORIGINAL error rethrown after the last
  one, so status and retryAfterMs survive for the log; the BUDGET rule, where
  a 60-second `Retry-After` produces an immediate failure and exactly one
  attempt; an abort landing mid-backoff stopping the retry that would have
  succeeded; and the onRetry seam, so a wait is never silent.
- `answer/__tests__/gate.test.ts` + `prompt.test.ts` — keyless. The gate
  at its boundaries (exactly-at-threshold answers, just-past refuses; min
  over mixed dense/lexical hits; lexical-only fails closed) and the prompt
  invariants (system prompt free of retrieved content; persona in system,
  never the user turn; question last; retry replays the exchange with
  every error).
- `answer/__tests__/pipeline.test.ts` — DB-gated. The full answer path
  against real Postgres with scripted mock LLMs: the grounded happy path
  (persistence, verified citation spans sliced back out of the chunk,
  event order, TTFT recorded); stripping (both verdicts stored, only the
  verified claim shown); the all-stripped fallback (refused=false, strip
  rate 100% on record); gate refusal BEFORE any model call (empty mock
  script proves zero calls); the one-retry path (errors fed back verbatim,
  second response accepted); double failure (AnswerSchemaError, visitor
  message survives, NO assistant row); conversation continuation and the
  cross-tenant append rejection; blank-question rejection. The M7.7 block
  covers surviving a provider: a 429 absorbed and answered on the retry, with
  the visitor's stream showing meta → claim → done exactly as on a first-try
  answer (nothing was shown, so nothing was lost); the policy giving up after
  its attempts and letting the provider's OWN error through, no assistant row
  written; a 401 attempted ONCE, where a second call would have thrown the
  mock's script-exhausted error; the platform fallback answering after the
  primary spent all three attempts, with the transcript naming the model that
  ACTUALLY answered (crediting the configured provider for a standby's answer
  would make the by-model metrics quietly wrong); the FIRST provider's error
  rethrown when the fallback fails too; the fallback never reached when the
  primary simply answered; and an abort landing mid-backoff stopping the
  retry that would have succeeded. The M8.4 block covers the deadline
  (§3.15.6) with a HANGING provider — one that resolves only when its
  signal aborts, which is what a real fetch does against a quietly held
  socket: cut off at a 60 ms test deadline with a `TimeoutError`, called
  exactly ONCE (a deadline abort is never retried), the question kept and
  no assistant row; a generous deadline invisible on the happy path; and
  the platform fallback NOT consulted after the deadline — the composed
  signal's case, where checking only the visitor's own signal would spend
  tokens on an answer nobody will be shown. The M5.2 block
  covers what an answer cost: the provider's reported usage landing on the
  row verbatim, the RETRY summing both attempts (recording only the
  successful one would make schema violations look free, which is exactly
  backwards), and the two silences staying NULL rather than becoming a
  zero the cost metric would average in as free — a provider that reports
  no usage, and a gate refusal that ran no model.
- `routes/__tests__/widgetDeadline.test.ts` — DB-gated (M8.4), its own file
  with its own app instance for widgetByo's reason: the deadline under test
  is 120 ms, and configuring it on the main suite's shared app would put
  every chat case under it. Drives the real HTTP hop: a hung provider's
  stream CONCLUDES at the deadline (elapsed asserted, where the behavior
  this replaces would sit until vitest's own timeout) as meta → one opaque
  `{type:"error"}` with no other key, the provider called once, the
  question persisted, no assistant row.
- `ingest/__tests__/worker.test.ts` — DB-gated. M7.6b replaced the case that
  asserted an upload job fails ("uploads are not crawlable") with the two
  that now hold: an UPLOAD ingested end to end from its stored extraction —
  under a crawler that THROWS if it is called, since the only proof an upload
  never touches the network is a crawler that cannot be used silently — with
  the document named by the FILE, the chunks carrying the heading trail the
  stored SPANS reconstructed (proof the blocks survived Postgres as structure
  and not merely as text), every chunk's text a slice of the stored text, and
  one embedding per chunk; and an upload source whose `source_uploads` row is
  MISSING failing loudly rather than being treated as a crawl that found
  nothing, which would soft-delete the document. Its fixture builds the spans
  with the real parser rather than by hand — the first attempt computed them
  by eye and put the `# ` marker inside the heading, which the markdown
  parser excludes by design, so the heading trail came out wrong. **Run-book note: bring up
  ONLY the compose database (`docker compose up -d database`) for test
  runs.** A running realtime container polls this same Postgres with its
  ingest worker and can adopt a job the suite just requeued — the
  stop()-requeue test then fails on the park update's CHECK. DATAFLOW §6
  prescribes database-only for exactly this reason; it bit for real once.
  The first suite where the
  ENTIRE pipeline runs against real Postgres and a real (loopback) site,
  through three crawls of a two-version fixture: initial ingest (documents,
  chunks with heading paths, embeddings, statuses), identical recrawl
  (zero embed calls — the content_hash short-circuit observed, not
  assumed), changed recrawl (chunks replaced, vanished page soft-deleted).
  A fourth crawl is the M3.6b case and the one that would silently rot
  without it: the same page, byte-identical, re-crawled while the org's
  resolveEmbedder returns a DIFFERENT model — every chunk must come back
  under the new model and dimension, the app-level embedder must not be
  touched, and the resolver must have been called once with this job's
  org id.
  Queue semantics get their own tests: two workers claiming concurrently
  under SKIP LOCKED (held open by gated fake crawlers), stale-lease
  reclaim on both sides of the attempts cap, stop() requeuing between
  pages, crawl failure and upload-source failure paths. M7.5 adds two: the
  lease RENEWED by the pages that land after the claim (a gated crawler
  holds the job at its gate so the as-claimed `locked_at` can be read, then
  the pages flow and the row's `locked_at` must be later), and the skipped
  record — a scripted crawl yielding one dead link, more robots.txt
  refusals than the row keeps, and two pages, after which `skipped_count`
  is exact, `skipped_pages` holds exactly `MAX_RECORDED_SKIPPED_PAGES`
  entries in event order with the dead link first, and the third real crawl
  of the fixture (which drops the vanished page's LINK as well as the page)
  records nothing skipped, because vanishing by absence and vanishing by 404
  are different stories.

### §3.9 `realtime/Dockerfile`

Multi-stage on node:22-alpine, **build context = repo root** (shared/ must
exist inside the image). `deps → dev → build → prod`, plus a `widget`
stage since M2.7: the widget bundle builds inside the image and lands at
/app/widget/dist, because this service is the bundle's origin fallback
(§3.20) — its own stage so widget changes and realtime deps don't bust
each other's layer caches. Prod runs
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
zeros) are deliberately _not recognized_ rather than normalized, since
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
carry a custom agent. Every request identifies itself:
`USER_AGENT_PRODUCT` (`InterrelatedBot`) is the crawler's product token —
exported since M7.5 so robots.ts matches groups against the very token the
header carries — and the full header adds the conventional `(+url)` a site
operator can follow to learn what the bot is; robots.txt is only useful to
someone who knows whom to name.

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
- `pdf.ts` — real since M7.6; its own section, §3.10.7, because the
  decisions in it are about a dependency and a binary format rather than
  about markup. (Until then this bullet recorded a deliberate ABSENCE: a
  `pdf-parse` implementation built at M1 and removed on review, because no
  caller could supply a PDF and the dependency cost 21 MB. The detection
  that remained — magic bytes, then media type — is unchanged and is now
  what routes a PDF to a parser instead of to a refusal.)
- `index.ts` — decode + dispatch. Detection in trust order: magic bytes
  (`%PDF-`, unfakeable) → declared media type → URL extension → sniff →
  markdown as fallback (it degrades to plain-text paragraphs; the HTML
  parser would strip nothing). Decoding
  strips the BOM and normalizes CRLF→LF BEFORE any parser runs, so server
  line-ending churn can never change a content_hash — and a PDF skips
  decoding entirely, taking the raw buffer, because it is bytes rather
  than text and a charset applied to one would corrupt it.

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

Since M7.5 the crawler honors robots.txt (§3.10.6) on every fetch but its
own. Same-origin scope means ONE file governs a whole crawl, so it is read
once, FIRST — before the root, through the same guarded client — and every
URL is checked against it: the root, each discovered link (at DISCOVERY, so
a disallowed link costs no fetch and no queue slot and is reported exactly
once), each sitemap entry (refused entries are announced and left OUT of the
plan, so the progress the dashboard shows counts only pages that will be
fetched), each child sitemap, and the FINAL url of a redirect (the fetch was
spent — safeFetch follows hops internally — but the content is not kept:
robots.txt speaks about the URL that answered). A disallowed root, or a
disallowed sitemap file, is a source failure whose text names the rule —
"nothing crawlable — disallowed by robots.txt (User-agent: *, Disallow: /)"
— before a single page is spent; a disallowed link is a third event kind,
`skipped`, distinct from `error` because it is not a failure of anything
(the site asked, the crawler listened) though both land in the same per-job
record (§3.10.5). An UNREACHABLE robots.txt (5xx, or a request that never
produced a status) refuses the crawl the same way, with the status in the
sentence, because RFC 9309 says so and because a crawl of zero pages that
"worked" would hide it. Crawl-delay is honored — the effective delay is the
larger of the crawler's own politeness delay and the site's request — up to
`DEFAULT_MAX_CRAWL_DELAY_MS` (5 s): the directive is not in the RFC, most
crawlers cap it, and "Crawl-delay: 3600" taken literally would run a
100-page crawl for four days; at the cap a full crawl is ~8 minutes, which
is why the worker renews its lease per page. Requests are PACED through one
helper (`pace`) so sitemap fetches wait their turn like pages do; a
redirect's hops are one logical request inside safeFetch and are not paced.

#### §3.10.5 `src/ingest/worker.ts`

The queue consumer that ties the pipeline together; runs IN-PROCESS (a
separate worker service was rejected: Render's free tier funds one
instance, and the throughput ceiling is embedding rate limits, not CPU).
Scheduling since M3.6: `pollMs > 0` is the dev-compose mode (chained
setTimeout loop, as always); **`pollMs: 0` is WAKE-DRIVEN, the production
mode** — one tick at start() (catches jobs stranded by a deploy), then
the worker is fully idle until wake(), which the internal enqueue route
calls. A wake landing mid-tick is REMEMBERED (one follow-up tick), never
dropped — in wake-driven mode there is no poll to catch a missed one.
The Neon arithmetic that forces this: any repeating poll short enough to
be useful holds Neon's compute awake against the ~100 CU-hour monthly
budget; zero timers means the database sleeps precisely when the product
is idle. The claim is one atomic UPDATE over a `FOR UPDATE SKIP LOCKED`
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

Since M3.6b the embedder is per-ORG, not per-process: `resolveEmbedder`
(injected, so the worker stays testable without the vault; server.ts
wires it to §3.21's resolve.ts) is called ONCE per job — a rotation
landing mid-crawl would otherwise split one source's pages across two
vector spaces, half of them invisible. A decrypt failure fails the job
loudly rather than falling back, because ingesting under the wrong model
is the outcome worth avoiding. That change also gave the recrawl
short-circuit a SECOND condition: unchanged text is only enough if the
document's chunks already carry vectors under THIS job's model. Without
that, a tenant switching embedding providers would re-crawl a
byte-identical site, skip every page, and be left with a corpus the dense
arm can never see again — the re-index (§3.22) would be a no-op. The cost
is one indexed EXISTS per unchanged page; the alternative is a widget
that silently stops answering.

Since M7.6b the worker also ingests UPLOADS, and does it by producing the
crawler's own event stream: `#uploadEvents` reads the stored extraction
(§3.3.11) and yields one `plan` and one `page`, so an upload is a crawl of
exactly one page whose fetch is a database read. That shape is the point —
everything below the branch stays unchanged, so progress, lease renewal, the
vanished-document sweep, the status transitions and the failure path all work
on an upload for free, and there is no second ingest path to keep in step
with this one. Blocks come back as spans and their text is SLICED out of the
stored text, so the parser contract holds on the way out as on the way in. A
missing `source_uploads` row throws rather than yielding nothing: the route
writes both in one transaction, so one without the other is a broken
invariant, and treating it as a crawl that found nothing would soft-delete
the document and leave a tenant a source that reads ready and answers
nothing.

Since M7.5 the worker also records what a crawl left OUT, and renews its
lease as it goes. Every `skipped` (robots.txt) and `error` (dead link,
off-origin redirect, unparseable body) event increments the job's
`skipped_count` and, up to `MAX_RECORDED_SKIPPED_PAGES`, appends
`{url, reason}` to its `skipped_pages` (§3.3.10) — the crawler's sentence
verbatim, so the dashboard shows "disallowed by robots.txt (User-agent: *,
Disallow: /private/)" rather than a paraphrase. Until then those events
were console.warn lines a tenant could never see; page errors are still
logged, since a burst of them is an operational signal, while robots skips
are not (nothing was fetched, and the record is the point). The columns are
written by ONE progress UPDATE per fetch that produced something to say — a
page landing or a page failing — and that same UPDATE sets `locked_at =
NOW()`: the stale-lease reclaim measures staleness from the last renewal
rather than from the claim, so a crawl that is slow because it is polite
(a Crawl-delay at the cap makes a full crawl ~8 minutes, against a
10-minute stale window) can never be requeued by a second worker while it
is making progress — the property that keeps "a second worker is a deploy,
not a rewrite" true. A page robots.txt now closes is soft-deleted with the
other absent pages, by the same rule: the site said not to keep it.

#### §3.10.5a Surviving a metered embedding provider (M9)

The worker's embed calls are wrapped in §3.15.5's `withRetry` under a
PATIENT policy — 8 attempts inside a 5-minute waiting budget, 2s base,
60s ceiling — and the reason is a defect the deployed demo made
unmissable rather than a precaution.

A hosted free tier meters embeddings **per ITEM per minute** (§7.9 records
Gemini's batch endpoint metering per item, not per request), and one
documentation page can hold more chunks than that minute allows. Until
M9 the loop had no retry at all, so the batch that crossed the line threw,
the page failed, and the whole JOB failed — and because the recrawl
short-circuit works at PAGE granularity, the next attempt re-embedded that
same page from its first chunk and died at the same place. Not a slow
ingest: **a page that could never be ingested at all.** It was measured on
the live deployment as three consecutive rounds of byte-identical failure
with zero forward progress, while the identical call from the same machine
with the same vault-resolved credential succeeded on demand — which is what
proved the fault was the loop rather than the key, the quota, or the
adapter.

Two properties make the fix work where a naive one would not. The retry
resumes **the batch that failed**, so each attempt is cheaper than the last
rather than re-spending the page's earlier items; and the WAITING BUDGET
keeps it honest — a page that cannot embed inside five minutes of waiting
fails loudly with the provider's own error rather than holding the queue's
single worker forever.

**What a retry cannot fix, measured the expensive way (M9).** Gemini's
free tier meters embeddings at
`EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier` = **1,000
per DAY**, and **a REFUSED batch still bills its items** — the arithmetic
that proves it is a day in which 27 embeddings were successfully stored
and the 1,000-item bucket was nevertheless exhausted, the balance spent
entirely by 429'd attempts. So on this provider a retry storm is
self-defeating: every attempt to absorb the limit brings the daily wall
closer. Two consequences the product lives by. Retrying is still right for
a TRANSIENT refusal (that is what the policy above is for) but the bound
that matters is the daily one, which no backoff can outwait. And bulk
embedding must **pace itself UNDER the limit rather than discover it** —
which is what `scripts/embedExistingChunks.ts` does at ~80 items/minute
against the tier's ~100, spending exactly one item per chunk. The same
fact explains a limit §7.9 records from the other side: the batch endpoint
meters per ITEM, so batching buys round-trips, never quota. The policy deliberately differs from the answer
path's (3 attempts / 8 seconds): §3.15.5's is set by how long a visitor
watches a chat bubble, and nobody is watching an ingest — the same
division of labor §3.14 made for the eval harness against this identical
provider behavior, from the other side.

#### §3.10.6 `src/ingest/robots.ts`

The Robots Exclusion Protocol (RFC 9309), parsed and applied — hand-written
for RRF's reason (§2.4.3): the whole protocol is a few pages of RFC and the
decisions worth pointing at in code are the ones a dependency would hide.
Each is implemented where the file cites the section:

- **Which group applies (§2.2.1).** The user-agent value is a PRODUCT TOKEN
  (letters, `_`, `-`; "InterrelatedBot/0.1" names InterrelatedBot), matched
  case-insensitively against `USER_AGENT_PRODUCT` from safeFetch — the very
  token the request header carries, imported rather than retyped so a site's
  rule for us can never apply to nobody. A run of consecutive user-agent
  lines is ONE group; any other line ends the run, so the next user-agent
  line starts a fresh group; rules before any user-agent line belong to
  nobody. Every group naming our token is MERGED into one; failing that,
  every `*` group; failing that, no rules — and a group naming us
  specifically REPLACES the wildcard's rules rather than adding to them,
  which is what naming a crawler in robots.txt is for.
- **Which rule wins (§2.2.2).** Among matching rules the most specific — the
  most octets — wins, and an Allow beats a Disallow of the same length. An
  empty `Disallow:` (the idiom for "everything allowed") is a rule that
  matches nothing and is simply not kept.
- **How a path is matched (§2.2.3).** `*` matches any run and a TRAILING `$`
  anchors; anything else is a prefix. Matched by the classic two-pointer glob
  rather than a compiled RegExp on purpose: a pattern is untrusted text from
  a fetched file, and `/*a*a*a*a*b` against a long path sends a backtracking
  engine exponential where the loop is bounded by pattern × path — a test
  runs exactly that pattern against a 5,000-character path and asserts it
  answers in milliseconds. Both sides compare in PERCENT-ENCODED form:
  non-ASCII is encoded (UTF-8, uppercase hex — what `new URL()` already does
  to a pathname, applied to patterns too so "/café" in a file matches the
  "/caf%C3%A9" a browser requests), escapes of UNRESERVED characters are
  decoded ("%7Efoo" and "~foo" are one resource), remaining escapes have
  their hex uppercased ("%2f" = "%2F"), and reserved characters stay as
  written ("/a%2Fb" and "/a/b" are different paths). The query string is
  part of what is matched.
- **What the fetch's outcome means (§2.3.1).** 2xx: parse (safeFetch follows
  up to five redirects first — the RFC's "SHOULD follow at least five").
  3xx it would not follow, and every 4xx: UNAVAILABLE, "the crawler MAY
  access any resources" — the common case for a small docs site. 5xx, or a
  request that never produced a status (network, timeout, DNS, the SSRF
  guard, the 512 KiB size cap): UNREACHABLE, "the crawler MUST assume
  complete disallow" — fail-closed, and visibly, since the crawler turns it
  into a source failure that names the cause.
- **What it deliberately does not do, and says so.** `Sitemap:` lines are
  ignored (a "url" source follows links; a "sitemap" source names its own
  file). Crawl-delay — not in the RFC — is REPORTED, never applied here: how
  much of it to honor is the crawler's decision (§3.10.4). No cache across
  crawls: the file is re-read per job, rarer than the 24 hours the RFC
  allows a copy to live.

The verdict a refusal carries is a self-contained clause the crawler passes
on verbatim and the dashboard shows: "disallowed by robots.txt (User-agent:
*, Disallow: /private/)" names the rule that decided it; an unreachable
file says so and why nothing may be fetched.

#### §3.10.7 `src/ingest/parsers/pdf.ts`

The format the pipeline refused until M7.6, and the one the M1 review was
right to defer: a PDF parser is the largest third-party surface in the
ingest path, and back then nothing could hand the product a PDF. Both facts
changed, and the file records how.

**The dependency.** `unpdf` — a serverless-shaped build of Mozilla's pdf.js,
2.1 MB unpacked with no dependencies of its own — against `pdf-parse`'s
21 MB and its `pdfjs-dist` + native-canvas pair. Loaded by DYNAMIC IMPORT
(the providers/ rule, §2.4.5c), so a stack that never meets a PDF never
pays for it and every module that imports the parser layer stays importable
everywhere; the module promise is cached, so a hundred-PDF crawl loads it
once, and a failed load resets it rather than poisoning the process.
Hand-writing an extractor was never on the table, for htmlparser2's reason
(§3.10.3): PDF is a thousand-page specification with compression,
encryption, fourteen standard fonts and a dozen text-positioning operators
— infrastructure, not this project's technical content.

**Two mechanical facts about pdf.js**, both learned from it failing rather
than from the documentation, and both load-bearing:

1. It TRANSFERS (detaches) the array it is given — after the first call
   `bytes.byteLength` is 0 and the next one throws `DataCloneError`. So the
   document is opened ONCE into a proxy and the title and the text are both
   read from that proxy. A parser that passed its caller's buffer straight
   through would work on the first page of a crawl and fail on the second;
   a test calls it twice on one buffer to keep that fixed.
2. A Node Buffer is a view into a shared pool, which cannot be transferred
   at all — so the bytes are copied into a standalone array first.

**The offset contract holds by construction**, as it does for HTML: layout
is not text, so there is no source to point into and the extraction IS the
canonical document — the blocks are literally the slices this file
assembled. Lines are GROUPED into paragraphs rather than emitted
individually, because the chunker joins the blocks it packs with a blank
line, and one block per line would blank-separate the halves of every
wrapped sentence — in the embedded text and in the verbatim quote a
citation has to contain. What that means in practice was MEASURED: pdf.js
emits no blank line between rows however large the vertical gap, so a page
normally becomes exactly one block, which the chunker then splits at
sentence bounds. Whitespace is collapsed before the text is assembled, so
kerning runs and table columns cannot change a `content_hash`.

**What it refuses, and why each refusal is a sentence rather than a
silence.** Not a readable PDF; password-protected (told apart by pdf.js's
own exception name, because that one a tenant can actually fix); larger than
10 MB; and — the case worth naming — a PDF with no text layer, which is a
SCAN whose content is pixels. Returning an empty document there would store
a source that answers nothing and says nothing about why, so the parser
refuses with a sentence naming OCR, which the crawler records against the
page (§3.10.5) and the dashboard shows (§9.9). This is exactly the clause
parsers/types.ts reserves for "formats with real integrity checks".

**Two honest limits, stated rather than pretended away.** A PDF gets no
heading trail: headings in a PDF are a font-size convention rather than a
structure, and inferring them would be a heuristic with silent failure
modes, so its chunks carry `heading_path = null` and are found by their
text. And the 10 MB cap bounds the INPUT, not the WORK — a small PDF
crafted to be pathologically slow still occupies the single ingest worker
while it parses, bounded only by the crawl's attempts cap. Bounding input
is the cheap half of that problem and the half that can be tested; the
other half is a second worker's job, and this codebase has one worker
(§10.4's honest note about the socket applies here too).

`SKIP_EXTENSIONS` in the crawler dropped `.pdf` in the same change: the
filter exists to not SPEND fetches on formats no parser handles, and a
datasheet or policy PDF linked from a docs site is now exactly the content
a support answer needs.

Proven against a real document, not only fixtures: RFC 9309's own PDF (12
pages, 177 KB, from the RFC Editor's toolchain — compressed streams,
embedded fonts, an xref stream) crawled from the dashboard into one
document titled from its Info dictionary, 12 chunks, 12 embeddings, and
retrievable through both arms. `unpdf` also loads and extracts inside the
shipped prod image, which is the failure a dual ESM/CJS package behind a
dynamic import would otherwise save for production.

#### §3.10.8 The upload path (`POST /internal/orgs/:orgId/sources/upload`)

The surface the crawler was never going to provide (M7.6b). It lives on the
internal API (§3.22) because the dashboard is its only caller, and it is
described here because what it does is ingest.

**Raw bytes, not multipart.** The dashboard has already parsed the browser's
FormData (Next does it for a Server Action), so what it holds is a buffer and
a name; asking it to re-encode that as multipart so this side could decode it
again would add a body-parser dependency to a service with three, each of
which earned its place — to move one string. The filename rides a header,
percent-encoded because header values are latin-1 and filenames are not, and
any path is stripped from it: a filename here is a LABEL (it becomes
`documents.url`, which is what a citation from an upload shows), never a
location. The body's content type is always `application/octet-stream`, and
that is load-bearing rather than lazy — app.ts mounts `express.json` at 64 KB
across every route, so a customer's `.json` upload announced as
`application/json` would be claimed and refused by THAT parser before this
route ran; the browser's claim about the type travels in its own header,
where detection treats it as one input among several.

**The parse happens in the request**, and that is the decision worth
defending. It could have been the worker's job. But a parser's refusals are
the most useful thing this route produces — a scan named with OCR, a
password-protected file, bytes that are not a PDF — and they are worth the
most at the moment the tenant pressed Upload with the file still in front of
them, not minutes later on a row that says failed. Parsing is also the cheap
half: CPU, bounded by the size cap. What stays queued is EMBEDDING, which is
external network measured in minutes for a large file — and the dashboard
runs on Vercel, whose functions cannot hold a request open that long. So the
split falls exactly where the control-plane/data-plane split already falls.

The size cap is 10 MB, the PDF parser's own number (§3.10.7 already
anticipated "the upload route has its own"), so one cap governs and a tenant
can never be told two different limits. `express.raw`'s refusal is invoked by
hand so its 413 is JSON like every other refusal here, and it fires BEFORE
any parsing — a PDF parser decompresses, so refusing an 11 MB body after
parsing it would have already done the expensive thing, which is what the
security probe's oversized case asserts (§6.3). A file that parses to nothing
is refused too: a source that reads "ready" and answers nothing is the state
a tenant cannot debug.

Then one transaction — `sources` (kind 'upload', location the filename,
depth 0, since a file has no links to follow) + `source_uploads` (§3.3.11) +
a queued job — and `onEnqueue`, which in production IS the scheduler. The
response carries the character count, because that is the only honest answer
to "did that work?" about a file the service deliberately did not keep.

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
the way production does — the org's saved BYO credential first (§3.21's
resolve.ts, announced on stdout so the model in play is never a guess),
EMBEDDING_PROVIDER as the fallback — and warns when the org has no
embeddings under that model: the routine dev mistake is ingesting under
one provider and querying under another, which otherwise looks like
retrieval returning nothing. `npm run ask` (§3.16) resolves identically.

### §3.14 `realtime/scripts/runEval.ts`

The evaluation harness runner (`npm run eval`) — lives in realtime/ because
it drives realtime's retrieval code; the _assets_ it consumes (corpus,
golden set, scorer, floor) live in eval/ (§7). Four stages, each loud on
failure:

1. **Ingest** eval/corpus/ into a dedicated eval org — parse → chunk →
   embed → store, deliberately the same shape as the worker's page path
   (heading trail prepended for embedding, trail-free stored text) because
   the eval must measure the PRODUCTION representation. Unchanged files
   skip via content_hash, so repeat runs pay only for retrieval; the
   chunking target participates in the hash so `--target-tokens 800`
   ablation runs re-chunk despite unchanged text.
2. **Resolve** every golden anchor to chunk ids (§7.4). ANY unresolved
   anchor fails the run after a complete report — a silently shrunken
   relevant set would inflate every score.
3. **Score** dense-only, lexical-only, and hybrid over all questions
   (recall@1/5/10, MRR@10, nDCG@10, retrieval-only p50/p95), print the
   comparison table, and list every hybrid miss with its top hit — the raw
   material of RESULTS.md's failure analysis. `--sweep-ef` emits the
   recall-vs-ef_search curve as CSV instead.
4. **Enforce the floor** (eval/floor.json) on hybrid recall@5; below it,
   exit 1 and CI goes red. `--no-floor` exists for experiments; absence of
   floor.json warns (bootstrap) rather than passes silently.

The embedder is the local model by default, and since M7.12 `--embedder`
picks which REAL one is scored — the plan asks for recall "per embedding
provider", which needed a second one to exist. What is refused is unchanged
and still by name: a SEMANTICS-FREE embedder, not a remote one (the promise
made in §2.4.5b — quality measured over meaningless vectors is noise, and
refusing beats producing an impressive-looking nonsense table).

Two things landed with that flag, both because switching models is what
exposed them:

- **Jittered retry on every embed call**, the plan's risk-table instruction,
  with a PATIENT policy rather than §3.15.5's interactive one: 8 attempts
  inside a 5-minute budget, because a corpus ingest is background work where
  a visitor's three-attempts-in-eight-seconds would abandon a run that a
  30-second wait would finish. A full remote run hits a free tier's
  per-minute quota partway through the corpus; without this it simply stops.
- **The short-circuit now knows about MODELS.** Unchanged text was enough to
  skip a document, which is wrong the moment two embedders share a corpus —
  the ingest worker learned this at M3.6b (§3.10.5) and the harness never
  did. A remote run that died on a rate limit left 196 of the corpus's 661
  chunks embedded under one model and none under the other; the next local
  run skipped exactly those as "unchanged", the dense arm could see 70% of
  the corpus, and hybrid recall@5 fell from 75.0% to 46.3% — a floor
  violation whose cause was invisible in the score. Unchanged text is now
  enough only if the chunks already carry vectors under the model about to
  be scored.

A fifth mode since M2.7: `--sweep-threshold` measures the groundedness
gate's signal (via the PRODUCTION evaluateGroundedness, not a copy) on
the golden set vs eval/noanswer.jsonl (§7.6), emits the correct-refusal
vs false-refusal curve as CSV, and prints the conservative (FR=0) and
aggressive (FR=1/80) frontier points with per-category breakdowns. This
is the calibration procedure for §3.15.1's threshold — re-run per
embedding model.

### §3.15 `src/answer/` — the grounded answer pipeline (M2.3)

Question → verified claims, traced in DATAFLOW.md §5. The SSE route is
deliberately NOT here yet: it lands with widget session auth (M2.5), so an
unauthenticated LLM-spending route never reaches the auto-deploying dev
branch. Callers today: the pipeline integration tests and `npm run ask`.

#### §3.15.1 `src/answer/gate.ts`

The groundedness gate — answer-or-refuse decided BEFORE any model call, so
a refusal costs zero tokens. Carries a correction to the M1 docs worth
reading in full in the file header: the plan said the threshold cuts on
the fused RRF score, but RRF is rank-based and therefore RELEVANCE-BLIND —
every non-empty retrieval has a rank 1 scoring ~1/61, answerable or not,
so cutting on it would refuse almost nothing. The gate instead cuts on the
MINIMUM dense cosine distance across the retrieved set (min, not the top
fused hit's: fusion may rank a lexical-only hit first, and the question is
whether ANY close dense evidence exists in what the model will see). All
lexical-only retrievals fail closed — "unknown similarity" must refuse.
The default (0.34 for bge-small-en-v1.5) is MEASURED, not guessed —
M2.7's sweep over the golden set vs the adversarial no-answer set (§7.6),
chosen mid-way inside the clean answerable/off-topic separation window
with margin on both sides; the derivation, the curve, and the honest
finding (distance gates TOPICALITY; coverage gaps are the verifier's
job) are in eval/RESULTS.md. Per-embedding-model by nature;
ANSWER_MAX_DISTANCE overrides per deployment. The signal is persisted
per-answer in messages.retrieval_score so production accumulates tuning
data.

#### §3.15.2 `src/answer/prompt.ts`

Prompt assembly with the injection boundary as its organizing principle:
the system prompt is a CONSTANT (plus the org's persona — org-controlled
config, not visitor input) containing instructions and the JSON contract;
retrieved text rides in the USER turn inside <context> delimiters,
declared as data-not-instructions, because crawled pages are untrusted
input and "retrieved content never concatenates into the system prompt"
is a plan-level security rule. The static prefix is also what makes
provider-side prompt caching work later. buildRetryMessages replays the
failed exchange plus EVERY validator error — one retry, never more: a
model failing the contract twice is failing systematically, and looping
would burn tenant quota to hide a bug the schema-violation metric exists
to surface. The final-answer-only instruction exists because reasoning
models leak deliberation and TTFT is a headline metric.

#### §3.15.3 `src/answer/pipeline.ts`

The orchestration: conversation resolve (a supplied conversation id is
validated against the ORG before anything is written — cross-tenant
append is a thrown error, and the test proves it) → visitor message
persisted FIRST (a model failure never erases the question; the recency
bump rides along so failed-answer threads still surface in the dashboard)
→ embed → hybridSearch → gate → prompt → stream (TTFT measured in the
pipeline at first delta so every provider measures identically) → parse
with one retry → verify → strip → ONE transaction (assistant message +
ALL citation verdicts including stripped ones + recency bump — atomic so
an answer can never persist without its audit trail) → events. Failure
shapes are enumerated in DATAFLOW §5.2; the notable ones: gate refusal
persists refused=true with model=NULL and zero citations, total
verification failure persists refused=false with the fallback text and a
100% strip rate on record, and a double schema failure throws
AnswerSchemaError leaving no assistant row at all — which since M7.10 is
counted on the ORG's day (`usage_daily.schema_failures`, §3.3.12) before it
throws, wrapped so an instrumentation failure can never replace the error
the caller needs, because the alternative is the one provider failure mode
that would otherwise be invisible. An answer that DID land carries how many
times the model broke the contract producing it, 0 or 1. Since M5.2 the stream
collector also keeps the terminal event's token usage, and the retry ADDS
to it rather than replacing it — TTFT keeps the first attempt's value
because the visitor has been waiting since the original question, while
tokens accumulate because the tenant paid for both calls.

#### §3.15.4 `src/answer/mockResponder.ts` + `src/answer/buildLLM.ts`

The context-quoting mock responder lives in answer/ (not providers/)
because it knows the prompt format — formatChunk is the other half of its
contract and the two must change together. It is what lets every stack
and the CI e2e job drive the REAL chat route keylessly. Since M5.2 it also
REPORTS USAGE the way a real provider does — the chunker's ceil(chars/4)
approximation over the actual prompt and response, not an invented number
— so the token columns and the cost path are exercised end to end in the
keyless stacks; `mock-llm` is priced at a true 0.00 (§2.4.8), so a keyless
demo shows real token volume against an honestly free bill. buildLLM maps a
provider name to a configured instance — ONE selection table shared by
server boot (LLM_PROVIDER env) and the askDev CLI (--llm flag); a missing
key throws a one-line usage error. Since M3.5 the env selection is the
FALLBACK, not a stopgap: an org's saved BYO credential outranks it per
answer (credentials/resolve.ts), and env selection remains what keeps
every keyless stack — dev compose, prod compose, CI, the demo org —
serving grounded mock answers.

#### §3.15.5 `src/answer/retry.ts` — surviving a provider's rate limit (M7.7)

The caller's half of a division of labor providers/llm/types.ts stated from
the start: implementations throw on transport failure, and "retry/backoff
belongs to the caller" (§2.4.5d). This is that caller, and it exists because
of arithmetic rather than taste — the free tiers this product is designed
around are 30 requests/minute (Groq) and 10–15 (Gemini), one visitor question
costs one model call (two when the schema retry fires), and until M7.7 a 429
threw straight out of the pipeline and reached the visitor as the same opaque
error a real outage gives. The plan names that twice: "handle 429s with
jittered retry before failing", and the demo dying mid-recruiter-visit.

**Why a retry is safe here**, which is not true of every streaming pipeline:
nothing generated reaches the visitor until it has been parsed, verified and
stripped (§2.4.4c — the protocol is claim-granular precisely because a claim
is the smallest unit that may be shown). A call that dies half-streamed has
shown nobody anything, so discarding its partial text costs only tokens. A
pipeline that forwarded raw deltas could not retry without double-rendering.

**What is not retried**, and why each is a configuration fact rather than
weather: a 401 is a wrong key, a 400 a malformed request, a 404 a model that
does not exist — each will be just as true in two seconds, so retrying only
spends the visitor's patience to reach the same failure. Retried: 429, 408,
5xx, and non-abort transport errors (a dropped socket, a DNS blip), which is
the class retries were invented for. An abort is never retried at all — the
visitor closed the tab, and stopping the spend is the whole point.

**The budget is WALL-CLOCK, not just attempts**, and that is the rule that
matters most. A provider may answer `Retry-After: 60`, and honoring it
literally would hold someone on a spinner for a minute to then maybe fail
anyway; so a wait that does not fit the remaining budget is not taken and the
call fails NOW with the provider's own error — strictly better information,
strictly sooner. Three attempts and 8 seconds of total waiting are product
judgments about how long a person watches a chat bubble, which is why they
are named constants rather than numbers inside the loop. Backoff is 250 ms
base with FULL jitter (`random() × exponential`, not `exponential ± a bit`)
capped at 4 s: full jitter is what actually spreads a herd, since the tighter
variants leave every client waiting roughly the same time and re-colliding.
The sleep and the random are injectable, so the arithmetic is pinned by tests
that run in milliseconds — §3.17.2's stance that rate math verified with real
sleeps is rate math unverified.

The pipeline wraps THREE calls in it: the query embedding (a rate-limited
third party too, and the cheapest failure in the pipeline to absorb) and both
generation attempts. Two different retries therefore stack, and they answer
different failures — `withRetry` absorbs a provider that REFUSED the call, so
nothing was generated and nothing is thrown away, while the schema retry
(§3.15.2) absorbs a provider that ANSWERED and broke the contract, costs a
full generation, and is capped at exactly one for that reason. Confusing them
would either burn a tenant's quota re-asking a model that is failing
systematically, or lose a question to a rate limit a 250 ms wait would have
cleared.

**The platform fallback, and the line it must not cross.** `LLM_FALLBACK_
PROVIDER` names a SECOND provider, tried once after the first has spent every
attempt — no retries of its own, because by then the visitor has already
waited out a whole budget and spending another on a vendor that may be
equally unwell turns a slow answer into an abandoned tab. If it also fails,
the FIRST provider's error is what rethrows: the primary is the configured
path, so "Groq said 429" is the finding and the standby's failure is a
footnote that gets logged. And the rule that makes the feature safe is
enforced at the ROUTE (§3.18), not here: **it is a fallback for the
PLATFORM's provider only, never for a tenant's.** An org that saved a
credential chose a vendor, a model, and a data processor; answering their
visitor from our key on a different service would send their customers'
questions somewhere they never agreed to, bill us for it, charge it against
the wrong quota, and change the answer's quality profile silently. A
transient 429 does not justify any of that — an honest failure does less
harm. What the fallback exists for is the demo: one always-on service on free
tiers, where a daily cap on our own key is exactly the plan's "the demo dies
mid-recruiter-visit" risk.

**A bug the live run caught and the suite did not**, recorded in the
tradition of loadtest/RESULTS.md and §6.3. The pipeline persisted
`llm.model` — the CONFIGURED provider — regardless of which one actually
produced the text, so an answer the fallback generated was filed under the
primary's name, which would have made the by-model metrics (§9.13) attribute
latency, tokens and cost to a model that never ran. The pipeline test for
exactly this assertion was GREEN, because both providers in it were
`MockLLMProvider` and both therefore reported `mock-llm`: the assertion could
not distinguish pass from fail. It surfaced the first time a real run put two
DIFFERENT providers behind it (a loopback Ollama that only ever answers 429,
with the mock as the standby), where the transcript said `fake-retry-model`
for an answer the mock wrote. The fix is one variable — `answeredBy`, moved
only by the fallback path — and `MockLLMProvider` now takes a `model`
override so two mocks in one test can be told apart, which is what makes the
assertion able to fail.

**One thing deliberately NOT changed**, and it is worth stating because the
plan's sentence mentions it: a provider failure the policy cannot clear still
reaches the visitor as §3.18's single opaque `{type:"error"}` event, not as a
distinguishable "we are rate limited" state. The user-visible "one moment"
state the plan asks for already exists for OUR limits (the widget maps a
bucket 429 to it, §8.1); making the PROVIDER's state visible would weaken a
deliberate trust-model property — failure detail on a public stream is
reconnaissance — to say something the visitor can act on no differently.

### §3.15.6 The answer deadline (M8.4) — the bound the retry policy cannot be

Sixty seconds, wall-clock, on the WHOLE answer — embed, retrieve, generate,
the schema retry included — enforced in pipeline.ts as `AbortSignal.timeout`
composed with the visitor's own signal via `AbortSignal.any`, so both aborts
travel one wire through every provider call. It exists because §3.15.5's
policy only runs when a call FAILS, and the failure M8.3 measured is a call
that never does: a provider accepted the connection and produced its first
token after 310 seconds, held open because Node's `fetch` has no default
timeout, `postStream` passes only a caller-supplied signal, and the only
abort on the whole path was the visitor closing the tab. No retry budget
ever started counting, because nothing ever went wrong.

The number is bounded on both sides by measured facts, stated at the
constant (`DEFAULT_ANSWER_DEADLINE_MS`): below, the free tier's TTFT p95 of
27.9 s doubled by the one schema retry is ~56 s, so a tighter deadline would
cut off answers the provider was actually going to deliver; above, nobody
watches a chat bubble for a minute, so a longer one only spends the tenant's
tokens on answers nobody reads. Killing mid-stream is safe for the retry
policy's own reason — nothing generated reaches the visitor until verified,
so an aborted stream has shown nobody anything.

Five consequences, each pinned by a test or carried by an existing rule:

- **A deadline abort is a `TimeoutError`, which retry.ts's `isAbort` already
  classifies as never-retryable** — the composition needed no change there,
  and the pipeline test proves the hung provider is called exactly once.
- **The platform fallback checks the COMPOSED signal**, not the visitor's:
  a deadline that has passed is a visitor already gone, and running the
  standby then would spend tokens on an answer nobody will be shown — the
  one place where checking only `options.signal` would have been a bug.
- **The route keeps its OWN controller** (§3.18) precisely so its catch can
  tell the two aborts apart: a visitor who left gets silence, while a
  deadline fired mid-answer leaves someone still staring at the stream —
  they get the ordinary opaque `{type:"error"}` event (a deadline is a
  provider fact, and provider facts on a public stream are reconnaissance),
  and the widget recovers their input. `widgetDeadline.test.ts` drives that
  end to end: meta → error, stream concluded, question kept, no assistant
  row.
- **A deadline can never kill an answer that already arrived**: only
  provider calls consult the signal, so the persist step runs to the end.
- **The signal only ever aborts waiting-on-provider work**, so the question
  is already history (persisted before retrieval) on every deadline path.

`ANSWER_DEADLINE_MS` overrides per deployment, and — unlike
`WIDGET_DAILY_ANSWER_CAP`, which may only tighten — in EITHER direction: it
is an operational bound with no cross-layer contract to break, a deployment
fronting a slow self-hosted model legitimately widens it and a demo
legitimately tightens it. It is guarded POSITIVE at boot where its siblings
are not, because its zero is uniquely destructive: `AbortSignal.timeout(0)`
fires before the first provider byte, so a mistyped "0" would be an outage
wearing a configuration's clothes. What the deadline deliberately does NOT
do is become visible to the visitor as anything but the ordinary failure —
§3.15.5's last paragraph applies unchanged. The CLIs name it on their side
of the trust line: `npm run ask` prints which timeout fired, and the compare
harness's slow-answer note now reports against the deadline instead of
reporting that nothing exists.

### §3.16 `realtime/scripts/askDev.ts`

Dev-only CLI (`npm run ask -- "<question>" [--org N] [--conversation
con_…] [--llm mock|groq|gemini|ollama|anthropic] [--tamper]`): the full M2 loop
drivable by hand. Same glue-only rule as the sibling CLIs. The default
LLM is the mock in responder mode (§2.4.5e): it parses the [chunk …]
blocks out of the prompt it actually receives and quotes the top chunks
verbatim — grounded by construction, so verification passes and
persistence/citations/events are all observable keylessly. `--tamper`
corrupts one quote so the strip path is observable too: the tampered
claim is stored quote_not_found and never displayed. `--llm` swaps in a
real provider (§2.4.5f–i, and §2.4.5n since M7.8), configured by the
GROQ_/GEMINI_/OLLAMA_/ANTHROPIC_ vars in .env.example — the first place
real model output meets the verifier, ahead of the M2.5 route; `anthropic`
is the one choice that spends money on every run, having no free tier, and
the file says so where the flag is documented. A missing key is a
provider 429 prints as a human sentence with the retry delay. Since M5.2
it prints the answer's token counts and their list-price cost too — the
cost metric drivable by hand — and distinguishes "not reported by this
provider" from "unpriced model", which are different silences (§2.4.8).

### §3.26 `src/usage/daily.ts` — the counters, written and read (M5.3)

Three functions over `usage_daily` (§3.3.6), and the shape of each is
argued in the file. `recordAnswer` and `recordEscalation` are upserts whose
increment amounts travel in the VALUES so the conflict branch can add
`excluded` to the stored row — the numbers appear once instead of once per
branch — and both take a Kysely OR a Transaction because every caller
passes a transaction: the counter is incremented alongside the row it
counts, so the two cannot disagree. Ten concurrent answers produce ten,
which application-side arithmetic would not; a test fires them together.
`recordEscalation` is called ONLY where a handoff row was actually created
(§3.23), because a visitor mashing the button must not inflate the number
the deflection rate is measured against.

`getDailyQuota` is the read the chat route makes before every question: one
LEFT JOIN from `organizations` to today's counter row, both sides
primary-key lookups, returning the plan, what has been spent, the effective
limit, and whether it is exceeded. A missing counter row is a quiet day —
0, not an error. The deployment override can only TIGHTEN the plan's cap
(the effective limit is the minimum of the two), which is the direction
that fails safe: one mistyped environment variable must not be able to hand
every tenant on every plan an unlimited allowance, and a test pins both
directions.

`recordSchemaFailure` (M7.10) is the third writer, and the odd one: its
siblings are called inside the transaction that writes the row they count,
because a counter that could disagree with its rows is not a counter. This
one has no row to agree with — it counts a question that produced NO answer
because the model broke the JSON contract twice — which is precisely why it
exists, since `messages.schema_violations` cannot record an outcome that
wrote no message. It is deliberately NOT added to `answers`: that counter is
the quota's denominator, and charging a tenant's daily allowance for a
question the product failed to answer would let a misbehaving model burn a
customer's plan.

`utcDay` owns the day boundary that the widget route's `utcDayStart` used
to compute inline, so exactly one function decides what "today" means for
the quota.

### §3.27 `realtime/scripts/seedSecurityFixture.ts` (M6.1)

Dev/CI CLI (`npm run seed-security -- --out <fixture.json>`): seeds the two
probe organizations the security and injection probes attack and writes
what they need to know as a JSON fixture — the CONTRACT between this script
and scripts/security-probe.mjs / scripts/injection-probe.mjs, documented
once at the top of the file. Per org: a live pk and a REVOKED one (created
live, then revoked — the rows a real rotation writes; `revoked_at` is
update-only in the schema types because a key is never born revoked, and it
is set with Postgres's `NOW()` rather than a `new Date()` from the seed
process because NOW() is what the session route compares against and a
container clock behind the host would otherwise leave the "revoked" key live
for the width of the drift; since M7.1 the dashboard performs rotation
itself, §9.17, but the e2e stack has no dashboard, so the fixture writes the
same rows with the window already over), since M7.3 a live SECRET key and a
revoked one (stored as the dashboard stores them — hash and suffix, never
the value; the plaintext travels in the fixture because it is a throwaway,
and the revoked one is written FIRST because 007 allows one current secret
per org), one
allowlisted origin, and a small corpus stored one-document-per-chunk so a
probe can say "this citation must point at THAT url". The two corpora share
no vocabulary, so a cross-tenant retrieval hit could never be excused as
topical overlap. Under the MOCK embedder always: the probes measure the
trust model, not retrieval quality, and exact-match retrieval is what makes
"ask this sentence, expect this citation" deterministic — which is also why
the embedding input is trail-free, for seed-demo's reason (§3.19).

Two more fields serve later steps: `credentialCanary`, a fake provider key
encrypted exactly as the internal API would store it, present only when the
vault's master key is set (the seed invents no fallback key, for the reason
the vault has none) — the read-back probe greps every response for it. It
lives on a THIRD org, C, that never chats: a saved generation credential is
what the chat route resolves and CALLS (§3.21), so a fake key on an org that
answers questions would turn every answer into a failed call to the real
provider and break the retrieval controls. And `systemPromptMarkers`, distinctive prose lines lifted from the
REAL system prompt rather than typed into a probe, so a rewrite of the
prompt cannot leave the leak check grepping for sentences that no longer
exist. Idempotent by REPLACEMENT like seed-demo, and every key and origin
is fresh per run and travels in the fixture: a probe hardcodes nothing
about the deployment it attacks. Runs from the host against the compose dev
database, or inside the compose network as §4.4's `seed` service.

### §3.28 `src/usage/origins.ts` — the per-origin counters (M7.2)

The write side of `origin_daily` (§3.3.8): `recordOriginMint(db, {orgId,
origin, outcome})`, one upsert per mint attempt that names an org, called
from the session route (§3.18) after the allowlist check — `minted` when it
passed, `refused` when it did not. usage_daily's shape (amounts travel in
VALUES, the conflict branch adds `excluded`), with two things §3.26 never
needed because its inputs were never attacker text:

- **Shape.** `normalizeRefusedOrigin` stores a refused value as itself only
  when it looks like an origin (`looksLikeOrigin`: `^https?://[^\s/]+$`,
  ≤253 chars — exported since M7.3 so the secret-key mint route can tell an
  authenticated tenant's server "that is not an origin" apart from "that
  origin is not allowlisted") or is the literal `null` — what file:// pages
  and sandboxed iframes send, and a real thing to show a tenant. Everything
  else lands under `(malformed)`, so a script cannot fill a tenant's page
  with junk. Case is kept: a case-variant of an allowlisted origin is refused
  precisely because it differs, and the tenant should see the string that
  was sent.
- **Volume.** One org accumulates at most
  `MAX_DISTINCT_REFUSED_ORIGINS_PER_DAY` (100) distinct refused origins per
  UTC day; past that, NEW ones count under `(other)` while origins the day
  already knows keep their own row. A script forging a fresh Origin per
  request is already held to the per-IP mint bucket, but "one row per
  request" is a growth curve worth capping twice. The path is an in-place
  UPDATE first (the common case, one statement), then a count and an upsert
  for a new origin; the cap can overshoot by the handful of writers racing
  at the boundary, and the file says so — it is a bound, not a quota.

Minted origins are a plain upsert (the allowlist bounds them). The route
AWAITS the write, so the counter is visible the moment the response is — a
dashboard that lagged the widget would make "is that copy still out there?"
unanswerable — but wraps it so an instrumentation failure logs and the
visitor still gets their session; there is no mint transaction to join
because a token is signed, not stored. Missing-Origin and bad-key refusals
are NOT counted: neither names an org without a lookup the route
deliberately does not spend on requests it refuses for free.

### §3.29 `realtime/scripts/runTenantScan.ts` — what iterative scans are worth (M7.12)

`npm run tenant-scan`. The runner for §7.8's scoring, in realtime/ for
runEval.ts's reason: it drives realtime's retrieval code and needs its
dependencies, while the scoring stays a package-less module the root runner
typechecks and unit-tests.

It produces the number §3.12 had been promising since M1 and nothing
delivered. N tenants of 30 chunks go into ONE shared index; each asks for its
own five nearest rows, once with `hnsw.iterative_scan = 'relaxed_order'` and
once with it off. The published sweep is in eval/RESULTS.md: starvation
begins at 8 tenants and reaches 15 of 16 at 480 vectors, a 52.5-point recall
loss, with no measurable latency cost for the fix at this scale.

Three things make it trustworthy, and two of them are ways it was wrong
first:

- **ONE connection, with `enable_seqscan` and `enable_sort` both off.** The
  pgvector knobs are transaction-local, so on a pooled connection the SET and
  the search can land on different backends; and a seqscan is not the only
  exact route — every non-HNSW plan must SORT by distance, and at fixture
  sizes those plans sit at the planner's break-even. That is the trap that
  cost the M7.1 ladder a red run (§3.8).
- **The plan is VERIFIED per sweep point**, and a row that left HNSW is
  reported as unmeasured rather than as a finding. An exact plan sorts every
  matching row and therefore cannot starve, so its 100% would read as
  "iterative scans are unnecessary" — the most damaging way this measurement
  could be wrong. The first run had only a comment saying this mattered and
  no check implementing it, and duly reported 5/8 starved at 240 vectors
  beside 0/32 at 960: non-monotonic, and impossible if both rows had measured
  the same plan.
- **Mock embeddings, deliberately**, where the quality eval refuses them by
  name (§2.4.5b). What is under test is the FILTER, not which chunk answers
  better: uniform random directions make the discard rate depend on tenant
  count alone, while real embeddings cluster by topic and would confound it.
  A foreign row coming back would be a filtering BUG rather than starvation,
  so the harness throws on one instead of folding it into recall.

Everything it creates is deleted at the end, including on Ctrl-C, like
§10.3's load harness. Its first run also failed on a `content_hash` CHECK,
because the fixture used a label where the column requires a 64-character
sha256 — the schema holding a harness to the same rule as the product.

### §3.30 `realtime/scripts/runProviderComparison.ts` — the provider table (M8.3)

`npm run compare`. The harness half of §7.9, in realtime/ for runEval.ts's
and runTenantScan.ts's reason: it drives realtime's answer pipeline and needs
its dependencies, while the scoring stays a package-less module the root
runner typechecks and unit-tests.

It asks the first N questions of the golden set through the **real pipeline**
(`answerQuestion` — retrieve → gate → prompt → stream → parse → verify →
strip → persist), once per generation provider. Driving the production path
rather than calling `stream()` directly is the point: what the plan wants
compared is not raw model output but what this PRODUCT does with it, since
the citation-verification and strip rates are properties of that whole path.
It is also why the schema-violation count is READ BACK from
`messages.schema_violations` rather than counted privately — the published
number is then the product's own record, and M7.10's column is proven end to
end rather than asserted.

Four decisions carry it:

- **The pipeline's retry policy is left alone.** §3.15.5 sets it from a
  product judgment — three attempts inside 8 seconds, because that is how
  long someone watches a chat bubble — and widening it to flatter a free tier
  would publish a latency no visitor will ever see. The harness paces ITSELF
  instead (`--pace-ms`, default 6 s ≈ 10 requests/minute), so it stays under
  the free tier rather than manufacturing rate limits a real tenant's traffic
  would not produce; a 429 that survives the visitor's own budget is recorded
  as the `error` outcome it really is, which is how the 20-per-day wall
  appears in the table instead of crashing the run.
- **Every provider named gets a row, including the ones with no key** — the
  key-gated idiom (§3.8, §2.4.5c): `buildLLMProvider`'s one-line usage error
  is caught and printed as a SKIPPED row with its reason, because "gated off"
  silently omitted is indistinguishable from "passed".
- **One embedder for the whole sweep**, enforced rather than documented.
  Retrieval decides which chunks a model is asked to ground in, so letting it
  vary between rows would confound the comparison with the thing runEval
  measures separately. The harness refuses to start if the eval corpus has no
  embeddings under that model, naming `npm run eval` — asking questions
  against a corpus the query model cannot see would measure the gate refusing
  rather than the provider answering.
- **The raw per-question outcomes are written to
  `eval/results/provider-comparison.json`** (gitignored, like runEval's own
  droppings) BEFORE the harness deletes the conversations it created. Without
  it the published table would be summary statistics whose underlying data no
  longer exists anywhere, which is the "it works well in my testing" the
  anti-tutorial rules refuse — and it is the difference between a 310-second
  p95 being a finding and being a mystery. The first run predated this and
  duly could not name its own outlier; the report now prints the slowest
  answer and the reason nothing bounds it.

Questions are the FIRST n, never a sample: a published comparison has to be
re-runnable into the same table, and a random subset would move the numbers
between runs for reasons that have nothing to do with the providers. A fresh
conversation per question, so the prompt does not grow as the run goes on.

**Run-book note, learned the way the worker suite's was (§3.8): realtime's
DB-gated test suite cleans up organizations, the eval org among them.** So
`npm run eval` → `npm test` → `npm run compare` finds no corpus, and the
sequence to run is eval, compare, then tests — or simply re-run the eval. The
harness fails on its precondition with the exact command to fix it rather
than measuring an empty corpus, which is the one thing that would have been
expensive: every question would have been refused by the gate and the table
would have reported a provider that never ran as a provider that refused.

### §3.31 `realtime/scripts/runIngestBench.ts` — ingest throughput (M8.7)

`npm run ingest-bench`. The plan's latency list names "ingest throughput"
beside retrieval-only latency and TTFT; both of those have had committed
producers for milestones while ingest speed existed only as anecdotes
("9 pages in 4 seconds", §9.9). This is the producer, in realtime/ for its
siblings' reason (§3.14, §3.29, §3.30) — and GLUE-ONLY by §3.11's stance:
it composes the tested pieces (the worker, the crawler, the parsers, the
chunker) and adds no logic of its own to drift, which is why it has no
suite of its own where the tenant scan's scoring half does.

The shape: the committed eval corpus (31 pages, ~584 KB) served over
loopback HTTP as a sitemap source, one `IngestWorker.tick()` per row over
the real crawler (`fetchDelayMs` 0, permissive hostGuard — the worker
suite's idiom), and three rows because they answer different questions:
cold under the mock embedder (everything but embedding), cold under the
local model (the CI-real number, with the ONNX engine warmed OUTSIDE the
timed window because model load is a boot cost, not a per-crawl cost), and
an unchanged re-crawl — the §3.10.5 short-circuit as a number, with the
embedder wrapped in a counter so the zero is proven rather than assumed.
Published in eval/RESULTS.md and the README's table: **embedding is ~98%
of the wall** (215 s against 4.6 s for the same 31 pages / 661 chunks) —
§3.3.1's "the ceiling is embedding-API limits, not Postgres" as a
measurement — the pipeline itself sustains **~144 chunks/s** stored with
HNSW maintenance included, and the short-circuit is worth **216×** (1.0 s,
zero texts embedded). The exclusions are printed with the table: loopback
network, politeness zeroed (production paces every fetch, plus Crawl-delay
— deliberate floors that would otherwise BE the measurement), model load
warmed away; and the local-model row is the KEYLESS stack's number, since
a hosted tier's ingest throughput is its quota (§7.9's per-item metering).

Wrongness guards, each from a sibling's scar: it REFUSES to start when the
queue holds live jobs, because tick() claims the OLDEST queued row and
suite residue would hijack the bench — the §3.8 run-book gotcha, and it
fired on this harness's very first run (a worker-test job the full suite
had left `running` against `docs.example.com`); and a run with ANY skipped
page fails loudly with the recorded reasons, because a throughput number
over a silently shrunken denominator reads fine and means nothing.
Everything it creates is deleted at the end, Ctrl-C included. Not a CI
gate, for loadtest's reason (§10.4): throughput on a shared runner
measures the runner.

### §3.17 `src/widgetAuth/` — session tokens and rate limits (M2.5)

#### §3.17.1 `src/widgetAuth/sessionToken.ts`

Trust-model layer 2. The publishable key is spent ONCE at bubble-open;
chat authenticates with a short-lived (30 min) HMAC token BINDING org +
origin + visitor. Hand-rolled compact token, deliberately not a JWT
library: the payload is four fields, the algorithm is fixed, and JWT's
flexibility — pluggable algorithms, unverified-decode APIs — is precisely
its historical vulnerability surface. Verification is timingSafeEqual on
the signature, then expiry, then SHAPE (a validly-signed but structurally
wrong payload is rejected — pinned by a test that signs malformed
payloads with the real secret); it returns payload-or-null, never a
reason, because invalid-vs-expired distinguishable to an attacker is an
oracle. The secret comes from WIDGET_TOKEN_SECRET, or an ephemeral random
one when unset/empty — correct in dev (the widget re-mints after
restart), wrong in prod (render.yaml prompts for it, sync:false); a
nonempty-but-short secret refuses to boot rather than limp.

#### §3.17.2 `src/widgetAuth/rateLimit.ts`

Trust-model layer 3 — the layer that actually bounds SCRIPTED abuse
(Origin defeats browsers; curl forges it, and the plan says so).
Classic token buckets, in-memory BY DESIGN: this deployment is exactly
one always-on instance, so a shared store would be a second stateful
service defending against a topology that cannot occur; the DB-backed
daily ceiling stays exact regardless. Injectable clock (rate math
verified with sleeps is rate math unverified), refill accrued even on
denials (a hammering client must still recover on schedule — pinned with
an IEEE-754-aware boundary test), and an opportunistic sweep of
fully-refilled buckets past 10k keys instead of a timer (no interval
handle to leak; a map only grows when traffic touches it).

### §3.18 `src/routes/widget/`

The only routes an untrusted browser ever calls, implementing the trust
model in layer order. `POST /v1/widget/session`: Origin header required
(absence means a script — no free sessions), per-IP mint bucket, pk
lookup (unknown and revoked collapse into ONE 401 — key state is not
probeable; since M7.1 "live" means `revoked_at IS NULL OR revoked_at >
NOW()`, because rotation schedules the old key's revocation at the end of
a grace window rather than on the click — §9.17 — and the comparison is
made on Postgres's clock, the one the dashboard wrote with, never this
process's), exact-match allowlist check (failures carry NO CORS headers,
so an unlisted site's browser cannot even read the error — and since M7.2
are COUNTED, §3.28: the key named the org, so the tenant gets to see which
origin presented it), then the
token mint — also counted per origin, and also the handshake that warms
Neon while the visitor types (the free-tier design's DB-warming path).
`POST
/v1/widget/chat`: token verify (uniform 401), live-Origin-vs-token-origin
re-check (kills replay from another site), rate limits AFTER auth (their
429s carry CORS so the widget can render "one moment") and BEFORE work,
then the daily ceiling — since M5.3 the org's PLAN cap (§2.4.9) against
the `usage_daily` counter (§3.26), one primary-key-shaped read instead of
a scan over the day's messages, so the most frequent query on this path
stops getting slower as the customer succeeds; refusals count, because
they still spend a retrieval, and the WIDGET_DAILY_ANSWER_CAP env can
only TIGHTEN a plan, never widen it — then SSE. Since M7.7 the route also decides whether a
platform FALLBACK provider may be used for this answer, and the rule is the
whole of the feature's safety: only when the org has NO credential of its
own. A tenant who configured a provider chose a vendor, a model, and a data
processor — answering their visitor from our key elsewhere would send their
customers' questions somewhere they never agreed to, bill us, charge the
wrong quota, and change the answer's quality silently; a transient 429 does
not justify that, and `widgetByo.test.ts` pins it (their provider 503s
through every retry, ours is never called, no assistant row is written).
Since M3.5 the answer's LLM is resolved per request
from the org's BYO credential (credentials/resolve.ts) with the
app-level provider as fallback, and since M3.6b the query EMBEDDER is
resolved the same way — not as a preference but as a requirement, since
the question must be embedded by whatever model embedded the org's
chunks; the ingest worker reads that same row, so the two cannot drift.
Headers flush before retrieval so TTFB
precedes the slow work; a closed tab aborts the pipeline mid-generation via
AbortController; since M8.4 the pipeline also carries its own DEADLINE
(§3.15.6 — 60 s default, ANSWER_DEADLINE_MS to override), and the route
keeps its controller SEPARATE from it so the catch can tell the two aborts
apart: a visitor who left gets silence, a deadline that fired mid-answer
gets the terminal error event, because someone is still watching the
stream; every failure past the SSE boundary is one opaque
{type:"error"} event (failure detail on a public stream is
reconnaissance — including hijack probes of another visitor's
conversation id, which learn nothing but "error"). CORS is hand-rolled
(~15 lines for two routes) and preflight grants nothing: enforcement
rides on the actual request's response headers.

Since M7.3 the browser mint accepts a client-supplied `visitorId` ONLY in
the anonymous `vis_<hex>` shape it mints itself (§2.4.10) — an identified
id is refused with the same 400 as a malformed one, because a browser has
no business telling the two apart — and `last_used_at` is stamped with
`NOW()` rather than this process's Date, since the dashboard shows it beside
"accepted until", which is Postgres's clock.

**`POST /v1/sessions` — the secret key's only moment (M7.3, layer 6).** The
one route in this file a browser never calls: the customer's OWN backend
presents `Authorization: Bearer sk_live_…` to mint a session for a user IT
has authenticated, and hands the token to its page (the widget fetches it
from an endpoint on the customer's site — §8.1). Same token, same chat
route, same everything after; only who proves what at the mint differs.
Order: the per-IP bucket first (60 burst / 1 per second — more generous
than the browser's because one IP here is a backend minting for many users,
and what it bounds is a flood of guesses at a secret, each costing a hash
and an indexed lookup; chat stays bounded downstream by the per-visitor
bucket and the plan quota whichever mint opened the session); then the
bearer — no `sk_` prefix (the publishable key, garbage, nothing) is refused
for its shape without a lookup, and a hashed lookup on `secret_hash` with
the SAME liveness rule as the publishable key (`revoked_at IS NULL OR
revoked_at > NOW()`, on Postgres's clock — a rotation's grace window keeps
the old secret minting until the customer has redeployed), unknown and
revoked and past-grace collapsing into the byte-identical 401 the shape
refusal gives; then the body — `visitorId` must be IDENTIFIED-shaped (the
anonymous namespace is the browser's), `origin` must be present, and the
origin must be ALLOWLISTED: the allowlist is the one statement of where the
widget may run, a server naming an unlisted origin is refused like a copied
snippet AND counted like one (layer 4 — the tenant's traffic table shows it
with an Allow button), and a value that is not an origin at all counts under
the malformed sentinel like any other. Then `last_used_at` (NOW()), the
minted counter, and the token — the same response shape as the browser
mint so the customer's endpoint can proxy it verbatim. Two postures differ
from the browser routes on purpose. **Never CORS**: no preflight handler, no
echo — a browser page cannot use this route even if a customer mistakenly
put their secret key in it (the browser stops at preflight, which is the
right feedback: a secret key belongs on a server; the live check saw exactly
that message). **Helpful where the caller has proven itself**: refusals are
uniform where an outsider could probe them, but a 400 or 403 for a request
that carried a valid secret key says why in a `detail` sentence — the shape
the visitor id must have, whether the origin was unlisted or simply not an
origin — because that is the tenant's own configuration to fix. Named
`/v1/sessions` rather than under `/v1/widget/` because the `/v1/widget/*`
routes are the ones a browser calls (Origin-gated, CORS) and this one is
called by a server with a bearer credential — a different caller, a
different posture, and a path that says so.

### §3.19 `realtime/scripts/seedWidgetDemo.ts`

Dev-only CLI (`npm run seed-demo [-- --corpus fastify] [--origin url]`):
the fixture/demo organization — org, the fixed publishable key the
fixture pages hardcode (pk values are public by design), the :4400
fixture origins plus any `--origin` (the deployed demo page's own), and
content: the six-chunk toy corpus by default, or with `--corpus fastify`
the REAL demo — eval/corpus through parse → chunk → embed with real
fastify.dev URLs, so demo citations deep-link to live pages (pair with
EMBEDDING_PROVIDER=local; under mock it warns that only exact-text
retrieval works). Idempotent by REPLACEMENT (the demo source is deleted and
re-seeded, so the seed is always exactly what the file says), and it
refuses to reassign the pk if it somehow exists under another org. One
subtle decision, learned live: embedding input is trail-free under the
MOCK embedder but trail-prepended (the §3.10.5 production
representation) under local — the mock hashes its input, so prepending
the heading trail doesn't shift the vector, it REPLACES it, silently
killing exact-text retrieval (the mock's only mode) and making the gate
refuse everything, which looks like a widget bug and is not.

### §3.20 `src/routes/demo.ts`

The public demo surface: GET /demo, a page wearing the widget exactly the
way a customer's site would (same snippet, same public routes), and GET
/widget.js — this service as the bundle's ORIGIN FALLBACK (the plan's
distribution is GitHub Release → jsDelivr with us as origin; the demo
page is the fallback's first consumer; the Dockerfile's widget stage is
what puts the bundle in the image). data-api="" makes the widget fetch
same-origin, so the page works on localhost and Render without
configuration. A null DEMO_PUBLISHABLE_KEY is a LEGAL state: /demo then
serves setup instructions — a recruiter hitting a half-configured
deployment must see a page that says what it needs, never a silently
broken bubble (the plan's "demo looks broken" risk). The key passes
through an attribute escape though it is server config, and a test feeds
a hostile key to prove it. The bundle is read per request, no cache: 8 KB,
immutable in prod, and a cache would go stale under the dev bind mount.

### §3.21 `src/credentials/` — the vault and the validator (M3.4, M3.6b)

- **vault.ts** — AES-256-GCM under CREDENTIAL_MASTER_KEY (32B base64,
  realtime-only env: web handles plaintext for the seconds between paste
  and save but can never decrypt at rest). Same v1.iv.tag.ct format and
  AAD-binds-row pattern as web's email crypto, with two deliberate
  differences: NO dev fallback key (a provider key is real even in dev —
  encrypting under a published constant would be silently worthless), and
  NO blind index (nothing looks credentials up by key; a searchable
  digest would be pure attack surface).
- **validate.ts** — everything between "payload arrived" and "worth
  encrypting": shape checks per provider (mirroring §3.3.3's
  CHECKs), the SSRF vet on tenant base URLs (safeFetch's assertPublicUrl,
  injectable for tests via the same seam shape as hostGuard — honest
  limitation recorded for M6: the vet runs at save time, and the
  provider's own fetch has no connect-time re-check against DNS
  rebinding), provider construction over the §2.4.5f–i adapters, and the
  LIVE round-trip: one real 16-token completion, latency measured to
  done, because a key that "looks right" but is revoked or out of quota
  must fail at the Test button, not at a visitor's first question.

  **The attempt policy is measured rather than assumed (M8.2)**, and it was
  wrong for two milestones. The budget was 15 s with no retry — a number
  picked before this project had ever called a real provider. M7.11 then
  measured the free tier it is designed around at a TTFT p95 of **27.9 s**,
  the live suite watched a structured-output call take 29.4 s, and the
  playground's own BYO step produced a 503 after 11 s. Both failure modes
  handed a tenant with a perfectly good key the sentence "the provider did
  not answer within 15s", which reads as "your key is bad". Now: a **25 s**
  budget, chosen against the ceiling that already existed rather than freely
  — web/src/lib/realtime waits 30 s for the whole internal call, so anything
  at or past that converts a provider timeout into a dashboard timeout, an
  error that names nothing — and **one extra attempt** for the retryable
  class only (429/408/5xx/transport), sharing that same wall clock so two
  waits can never become two budgets. A 401 is never retried: a wrong key is
  just as wrong a second later, which is §3.15.5's distinction applied to a
  form. An adapter's own contract violation (wrong vector count, a changed
  dimension) is likewise a fact, not weather. What the budget still does NOT
  cover is a 27.9 s p95, and the timeout sentence says so — "free tiers are
  often slow, try again before assuming the key is wrong" — because an
  unbounded tail is answered by a retry and an honest sentence, not by a
  bigger constant. Verified against real Gemini through the internal route:
  two Test calls succeeded at 16.3 s and 19.4 s of provider latency, both of
  which the old cap would have refused.
  Since M3.6b it is role-aware and symmetric: `buildGenerationProvider`
  (renamed from buildCredentialProvider when it stopped being the only
  one) and `buildEmbeddingProvider` over §2.4.5k–m, with
  `testEmbeddingRoundTrip` as testGenerationRoundTrip's twin — one real
  embedding of one short text, answering three things no shape check can:
  does the key authenticate against THIS endpoint (embedding and
  generation keys are often scoped differently), what dimension does the
  model actually return, and does that dimension FIT. Over PADDED_DIM it
  is refused with a sentence naming both numbers and the fix — silently
  truncating an embedding that was not Matryoshka-trained would destroy
  exactly the geometry that made it worth storing. Groq + embedding and,
  since M7.8, Anthropic + embedding are refused BY NAME (neither has such
  an endpoint at all — the plan's provider table has a dash in that column
  for both — and a gap is worth stating rather than turning into a
  confusing 404). Adding a HOSTED provider also has one rule worth its own
  test, which M7.8's shape cases now carry: its endpoint must land in the
  FIXED set rather than the base-URL set, since a hosted provider that
  accepted a tenant-typed base URL would be a request-forgery lever wearing
  a vendor's name (§3.3.3's argument, one level up).
  `effectiveEmbeddingModel`
  computes the model id a stored row resolves to WITHOUT decrypting its
  key, which is what lets §3.22 compare "what the corpus was embedded
  with" against "what it will be embedded with next".

- **resolve.ts** (M3.5, M3.6b) — the vault's READ side: org →
  ready-to-call provider, decrypted per call with deliberately NO cache (a
  cache would serve a revoked key until eviction — the exact window
  rotation exists to close; the cost is one indexed read plus a
  sub-microsecond AES-GCM decrypt). Absence is normal (demo org, fresh
  org → caller falls back to the app-level provider); decrypt failure
  throws LOUDLY rather than degrading to the mock, which would look like
  the product working while serving nonsense. Until M7.8 an 'anthropic'
  row threw by name here — schema forward provision the adapters had not
  caught up with; §2.4.5n closed that, so **the schema's provider union and
  the adapters that exist are now the SAME five** and the
  unimplemented-provider branch is gone. What replaced it is narrower and
  true by construction: the only pairing the builders cannot serve is an
  anthropic EMBEDDING row, which checkCredentialInput refuses by name and
  buildEmbeddingProvider throws by name if one ever appears anyway (a
  DB-gated test seeds exactly that row to prove the loud stop).
  `resolveEmbeddingProvider` is the twin, and it buys the property
  nothing else in the system enforces: the ingest worker and the query
  path call the same function on the same row, so a tenant's chunks and
  their visitors' questions land in the SAME vector space by
  construction rather than by two settings happening to match. It passes
  the stored `dim` straight through, which is what turns each response
  into an assertion instead of a discovery.

### §3.22 `src/routes/internal/` — the dashboard's server-to-server API

The only surface that ever sees a tenant key in plaintext, and only in
transit. Auth is ONE shared secret (INTERNAL_API_SECRET, identical on
Render and Vercel) compared in constant time — signed-request ceremony
buys nothing between two backends we own on TLS. Uniform empty 401s; org
ids vetted and existence-checked with 404 for both unknown and malformed
(the id rides res.locals so handlers never re-trust req.params); no CORS
at all, so browsers cannot read responses cross-origin. POST tests AND
saves through one code path (`save:false` = the Test button — the two
can never drift on what "valid" means); save is replace-by-delete in one
transaction; GET returns display fields ONLY (the read-back denial test
pins that neither ciphertext nor any key substring appears); DELETE hard-
removes. The surface MOUNTS ONLY when configured (app.ts): unconfigured
deployments 404 these paths — indistinguishable from the routes not
existing, which the smoke probe (§6.1) asserts from outside. server.ts
enforces the all-or-nothing env pair: a secret without the master key
refuses to boot rather than accept keys it cannot encrypt.

Since M4.6 it also owns closing a handoff (`POST
/internal/orgs/:orgId/handoffs/:conversationId/close`), for the reason the
enqueue route exists: the effect is not only a row. The socket rooms live
in realtime's memory, so the close and the `closed` frame have to happen in
one process, and the route calls onHandoffClosed only when a row ACTUALLY
changed — ringing the room on a second click could hang up on a later
escalation of the same conversation that is already sitting in it.
Membership is re-established here rather than taken on web's word, exactly
as the ticket route does it.

Since M3.6a the surface also owns source enqueueing: POST
/internal/orgs/:orgId/sources vets the location through the SAME url-vet
seam (a crawl target is a tenant-typed URL this server will fetch — the
credential-base-URL threat exactly; safeFetch re-vets every actual fetch
with its connect-time hook), mirrors the schema's depth cap as a
sentence instead of a constraint violation, writes source + queued job
in one transaction, and then calls onEnqueue — which server.ts wires to
the worker's wake(). In production that callback is the entire
scheduler (§3.10.5).

Since M7.5 it also owns RE-crawling one source: `POST
/internal/orgs/:orgId/sources/:sourceId/recrawl`, the action the sources
page's new visibility exists for. Until then a source was crawled once,
when connected, and again only when the org's embedding model changed; a
tenant who read "failed: nothing crawlable — disallowed by robots.txt" and
fixed their robots.txt, or whose docs simply changed, had nowhere to click.
Through realtime rather than an INSERT from web for the enqueue route's
reason — the row is not the whole effect, the wake is. Idempotent by SCHEMA:
one INSERT with `ON CONFLICT (source_id) WHERE state IN ('queued',
'running') DO NOTHING` against 008's partial unique index (§3.3.10), so a
source with a crawl already queued or running answers `queued: false` and
writes nothing, and five concurrent clicks insert one job and fire one wake
(a test fires them together). No read before the insert, no transaction —
the race resolves in Postgres, §3.23's playbook. A source that is another
org's, or does not exist, or is not even an id, is one 404 — the org guard's
stance one level down. UPLOADS were refused here with a sentence until
M7.6b, because the worker failed them by design and manufacturing a job
guaranteed to fail is not a re-crawl; 009 keeps an upload's text, so
re-ingesting one is now both possible and worth having — an upload whose
FIRST ingest failed on a wrong embedding credential or a provider outage
otherwise left the tenant nothing to click but "upload the file again". The
route needs to know nothing about the difference; the dashboard calls the
button "Re-index" for a file.

Since M7.6b it also owns the UPLOAD route (§3.10.8), which is described with
the ingest pipeline because that is what it does.
`enqueueReindex` gained the same ON CONFLICT clause, so a click landing
between its read and its insert can no longer turn a unique violation into
a rolled-back credential save.

Since M8.5 both create routes enforce **the plan's source ceiling** —
shared/billing/plans.ts had advertised the number on the billing page since
M5.3 with a comment admitting nothing checked it, the state its own text
called "worse than none". The check runs INSIDE the create transaction with
the org row locked (`FOR UPDATE`): a cap held by count-then-insert races,
and two concurrent creates would both count below the limit and both land —
locking the org row serializes source creation per org, held for the
milliseconds a count and two inserts take on an operation a tenant performs
a handful of times ever, and a test fires five concurrent creates at a free
org to prove exactly one lands. The refusal is a 409 whose sentence names
the plan, the count, and both ways out (delete or upgrade). The upload route
checks TWICE — an advisory unlocked read before the parse (a PDF parser
decompresses, and refusing a full plan after seconds of CPU would have done
the expensive thing — the 413-before-parse argument) and the authoritative
locked check in its transaction. Every source row counts, failed ones
included: they hold a slot the tenant can see and, now, release.

Which is why the same increment made sources DELETABLE — `DELETE
/internal/orgs/:orgId/sources/:sourceId` — because a cap on an add-only
resource would spend a free tenant's single slot forever on their first
typo'd URL. One DELETE takes the whole subtree (documents, chunks,
embeddings, the stored upload extraction, and job history all CASCADE from
sources) while every transcript SURVIVES: message_citations snapshots what
it cites and carries no chunk FK (§3.3.2) — this route is the first caller
to lean on that property outside a test, and the suite pins both directions.
The queue interaction is the careful part: a QUEUED job dies with its source
(the DELETE takes the row lock, and the worker's `FOR UPDATE SKIP LOCKED`
claim cannot take a locked row, so a job cannot be claimed mid-delete — the
race resolves in Postgres, §3.23's playbook), while a RUNNING one refuses
the delete with a 409 (cascading it away would yank the row out from under a
live crawl), checked AFTER the queued-delete so a job claimed a moment
earlier is seen as the running job it now is, with the throw rolling the
queued-delete back so a refused delete changes nothing. Stale running rows
cannot refuse forever — the worker's reclaim pass clears them past the lease
window. No wake: nothing was enqueued. Direct inserts (seeds, fixtures, the
eval harness) bypass the cap by construction — it gates the TENANT surface —
but two seeded orgs whose sources ARE later touched through that surface now
carry `pro`: the security fixture's probe orgs (free's ceiling is one, and
the probe's malformed-upload case would otherwise meet the cap's 409 where
the case is about the parser's 422) and seed-demo's Widget Demo Org (the
playground tour's first sources step is "crawl nodejs.org", which on a free
org already holding the demo corpus would refuse at the first click).

Since M3.6b the credential route serves both ROLES through that same
one-path rule: the role picks which builder and which round-trip runs,
and an embedding save additionally stores the dimension its round-trip
measured. It also owns the consequence a naive implementation would
leave to the tenant to discover — **an embedding model change orphans
the corpus.** Chunk vectors are stored per (chunk, model) and the dense
arm filters on model, so a new model does not make existing content
wrong, it makes it INVISIBLE, and the gate then refuses every question
(it fails closed on lexical-only retrievals by design, §3.15.1). That
reads to a tenant as "the widget broke". So a save whose effective model
differs from the previous one — including the first-ever save, where the
corpus sits under the platform's built-in model — queues a fresh crawl
of every source IN THE SAME TRANSACTION as the credential write, then
wakes the worker; §3.10.5's short-circuit fix is what makes those
re-crawls actually re-embed. Removal does the same, for the same reason
(reverting to the built-in model is a model change). Sources with work
already queued are skipped, uploads are skipped (the worker fails them
by design), and re-pasting a rotated key for the SAME model queues
nothing — the vector space did not move. The count comes back in the
response so the dashboard can say so out loud (§9.8).

### §3.23 `src/handoff/escalate.ts` — the escalation transition (M4.1)

The moment a conversation stops being the bot's and becomes a person's.
Everything else in M4 — the ticketed socket, presence, replay — carries
messages once this has happened; this file decides THAT it has, and does so
exactly once per conversation.

Idempotence is the whole design problem: a visitor mashing the button, a
widget retrying a request whose response was lost, and (later) an
auto-escalation racing the button all arrive as concurrent requests for the
same thing. The answer is not application-side deduplication — a
check-then-insert races, and the loser corrupts the queue with a second row
— but §3.3.4's partial unique index, which makes a second open handoff
unrepresentable. `requestHandoff` reads first (the common case costs one
indexed lookup), inserts inside a transaction that also flips
`conversations.status` (a conversation showing 'escalated' with no row
would be a visitor queued where nobody can see them), and on a unique
violation reads back the winner. The race resolves in Postgres; the loser
returns the same handoff with `created: false`, which the widget uses to
avoid repeating itself and M5 needs so impatience does not inflate the
escalation rate. Access is scoped by org AND visitor, and all three failure
shapes — unknown conversation, another org's, another visitor's — collapse
to one `not_found`, because distinguishing them on a public route is an
oracle.

`getOpenHandoff` is the read the answer pipeline runs on every question
(§3.15.3): when a human owns the thread the bot emits `{type:"handoff"}`
and stops — no retrieval, no model call, no assistant row — while the
visitor's message is still persisted, deliberately, because it is exactly
what the waiting agent needs to read and a queued visitor who keeps typing
must not have those turns dropped. Answering anyway would put two voices in
one conversation and bill the tenant for the privilege.

`closeHandoff` (M4.6) is the transition's mirror image, and mirrors its
reasoning too. Both rows move in ONE transaction — a closed handoff under a
conversation still reading 'escalated' would be a widget insisting a person
owns a thread the bot is answering. The UPDATE's `status <> 'closed'` guard
is what makes concurrency safe without a lock: five agents clicking at once
produce one write and four no-ops instead of four rewrites of when the
conversation ended, and the function reports `closed: false` for those,
because a double click and a colleague who got there first are normal
answers rather than errors. Closing also CLAIMS the handoff if nobody had
(`COALESCE(claimed_at, NOW())`) — a resolved handoff with nobody ever
having handled it is a lie the CHECK constraint happily permits — while an
existing claim is left alone, since who handled it is the fact worth
keeping. The conversation returns to 'open', not 'closed': §3.15.3 stops
finding an open handoff, so the bot answers again, and the partial unique
index over open rows lets the same visitor escalate later — which is why
the lifecycle is a table and not a column.

The public surface is `POST /v1/widget/escalate` (§3.18): plain JSON, not
SSE — the transition is one small state change, and the stream that carries
the human's replies is M4's WebSocket. It reuses the chat route's
per-visitor bucket rather than getting its own, because escalation is cheap
for us and expensive for the tenant (it puts a person on the hook), so a
visitor who has spent their question budget should not have a separate
allowance for summoning staff. Reason is fixed to `visitor_request` at this
boundary: `low_confidence` is the pipeline's call to make, not a request's
to claim.

### §3.24 `src/handoff/ticket.ts` — identity at upgrade (M4.2)

Both ends of the handoff socket already hold a credential: the visitor a
30-minute session token, the agent a dashboard cookie. Neither can be used
directly, because **a browser cannot set headers on a WebSocket
handshake** — the credential would have to ride in the URL, and a URL is
the worst place in this system to put one (access logs, proxy logs, error
reports). So each side spends its real credential on an ordinary
authenticated POST and receives a ticket good for SIXTY SECONDS and
exactly ONE upgrade. A ticket recovered from a log is already spent,
already expired, or both.

Signed with a key DERIVED from WIDGET_TOKEN_SECRET
(`HMAC(secret, "interrelated/handoff-ticket/v1")`) rather than the secret
itself: one env var, two token types, and cross-acceptance impossible by
construction — a session token can never verify as a ticket even if a
future refactor made their payload shapes overlap. A test pins both
directions.

Single-use is the half that needs state, and it is in-memory on purpose —
the §3.17.2 argument (one always-on instance; a shared store would defend
against a topology that cannot occur). The sweep is safe by ordering: an
entry is dropped only once the ticket it remembers has expired, and expiry
is checked by the verifier BEFORE the registry is consulted, so a sweep can
never re-open a spent ticket. **The honest limit, which belongs in the
README:** a second instance would need this set — and §3.25's rooms — in
Redis. It is the one place where "a second worker is a deploy, not a
rewrite" stops being true for this codebase.

### §3.25 `src/handoff/socket.ts` — the WebSocket server (M4.2)

`noServer: true` with a hand-written upgrade handler, deliberately. The ws
library will happily attach to an http server and let you authenticate in
the connection handler — the wrong shape, because it completes a handshake
for an unauthenticated party: a connection exists, holds a slot, and can
send frames before anyone has checked who it is. Here the ticket is
verified and SPENT before `handleUpgrade` is called at all, so an
unauthenticated socket is never a WebSocket — it is a TCP connection that
gets an HTTP status and a FIN. That is the identity-at-upgrade pattern the
plan names, and the smoke probe asserts it from outside the image by
sending a real handshake and requiring a 401 rather than a 101.

After the ticket, the database still gets a say: the handoff must be open
(one closed in the seconds since minting means the conversation is the
bot's again), the org must match, and a VISITOR ticket only opens its own
conversation. An **agent attaching IS the claim** — presence is the product
meaning of "active", so there is no separate button to forget to press;
the UPDATE is guarded on `status='pending'` so two agents arriving together
produce one claim and two participants rather than a lost update.

On a message: validated, PERSISTED, then broadcast — in that order, because
a message the other side saw but the transcript never recorded is worse
than a slow one, and the transcript view (§9.10) is the record of what was
said. The role written to `messages.role` comes from the ticket; a frame
claiming `role: "agent"` is ignored, which a test proves by sending exactly
that. Rooms are keyed by conversation so a broadcast cannot cross threads
(also tested), and empty rooms are deleted rather than accumulating one
entry per conversation the service has ever seen. The heartbeat exists for
half-open sockets — a closing laptop lid never fires 'close', and without
it a phantom agent would show as present forever while the visitor waits
for someone who left.

**M4.3 — replay and typing.** Attaching now yields `ready` → `history` →
`presence`, and the room relays composing hints. Three decisions carry it:

1. **The backlog is buffered into, not read around.** A client joins its
   room BEFORE its history is read, so both naive orderings are wrong in
   the window between: reading first and joining after LOSES a message
   committed in between (nobody was in the room to hear the broadcast),
   while joining first without a buffer delivers one TWICE — or delivers
   it and then renders the backlog over it. So live `message` frames queue
   on the attachment until the backlog is on the wire, then flush minus
   any id the backlog already carried. The window is one indexed SELECT
   wide and the fix costs an empty array per connection; the test that
   pins it attaches a client mid-conversation and asserts every message
   arrives exactly once under EITHER interleaving — and it failed on 3
   runs of 3 with the buffer removed, which is what makes it a regression
   test rather than decoration.
2. **One clock, and it is Postgres's.** The message insert now RETURNs
   `created_at` and broadcasts that, instead of stamping a `Date` in this
   process. Replay and live frames land in ONE rendered list, and this
   process and the database are different machines (Render and Neon) —
   their skew can exceed the gap between two turns of a fast exchange, so
   taking the stored instant for both makes a reconnecting client's merged
   thread ordered by construction. It also matches the answer pipeline's
   rows, which take the column default. A test asserts the `at` a client
   sees live is byte-identical to the one it gets back on replay.
3. **Typing costs the server no timer and no state worth leaking.** The
   relay coalesces: a repeat earns the wire only when it refreshes a
   receiver's TTL, a change always does, and a hard 250 ms floor bounds a
   per-keystroke client — by DROPPING, never by erroring, since answering
   every keystroke with an error frame is a worse storm than the one being
   prevented. A state change lost to the floor self-heals within
   `TYPING_TTL_MS`, which is what that TTL is for. Two stops are explicit
   rather than left to it: sending a message ends composing by definition,
   and a socket closing mid-sentence announces the stop on its way out.

**M4.6 — `endRoom`.** Closing a handoff has an in-process consequence: the
rooms are in memory HERE, so the write and the notification must happen in
the same place, which is why the dashboard's close goes through realtime
(§3.22) rather than being a direct write like the origin allowlist. The
frame goes out first and the socket closes after — the reverse would make
both ends spend a reconnect to learn what one frame already said. server.ts
wires the route's callback to this with a late-bound closure, because the
socket server needs the http server, which needs the app the route lives in.

Shutdown ordering matters and server.ts handles it: sockets are terminated
BEFORE `server.close()` can finish, because an open WebSocket is a live
connection and http.Server.close waits for every one — a deploy would
otherwise hang until Render's kill timeout with browsers still holding
sockets.

---
