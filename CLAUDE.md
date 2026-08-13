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

**Current milestone: M3 — dashboard, auth, provider onboarding —
UNDERWAY.** M0–M2 are complete: the full
content pipeline in (source → crawl → parse → chunk → embed → store), back
out (query → dense + lexical arms → RRF fusion → ranked chunks), and
retrieval quality MEASURED — an 80-question hand-written golden set scored
for recall@k/MRR/nDCG, enforced as a CI gate, with baselines and failure
analysis published in eval/RESULTS.md. M2 (grounded streaming answers and
the widget) is underway: M2.1 is done — the LLMProvider streaming
interface with a scripted deterministic mock (§2.4.5d–e), the structured
claim-and-span answer contract with its dependency-free validator
(§2.4.4a), and the deterministic span verifier that decides what a visitor
is allowed to see (§2.4.4b). M2.2 is done — chat persistence (migration
003, §3.3.2): conversations, messages, and per-claim citation verdicts,
with transcripts decoupled from mutable pipeline rows by snapshotting.
M2.3 is done — the grounded answer pipeline (§3.15, DATAFLOW §5):
retrieve → gate (min dense distance, NOT the fused score — see §3.15.1) →
delimited prompt → stream → parse with one retry → verify → strip →
persist → claim-granular events, drivable keylessly via `npm run ask`
(§3.16). The SSE route deliberately lands WITH widget session auth (M2.5)
so an unauthenticated LLM-spending route never reaches the auto-deploying
dev branch. M2.4 is done — the real LLM providers (§2.4.5f–i): a generic
OpenAI-compatible adapter with Groq as a named preset, native Gemini
(server-side schema enforcement via responseJsonSchema), and native
Ollama (full-schema `format`), all tested keylessly against in-test
loopback protocol servers and reachable from `npm run ask --llm …`.
M2.5 is done — the widget's public surface (§3.17–3.18, DATAFLOW §5.3):
HMAC session tokens bound to org + origin + visitor, the server-enforced
origin allowlist with allowlist-scoped CORS, per-IP and per-visitor token
buckets, the per-org daily answer ceiling checked before any model call,
and the SSE chat route that serializes the answer pipeline's events —
mounted in every stack and driven keylessly by the context-quoting mock.
M2.6 is done — the widget itself (§8): vanilla TS, Shadow DOM with
`:host { all: initial }` armor, zero runtime dependencies, 3.8 KB gzipped
against the CI-enforced 15 KB budget (§6.2), verified live in a real
browser on all three fixture host pages (Tailwind, Bootstrap, and the
hostile `* { all: unset }` + strict-CSP page — §8.4). M2.7 is done, and
with it **M2 IS COMPLETE**: the refusal threshold is now MEASURED
(§3.15.1 — 0.34 for bge-small, derived from the golden set vs the
40-question adversarial no-answer set via `npm run eval --
--sweep-threshold`, full analysis in eval/RESULTS.md), and the demo
surface exists (§3.20): GET /demo wears the widget over the Fastify
corpus and GET /widget.js makes this service the bundle's origin
fallback, both shipped in the prod image and smoke-probed. The live
browser check of the demo also caught and fixed a real widget race
(§8.1 — concurrent session mints forking the visitor identity). The
DEPLOYED demo needs only Xavier's free-tier keys: the runbook is in
render.yaml's comments. M3 is underway. M3.1 is done — the web/ dashboard
package exists (§9): a hand-rolled Next.js App Router skeleton (Next 16,
not the plan's Next 15 — §9 records why), strict TS, plain CSS, wired
into CI (typecheck, tests, `next build`). M3.2 is done — session auth
ported from the whiteboard (§9.4–§9.6, DATAFLOW §7): scrypt passwords,
HIBP breached-password screening, AES-GCM email-at-rest with a slow-KDF
blind index, sha256-hashed session tokens in an httpOnly SameSite=Lax
cookie, signup/login/logout as Server Actions, and requireUser() gating
the dashboard — the schema types moved to shared/db (§2.4.6) so web
types its queries against the same contract realtime does. The whole
loop is verified by a DB-gated integration suite AND live in a real
browser. M3.3 is done — org onboarding (§9.7, DATAFLOW §7.6–§7.7): org +
owner membership + publishable widget key created in one transaction,
the org-scoped dashboard at /dashboard/[orgId] behind requireOrgMember
(non-members get a 404 that reveals nothing), and newPublishableKey in
the shared id registry (§2.4.1) because the pk format is a cross-package
contract with realtime's session route. M3.4 is done — the credential
vault (§3.3.3, vault + validate §3.21, internal API §3.22,
web surface §9.8, DATAFLOW §7.8): tenant provider keys tested with a
LIVE round-trip before save, AES-256-GCM encrypted under a realtime-only
master key, displayed only as a suffix, guarded by a read-back denial
test and an SSRF vet on tenant base URLs; the dashboard's provider page
drives it through a shared-secret server-to-server API that simply does
not mount unconfigured. M3.5 is done — saved credentials now ANSWER
(§3.21's resolve.ts, DATAFLOW §5.3): the chat route resolves the org's
generation credential per request — decrypted inside realtime for the
request's lifetime, deliberately uncached so rotation bites on the next
question — with the env mock as the fallback that keeps the demo org and
CI keyless; proven by an SSE round-trip through a loopback tenant
provider plus the tenant-isolation and credential-removal cases.
M3.6a is done — sources and the ingest loop went live (§3.22's enqueue
route, §3.10.5's wake-driven mode, §9.9, DATAFLOW §7.9): the dashboard
connects a crawl/sitemap source, the internal API vets it (same SSRF
seam as credentials) and enqueues source + job in one transaction, and
the enqueue WAKES the worker — production (render.yaml) now runs the
worker with INGEST_POLL_MS=0, no timer at all: one boot tick for
deploy-stranded jobs, then the dashboard's enqueue IS the scheduler and
Neon sleeps between ingests. Progress streams back through the sources
page's conditional auto-refresh. Verified live end to end: two real
public pages crawled — one recovered by the boot tick, one by the wake
path — with the UI flipping to "indexed" unattended. M3.7 is done — conversations and citation verdicts (§9.10, DATAFLOW
§7.10): the transcript view renders every claim's verdict, VERIFIED AND
STRIPPED ALIKE, so the tenant sees what the verifier refused to show
their visitor — the M2 thesis made visible in the product rather than
only in tests. M3.8 is done, and with it the dashboard is
SELF-SUFFICIENT (§9.11, DATAFLOW §7.11): the origin allowlist —
trust-model layer 1 — is managed from the UI, with pasted URLs
normalized to the exact origin a browser will send, and the install page
carries the snippet and the two CSP directives a locked-down host needs.
Nothing about running the product now requires SQL by hand. M3.6b is
done, and with it **BYO-provider is COMPLETE in both roles**: the remote
embedding adapters exist (§2.4.5j–m — Gemini native with the
Matryoshka-reduced dimension that fits halfvec(1024), the generic
OpenAI-compatible batch endpoint, and Ollama's native /api/embed), the
credential path validates them with a REAL embedding whose measured
dimension it stores (§3.3.3, §3.21), and both ends of
retrieval run under the org's model from that one row — the ingest
worker per job (§3.10.5) and the chat route per question (§3.18) — with
a model change re-queueing the org's sources inside the same transaction
that changed the credential (§3.22). **M3 IS COMPLETE.** The schema was
then FLATTENED (§3.3): the five migrations that built it collapsed into one
baseline, a one-time cost taken while the product is still pre-launch.
M4 (human handoff) is underway. M4.1 is done — the escalation transition
(§3.3.4, §3.23, DATAFLOW §8): a conversation becomes a person's exactly
once, idempotent by SCHEMA rather than by application deduplication, and
the bot then stays out of the thread while still persisting everything the
visitor types, because that is what the waiting agent needs to read.
M4.2 is done — the socket that carries the conversation (§2.4.7, §3.24,
§3.25, DATAFLOW §8.3): identity at UPGRADE via a single-use 60-second
ticket, because a browser cannot put a credential in a WebSocket
handshake's headers and a URL is the worst place in the system to keep
one; an agent attaching IS the claim; and every message is persisted
before it is broadcast, with the sender's role taken from the ticket and
never from the frame. M4.3 is done, and with it the socket PROTOCOL is
complete (§2.4.7, §3.25, DATAFLOW §8.4): a client that drops gets the
conversation back on attach — the bot's half included, because that is
what an arriving agent needs to read — delivered exactly once even when
messages land during the attach itself, and on Postgres's clock so replay
and live frames merge into one correctly ordered thread; and typing
travels as an ephemeral, self-expiring hint that touches no table, is
never echoed to its sender, and cannot be turned into a broadcast storm
by a per-keystroke client. M4.4 is done — the VISITOR's end of that
protocol (§8.1b–§8.1c, DATAFLOW §8.5): a refusal now offers a person, the
panel switches from the bot to the socket, and the widget survives losing
its connection because a ticket is single-use and a reconnect is simply a
fresh mint. Verified live in a real browser against the Tailwind fixture,
with a scripted agent standing in for the inbox that does not exist yet:
refusal → escalate → the transcript replayed over the local thread → a
message echoed back from the server rather than rendered optimistically →
the agent's arrival flipping presence and claiming the handoff exactly
once → "Support is typing…" appearing and self-expiring at its TTL → and
the server KILLED mid-conversation, after which the widget reconnected on
its own and its next message persisted through the new process. The
bundle is 5.65 KB gzipped against the 15 KB budget. Still open in M4: the
agent inbox in the dashboard — the last consumer of the protocol — and,
recorded honestly rather than half-built, resuming a handoff across a page
RELOAD (the widget keeps its conversation id in memory only; DATAFLOW §8.5
states what that costs). The one package in the plan but not here —
loadtest/ — arrives with the inbox.

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
The root is a tooling package only: it owns the test runner and typecheck
scripts for the package-less source folders — `shared/` (§2.4),
`providers/` (§2.4.5), and `eval/` (§7) — and nothing else. Application
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
this file, keeping the registry in one reviewable place. Since M3.3 the
file also mints `newPublishableKey` (`pk_live_<32 base32>`): the pk VALUE
format is a cross-package contract — realtime's session route gates on the
`pk_` prefix and looks the value up verbatim — so it lives beside the id
formats rather than in web/, its only minter; a test pins that a pk can
never pass as an api_keys row id.

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

#### §2.4.4 `shared/grounding/` — the claims contract and the verifier

The project's thesis as code: the model answers with structured CLAIMS,
each naming the retrieved chunk it came from and quoting the verbatim span
it relies on; deterministic code verifies the quote actually occurs there
and strips what doesn't check out BEFORE the visitor sees it. Lives in
shared/ because both sides of the wire touch it: realtime verifies and
strips, the widget renders the surviving claims and their citations.

##### §2.4.4a `shared/grounding/claims.ts`
The answer contract: `Claim` (`text` + `chunkId` + `quote`), flat and
one-citation-per-claim on purpose — a claim needing two sources is two
claims, because multi-citation claims make the strip decision ambiguous
(strip on ANY failure? on ALL?) and one quote per claim keeps "unverified →
stripped" a single deterministic rule. There is deliberately NO uncited
claim shape: prose the model cannot ground is prose the visitor never sees.
`MAX_CLAIMS` (32) bounds what a looping model can make the verifier pay
for. Three exports beyond the types:
- `ANSWER_JSON_SCHEMA` — the same contract as a JSON Schema, handed to
  providers with native structured output (`LLMRequest.responseSchema`).
  The validator stays the source of truth (native enforcement ranges from
  real to advisory); a test pins schema and validator together at the two
  facts that would drift first (required fields, claims cap).
- `parseAnswerPayload` — hand-rolled structural validation (shared/ is
  dependency-free; the contract is smaller than a schema library). Collects
  EVERY error with path-prefixed messages ("claims[2].quote: …") because
  the pipeline gets exactly one retry and the retry prompt pastes the full
  list.
- `parseAnswerText` — raw model text → payload. Tries the text as-is, then
  the inside of a ``` fence, then first-{-to-last-} (models wrap JSON in
  fences and preambles no matter how firmly told not to; the brace slice
  also rescues a stream cut off before its closing fence). Escalation
  cannot false-positive: every candidate must survive JSON.parse AND the
  structural check — fallbacks rescue formatting noise, never shape errors.

##### §2.4.4b `shared/grounding/verify.ts`
The deterministic citation check. `findQuote` locates a quote in a chunk
tolerating ONLY whitespace differences (same stance as eval/resolve.ts's
anchor matching, same reason: stored text hard-wraps at the source's whim)
— case stays significant because a quote is a quotation. Implemented as an
escaped-literal regex with whitespace runs generalized to `\s+`, because a
squash-both-sides indexOf would confirm presence but lose RAW offsets, and
the offsets are the point: message_citations (M2.2) stores them so the
dashboard highlights the exact span and `chunk.charStart + start`
deep-links into the source document. `verifyClaims` checks each claim
against the chunks the model was ACTUALLY shown (a citation to unretrieved
content is unauditable even if the text exists somewhere in the corpus)
and splits failure into `unknown_chunk` (fabricated id) vs
`quote_not_found` (real chunk, misquoted) — the metrics story needs them
separately. `displayableClaims` is the strip policy as ONE named function:
only verified claims reach the visitor; centralizing it means the
product's core promise has exactly one implementation to cite and test.
The test suite pins the cross-chunk cheat (right quote, wrong attribution
→ stripped), offset boundaries (start of chunk, end of chunk, whole-chunk
quote), regex metacharacters as literals, and first-occurrence
determinism.

##### §2.4.4c `shared/grounding/events.ts`
The answer-stream wire protocol (`AnswerEvent`): meta → claim×N | refusal
→ done. Claim-granular BY DESIGN: a claim is the smallest unit that can be
verified, so it is the smallest unit that may reach a visitor — raw model
deltas can never be forwarded because stripping happens before display.
Today the pipeline emits after collecting the full response; an
incremental claim parser can later emit each claim the moment it verifies
WITHOUT changing this protocol — that future-proofing is the reason the
protocol is claim-granular rather than delta-granular. The M2.5 SSE route
serializes these verbatim; the widget consumes them.

#### §2.4.7 `shared/handoff/protocol.ts`
The handoff socket's wire protocol (M4.2) — the human half of the
conversation, where §2.4.4c's AnswerEvent is the bot's. In shared/ for the
same reason: three packages speak it (realtime produces and consumes, the
widget is the visitor end, the dashboard the agent end).

Deliberately tiny and SYMMETRIC: both ends send the identical frames
(`{type:"message", text}` and `{type:"typing", active}`), and the server is
what knows who is talking. A client that could declare its own role would
be a client that could impersonate an agent, so role is never an input,
only an output — the socket takes it from the ticket. Server frames are
`ready` (who you are + the handoff's state; a client that never gets one
did not authenticate), `message` (broadcast to EVERYONE including the
sender, so both ends render one order from one source of truth rather than
guessing whether their own message landed), `presence` (a COUNT, not names
— a support agent's identity is the tenant's to disclose, not ours), and
`error`. Errors here carry a reason, unlike the public SSE stream's opaque
one, because both ends of this socket are authenticated parties.
`MAX_HANDOFF_MESSAGE_CHARS` (4000) is the socket's equivalent of app.ts's
64 KB body cap.

M4.3 added the two frames that make a dropped connection survivable and a
silence legible, and each is shaped by what it is NOT:

- **`history`** is a separate frame from `message`, not a burst of them,
  because a replayed message is not a new event: a client receiving the
  backlog as `message` frames would double-render everything it still had
  and ring a notification for prose from an hour ago. One frame is
  something a client renders OVER its thread instead of appending to. Its
  entries carry `HandoffTranscriptRole`, which is WIDER than the socket's
  own role union — the bot's answers are in there as `assistant`, because
  what the bot already told this visitor is most of what an arriving agent
  needs to read, and relabelling those turns would misattribute them.
  Bounded by `HANDOFF_HISTORY_LIMIT` (50): an upgrade must not become an
  unbounded transcript download, and the dashboard already has the full
  record over HTTP (§9.10).
- **`typing`** is never persisted, never replayed, and never echoed to its
  sender — the transcript is the record of what was SAID, not of what
  someone nearly said, and a client knows it is typing. It carries a role
  rather than a name, for presence's reason. The self-expiry is a
  CONTRACT rather than server state: `TYPING_TTL_MS` (6000) is how long a
  receiver may hold the indicator without a refresh, `TYPING_HINT_INTERVAL_MS`
  (2000) how often a still-typing client re-asserts it. TTL > 2× interval
  so one dropped or throttled frame makes the indicator flicker rather
  than lie, and a socket that dies mid-sentence cannot leave "an agent is
  typing…" on screen forever — the phantom-participant problem the
  heartbeat solves for presence, solved here without a timer per socket.

#### §2.4.6 `shared/db/schema.ts`
The hand-written Kysely types for every table — MOVED here from
realtime/src/db/ in M3.2, when the dashboard started querying the same
database and the table shapes became a cross-package contract like the
wire protocol. The lockstep rule is unchanged (any migration touching a
table updates this file in the same change), and so is ownership:
realtime's migrations remain the only thing that changes the database —
web never migrates. kysely is a TYPE-ONLY import, erased at compile time,
so shared/ stays dependency-free at runtime; each consumer resolves the
types from its own node_modules, and the root package carries kysely as a
devDependency purely so `typecheck:shared` can see it — the exact
arrangement fastembed has for providers/local.ts (§2.4.5c).

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
dimension, pre-padding), and batch-first `embed(texts, options?)` —
batch-first because free tiers rate-limit per REQUEST, and a single-text
convenience method is how N-requests-for-N-chunks code gets written.
`EmbedOptions` arrived with the remote adapters (M3.6b) and carries two
things the local implementations never needed: a `task` hint
("document" | "query"), because asymmetric retrieval models place a
QUESTION and a PASSAGE into the same space from different sides — Gemini
exposes exactly that as taskType, and using the wrong one is free recall
thrown away — and an AbortSignal, because Node's fetch has NO default
timeout and a provider that accepts a connection then goes quiet would
otherwise hang a request handler or a worker tick forever. `DIM_UNKNOWN`
(0) is what a remote adapter reports before its first response: a
self-hosted model's dimension is a machine fact, discovered once at Test
time and then persisted (§3.3.3) so every later construction can DECLARE
it and assert against it.

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

#### §2.4.5d `llm/types.ts`
`LLMProvider`, the generation-side sibling of §2.4.5a: `model` (the key of
the provider-comparison table) and `stream(request)` yielding deltas then
EXACTLY ONE terminal `done` event. Streaming-first because TTFT is the
widget's headline metric — a Promise interface would make streaming a
per-provider afterthought, while collecting deltas is trivial.
`LLMRequest` carries messages, maxTokens (the cheap defense against a
runaway generation spending a tenant's quota), temperature (pipeline
passes 0 — reproducible runs make schema-violation rates measurable),
`responseSchema` (mapped to each provider's native structured-output
support, which ranges from real enforcement to "please emit JSON" — so
callers MUST still validate via §2.4.4a), and an AbortSignal (a visitor
closing the widget must stop spending the tenant's tokens). `done` carries
finishReason — a `length` cutoff mid-JSON is why the parser sees truncated
output, counted separately from JSON indiscipline — and usage, null where
providers don't report it on streams (cost metrics treat null as unknown,
never zero). Implementations throw on transport failure; retry/backoff
belongs to the caller, same division of labor as embed().

#### §2.4.5e `llm/mock.ts`
Scripted deterministic LLM for tests and CI, with one deliberate
difference from the embedding mock: embeddings can be DERIVED from input
(hash → vector), but a mock completion faking the answer pipeline must be
exact JSON grounded in exact chunks, so tests SCRIPT each response.
Responses are consumed in call order; a call past the script's end throws
(an extra call is usually an unexpected retry — worth a loud failure).
`calls` records every request verbatim so pipeline tests can assert what
was SENT — is the context delimited, is the schema attached. Default
deltaSize is 7, deliberately odd so word/JSON-token boundaries almost
never align with delta boundaries and a consumer that parses per-delta
instead of per-buffer breaks loudly. The abort signal is checked before
EVERY yield, or cancellation tests would pass vacuously after delta one.
Besides the scripted list there is a RESPONDER mode (a pure
request→response function) for callers that cannot know retrieval results
before the call — the askDev CLI (§3.16) uses it to derive grounded
claims from the prompt it receives, keeping the full loop keyless.

#### §2.4.5f `llm/http.ts`
Shared plumbing for the HTTP providers, zero imports (fetch/streams are
Node 22 globals — providers/ keeps its no-package-json rule without even
a dynamic import). `LLMHttpError` carries status + retryAfterMs so the
M2.5 queue can implement backoff policy without string-matching, and its
message includes a truncated response body but NEVER request headers or
the URL (a misconfigured base URL could embed credentials, and errors end
up in logs) — the 429 test asserts the key is absent. `postStream` is the
single point where provider requests leave the process. `byteLines` runs
TextDecoder in streaming mode because socket chunk boundaries land
mid-multibyte-character — a test splits "café" inside the é to pin it.
`sseData` is deliberately minimal (one JSON document per data line — the
only shape these APIs emit; event/id/retry handling would be dead code);
`ndjsonObjects` is Ollama's framing.

#### §2.4.5g `llm/openaiCompatible.ts` + `llm/groq.ts`
The generic OpenAI-compatible chat adapter — one implementation covering
Groq, OpenRouter, Together, vLLM, LM Studio, and Ollama's compat
endpoint: exactly the one-adapter-for-N-providers trade the plan calls
out. responseSchema maps to `response_format: json_object` — the lowest
common denominator (enforcement is "please emit JSON", which is why the
pipeline validates and retries); json_schema variants are deliberately
NOT attempted generically, support being too fragmented. jsonMode:"none"
exists for servers that reject response_format outright. Reasoning-model
side channels (delta.reasoning_content) are dropped: deliberation is not
answer text. Usage reads both the standard field and Groq's x_groq
placement. GroqProvider is a named PRESET of this adapter (base URL,
llama-3.3-70b default, json_object, error label) — a subclass so a Groq
quirk has an obvious home, with an instanceof test pinning that no
duplicate stream loop exists.

#### §2.4.5h `llm/gemini.ts`
Native, not compat, for one load-bearing reason:
`generationConfig.responseJsonSchema` takes our standard JSON Schema
VERBATIM and enforces it server-side — the strongest structured-output
guarantee of any supported provider (the older responseSchema field wants
Gemini's OpenAPI dialect; a lossy translation we refuse to maintain).
The pipeline still validates — trust isn't transitive — but Gemini's
near-dead retry path makes the per-provider schema-violation metric a
comparison instead of a constant. Dialect mapping: system messages →
systemInstruction, assistant → "model" turns, STOP/MAX_TOKENS →
stop/length. Auth rides the x-goog-api-key HEADER, never ?key= — URLs
land in logs, and the test asserts the URL is key-free.

#### §2.4.5i `llm/ollama.ts`
The self-hosted path, speaking native /api/chat (NDJSON) rather than
Ollama's compat endpoint because the native `format` field takes a FULL
JSON Schema and constrains generation server-side — the reason a small
local model can hold the claims contract at all. No apiKey (Ollama is
unauthenticated); no default model (what is pulled locally is a machine
fact this file can't guess). The SSRF note that matters: today the base
URL is developer-supplied; when tenants supply their own (M3), vetting
happens at the realtime boundary through the safeFetch hostGuard seam
BEFORE a provider is constructed — the defense belongs where the URL
enters the system. A down-server test pins that connection failure
throws rather than hangs.

#### §2.4.5j `embedding/http.ts`
Shared plumbing for the remote embedding adapters (M3.6b), and only one
verb: `postJson` — embedding APIs answer in one shot, so there is no
streaming twin of §2.4.5f's postStream. It is implemented ON postStream
rather than beside it, which keeps the non-2xx path (truncated body,
Retry-After, and the rule that a message never carries headers or the
URL) at exactly one implementation and one test. The error class is
deliberately the SAME `LLMHttpError`: "a provider's HTTP endpoint
refused" is one failure shape with one pair of fields callers act on, and
§3.21's validator maps it to a human sentence once for both roles — a
parallel EmbeddingHttpError would double that surface to say the same
thing (the LLM prefix is historical; that side landed first). Two
helpers carry the invariants every adapter shares: `toVector` rejects the
two shapes that would otherwise reach Postgres as corruption (a
base64-encoded embedding — some servers default to it — and a null entry
inside an otherwise-2xx response), and `assertBatch` enforces one vector
per input text in order, uniform length, and equality with the DECLARED
dimension when there is one. That last check is what finally cashes
§3.3.1's promise that `dim` exists "so code can detect a model
whose dimension changed out from under stored vectors": a provider that
starts answering 1536 where it answered 768 stops the ingest loudly
instead of quietly filling one org's index with a second vector space.

#### §2.4.5k `embedding/gemini.ts`
The hosted embedding default — the only provider in the plan's table
offering real embeddings on a free tier without a card. Two decisions
carry the file. **outputDimensionality, always**: `gemini-embedding-001`
is natively 3072-d and the storage column is halfvec(1024) (§3.3.1's
free-tier arithmetic), so the native output simply does not fit; the
model is Matryoshka-trained and 768 is one of the sizes Google documents
for it, so we ask for a size the model was trained to produce rather than
truncating one it wasn't. Widening the column instead would triple every
row and index entry for the one provider that needs it. **Re-normalizing
afterwards**: only the full 3072-d output comes back unit-length. Cosine
ranking is scale-invariant so this is not correctness for THIS index, but
the zero-padding proof (§2.4.2), halfvec's fp16 range, and any future L2
or inner-product index all assume unit vectors. taskType is honored
(§2.4.5a), auth rides the x-goog-api-key header (never `?key=`, asserted
by a test), and the model name is repeated on every sub-request because
batchEmbedContents requires it there as a full resource name.

#### §2.4.5l `embedding/openaiCompatible.ts`
The generic `POST /embeddings` adapter — the same one-implementation-
covers-N-providers trade as §2.4.5g, reaching Together, OpenRouter, vLLM,
LM Studio, text-embedding-inference, and Ollama's compat endpoint. Results
are ordered by the response's `index` field rather than by arrival, since
a silent reordering would misattribute every chunk's vector to its
neighbour and look like retrieval simply being bad. Two deliberate
omissions: it never sends `dimensions` (the parameter means something
only for Matryoshka-trained models, and compat servers disagree about
whether an unknown field is ignored or a 400 — so an oversized model is
REFUSED at the Test button with a sentence naming the fix, §3.21, rather
than silently truncated), and it ignores the task hint (the OpenAI
embeddings API has no field for it; models wanting an asymmetric prefix
expect it in the text, which is the tenant's choice of model to make).

#### §2.4.5m `embedding/ollama.ts`
The self-hosted, zero-cost path, speaking native `/api/embed` — chosen
over the older `/api/embeddings` because it is the BATCH endpoint, and
this interface is batch-first precisely because per-request cost is what
kills an ingest run. No apiKey (Ollama is unauthenticated). The base URL
is tenant-supplied and therefore an SSRF vector; it is vetted at the
realtime boundary before the adapter is ever constructed — the seam
§2.4.5i promised, now with a second caller.

### §2.5 `render.yaml`
The Render deployment as code (a "Blueprint"): one free-tier Docker web
service building `realtime/Dockerfile` with the repo root as context,
health-checked on the DB-free `/api/health`, deploying the `dev` branch on
every push (flip to `main` when the demo should track releases). Neon
connection values are marked `sync: false` — Render prompts for them in its
dashboard; secrets never enter the repo. Exactly ONE service by design: the
free tier's ~750 instance-hours/month keep one service always warm, not two
(the M3 dashboard goes to Vercel instead). Since M3.6a `INGEST_WORKER` is
"1" with `INGEST_POLL_MS=0` — the wake-driven mode §3.10.5 explains: no
timers, one boot tick, the dashboard's enqueue is the scheduler, Neon
sleeps between ingests. Since M2.5 it
also declares `WIDGET_TOKEN_SECRET` (sync: false — set in the Render
dashboard so widget sessions survive deploys; unset would silently log
visitors out on every deploy) and pins `LLM_PROVIDER=mock` until per-org
BYO credentials exist (M3) — honest for a stack that has no tenant keys
yet; the file's runbook comment is the four-step recipe for flipping the
deployed demo to a real provider, and `GROQ_API_KEY`/`GEMINI_API_KEY`
are declared `sync: false` so Render PROMPTS for them rather than
requiring a hand-added variable — the same names the CLI, the local
fallback, and the key-gated live suite read, so nothing is kept in sync.
Since M3.4 it also declares the internal-API pair (INTERNAL_API_SECRET +
CREDENTIAL_MASTER_KEY, both sync: false) with its own runbook: leave
BOTH empty until the Vercel dashboard deploys — while unset the
/internal/* routes do not exist, and server.ts refuses the
half-configured state at boot.

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

| Table | Purpose | Notable constraint |
|---|---|---|
| `organizations` | tenants | `plan` CHECK; `char_length(id) = 36` |
| `users` | dashboard logins | email stored encrypted + blind index (columns predate the code because retrofitting encryption is a data migration) |
| `org_members` | user↔org + role | **partial unique index: one owner per org** |
| `sessions` | dashboard sessions | id IS sha256(cookie token) — a DB leak can't be replayed as logins |
| `api_keys` | widget pk/sk credentials | one CHECK makes kind/column mismatches unrepresentable; uniqueness among live keys only (`WHERE revoked_at IS NULL`) so rotation revokes instead of deletes |
| `allowed_origins` | widget origin allowlist | regex CHECK rejects paths/trailing slashes — a stored `https://a.com/` would silently never match a browser `Origin` header |

### §3.3.1 The content pipeline tables
What the ingest worker reads and writes, and what retrieval queries.

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

| Table | Purpose | Notable decision |
|---|---|---|
| `conversations` | one widget chat thread | `status` carries `'escalated'` from day one (M4 adds the mechanism; the M2 widget must already render the state, and enum growth is a migration); `(org_id, last_message_at DESC)` index IS the dashboard's conversation list |
| `messages` | one turn | `org_id` denormalized (M5's pre-flight usage cap counts answers per org per day — the hot path can't afford a join); three role CHECKs pin model/refused/score/latency to the assistant role, making mismatches unrepresentable (the api_keys pattern); `ttft_ms`/`total_ms` instrumented from day one |
| `message_citations` | one verdict per claim | see below — the snapshot decision |

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
  *fast* (the sub-second health assertion also guards "someone added a DB
  call to the liveness route").
- `db/__tests__/migrate.test.ts` — integration suite, self-gated on
  `POSTGRES_PASSWORD` (green on a machine with no DB, lights up in compose/
  CI). Asserts: all tables exist, pgvector installed, idempotent re-run,
  bookkeeping matches the registry, and the three interesting constraints
  reject invalid rows **at their boundaries** (second owner rejected while
  second agent accepted; mismatched api_key kind; origin with a trailing
  slash).
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
- `widget/__tests__/sessionToken.test.ts` + `rateLimit.test.ts` —
  keyless. Tokens: round-trip, the expiry boundary (valid at exp−1,
  rejected AT exp), tampered payload and signature, wrong secret,
  malformed garbage, and validly-signed-wrong-shape. Buckets: exactly
  capacity takes then denial, refill at the boundary, long-absence caps
  at capacity, key independence, hammering recovers on schedule, sweep.
- `routes/__tests__/widget.test.ts` — DB-gated, drives a REAL http
  listener. Session: allowlisted mint with CORS echo, unlisted origin
  rejected WITHOUT CORS, missing Origin, unknown/revoked keys collapse
  to one uniform 401, preflight, per-IP mint flood. Chat: the grounded
  SSE stream end to end (meta/claim/done with citations, persistence
  under the token's visitor), uniform 401 for missing/tampered/expired/
  wrong-secret tokens, token replay from a different origin, question
  length edges, own-conversation continuation vs the cross-visitor
  hijack probe (opaque error event, nothing to learn), malformed
  conversation ids, the daily cap 429 BEFORE the model call, and a
  rate-limit 429 that still carries CORS. Escalate (M4.1): the queue place
  taken once and reported idempotently with CORS on the real response, the
  bot falling silent on the next question, the cross-visitor hijack and a
  fabricated id both 404 with nothing written, and bad token / malformed
  id / replayed origin all rejected before any write.
- `handoff/__tests__/escalate.test.ts` — DB-gated. The transition and its
  record moving together; idempotence (a second request reports the first,
  and does not rewrite why the visitor is waiting); the CONCURRENT
  double-escalation — five simultaneous requests must yield one row, one
  `created: true`, and no error — which is the only way to show that
  idempotence comes from the index rather than from the read above it; the
  three not-found shapes collapsing to one; a closed handoff followed by a
  new one (the index is over OPEN rows precisely so a conversation can come
  back); and deleting an agent MID-handoff, which must succeed and leave
  the record intact — the test that caught the claimed_by/claimed_at
  invariant (§3.3.4). Plus the schema states that would corrupt the queue:
  active with nobody holding it, closed with no closing time, an unknown
  reason.
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
  helper, which asserts backlog and flushed ids are disjoint.
- `credentials/__tests__/vault.test.ts` — keyless. Round-trip, AAD swap,
  tamper/garbage rejection, and the NO-dev-fallback stance (missing or
  short CREDENTIAL_MASTER_KEY throws — pinned because email crypto makes
  the opposite choice and someone will one day "align" them).
- `credentials/__tests__/liveProviders.test.ts` — **key-gated**, the
  fastembed pattern (§2.4.5c) applied to providers: each provider's cases
  run only when ITS key is in the environment (`GROQ_API_KEY`,
  `GEMINI_API_KEY` — the same variables the CLI and server fallback read,
  §2.6; there is deliberately no test-only variable to keep in sync).
  What only a real provider can answer: does it accept the exact payload
  the Test button sends and report a resolved model; does the key still
  authenticate after an AES-GCM encrypt/decrypt cycle (a subtle encoding
  or AAD corruption would pass every loopback test and fail only here);
  and does its structured output honor the claims contract — logged
  per-provider so §2.4.5h's "enforcement ranges from real to advisory"
  becomes an observation instead of an assumption. A 429 is reported as
  the free-tier rate limit it is, with the retry delay. With no keys the
  cases skip AND a guard test asserts the keyless default, so "gated off"
  can never be mistaken for "passed". CI sets no keys, by design. Since
  M3.6b Gemini — the only free tier serving both roles — also runs the
  EMBEDDING credential path: that the reduced output dimension we request
  is honored and storable (the whole basis for halfvec(1024)), that a
  batch comes back in order, and that a query embedding really is nearer
  its own passage than an unrelated one — which is both a semantic check
  the mock cannot make and the proof that taskType is doing something.
- `routes/__tests__/internal.test.ts` — DB-gated, real HTTP listener, a
  loopback OpenAI-compatible fake as the tenant's provider (recording
  every request so tests assert what left the process). Pinned: uniform
  empty 401s; 404 for unknown AND malformed org ids; test-without-save
  storing nothing while the round-trip really hit the upstream;
  encrypted-at-rest proof (ciphertext decrypts only under the row id);
  replace-destroys-the-old-ciphertext; the READ-BACK DENIAL (no key
  substring, no ciphertext in the status response); Groq refused for the
  embedding role with zero upstream calls; shape violations rejected with
  zero upstream calls; a failing upstream storing nothing and never
  echoing the key; the PRODUCTION url vet rejecting loopback (the SSRF
  default, asserted by NOT injecting the test seam); and the unconfigured
  app 404ing the whole surface. The M3.6b block adds the embedding role
  end to end against a loopback embeddings endpoint: the dimension is
  MEASURED not declared (the form never asks for one) and stored on the
  row; a 1536-d model is refused with both numbers in the sentence while
  the previous valid credential stays untouched; and the re-index
  contract from all three sides — a changed model queues one job per
  source, a rotated key for the SAME model queues nothing, and removal
  queues a re-index exactly when a row was actually deleted.
- `routes/__tests__/widgetByo.test.ts` — DB-gated. Per-org BYO generation
  in the LIVE chat path: a loopback OpenAI-compatible upstream wrapping
  the context-quoting responder, reached through the REAL adapter with
  the DECRYPTED tenant key (the Authorization header is asserted);
  claims survive the full verify/strip loop and the persisted message
  names the tenant's model. The multi-tenant cases are the point: a
  credential-less org falls back to the mock and never touches the other
  tenant's provider, and a removed credential stops being used on the
  very next question (no cache to serve it stale).
- `routes/__tests__/internalSources.test.ts` — DB-gated. The enqueue
  surface: source + queued job + the wake callback firing; malformed
  inputs (upload kind, non-URLs, embedded credentials, depth out of
  bounds) rejected with ZERO enqueues; the production vet refusing a
  metadata-endpoint crawl target; and the wake-driven worker proof — a
  pollMs-0 worker, idle after its start tick with NO timer in existence,
  runs a job if and only if wake() is called (an upload-kind source's
  fast loud failure is the no-network probe that the tick really ran).
- `routes/__tests__/demo.test.ts` — keyless and DB-free (the demo surface
  is static config → static responses). The configured page carries the
  snippet with same-origin data-api; the unconfigured page is honest
  setup instructions; a hostile publishable key renders escaped; the
  bundle serves with a JS content type and short cache; a missing bundle
  404s with the build hint.
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
  cross-tenant append rejection; blank-question rejection.
- `ingest/__tests__/worker.test.ts` — DB-gated. **Run-book note: bring up
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
  pages, crawl failure and upload-source failure paths.

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
it drives realtime's retrieval code; the *assets* it consumes (corpus,
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

The embedder is ALWAYS the local model. EMBEDDING_PROVIDER=mock is refused
by name with an explanation — the promise made in §2.4.5b: quality
measured over semantics-free vectors is noise, and refusing beats
producing an impressive-looking nonsense table.

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
AnswerSchemaError leaving no assistant row at all.

#### §3.15.4 `src/answer/mockResponder.ts` + `src/answer/buildLLM.ts`
The context-quoting mock responder lives in answer/ (not providers/)
because it knows the prompt format — formatChunk is the other half of its
contract and the two must change together. It is what lets every stack
and the CI e2e job drive the REAL chat route keylessly. buildLLM maps a
provider name to a configured instance — ONE selection table shared by
server boot (LLM_PROVIDER env) and the askDev CLI (--llm flag); a missing
key throws a one-line usage error. Since M3.5 the env selection is the
FALLBACK, not a stopgap: an org's saved BYO credential outranks it per
answer (credentials/resolve.ts), and env selection remains what keeps
every keyless stack — dev compose, prod compose, CI, the demo org —
serving grounded mock answers.

### §3.16 `realtime/scripts/askDev.ts`
Dev-only CLI (`npm run ask -- "<question>" [--org N] [--conversation
con_…] [--llm mock|groq|gemini|ollama] [--tamper]`): the full M2 loop
drivable by hand. Same glue-only rule as the sibling CLIs. The default
LLM is the mock in responder mode (§2.4.5e): it parses the [chunk …]
blocks out of the prompt it actually receives and quotes the top chunks
verbatim — grounded by construction, so verification passes and
persistence/citations/events are all observable keylessly. `--tamper`
corrupts one quote so the strip path is observable too: the tampered
claim is stored quote_not_found and never displayed. `--llm` swaps in a
real provider (§2.4.5f–i), configured by the GROQ_/GEMINI_/OLLAMA_ vars
in .env.example — the first place real model output meets the verifier,
ahead of the M2.5 route; a missing key is a one-line usage error and a
provider 429 prints as a human sentence with the retry delay.

### §3.17 `src/widget/` — session tokens and rate limits (M2.5)

#### §3.17.1 `src/widget/sessionToken.ts`
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

#### §3.17.2 `src/widget/rateLimit.ts`
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

### §3.18 `src/routes/widget.ts`
The only routes an untrusted browser ever calls, implementing the trust
model in layer order. `POST /v1/widget/session`: Origin header required
(absence means a script — no free sessions), per-IP mint bucket, pk
lookup (unknown and revoked collapse into ONE 401 — key state is not
probeable), exact-match allowlist check (failures carry NO CORS headers,
so an unlisted site's browser cannot even read the error), then the
token mint — which is also the handshake that warms Neon while the
visitor types (the free-tier design's DB-warming path). `POST
/v1/widget/chat`: token verify (uniform 401), live-Origin-vs-token-origin
re-check (kills replay from another site), rate limits AFTER auth (their
429s carry CORS so the widget can render "one moment") and BEFORE work,
then the daily ceiling counted from messages via the (org_id,
created_at) index — model spend, not conversation length, refusals
included — then SSE. Since M3.5 the answer's LLM is resolved per request
from the org's BYO credential (credentials/resolve.ts) with the
app-level provider as fallback, and since M3.6b the query EMBEDDER is
resolved the same way — not as a preference but as a requirement, since
the question must be embedded by whatever model embedded the org's
chunks; the ingest worker reads that same row, so the two cannot drift.
Headers flush before retrieval so TTFB
precedes the slow work; a closed tab aborts the pipeline mid-generation via
AbortController; every failure past the SSE boundary is one opaque
{type:"error"} event (failure detail on a public stream is
reconnaissance — including hijack probes of another visitor's
conversation id, which learn nothing but "error"). CORS is hand-rolled
(~15 lines for two routes) and preflight grants nothing: enforcement
rides on the actual request's response headers.

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
  exactly the geometry that made it worth storing. Groq + embedding is
  refused by name (it has no such endpoint at all — a gap worth stating
  rather than turning into a confusing 404). `effectiveEmbeddingModel`
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
  the product working while serving nonsense. An 'anthropic' row (schema
  forward-provision, unreachable through validate.ts) also throws by
  name. `resolveEmbeddingProvider` is the twin, and it buys the property
  nothing else in the system enforces: the ingest worker and the query
  path call the same function on the same row, so a tenant's chunks and
  their visitors' questions land in the SAME vector space by
  construction rather than by two settings happening to match. It passes
  the stored `dim` straight through, which is what turns each response
  into an assertion instead of a discovery.

### §3.22 `src/routes/internal.ts` — the dashboard's server-to-server API

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

Since M3.6a the surface also owns source enqueueing: POST
/internal/orgs/:orgId/sources vets the location through the SAME url-vet
seam (a crawl target is a tenant-typed URL this server will fetch — the
credential-base-URL threat exactly; safeFetch re-vets every actual fetch
with its connect-time hook), mirrors the schema's depth cap as a
sentence instead of a constraint violation, writes source + queued job
in one transaction, and then calls onEnqueue — which server.ts wires to
the worker's wake(). In production that callback is the entire
scheduler (§3.10.5).

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

Shutdown ordering matters and server.ts handles it: sockets are terminated
BEFORE `server.close()` can finish, because an open WebSocket is a live
connection and http.Server.close waits for every one — a deploy would
otherwise hang until Render's kill timeout with browsers still holding
sockets.

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
(Corollary, learned the hard way: bring up ONLY the database service when
running the DB-gated test suite — §3.8's worker-test note.) Both stacks
also mount the widget surface: dev passes through LLM_PROVIDER and the
provider keys from .env (mock default), prod pins LLM_PROVIDER=mock so
the e2e job drives the real chat route keylessly; token secrets are
ephemeral in both, which is correct for stacks whose sessions should not
outlive them.

### §4.3 `docker-compose.prod.yaml`
Production shape: prod image target, no bind mounts, Postgres **not**
published to the host. This is the stack CI's e2e job boots — the artifact
probed is the artifact shipped.

---

## §5 `.github/workflows/`

### §5.1 `ci.yml`
`verify` (10-min timeout): pgvector service container + per-package
`npm ci` → typechecks (shared, providers, eval, realtime, widget) →
tests (including the widget's jsdom suite) → widget build → the §6.2
size budget; the DB-gated suites run for real here. `e2e` (needs verify): generates a
throwaway `.env`, `compose -f prod up --build --wait`, runs
`scripts/smoke-test.mjs` against the live stack, dumps logs on failure,
always tears down. `eval` (needs verify, parallel with e2e): its own
pgvector service container, fastembed's ONNX model restored from an
actions/cache keyed on the model name (immutable → one download ever),
then `npm run eval` — which ingests the committed corpus, scores the
golden set with the LOCAL embedding model, and exits nonzero below the
recall floor (§3.14). Retrieval-quality regressions are merge blockers,
not vibes. **No API keys anywhere in CI, by design** — fork PRs get the
full pipeline.

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
that unknown routes 404, and — since M2.5 — the widget surface's POSTURE:
a fresh stack has no seeded org, so what a probe can verify is that the
session route is mounted AND closed (no Origin → 403; a 404 would mean
the routes fell off the app, a 200 that the origin gate fell off the
route) and that chat without a session is 401. Since M2.7 it also probes
the demo surface: /demo must be 200 in BOTH states (widget page or setup
instructions — a recruiter must never see a 500) and /widget.js must
serve with a JS content type, proving the bundle actually shipped inside
the image. Since M3.4 it also asserts the internal credential API is
CLOSED from outside in every state — 404 (unconfigured: routes absent)
or 401 (configured: secretless request rejected); anything else means
the admin surface leaks. Failures are counted
rather than thrown so one broken endpoint doesn't mask the state of the
rest; every fetch carries a timeout because a probe that can hang turns a
dead service into a stuck CI job.

---

## §7 `eval/` — the retrieval evaluation assets

The measurement layer that makes retrieval quality a number with a CI
gate instead of a claim. Same no-package-json pattern as shared/ (§2.4):
the root runner owns its tests, `typecheck:eval` its types, and the runner
(realtime/scripts/runEval.ts, §3.14) consumes it through the `@eval/*`
alias. Committed artifacts only — `eval/results/` (per-run droppings) is
gitignored; what IS committed is what someone chose to publish.

### §6.2 `scripts/widget-size.mjs`
The 15 KB gzipped budget as a merge blocker. Gzip, not raw — gzip is what
crosses the wire from any CDN and what a customer's performance audit
sees. The budget is deliberately far above the actual size (~3.8 KB at
M2.6): it exists to flag a dependency creeping in or a framework-shaped
rewrite, not normal growth, and the number printed on every CI run is
what keeps the README's size claim honest.

### §7.1 `eval/corpus/`
The frozen documentation snapshot: 31 Fastify v5.11.3 pages, MIT-licensed,
with LICENSE and PROVENANCE.md recording the exact upstream tag, what was
excluded and why, and the refresh procedure (an upgrade re-verifies every
golden anchor and re-baselines the floor in the same change — there is
deliberately no update script). Files are ingested under their real
fastify.dev URLs so eval citations deep-link to live pages and the same
corpus can seed the M2 public demo. Chosen precisely because it does NOT
make retrieval look easy: 31 pages about one Node web framework share
vocabulary everywhere.

### §7.2 `eval/golden.jsonl`
80 hand-written question → anchor pairs (the plan's floor is 60;
LLM-generated-and-self-graded sets are worthless and interviewers know
it). Each entry anchors to a document URL plus a VERBATIM `mustContain`
substring rather than to chunk ids — chunk ids change whenever chunking
policy changes, and a golden set that breaks on every chunker experiment
would never survive one. Entries carry a `style` tag
(paraphrase/verbatim) so results can say WHICH kind of phrasing fails —
that split is the backbone of RESULTS.md's failure analysis. Questions
were written while reading the corpus, mixing paraphrase phrasing (the
dense arm's strength) with exact-term phrasing (the lexical arm's), the
way real support traffic mixes both.

### §7.3 `eval/metrics.ts`
The scorer: recall@k, MRR@k, nDCG@k (binary gains) plus macro-averaged
`scoreRun`. Pure and database-free, so every metric is pinned by
hand-computed unit fixtures (`__tests__/metrics.test.ts`) — including the
property distinguishing nDCG from the other two (golds packed early beat
golds spread late). Guards throw on the states that would silently corrupt
an average: empty run, empty relevant set (an unresolved anchor), duplicate
ranked ids.

### §7.4 `eval/resolve.ts`
Anchor → chunk-id resolution: squash whitespace on both sides (markdown
hard-wraps at upstream's whim; anchors must survive rewrapping), then
case-SENSITIVE containment — an anchor is a quotation, and case-folding
could bind it to a different sentence than the question was written
against. Returns ALL matching chunks: a sentence the chunker legally
placed twice makes both chunks correct retrieval targets. Returns empty
rather than throwing so the runner can report every broken anchor at once.

### §7.5 `eval/floor.json` + `eval/RESULTS.md`
The committed operating point and the published measurement. floor.json
holds the CI threshold (hybrid recall@5 ≥ 0.70 against a 75.0 baseline —
headroom for cross-machine ONNX/HNSW noise, tight enough that a broken
filter or fusion lands far below). RESULTS.md is the deliverable the plan
calls the strongest seniority signal: the strategy comparison table
(hybrid beats dense on every metric; the lexical arm is honestly weak on
full-sentence questions and the write-up says exactly why), the flat
recall-vs-ef_search curve WITH the explanation of why it is flat at this
corpus size, the 400-vs-800 chunk ablation behind the 400 default, and a
failure analysis that categorizes all 12 misses and commits to not padding
the golden set to bless near-misses.

### §7.6 `eval/noanswer.jsonl`
The adversarial no-answer set (M2.7): 40 hand-written questions the
corpus can NOT answer, in three categories that fail differently —
off_topic (banana bread; lands far away in embedding space), adjacent
(Express/webpack/npm questions that retrieve plausible Fastify text),
and absent_detail (Fastify-flavored facts these 31 pages don't contain:
roadmap, history, pricing). Written AGAINST the corpus: a question only
belongs here if the corpus genuinely can't answer it, which is why there
are no nginx/Lambda/database questions — the Guides cover those. The
per-category split is the backbone of RESULTS.md's finding that the
distance gate separates off-topic perfectly and absent_detail barely at
all.

---

## §8 `widget/` — the embeddable chat widget (M2.6)

Vanilla TS bundled by esbuild into one IIFE, Shadow DOM, ZERO runtime
dependencies — the 15 KB gzipped budget (§6.2) is the package's design
constraint, and M2.6 lands at ~3.8 KB. Own package.json (app packages own
their deps; all four are devDependencies). shared/ contributes TYPE-ONLY
imports (the AnswerEvent wire protocol) that esbuild erases — zero bytes,
one source of truth for the contract.

Since M4.4 shared/ also contributes three VALUES — the handoff protocol's
`MAX_HANDOFF_MESSAGE_CHARS`, `TYPING_HINT_INTERVAL_MS`, and
`TYPING_TTL_MS`. That is not a softening of the no-runtime-imports rule
(§8.1), which is about BEHAVIOR: an SSE parser is reimplemented for browser
streams rather than lifted from the server. A TTL and its refresh interval
are contract — the invariant that makes them correct (TTL > 2× interval)
is a property of the PAIR, so copying the numbers here is exactly the
drift shared/ exists to prevent. esbuild inlines them and no module
survives into the bundle; the one visible cost is that `@shared` now needs
an alias in the widget's esbuild command and vitest config, because
type-only imports were erased before anything had to resolve them.

### §8.1 `src/index.ts` + `src/api.ts` + `src/sse.ts`
The boot and network half. index.ts reads its config off its own
`<script>` tag (data-key / data-api / data-title / data-accent) via
document.currentScript, captures window.fetch at evaluation time (before
any analytics snippet can wrap it — Promise needs no capture: es2020
async functions use the engine's internal Promise, not window.Promise),
guards double-mounting, and degrades a misconfigured snippet to "no
widget", never a broken host page. api.ts speaks the §3.18 route
contract: mint at bubble-open (the DB-warming handshake), the visitor id
persisted in guarded localStorage (Safari private mode throws on ACCESS
— degraded mode is a per-load visitor), ONE silent re-mint on a 401 so
the 30-minute token expiry is invisible mid-conversation, and the two
429 bodies mapped to distinct errors (daily quota is terminal for today;
a bucket limit is "one moment"). sse.ts is the browser twin of
realtime's SSE parser — reimplemented rather than imported because the
widget imports RUNTIME code from nowhere; streaming TextDecoder, frame
buffering, trailing-partial-frame discard. ensureSession is SINGLE-FLIGHT
(one in-flight mint promise shared by every caller) — the M2.7 live demo
check caught the race the unit tests missed: bubble-open's fire-and-forget
mint racing ask()'s awaited mint produced two sessions with two
server-generated visitor ids, and whichever response landed last clobbered
the token that owned the just-created conversation, making every
follow-up ask die "conversation not found". A test now pins
three concurrent ensureSession calls to exactly one mint request.

M4.4 added `escalate`, `handoffTicket`, and `openHandoff` to the same
client, and in doing so factored the 401-re-mint dance into one `#authed`
helper: a 30-minute session expiring while a visitor waits for an agent
must be as invisible on the ticket route as it is on chat, or the socket
would simply stop reconnecting after half an hour. `handoffTicket`
returns NULL rather than throwing when there is no open handoff, because
that is the one answer the reconnect loop must treat as final — a thrown
error is an outage and outages are what the loop is for. `openHandoff`
lives here rather than in ui.ts so the UI keeps knowing nothing about
network configuration; it is the same seam that lets DOM tests inject
scripted answers, now injecting a scripted socket.

### §8.1b `src/handoff.ts`
The visitor's end of the handoff socket (§2.4.7) — sse.ts's sibling: the
protocol is shared, the transport is not. It owns the one fact the UI
should not have to think about, that a socket is not a durable
connection. Tickets are single-use and expire in 60 seconds (§3.24), so a
reconnect is a fresh MINT plus a fresh upgrade; there is no credential
kept anywhere, which is also why a stolen ticket is worthless. Backoff is
exponential with jitter and capped at 8 s, and is reset by the `ready`
FRAME rather than by the socket opening — a connection that opens and
dies before authenticating has made no progress, and treating it as
success is how a reconnect loop becomes a hot loop. The loop is
unbounded, because giving up would leave a waiting visitor staring at a
dead panel; it ends only on `close()` or on the null ticket that means
the handoff is over. Composing hints are throttled here to the protocol's
refresh interval (the server floors them again at 250 ms — a client that
honors the contract never meets that floor), and the incoming indicator's
TTL timer lives here too: the RECEIVER expiring it is precisely why the
server needs no timer per socket.

### §8.1c The handoff UI (in `src/ui.ts`)
Three entry points, one state. The "Talk to a person" offer appears after
a REFUSAL — the moment the product has admitted it cannot help, which the
events protocol names in as many words (§2.4.4c) — and never stacks a
second button. A `handoff` answer event enters the same mode without any
click, which is how a tab that did not escalate catches up (another tab
did, or the page was reloaded mid-handoff). And `ended` leaves it, giving
the conversation back to the bot — literally true server-side, since the
pipeline stops finding an open handoff and answers again.

Two decisions are worth their comments. Sent messages are NOT rendered
locally: the server echoes every message to its sender (§2.4.7), so the
echo is the render — one order from one source of truth, and nothing to
reconcile against the replay. And `history` REPLACES the thread rather
than appending to it, because on attach the server's transcript is the
truth; the honest cost is that earlier bot answers come back as the text
the visitor saw, without the citation links the widget drew the first
time (messages.content is visitor-facing text; the per-claim verdicts
live in the dashboard, §9.10). A send that could not go returns false and
the visitor's words stay in the box — a support message that silently
vanished is worse than one that visibly did not send.

### §8.2 `src/ui.ts` + `src/styles.ts`
The rendering half, built on a three-line element factory with one iron
rule: everything textual goes through textContent, NEVER innerHTML —
claim text is MODEL OUTPUT relayed from crawled documents
(attacker-reachable), and the widget runs inside a customer's page; one
innerHTML would be stored XSS on someone else's site. A test feeds a
literal <img onerror> claim and asserts it renders inert. Citation hrefs
are re-vetted for http(s) (defense in depth over safeFetch's crawl-time
vetting — the widget trusts nothing it didn't compute). The UI consumes
the WidgetClient interface, not ApiClient, so DOM tests inject scripted
fakes. Styling: `:host { all: initial }` severs every inherited property
at the shadow boundary (the armor the hostile fixture proves), px units
only (rem resolves against the HOST page's root font size — exactly the
leak all:initial exists to stop), applied via adoptedStyleSheets
(CSP-exempt constructed sheets) with a <style> fallback; --ir-accent is
the ONE deliberate opening through the boundary (custom properties
inherit), so hosts theme the bubble without a widget API.

### §8.3 Tests (`src/__tests__/`, jsdom)
sse: frame reassembly across network chunks, a multi-byte character
split mid-encoding, non-data frames ignored, trailing partial never
parsed. api: mint-once semantics, visitor-id persistence and reuse,
bearer-token asks, the 401→re-mint→retry dance (and a SECOND 401
surfacing as failure instead of looping), both 429 mappings, escalation
over the same authenticated path, a ticket mint that re-mints the SESSION
mid-wait, and the closed-handoff null vs the 500 that still throws. ui:
shadow isolation (nothing leaks into light DOM), open/greet/warm behavior,
claims with citation links, conversation-id threading between asks, the
XSS and javascript:-href probes, refusal rendering, and all three
failure shapes recovering the input — the widget never bricks.

handoff (M4.4): the socket suite drives a scripted FakeSocket, so a
connection's whole lifecycle is deterministic. Pinned: the ticket rides
the URL and the URL is wss + the mounted path; status follows the
server's frames (ready → waiting, presence → connected and back); history
and live messages reach DIFFERENT callbacks (collapsing them would
double-render a reconnecting client); composing hints coalesce to one
frame per interval and re-announce immediately after a send; the incoming
indicator expires on the RECEIVER's timer with no frame saying so; a send
before `ready` is refused rather than swallowed; a drop reconnects with a
NEW ticket, a null ticket ends it permanently, a FAILED mint keeps
retrying (an outage is not a decision), and close() stops everything. The
UI suite covers the same states through the DOM: the offer appearing only
after a refusal and only once, escalation switching the panel, the
transcript rendering the bot's turns alongside the agent's, sends going
to the socket instead of the bot with unsent text kept, catching up on a
`handoff` event this tab did not start, ending handing the composer back
to the assistant, and the XSS probe repeated for socket text — because
agent prose is as attacker-reachable as model output.

### §8.4 `fixtures/` + `scripts/serve.mjs`
The three host pages the plan requires, each testing a distinct failure
mode: Tailwind (preflight reset), Bootstrap (high-specificity components
+ a fixed navbar; also proves data-accent wins), and hostile —
`* { all: unset }` plus a strict CSP whose every directive is explained
in the page source (connect-src is the ONE thing customers must add;
style-src deliberately excludes anything the widget would need, pinning
the adoptedStyleSheets path). serve.mjs hosts them on :4400 because
file:// sends `Origin: null`, which the allowlist rightly rejects — the
fixtures exercise the SAME origin rules production enforces. Verified
live in a real browser at M2.6: grounded answers with citations on all
three pages, refusal on off-corpus questions, 56px styled bubble under
the hostile reset. Prerequisite: `npm run seed-demo` (§3.19), `npm run
build`, `npm run fixtures`.

---

## §9 `web/` — the control-plane dashboard (M3)

Next.js App Router on Vercel: auth, org onboarding, provider setup,
conversation and document lists — every surface that is short
request/response and form-shaped. Long-lived streams (SSE chat, the M4
handoff WebSocket) and background work stay in realtime/ by design: Vercel
functions cannot hold them open, and the split confines the newer
framework to a CRUD surface where a bug is a bad page while the novel
work runs on the proven stack (the plan's control-plane/data-plane
argument). Hand-rolled, not `create-next-app` — the generated silhouette
is the anti-tutorial rule's first tell, and every config line here is one
we can explain.

**On Next 16, not the plan's Next 15 — a recorded deviation.** At
scaffold time (Aug 2026) the newest Next 15 patch still depended on
postcss and sharp versions carrying high-severity npm advisories
(postcss XSS via unescaped `</style>` in stringified output; sharp's
inherited libvips CVEs), and the fix exists only in Next 16. For a fresh
skeleton the migration cost was zero, the App Router architecture the
plan actually names is unchanged, and a security-thesis project shipping
a dashboard that `npm audit` flags on install would be the wrong trade.
Consequences worth knowing: Turbopack is the default bundler, the JSX
transform is `react-jsx` (Next rewrites tsconfig to say so), and
`next-env.d.ts` is generated per-build with imports into `.next/` — which
is why it is gitignored, not committed (§9.1).

### §9.1 `package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`

- **package.json** — web owns its dependencies (app-package rule, §2.1):
  next, react, react-dom, and dev tooling only. No UI library, no CSS
  framework, no data-fetching layer: RSC + Server Actions are the
  data-fetching layer, and plain CSS is the styling (anti-tutorial rules).
- **next.config.ts** — two jobs. (1) The repo-root .env loader: the repo
  keeps ONE .env (§2.6 is the registry) but Next only reads env files
  inside web/, so the config — evaluated before any worker forks —
  hand-parses the root file into process.env, already-set values always
  winning (Vercel env untouched; missing file a no-op). (2)
  `outputFileTracingRoot` points at the REPO root, because shared/ lives
  one directory up and is imported through `@shared/*` with no build step
  of its own (§2.4); Next's standalone tracing must see it or drop it.
  Also silences the multi-lockfile root-inference warning this flat
  layout triggers by construction.
- **tsconfig.json** — strict like every package, but Next-MANAGED:
  `next build` rewrites the options it mandates (jsx, allowJs,
  incremental, the language-service plugin) and reformats the file, so
  those are accepted rather than fought; our strictness extras
  (noUnusedLocals/Parameters, noFallthroughCasesInSwitch) survive the
  rewrite. `tsc --noEmit` passes on a fresh clone (the generated include
  globs legally match nothing); the generated route types are checked by
  `next build`'s own TypeScript pass, which is why CI runs both.
- **vitest.config.ts** — node environment (Server Components are plain
  functions rendered with react-dom/server; the one client component so
  far is exercised by `next build` and the live-browser check rather
  than jsdom). fileParallelism off for the same reason as realtime's
  config: DB-gated suites share one real Postgres. One trap worth its
  comment: Vite's esbuild default is the CLASSIC JSX transform, and
  Next's components rightly never import React — tests must set
  `esbuild: { jsx: "automatic" }` or every render throws
  "React is not defined".
- **Vercel runbook**: import the GitHub repo in Vercel → set Root
  Directory to `web/` → framework auto-detects as Next.js → deploy the
  `dev` branch. Project env, complete as of M3.8: the POSTGRES_*
  variables (pointing at Neon's POOLED `-pooler` host — serverless
  instances multiply client pools); EMAIL_INDEX_PEPPER and
  EMAIL_ENCRYPTION_KEY, which production REFUSES to boot without
  (§9.6's instrumentation note); INTERNAL_API_SECRET matching Render's
  (§3.22) and REALTIME_INTERNAL_URL pointing at the Render service; and
  NEXT_PUBLIC_WIDGET_API_URL — the widget's PUBLIC base URL, which the
  install page prints into the snippet (§9.11). Zero config files
  needed: `vercel.json` earns a place only when a default needs
  overriding.

### §9.2 `src/app/` — layout, landing page, global CSS

- **layout.tsx** — the `<html>`/`<body>` shell, the site metadata, and
  the ONE place global CSS enters. Server Component; the shell ships no
  client JS.
- **globals.css** — resets and the palette variables only. The accent
  matches the widget's default `--ir-accent` family so dashboard and
  bubble read as one product. Component styling convention: App Router
  CSS imports are GLOBAL, so every page/component ships its own css file
  with class names prefixed by component name ("landing-…") — the prefix
  is the scoping mechanism, same convention as OnlineWhiteboard.
- **page.tsx + page.css** — the landing page: product name, the
  verification thesis in one paragraph, and the two auth links (M3.2
  replaced the M3.1 under-construction note, flipping the test that
  pinned it). Plain `<a>` over next/link ON PURPOSE: the page test
  renders the component outside the Next runtime where Link does not
  render, and prefetch on a two-route site buys nothing.

### §9.3 Tests (`src/app/__tests__/` and `src/lib/auth/__tests__/`)

The landing page renders via `react-dom/server` with no DOM — an RSC is
a plain function, so `renderToStaticMarkup` is the whole harness; pinned:
it renders at all (a thrown render is a blank site) and links to /login
and /signup. The auth suites are §9.5's last bullet.

### §9.4 `src/lib/db/index.ts`

One pg Pool in one Kysely instance — realtime's §3.2 shape, tuned for
serverless: `max` 3 (a Vercel "process" is a warm function instance, and
several × max is the real Neon ceiling — production points at the
`-pooler` host), constructed eagerly at module load (safe: pg defers
connections until the first query, so `next build` evaluating the module
costs nothing), never explicitly ended (the platform freezes instances;
idle timeouts reap connections). Typed against @shared/db/schema
(§2.4.6) — the same contract realtime queries, which is the point of the
move. web NEVER migrates; a missing table means realtime hasn't run.

### §9.5 `src/lib/auth/` — the whiteboard port

The auth layer the plan says to port, file by file — each carries its
original WHY header plus what changed in translation:

- **password.ts** — scrypt via node:crypto (memory-hard, stdlib so zero
  native-build risk), self-describing `scrypt$N$salt$hash` format so cost
  raises never invalidate old hashes. Verbatim port.
- **emailCrypto.ts** — the at-rest scheme: AES-256-GCM ciphertext with
  AAD = userId (a ciphertext moved to another row fails to decrypt — the
  swap attack), plus a SLOW-KDF blind index for lookups (emails are
  low-entropy; a fast HMAC would let a pepper+DB holder enumerate the
  address space cheaply). Two separate secrets on purpose; dev falls back
  to published constants with a warning; production REFUSES to boot
  without real ones. The users table has carried these columns since
  the schema (§3.3) precisely so this port would be code-only.
- **breachedPassword.ts** — HIBP k-anonymity screen at signup (the
  23andMe lesson: correct-but-reused passwords are the attack). Only the
  5-char SHA-1 prefix ever leaves the server; fails OPEN by design (a
  third-party outage must not become a sign-up outage); range URL is
  injectable so tests drive it against a loopback server.
- **validation.ts** — email normalization (trim+lowercase, which the
  blind index then depends on) and password bounds (8–200; the cap
  matters because scrypt hashes the whole input). Common-password
  blocklist kept as a FLOOR under the fail-open HIBP check.
- **session.ts** — token lifecycle against the sessions table: cookie
  carries 256 random bits, the DB stores only sha256(token) as the row
  id, expiry is checked in SQL against the DATABASE clock. Decrypts the
  email at resolve — the one read-path place ciphertext becomes
  plaintext. Deliberately imports nothing from next/headers so it tests
  under plain vitest.
- **cookies.ts** — the Next half session.ts abstains from: httpOnly +
  SameSite=Lax + Secure-in-prod, `__Host-` prefix in production (browser
  refuses the cookie from any subdomain or non-HTTPS setter).
- **user.ts** — registration (validate → HIBP → id-before-row because
  the id is the AAD → encrypt+index → insert, with the UNIQUE index as
  the authority on duplicates so there is no check-then-insert race) and
  authentication (ONE uniform failure string, plus a scrypt decoy burn
  on unknown emails so timing cannot distinguish "no account" from
  "wrong password"). Registration's "already registered" is knowingly
  enumerable — fixing that needs a verification mailer, recorded as
  future work rather than half-done.
- **requireUser.ts** — the RSC gate: `currentUser()` (wrapped in React
  cache() since M3.3 — the dashboard layout renders chrome from it AND
  every page re-asserts it, and layouts don't re-run on soft navigation,
  so the honest double-check would otherwise be a double session query)
  or redirect to /login. Deliberately NO middleware.ts: middleware can't
  reach the database cheaply, and a cookie-presence check there would be
  theater next to the page-level DB-backed check.
- **actions.ts** — signup/login/logout as Server Actions in
  useActionState shape (user errors return as form state; success sets
  the cookie then redirects). CSRF: Next's own action origin check plus
  SameSite=Lax. Logout revokes server-side FIRST, then clears the
  cookie.
- **Tests** — keyless: password round-trip/salting/malformed-stored,
  email crypto round-trip/tamper/AAD-swap/IV-randomization, blind-index
  determinism, validation at its exact boundaries (254/255, 7/8,
  200/201), breach check against a loopback HIBP (asserting only the
  5-char prefix leaves). DB-gated (self-skip without POSTGRES_PASSWORD;
  schema must already be migrated — realtime's suite does that in CI's
  verify job BEFORE the web steps, and ci.yml says so): register →
  at-rest row proof (no plaintext in any column) → duplicate rejection →
  uniform-error authentication → session round-trip with hashed-id proof
  → expiry via the database clock.

### §9.6 `src/app/` auth routes + `src/instrumentation.ts`

- **login/ + signup/** — thin Server Component pages around the ONE
  client component, `components/AuthForm/` (useActionState needs the
  client; the two pages differ only in action, labels, and password
  autocomplete hint). Both redirect an already-signed-in visitor to
  /dashboard. signup imports login's page.css — one authpage shell, no
  duplicate.
- **dashboard/** — restructured by M3.3 into a layout + org-scoped
  routes; see §9.7.
- **instrumentation.ts** — Next's one server-start hook, gated to the
  nodejs runtime: production asserts the email secrets exist at BOOT
  (the lazy readers are only reached from register/login, so without
  this a misdeployed dashboard 500s on the first signup instead of
  refusing to start — the whiteboard shipped that bug; the fix ports
  with it).

The whole loop was verified live in a real browser at M3.2 (dev server +
compose database): signup → dashboard with decrypted email,
document.cookie empty (httpOnly), sign-out → /login, wrong password →
the uniform inline error, anonymous /dashboard → redirect, mixed-case
email sign-in → same account.

### §9.7 `src/lib/orgs/` + the dashboard routes (M3.3)

The org layer, in the lib/auth split: queries in `index.ts` (plain
vitest-testable), Server Actions in `actions.ts`, next/navigation only in
the page guard.

- **createOrgForUser** — org + owner org_member + publishable api_key in
  ONE transaction: an org missing any of the three is corruption, not a
  partial onboarding state. Only the PUBLIC key is minted; the secret
  (sk) key arrives with its consumer (server-side session minting) —
  minting a credential nobody can use would just be something to rotate.
- **getOrgForMember / requireOrgMember** — every org read in the
  dashboard goes through membership, so a cross-tenant page is
  unrepresentable at this layer (the web-side sibling of retrieval's
  org_id filter). Non-members get notFound(), NOT a redirect: a probe of
  /dashboard/org_… must not learn whether the org exists, and a wrong id
  looks exactly the same. Malformed ids fail isId() before any query.
- **validateOrgName** — bounds only (2–64, trimmed); a name is a display
  label, not an identifier.
- **Routes** — `dashboard/layout.tsx` owns the chrome (brand, cached
  currentUser email, sign-out) and deliberately does NOT gate (layouts
  skip re-running on soft navigation; pages own the check).
  `/dashboard` is the router: no orgs → the CreateOrgForm IS onboarding;
  otherwise redirect to the first org, keeping "/dashboard" a stable
  bookmark. `/dashboard/new` (literal segment, wins over the dynamic
  sibling; "new" would fail isId anyway) creates additional orgs.
  `/dashboard/[orgId]` is the overview: plan + role, the publishable key
  shown IN FULL (public by design — the trust model's guarding lives in
  the origin allowlist and rate limits, and saying so on the page is the
  product teaching its own security model), an other-orgs switcher, and
  an honest next-steps map naming which increments unlock providers,
  sources, and the snippet.
- **Tests** — keyless: org-name boundaries (1/2, 64/65), pk format and
  its never-an-entity-id property (in shared's ids suite). DB-gated:
  the atomic create (all three rows, DB-default plan), member access vs
  the outsider/fabricated-id/malformed-id denials all collapsing to
  null, multi-org listing in creation order with distinct keys.

Verified live at M3.3: sign-in → onboarding form (org-less user) →
create → /dashboard/org_… overview with the minted pk and owner badge;
fetch of a fabricated org id under a live session → 404.

### §9.8 `src/lib/realtime/`, `src/lib/providers/`, the providers page (M3.4, M3.6b)

The web half of the credential path. The plaintext key exists web-side in
exactly one flow — FormData → action → lib/realtime request body — and is
never assigned, logged, or stored anywhere else.

- **lib/realtime/index.ts** — the server-to-server client
  (REALTIME_INTERNAL_URL + INTERNAL_API_SECRET; Server Actions only —
  nothing client-side can import env secrets). Missing config is a NORMAL
  state surfaced as a typed "not connected" result, not a crash; a 401 is
  named as an OPERATOR error (secret mismatch) because a tenant retrying
  it forever helps nobody. cache: "no-store" on every call. Tested
  against a loopback fake of the internal API — OUR half of the wire
  (secret header, save flag, error mapping); the real API's behavior is
  realtime's own suite.
- **lib/providers/queries.ts** — the READ side, straight from Postgres so
  a realtime outage cannot blank the settings page. The iron, greppable
  rule: NO query in web/ ever selects key_ciphertext; the column list
  here is the complete set of things the dashboard may know.
- **lib/providers/actions.ts** — trust rules in order: signed-in →
  member (an outsider POSTing a foreign orgId gets the same not-found
  shape the pages give) → OWNER for writes (provider keys are
  billing-adjacent; agents answer conversations, they don't rewire the
  org). Test and Save are one action distinguished by the pressed
  button's intent value; unexpected intent degrades to the safe option
  (test). The role comes from a hidden field with the same stance — an
  unrecognized value reads as "generation", and realtime validates the
  role again regardless. A successful save reports what the provider
  ACTUALLY answered (model, dimension, latency) plus the re-index count,
  and revalidates the sources page as well as this one, because a model
  change just queued crawls there.
- **components/ProviderForm/** + **dashboard/[orgId]/providers/** — the
  provider picker drives field VISIBILITY only (requirements are
  enforced server-side in checkCredentialInput; the form never
  duplicates that logic). The page states the key's lifecycle on the
  page — pasted over TLS, tested live, encrypted, suffix-only forever —
  and shows the current credential from queries.ts with an owner-only
  remove. Since M3.6b the form is per-ROLE (one component, two provider
  matrices: no Groq under embedding, and different model defaults for
  the same vendor) and the embedding card is real — current model,
  measured dimension, and the sentence a tenant needs BEFORE pressing
  save: changing this re-indexes your sources.

Verified live at M3.4 (realtime dev + web dev, both secrets set): a
private base URL rejected through the whole chain with "must resolve to
a public address", and a fake Groq key rejected by the REAL Groq API
with the clean 401 message — the key itself absent from the error, and
nothing persisted on either failure. A successful save is covered by the
loopback-fake integration tests; the SUCCESS path against a real
provider is covered by the key-gated live suite (§3.8) the moment a free
tier key is pasted into .env — no code change, no test-only variable.

**What M3.6b was and was NOT verified against.** Verified: the full
suites (realtime against real Postgres, including the embedding save,
the dimension refusal, the re-index contract from all three sides, and
the worker's model-switch re-embed), `next build`, and a prod compose
boot with the smoke probe green — first with the increment's own
migration applying to a database that already held the previous four
(the ALTER-on-existing-rows path, before the flatten), then again on the
flattened baseline (§3.3). NOT verified: the embedding path
against a real hosted provider, which needs a free-tier
`GEMINI_API_KEY`; the moment one is in .env the gated live cases (§3.8)
cover it with no code change, and the dashboard's own Test button covers
it in the browser. There is deliberately no keyless substitute for that
last step: a loopback fake would have to defeat the SSRF vet, which is
the one thing about this surface that must never be made easy.

### §9.9 `src/lib/sources/`, AddSourceForm, AutoRefresh, the sources page (M3.6a)

- **lib/sources/queries.ts** — sources with each one's LATEST ingest job
  (jobs are append-per-crawl; the newest row is the current truth) plus
  live document counts. Straight from Postgres like every dashboard
  read; two plain queries and a JS pick over a DISTINCT ON, because a
  tenant has a handful of sources.
- **lib/sources/actions.ts** — the providers trust ladder verbatim
  (signed-in → member → OWNER: connecting a crawl target spends quota
  and changes what the widget answers from — org wiring, not
  conversation work), then lib/realtime's createSource.
- **components/AddSourceForm/** — kind picker (crawl/sitemap), depth
  only for crawls (a sitemap enumerates its own pages); requirements
  live server-side, visibility here.
- **components/AutoRefresh/** — the ingest-progress mechanism: a tiny
  client component calling router.refresh() on an interval, MOUNTED ONLY
  while a job is queued/running, so an idle dashboard costs zero
  requests. Polling over a socket on purpose: progress moves on the
  seconds scale, and the WebSocket budget is reserved for M4's handoff
  where latency matters.
- **dashboard/[orgId]/sources/** — add form (owner), the per-source
  status line (queued/crawling with page counts/indexed/failed-with-
  reason), and the honest crawl promises in the intro (same-origin,
  private addresses refused, unchanged pages skipped).

Verified live at M3.6a with two real public pages: one job recovered by
the BOOT tick after a dev-server restart (the deploy-stranded path), one
run purely by wake (no poll timer existed), and the page's auto-refresh
flipping to "1 pages indexed" unattended.

### §9.10 `src/lib/conversations/` + the transcript routes (M3.7)

Where the verification thesis faces the TENANT. Everything else in the
dashboard is administration; this is the product explaining itself.

- **queries.ts** — `listConversations` rides the (org_id,
  last_message_at DESC) index §3.3.2 shaped for exactly this
  page. `getConversation` is org-scoped in the WHERE, so another
  tenant's conversation id and a fabricated one are INDISTINGUISHABLE
  (both null → the page's 404); malformed ids fail isId() before any
  query. Citations come back per message in `ord` order, ALL of them —
  the one thing this file must never do is filter to verified rows.
- **dashboard/[orgId]/layout.tsx** — the org section nav (Overview /
  Conversations / Sources / Providers), built purely from the path
  param: no queries, no auth (layouts skip re-running on soft
  navigation, so pages keep their own requireOrgMember, and a nav
  rendered for an inaccessible org links only to pages that 404).
- **conversations/page.tsx** — the list: preview, message count,
  status (including `escalated`, which M4 will start producing), and
  the last-activity timestamp. Readable by agents as well as owners:
  reading conversations IS the agent job.
- **conversations/[conversationId]/page.tsx** — the transcript.
  Assistant rows carry model, refused, TTFT and total latency
  (per-answer observability M5 will aggregate); under each, every
  citation with its verdict spelled out as a sentence — "stripped —
  quote not found in the cited source" / "stripped — cited a chunk
  that was never retrieved" — beside the quote and its source link.
  `content` is what the visitor SAW; the stripped rows underneath are
  what they were spared.
- **Tests** — DB-gated: list ordering/counts/previews, list and
  transcript both org-scoped (cross-tenant read indistinguishable from
  a fabricated id, malformed ids short-circuited), and the
  strip-visibility contract — an assistant message with one verified
  and one `quote_not_found` claim must surface BOTH while `content`
  contains only the verified text.

Verified live at M3.7 end to end: a real crawl → a real widget session
(mint + SSE chat) → a grounded answer whose transcript shows the
verified citation; then `npm run ask --tamper` through the same pipeline
→ the dashboard showing the fabricated quote marked stripped and absent
from the visitor-facing content, with cross-tenant and fabricated ids
both 404.

### §9.11 `src/lib/origins/` + the install page (M3.8)

The allowlist — trust-model layer 1, the layer that kills the
copy-pasted-snippet attack outright — plus everything a customer needs
to install the widget.

- **lib/origins/index.ts** — validation, queries, and mutations. Written
  directly through Kysely rather than proxied to realtime's internal
  API: that API exists for what web CANNOT or MUST NOT do (decrypt
  tenant keys, poke the in-process worker), and these rows hold no
  secret — routing them through it would be ceremony without a reason.
  `validateOrigin` normalizes what customers actually paste (full page
  URL, trailing slash, mixed-case host, default port) into `url.origin`
  — the browser's OWN definition of the string the `Origin` header will
  carry — because every one of those variants stored raw is a row that
  can never match, which reads as "the allowlist mysteriously doesn't
  work" (§3.3's CHECK comment says exactly that). Two refusals
  worth their code: a bare host (guessing https for someone's allowlist
  would be us deciding their security posture) and the literal `null`
  (what file:// and sandboxed iframes send — allowlisting it would open
  the widget to every one of them). The schema CHECK stays as the
  backstop that makes a bypass unrepresentable; the validator exists so
  a tenant gets a sentence instead of a 500. add is idempotent
  (re-adding satisfies the same intent), remove is unvalidated on
  purpose — whatever string is in a row must be deletable.
- **lib/origins/actions.ts** — the providers/sources trust ladder
  verbatim (signed-in → member → OWNER: the allowlist IS the widget's
  front door). Success echoes the NORMALIZED value so a customer who
  pasted a page URL learns what was actually allowlisted.
- **components/OriginForm/**, **components/CopyButton/** — the add form
  (type=text, not type=url: the browser's own validation would reject a
  bare host before our validator can explain why a scheme is required)
  and a copy button that degrades honestly where the Clipboard API is
  unavailable rather than silently doing nothing.
- **dashboard/[orgId]/widget/** — the install page, three sections in
  the order a customer hits them: allowlist (with the unforgeable-Origin
  argument stated, which is also why the public key below it is safe),
  the snippet with the org's real pk, and the exact two CSP directives —
  no `style-src` entry, because the widget's styles ride
  adoptedStyleSheets, a claim the hostile fixture page proves by
  withholding one. `NEXT_PUBLIC_WIDGET_API_URL` is CONFIG, not derived:
  the dashboard is on Vercel and the widget API on Render, so this host
  cannot infer the other's; unset renders a visible placeholder and says
  so, rather than emitting a snippet that would fail silently on the
  customer's site.
- **Tests** — keyless: normalization of every realistic paste, port
  handling matching the browser (:443/:80 dropped, :8443 kept), the
  bare-host and `null` refusals, and a property that every accepted
  value satisfies the schema CHECK regex. DB-gated: add/list/remove,
  idempotent re-add, silent no-op remove, per-org scoping including a
  cross-tenant delete that must not touch the other tenant's row, and
  the CHECK rejecting a path or trailing slash if validation is
  bypassed.

Verified live at M3.8, with the widget route as the oracle: pasting
`  https://DOCS.Example.com/help/faq?x=1#top  ` stored
`https://docs.example.com` and that origin immediately minted a session
(200) while an unlisted one was refused (403); removing it flipped the
same origin to 403 on the next request, with the other origin still at
200. A bare host was rejected in the form with the scheme sentence.
