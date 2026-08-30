# 02 — Architecture: the pieces, and how each one works

This is the system explained part by part. Each section ends with pointers
into the §-numbered reference ([docs/reference/](reference/), mapped by
the lookup table in [CLAUDE.md](../CLAUDE.md)) where the full reasoning lives.

## The bird's-eye view

```
                        THE CUSTOMER'S WEBSITE
                 ┌────────────────────────────────┐
                 │  <script src=".../widget.js"   │
                 │          data-key="pk_live_…"> │
                 │        ┌─────────────┐         │
                 │        │ chat bubble │  visitors
                 │        └──────┬──────┘         │
                 └───────────────┼────────────────┘
             HTTPS (sessions, SSE chat)  +  WSS (human handoff)
                                 │
   ┌─────────────────────────────▼──────────────────────────────┐
   │  realtime/  — "the data plane"       Express 5, on Render  │
   │                                                            │
   │  widget API (mint/chat/escalate)   handoff WebSocket rooms │
   │  grounded answer pipeline          ingest worker + queue   │
   │  crawler / parsers / chunker       internal admin API      │
   │  DB migrations (sole owner)        /demo + /widget.js      │
   └──────────────┬──────────────────────────────▲──────────────┘
                  │ SQL                           │ shared-secret HTTPS
   ┌──────────────▼──────────────┐   ┌────────────┴──────────────┐
   │  Neon Postgres 18           │   │  web/ — "the control      │
   │  + pgvector (halfvec/HNSW)  │◄──┤  plane"  Next.js 16,      │
   │  ~20 tables, one database   │SQL│  on Vercel                │
   └─────────────────────────────┘   │                           │
                                     │  signup/login, orgs,      │
        tenant's own AI provider     │  provider keys, sources,  │
        (Gemini/Groq/Ollama/…)  ◄────┤  transcripts, inbox,      │
        called from realtime only    │  metrics, billing, install│
                                     └───────────▲───────────────┘
                                                 │ HTTPS
                                            tenant's browser
```

Two ideas organize everything:

1. **Control plane vs. data plane.** Short, form-shaped request/response
   work (auth, settings, lists) lives in a Next.js app on Vercel. Anything
   long-lived or stateful — SSE streams, WebSockets, background crawls —
   lives in a single always-on Express service on Render, because serverless
   functions cannot hold a socket open. The split also quarantines the newer
   framework to a CRUD surface where a bug is a bad page, while the novel
   work (retrieval, verification, streaming) runs on a plain, proven stack.
2. **One database, one owner.** Both services query the same Postgres, but
   only `realtime/` ever migrates it. The table shapes are a cross-package
   contract in `shared/db/schema.ts`, hand-written and kept in lockstep with
   raw-SQL migrations. (§3.1, §2.4.6)

## Repo layout

| Directory    | What it is                                                                                                                                                                                                                   | Runtime deps                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `realtime/`  | The Express data plane. Owns schema, migrations, ingest, retrieval, answering, sockets.                                                                                                                                      | `express`, `pg`+`kysely`, `undici`, `htmlparser2`, `ws`, `unpdf` |
| `web/`       | The Next.js dashboard.                                                                                                                                                                                                       | `next`, `react`, `pg`+`kysely`                                   |
| `widget/`    | The embeddable chat bubble. Vanilla TS → one 6.5 KB gzipped IIFE.                                                                                                                                                            | **zero**                                                         |
| `shared/`    | Code both sides must agree on: wire protocols, the claims contract + verifier, the chunker, RRF, DB types, plan/pricing tables, id formats. No package.json, no build step — consumers compile it via the `@shared/*` alias. | **zero**                                                         |
| `providers/` | The `LLMProvider` / `EmbeddingProvider` interfaces and all adapters. Same no-package pattern.                                                                                                                                | zero (heavy deps load dynamically)                               |
| `eval/`      | The measurement assets: frozen corpus, golden set, scorers, published results.                                                                                                                                               | —                                                                |
| `loadtest/`  | The WebSocket load harness + published results.                                                                                                                                                                              | —                                                                |
| `scripts/`   | Zero-dependency `.mjs` probes: smoke, security, injection, widget-size, TTFT, playground. Run with no `npm install`.                                                                                                         | —                                                                |
| `database/`  | The Postgres 18 + pgvector Docker image.                                                                                                                                                                                     | —                                                                |

This is a _flat_ layout joined by TypeScript path aliases — deliberately not
a monorepo tool. (§2.1)

## The provider layer (`providers/`)

Two small interfaces hide five generation backends and four embedding
backends:

- `LLMProvider` — `model` + `stream(request)` yielding text deltas then one
  `done` event (with finish reason and token usage). Streaming-first because
  time-to-first-token is a headline metric. (§2.4.5d)
- `EmbeddingProvider` — `model`, `dim`, and batch-first
  `embed(texts, {task})`, because free tiers meter per request/item and a
  question vs. a document should be embedded from different "sides" of an
  asymmetric model. (§2.4.5a)

| Provider          | Kind                                                  | Structured-output mechanism                                    |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `mock`            | scripted / context-quoting                            | exact by construction (drives all keyless stacks and CI)       |
| Groq              | preset of the generic adapter                         | `json_object` — "please emit JSON"                             |
| OpenAI-compatible | generic (OpenRouter, Together, vLLM, LM Studio, xAI…) | `json_object`                                                  |
| Gemini            | native                                                | **server-side JSON-schema enforcement** (`responseJsonSchema`) |
| Ollama            | native (self-hosted)                                  | full-schema `format` constraint                                |
| Anthropic         | native                                                | **forced tool call** whose input schema is the claims contract |

Four genuinely different mechanisms is why "schema violations per model" is
an interesting metric rather than a constant zero. The pipeline validates
every response anyway — enforcement ranges from real to advisory. Embedding
adapters: local `bge-small-en-v1.5` (ONNX, keyless — what CI uses), Gemini
(`gemini-embedding-001` at a Matryoshka-reduced 768 dims), generic
OpenAI-compatible, and Ollama. (§2.4.5f–n, §2.4.5j–m)

## The data model (Postgres + pgvector)

About twenty tables, in groups (§3.3):

- **Tenancy & auth**: `organizations` (with a `plan` column that _is_ the
  entitlement), `users` (emails AES-GCM-encrypted with a blind index for
  lookup), `org_members`, `sessions` (rows store only the sha256 of the
  cookie token), `api_keys` (publishable + secret widget keys; revocation by
  timestamp so rotation has a grace window), `allowed_origins`.
- **Content**: `sources` → `documents` → `chunks` → `chunk_embeddings`, plus
  `ingest_jobs` (a Postgres-backed work queue using
  `FOR UPDATE SKIP LOCKED`) and `source_uploads` (the extracted text of
  uploaded files — the bytes are never stored).
- **Chat**: `conversations` → `messages` → `message_citations` (one verdict
  per claim, stripped ones included). Citations **snapshot** what they cite
  (URL, heading, quote) with deliberately _no_ foreign key to `chunks`,
  because chunks are mutable pipeline state and transcripts are immutable
  history — a re-crawl must never rot a transcript. (§3.3.2)
- **Handoff**: `handoff_sessions` — one row per escalation, with a partial
  unique index that makes double-escalation _unrepresentable_.
- **Ops**: `org_provider_credentials` (the encrypted vault),
  `usage_daily` (per-org counters read before every model call),
  `origin_daily` (traffic per origin), `subscriptions` + `stripe_events`
  (billing, idempotent by Stripe's own event id).

Three vector-storage decisions carry the retrieval layer (§3.3.1):

1. **`halfvec(1024)`** — 2-byte floats halve storage; ~78k chunks fit in
   Neon's free 0.5 GB. Shorter models are zero-padded to 1024 (provably
   rank-preserving).
2. **One partial HNSW index per embedding model** — different models'
   vectors are different spaces; HNSW (unlike IVFFlat) builds incrementally
   under continuous ingest.
3. **`org_id` denormalized onto `chunk_embeddings` + pgvector iterative
   scans** — HNSW searches _then_ filters, so without this a small tenant
   inside a big shared index silently gets fewer than k results. Measured:
   turning iterative scans off costs 52.5 points of recall at 16 tenants.

## Ingest: source → chunks in the index

The pipeline is strictly layered; each layer is testable alone (§3.10):

- **`safeFetch`** — every crawl fetch goes through an SSRF-guarded HTTP
  client: URLs are vetted (scheme, no embedded credentials, all DNS answers
  publicly routable), the _connect-time_ address is re-checked (defeats DNS
  rebinding), redirects are followed manually so each hop is re-vetted, and
  bodies are size-capped while streaming. Crawl targets are user-supplied
  URLs this server then fetches — the textbook SSRF shape.
- **`robots.ts`** — a hand-written RFC 9309 implementation. Disallowed pages
  are skipped _and recorded with the rule that decided it_, so the dashboard
  can show a tenant exactly why a page is missing.
- **Parsers** (markdown, HTML, PDF) — all honor one contract:
  `block.text === canonicalText.slice(charStart, charEnd)`. Those offsets
  are what make citation deep-links possible.
- **Chunker** (`shared/chunking/`) — heading-aware packing to ~400 tokens; a
  chunk never straddles a section boundary; character offsets survive every
  split.
- **Worker** — claims one job at a time from `ingest_jobs`, crawls
  page-by-page, and per page: hash the text (unchanged pages are skipped
  entirely — the "recrawl short-circuit", measured at 216× cheaper), chunk,
  embed (with a patient rate-limit retry), then one short transaction for
  document + chunks + embeddings. In production the worker is **wake-driven**
  — no polling timer at all; the dashboard's enqueue call wakes it, so the
  database sleeps when the product is idle. (§3.10.5, §3.10.5a)

Measured: embedding is ~98% of ingest wall-clock; everything else sustains
~144 chunks/s.

## Retrieval: question → ranked passages

Two arms run concurrently, then fuse (§3.12):

- **Dense**: cosine nearest-neighbor over the per-model HNSW index — finds
  _paraphrases_ ("how do I undo a payment" → the refunds page).
- **Lexical**: Postgres full-text search (`ts_rank_cd` over a generated
  `tsv` column) — finds _exact terms_ ("ERR_STREAM_PREMATURE_CLOSE").
- **Fusion**: Reciprocal Rank Fusion — each arm contributes `1/(60+rank)`
  per chunk; scores on incomparable scales are never mixed, only ranks.
  Hand-written, ~20 lines. (§2.4.3)

Hybrid beats dense-only on every metric on the golden set (recall@5 75.0%
local, 90.0% with Gemini embeddings), and the whole thing is a CI gate that
fails the build below a committed floor.

## The grounded answer pipeline

The heart of the product (§3.15, traced in DATAFLOW §5):

```
question ─► persist visitor msg ─► embed query ─► hybrid retrieval
   ─► GATE (min dense distance ≤ threshold? else refuse — zero tokens spent)
   ─► build prompt (system = constant instructions; retrieved text rides in
       the USER turn inside <context> delimiters — the injection boundary)
   ─► stream from the org's own LLM   (jittered retry on 429/5xx;
       platform fallback ONLY for orgs with no credential; 60 s wall-clock
       deadline over the whole answer)
   ─► parse JSON (one retry with the validator's errors, then fail loudly)
   ─► VERIFY every claim ─► strip failures
   ─► one transaction: assistant message + ALL verdicts + usage counters
   ─► emit events: meta → claim × N (verified only) → done
```

Key properties: nothing generated reaches the visitor until verified (which
is also what makes retries and the deadline safe — an aborted stream has
shown nobody anything); a refusal costs no model call; a schema failure
never bills the tenant's quota; and every failure a visitor can see is one
opaque `error` event, because failure detail on a public stream is
reconnaissance. (§3.15.5, §3.15.6, §2.4.4)

## The widget

Vanilla TypeScript compiled to one IIFE: **6.52 KB gzipped, zero runtime
dependencies**, against a CI-enforced 15 KB budget. Shadow DOM with
`:host { all: initial }` armor so the host page's CSS cannot reach in (and
the widget's cannot leak out) — proven against a hostile fixture page with
`* { all: unset }` and a strict CSP. Everything textual renders through
`textContent`, never `innerHTML`: claim text is model output relayed from
crawled pages, i.e. attacker-reachable, and one `innerHTML` would be stored
XSS on someone else's site. The cost contract is tested: a page that nobody
chats on pays **one request** (the script) and nothing else; the session
mint fires at bubble-open (which doubles as the handshake that wakes the
database while the visitor types). (§8)

## The trust model — six layers

The snippet is public by design (a publishable key is the same category as
a Stripe publishable key). What stops abuse (§3.17–3.18, README "trust
model"):

| #   | Layer                                                                                                                                             | What it stops                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Server-enforced **origin allowlist** (browsers can't forge `Origin`)                                                                              | The copy-pasted-snippet attack, outright                                                             |
| 2   | **Session tokens** — the pk is spent once at bubble-open for a 30-min HMAC token bound to org+origin+visitor                                      | Key use as a per-message bearer credential                                                           |
| 3   | **Rate limits + daily caps** — per-IP and per-visitor token buckets, plus a per-org daily answer ceiling checked _before_ the model call          | Scripted abuse (curl forges Origin; this layer is what actually bounds it)                           |
| 4   | **Per-origin analytics** — every mint counted per origin per day, refused ones included                                                           | Makes unauthorized use _visible_ (the dashboard shows "your snippet loaded 340× from thief.example") |
| 5   | **One-click key rotation** with a 24 h grace window                                                                                               | Makes rotation routine instead of an outage                                                          |
| 6   | **Secret-key sessions** ("strong mode") — the customer's backend mints sessions for its own signed-in users; nothing on the page is worth copying | The determined attacker, properly                                                                    |

## Human handoff

When the bot refuses, the widget offers a person (§3.23–3.25, §2.4.7):

- **Escalation** is idempotent _by schema_ — a partial unique index allows
  one open handoff per conversation, so button-mashing and races resolve in
  Postgres, not application code.
- **Sockets authenticate at upgrade** via a 60-second, single-use ticket
  (browsers can't put credentials in WebSocket headers, and URLs land in
  logs — so the real credential buys a throwaway one). An unauthenticated
  connection never becomes a WebSocket at all.
- Messages are **persisted before broadcast**, roles come from the ticket
  (never from the frame), reconnecting clients get the backlog replayed
  exactly once on Postgres's clock, typing indicators are ephemeral with a
  TTL, and closing tells the room rather than letting sockets discover it.
- The widget survives page reloads mid-handoff via a localStorage bookmark
  (never the token, never a bot conversation), and the agent side lives in
  the dashboard inbox, ordered by who has waited longest.

Measured: 300 concurrent sockets, nothing dropped, round trip p50 26 ms
(including the Postgres write).

## The dashboard (`web/`)

Hand-rolled Next.js App Router (no create-next-app, no UI library, plain
CSS). Auth is ported from a previous project and hardened: scrypt password
hashing, HIBP breached-password screening, emails AES-GCM-encrypted at rest
with a slow-KDF blind index, hashed session tokens in an httpOnly cookie.
The pages, all under `/dashboard/[orgId]` after org selection (§9):

| Page             | What it does                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Overview         | Plan, today's usage meter, publishable-key card with rotation, secret-key card                     |
| Providers        | Paste/Test/Save generation + embedding credentials (the vault)                                     |
| Sources          | Connect crawls/sitemaps, upload files, re-crawl, delete; per-page skip reasons                     |
| Widget (install) | Allowlist manager, the snippet, exact CSP directives, per-origin traffic table, strong-mode recipe |
| Conversations    | Transcripts with **every claim's verdict, stripped ones included**                                 |
| Inbox            | The live handoff queue + chat view (the agent end of the socket)                                   |
| Metrics          | Deflection, strip rate, latency percentiles, per-model table, cost                                 |
| Billing          | Stripe test-mode checkout + portal                                                                 |

The dashboard never touches tenant provider keys at rest: writes go through
a shared-secret internal API on realtime (the only surface that can encrypt
into the vault), reads return only a suffix. (§3.21–3.22, §9.8)

## Money, quotas, metrics

- **Plans** live in one catalog (`shared/billing/plans.ts`) read by
  realtime (enforcement), web (display), and Stripe checkout — free is 200
  answers/day and 1 source; the deployed demo runs an org on `pro`.
- **Quotas are enforced pre-flight**: `usage_daily` counters are written in
  the same transaction as the answers they count and read as one
  primary-key lookup before every model call. A deployment override can
  only _tighten_ a plan, never widen it. (§3.26)
- **Billing** is Stripe test mode with a hand-rolled signature verifier and
  an event ledger keyed by Stripe's own event id (redelivery applies exactly
  once _by schema_). Entitlement is a column, not a join — a billing outage
  can never reach the answer path. A live Stripe key is refused by name.
  (§3.3.7, §9.15)
- **Metrics** are computed in SQL from columns the pipeline has written
  since day one: deflection (per conversation), strip rate, TTFT/total
  percentiles (refusals excluded — they have no first token), cost per 1k
  answers from a dated price table where unknown prices are `null`, never
  `$0.00`. (§9.13)

## How it's tested (the part that makes the rest believable)

Four rings, all in CI, **zero API keys anywhere in CI** (§3.8, §5.1, §6):

1. **Unit/keyless** — chunker, RRF, verifier, tokens, buckets, parsers,
   robots, retry math (with injected clocks), every provider adapter against
   in-test loopback servers speaking the real wire protocols.
2. **Integration** — the suites run against a real pgvector Postgres:
   migrations and their CHECK constraints at the boundaries, the full answer
   pipeline, the sockets with real WebSocket clients, the multi-tenant
   starvation regression test.
3. **The eval gate** — `npm run eval` ingests the committed corpus, scores
   the golden set with the local embedding model, and fails CI below
   recall@5 = 70.
4. **Black-box probes against the shipped Docker image** — smoke (mounted
   and closed), a 57-check security probe (origin, key states, token
   tamper/replay, tenant isolation with positive controls, SSRF payloads,
   credential read-back denial, socket abuse, rate limits), and an
   injection probe (nine poisoned documents; asserts no uncited text, no
   attacker-controlled citation, no system-prompt leak).

Plus key-gated live suites that light up only when a real provider key is
in the environment, and non-CI measurement harnesses (loadtest,
tenant-scan, ingest-bench, provider comparison, TTFT) whose numbers fill
the README.
