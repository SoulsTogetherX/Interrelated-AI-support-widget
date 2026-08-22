# Interrelated

An embeddable AI support widget, built as a multi-tenant SaaS: a business
signs up, brings its own model-provider key, points the product at its
documentation, and gets a `<script>` tag. On their site that tag renders a
chat bubble that answers visitor questions **from those docs only**, streams
the answer, cites the exact passage each sentence came from, refuses when
the docs don't cover the question, and hands the conversation to a human
over a WebSocket when the visitor asks. The dashboard shows conversations,
indexed content, quotas, billing, and the metrics below.

The one decision everything else follows from: **the model's claims are
verified by code, not trusted.** The model must answer as a list of claims,
each naming the retrieved chunk it came from and quoting the verbatim span it
relies on. A deterministic check confirms the quote actually occurs in that
chunk. Claims that fail are stripped before the visitor sees them, every
verdict is stored, and the strip rate is a published number. There is no
uncited channel in the protocol at all.

Everything runs for $0 — free tiers only, no paid API required — and CI runs
the whole pipeline with no API keys.

---

## Measured

Every number below is produced by a committed script against committed
data, and most of them are CI gates.

| What | Number | Where it comes from |
|---|---|---|
| Retrieval, hybrid dense + lexical with RRF | **recall@5 75.0%, recall@10 83.8%, MRR@10 52.6, nDCG@10 59.7** on an 80-question hand-written golden set over 31 Fastify docs pages | `npm run eval` — [eval/RESULTS.md](eval/RESULTS.md); CI fails below recall@5 = 70 |
| Dense-only, for the delta hybrid buys | recall@5 72.5%, recall@10 81.3% | same run |
| Retrieval latency (hybrid, warm, local model) | p50 70 ms · p95 107 ms | same run |
| What multi-tenant iterative scans are worth | **52.5 points of recall.** With `hnsw.iterative_scan` off, 15 of 16 tenants sharing one index get fewer than the *k* rows they asked for (47.5% recall) while every query still returns 200; with it on, every tenant gets exactly *k* at every measured size, at no measurable latency cost | `npm run tenant-scan` — [eval/RESULTS.md](eval/RESULTS.md); the plan verified per sweep point, so a row that left the index is reported unmeasured rather than as a finding |
| Refusal threshold | **0.34** cosine distance for bge-small — 0% false refusals on the golden set, 100% correct refusals on off-topic questions, derived from an 80 + 40 question sweep, not picked by feel | [eval/RESULTS.md §threshold](eval/RESULTS.md) |
| Handoff socket under load | **300 concurrent sockets connected, nothing errored or dropped; round trip p50 26 ms / p95 72 ms** at 100 msg/s (that round trip includes a Postgres write — the server persists before it broadcasts); connect p50 flat at ~10 ms from 200 to 300 sockets; a knee between 200 and 250 msg/s where messages go late, traced to the 5-connection pool | [loadtest/RESULTS.md](loadtest/RESULTS.md) |
| Widget bundle | **6.52 KB gzipped**, zero runtime dependencies, Shadow DOM, CSP-safe | `scripts/widget-size.mjs` — CI budget 15 KB |
| What the widget costs a host page | **1 request, 6.52 KB gzipped, and nothing further until a visitor opens the bubble** — the bundle fetches no font, stylesheet, chunk or image, and the session mint is deferred to bubble-open | `scripts/widget-size.mjs` (static) + `widget/src/__tests__/cost.test.ts` (behavioral); both CI-enforced |
| Snippet load → interactive bubble | **9.5 ms p50** warm (10 loads, 9 of them 7.3–16.3 ms), **168 ms** on a cold first load | `widget/fixtures/measure.html` — localhost, so add a CDN's TTFB and transfer |
| Security gate | **57 black-box checks** against the shipped image (origin allowlist, key state, token replay, tenant isolation, SSRF, credential read-back, secret-key sessions, oversized uploads, socket, rate limits) + **9 poisoned documents** through the answer path | `scripts/security-probe.mjs`, `scripts/injection-probe.mjs` — CI e2e job |
| What verification actually catches | **23.8% of a real model's claims were stripped** — quoted spans that were not verbatim in the chunk they cited, withheld from the visitor — against **0%** for the context-quoting mock over the same 20 questions and the same retrieved chunks | `npm run compare` — [eval/RESULTS.md](eval/RESULTS.md); the mock is the control that proves the number is about the model, not the harness |
| Embedding provider, measured rather than assumed | `gemini-embedding-001` beats the local `bge-small-en-v1.5` by **+15.0 points of recall@5** (hybrid **90.0%** vs 75.0%, @10 96.9% vs 83.8%), and the hybrid miss list drops from **12 of 80 questions to 2** | `npm run eval -- --embedder gemini` — [eval/RESULTS.md](eval/RESULTS.md); the lexical arm is byte-identical across both runs, so only the dense arm moved |
| Answer path against a real model | **TTFT p50 6.9 s** over 19 answers on free-tier Gemini `gemini-3.6-flash` (3,711 in / 115 out tokens per answer, ten retrieved chunks per prompt); an earlier n=9 run on a six-chunk toy corpus measured p50 2.2 s | `npm run compare`, read back from `messages` |
| Schema-violation rate, Gemini | **1 of 19 answers** needed the contract retry under native server-side JSON-schema enforcement — near-dead rather than dead, where an earlier n=9 run saw 0 | `messages.schema_violations` — the column M7.10 added |
| Tests | 836 across the repo, the integration suites against a real pgvector Postgres (12 more are key-gated and skip without provider keys or the local embedding model) | `npm test` per package |

The rows measured against a real model come from **borrowed free-tier keys**
at n=19 and n=20, which is a sample rather than a benchmark and is reported
as one. The binding constraint is the free tier itself: `gemini-3.6-flash`
allows **20 generate requests per day**, so the full 80-question golden set
is four days per provider. Two numbers are deliberately *not* claimed. **Cost
per 1,000 answers**, because `gemini-3.6-flash` has no row in the price table
— its price was not read off the pricing page, and this project prices
unknown models as `null` rather than guessing (a wrong-but-believable cost
figure is worse than none); the token counts are published instead, so anyone
holding the current price sheet can compute it. And **TTFT p95**, because at
n=19 the nearest-rank p95 is the single worst observation, and that
observation — 310 seconds — measured a gap rather than a provider: at the
time, nothing on the answer path imposed a deadline, so a provider that
accepted the connection and went quiet held the stream for as long as it
liked. That finding became the next increment: the pipeline now bounds every
answer at 60 seconds of wall clock (see limitations below), so the 310-second
stream is no longer representable — it would end as an ordinary error at the
deadline, which is also how the comparison harness records it on a re-run.

Each provider adapter is proven against a loopback server speaking its real
wire protocol, and against the provider itself only when that provider's key
is in the environment — a key-gated suite that skips loudly rather than
passing quietly, and a comparison table that prints a **SKIPPED row naming
the reason** rather than omitting a provider. Groq, Anthropic and Ollama have
never run here: no key for the first, no paid account for the second, no local
model for the third.

---

## How it works

Two services, split by runtime shape rather than by framework: a **Next.js
dashboard** on Vercel for everything short and form-shaped (auth, org
onboarding, provider keys, sources, transcripts, metrics, billing), and an
**Express + `ws` + Kysely** service on Render for everything long-lived
(SSE chat, retrieval, the ingest worker, the handoff WebSocket). Postgres 18
with pgvector on Neon. The full file-by-file reference is
[CLAUDE.md](CLAUDE.md); the request-by-request traces are
[DATAFLOW.md](DATAFLOW.md). Section numbers below refer to CLAUDE.md.

**Ingest** (§3.10) — a source is a URL to crawl or a file the tenant
uploads. A URL goes through an SSRF-guarded fetcher
(every DNS answer must be public; redirects re-vetted per hop; a
connect-time hook re-checks the address actually dialed, which closes DNS
rebinding), a crawler that reads the site's `robots.txt` first and honors
it on every fetch — a hand-written RFC 9309 parser, most-specific rule
wins, Crawl-delay honored up to a cap, an unreachable file refusing the
crawl as the RFC says, and every page it left out recorded with the reason
so the dashboard can show *why* rather than a smaller count — an
HTML/Markdown/**PDF** parser whose one contract is
`block.text === source.slice(start, end)`, a heading-aware chunker, and the
org's own embedding model. The PDF half is worth its own sentence, because
it is the one dependency this project removed and then re-admitted: a
21 MB library was cut at M1 for weight and for having no caller, and the
format came back only when both objections could be answered — 2.1 MB with
no dependencies, dynamically imported so a stack that never meets a PDF
never pays for it, and refusing a scanned PDF with a sentence naming OCR
rather than storing a source that answers nothing. An UPLOAD skips the
fetcher and the crawler and joins at the parser: it is parsed inside the
upload request, so a refusal reaches the tenant while the file is still in
front of them, and everything after that is the ordinary path — the worker
ingests it as a crawl of one page whose fetch is a database read. Storage is `halfvec(1024)` with one partial HNSW
index per model and `org_id` denormalized onto the vector table — because
HNSW searches then filters, and a small tenant inside a large index would
otherwise get fewer than *k* results. A regression test seeds 20 tenants and
asserts every one retrieves exactly *k*. The queue is Postgres
(`FOR UPDATE SKIP LOCKED`); production runs no poll timer — the dashboard's
enqueue wakes the worker, and Neon sleeps between ingests.

**Retrieval** (§3.12) — a dense arm (cosine over HNSW, iterative scans on)
and a lexical arm (`ts_rank_cd` over a generated `tsvector`), fused with
Reciprocal Rank Fusion, hand-written. No RAG framework anywhere: the
retrieval layer *is* the technical content.

**Answering** (§3.15) — retrieve → a groundedness gate on the minimum dense
distance (decided **before** any model call, so a refusal costs zero tokens)
→ a prompt whose system half is constant and whose retrieved text rides in
the user turn inside `<context>` delimiters declared as data → the model,
streamed → structured claims parsed and validated with one retry → each
claim's quote located verbatim in the chunk it names → unverified claims
stripped → one transaction persisting the answer, **every** verdict, and the
day's usage counter → claim-granular events over SSE.

**Five providers, four mechanisms.** Structured output is where model APIs
disagree most, and the interface normalizes four genuinely different
answers rather than one: Groq (and any OpenAI-compatible endpoint) has JSON
*mode*, which is a request rather than a guarantee; Gemini enforces a JSON
schema server-side; Ollama constrains generation with its native `format`;
and Anthropic has no response-format field at all, so its schema is carried
as a forced **tool call** whose streamed arguments are the answer document.
The pipeline validates regardless — trust is not transitive — and records
per answer whether the model had to be asked twice, so the schema-violation
rate is a column in the dashboard's by-model table rather than an assumption.
The case that would otherwise hide is counted too: when the one retry also
fails there is no answer row to attribute, so that lands on the org's daily
counters instead — a provider failing systematically must not read as a
provider that never fails. A deterministic mock keeps CI keyless, and
Anthropic is the one provider with no free tier, so nothing here selects it
by default and no keyless stack can reach it.

Two *different* retries live in that path and they answer different failures.
A provider that **refused** the call — a 429 from a 30 rpm free tier, a 5xx,
a dead socket — is retried with jittered backoff honoring `Retry-After`,
bounded by attempts *and* by a wall-clock budget, so a `Retry-After: 60` is
declined outright rather than parking a visitor on a spinner for a minute to
maybe fail anyway. A wrong key (401) is never retried: it will be just as
wrong in two seconds. This is safe only because nothing generated reaches the
visitor until it has been verified, so a half-streamed call has shown nobody
anything. A provider that **answered and broke the JSON contract** gets the
one schema retry instead, capped at one because it costs a full generation.
An optional second *platform* provider covers the first once its attempts are
spent — and never covers a **tenant's** provider, which is the point: an org
that saved a credential chose a vendor and a data processor, and a transient
429 does not justify sending their customers' questions somewhere else on our
key.

**Handoff** (§3.23–§3.25) — escalation is idempotent by a partial unique
index, not by application deduplication. The socket authenticates *at
upgrade* with a single-use, 60-second ticket (a browser cannot put a
credential in a WebSocket handshake, and a URL is the worst place to keep
one), an agent attaching *is* the claim, every message is persisted before
it is broadcast with the sender's role taken from the ticket and never from
the frame, and a reconnecting client gets the backlog exactly once even when
messages land mid-attach. The widget keeps a live handoff across a page
reload — or a click to the next page of the site, which is the same event to
a script that lives one page at a time — through a stored bookmark whose
staleness the server settles: the next page rejoins the socket and draws
nothing until the server confirms the handoff exists, so a conversation an
agent closed while the visitor was away leaves the page exactly as if it had
never happened.

**Quotas and billing** (§3.26, §9.15) — plan ceilings are enforced before
the model call against a per-org, per-day counter written in the same
transaction as the answers it counts. Stripe test-mode Checkout out, a
hand-verified signed webhook back, and an event ledger keyed by Stripe's own
event id so a redelivery applies exactly once. Entitlement stays a column on
the organization: a billing outage can never reach the answer path.

---

## The trust model — why the public key being public is fine

The snippet is visible in view-source. The answer is not to hide it but to
make a copied snippet useless, and to keep the thing worth stealing out of
the browser entirely.

```
  customer's page                       realtime (Render)                 provider
 ┌───────────────────┐   Origin: https://docs.acme.com   ┌──────────────┐
 │ <script data-key= │ ────────────────────────────────▶ │ 1 allowlist  │
 │   pk_live_…>      │      POST /v1/widget/session      │ 2 HMAC token │
 │                   │ ◀──────────────────────────────── │   30 min,    │
 │  bubble opens     │   token bound to org+origin+visitor│   bound      │
 │                   │                                    │              │
 │  visitor asks     │ ────────────────────────────────▶ │ 3 buckets +  │
 │                   │  POST /v1/widget/chat  Bearer …    │   plan quota │
 │  claims stream    │ ◀──────────────────────────────── │   BEFORE the │     tenant key,
 │  in, verified     │        SSE: claim / refusal / done │   model call │ ──▶ AES-GCM at
 └───────────────────┘                                    └──────────────┘     rest, decrypted
   the browser holds: a pk (public by design) and a short-lived token          only here, only
   the browser never holds: the tenant's provider key                          for one call
```

Three credentials that must never be confused: the tenant's **provider key**
(server only, encrypted under a master key the dashboard never holds, shown
only as a suffix, never in an error, with a read-back denial test and a live
probe that greps for a canary); the **publishable key** in the snippet
(identifies the org, authorizes nothing by itself); and an optional
**secret key** the tenant's own backend uses to mint sessions for users it
has signed in — shown once, stored as a hash, and never accepted from a
browser.

The layers, in order of how much work they do: **(1)** an exact-match origin
allowlist checked before any database read, refusals carrying no CORS
headers so an unlisted site's browser cannot even read the error;
**(2)** session tokens instead of per-message key use, bound to origin and
visitor so replay from another site dies; **(3)** per-IP and per-visitor
token buckets and a per-org daily ceiling from the plan, all enforced before
the model call, so the worst case is a stopped widget rather than a bill;
**(4)** per-origin visibility — every mint that names an org is counted per
origin per day, minted or *refused*, so a copy of the snippet on someone
else's site (or a forgotten staging domain, which looks the same) shows up
in the dashboard as a name and a number next to the allowlist, with a
one-click Allow, rather than being inferred from a bill; refused origins are
attacker text and are bounded by shape and by a per-day cap; **(5)**
one-click key rotation with a 24-hour grace window — the new key works
immediately, the old snippet keeps working until it is redeployed, "revoke
now" ends the window early, and a revoked key is refused byte-identically
to one that never existed; **(6)** the strong mode — the tenant's own server
mints the session with a *secret* key for a user it has signed in, the page
carries `data-session-url` instead of a publishable key, so there is nothing
on it worth copying and only that tenant's logged-in users can open a chat.
The route that mints those never speaks CORS (a secret key pasted into a
page stops at preflight), and server-asserted identities live in a
namespace the browser route refuses — anyone on an allowlisted origin can
mint an anonymous session, nobody can mint one *as user 42* — which is what
lets the transcript say "identified by your server" and mean it. The honest
limit, stated plainly: `Origin` is unforgeable from a browser and trivial
from `curl`, so layers 1–2 defeat browser-based theft and layer 3 is what
bounds scripted abuse; rotation of a *public* key is hygiene rather than
defense (a scraper simply re-scrapes), and it is the secret key that turns
the same mechanism into one — layer 6 is the real answer for tenants who
need one. The security probe attacks every one of these from outside on
every CI run.

---

## Known limitations and future work

- **One instance.** Rate limits and the single-use ticket registry are
  in-memory; a second realtime instance would need them — and the socket
  rooms — in Redis. "A second ingest worker is a deploy, not a rewrite" is
  true; a second *socket* instance is not yet.
- **Free-tier arithmetic.** Neon's 0.5 GB holds roughly 78k chunks at
  `halfvec(1024)`; Render's one always-on service is kept warm by a cron that
  deliberately never touches the database. Free provider tiers move without
  notice, and free-tier submissions may be used for training — real customers
  should bring a paid key.
- **The mock measures the pipeline, not a model.** CI's e2e stack answers
  from a context-quoting mock. Retrieval quality is a real number (local
  embedding model in CI); injection *containment* is a real number; the
  injection *relay rate* and TTFT are per-model numbers that need a key.
- **The answer deadline is a constant, not a negotiation.** Every answer —
  embed, retrieve, generate, the one schema retry — must conclude inside 60
  seconds (`ANSWER_DEADLINE_MS` to override), after which every in-flight
  provider call is aborted and the visitor gets the ordinary failure state
  with their input recovered. That bound exists because the provider
  comparison measured one answer reaching its first token after 310 seconds
  — a provider that accepts the connection and goes quiet never *fails*, so
  the retry policy never sees it. What the deadline does not do is
  distinguish itself to the visitor: a deadline is a provider fact, and
  provider facts on a public stream are reconnaissance.
- **Grounding's honest limit.** A page the tenant crawled is the tenant's
  documentation, and a grounded answer may quote it — including a poisoned
  sentence. What the design guarantees is narrower and stated: no uncited
  text, no attacker-controlled citation, and the system prompt never in
  anything the visitor sees, all asserted from outside.
- **An uploaded file is not kept — its text is.** There is no object storage
  here, and Neon's 0.5 GB holds ~78k chunks, so a 10 MB PDF would cost more
  than the ~800 chunks extracted from it, as a second copy of the same
  content in the more expensive form. The upload is parsed in the request
  and the bytes are dropped; the extraction is stored, which is also what
  makes an upload survive an embedding-model change (a crawl re-fetches; an
  upload has nothing to re-fetch). The practical limit is that we cannot
  re-parse a file later under a better parser without asking for it again.
- **A PDF's chunks carry no heading trail.** Headings in a PDF are a
  font-size convention rather than a structure, so inferring them would be
  a heuristic with silent failure modes; PDF chunks are found by their text.
  A scanned PDF is refused outright, naming OCR — there is no OCR here.

---

## Running it

```bash
cp .env.example .env            # the registry of every variable, with placeholders
docker compose up -d database   # Postgres 18 + pgvector on :5433
cd realtime && npm ci && npm run dev          # migrates, then listens on :3000
cd ../web   && npm ci && npm run dev          # the dashboard on :3001
```

**Or boot the whole thing in one command:**

```bash
npm run playground
```

That starts the database, the realtime service, the dashboard and a set of
pretend customer websites with the widget installed, seeds a real
documentation corpus and a dashboard login, and prints where everything is —
no API keys needed. [PLAYGROUND.md](PLAYGROUND.md) is a fifteen-minute guided
tour of the product through it.

Keyless out of the box: `npm run seed-demo` in `realtime/` seeds a fixture
org, `npm run ask -- "<question>"` drives the whole grounded loop from the
CLI, and `GET /demo` wears the widget over a real documentation corpus. A
free Groq or Gemini key in `.env` lights up the real providers, the CLI's
`--llm` flag, and a key-gated live test suite — the same variable for all
three, nothing to keep in sync.

The production stack CI probes is `docker-compose.prod.yaml`; the deployed
demo is `render.yaml` (Render, one free web service) plus the Vercel runbook
in CLAUDE.md §9.1, and both need only free-tier keys.

## Repository

```
web/        Next.js 16 App Router dashboard — auth, orgs, providers, sources, transcripts, metrics, billing
realtime/   Express 5 + ws + Kysely — SSE chat, retrieval, ingest worker, handoff socket; owns migrations
shared/     wire protocols, chunker, RRF, claim verifier, schema types, plans, prices — no package.json
widget/     vanilla TS, esbuild IIFE, Shadow DOM, zero deps
providers/  LLMProvider + EmbeddingProvider interfaces and their implementations
eval/       golden set, no-answer set, injection corpus, corpus snapshot, scorer, RESULTS.md
loadtest/   handoff-socket harness and RESULTS.md
scripts/    zero-dependency probes: smoke, security, injection, widget size
database/   Postgres 18 + pgvector image
```

Apache-2.0.
