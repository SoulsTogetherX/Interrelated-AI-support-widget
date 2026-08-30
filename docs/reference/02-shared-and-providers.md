<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §2 Repo root, shared/, providers/

## §2 Repo root

### §2.1 `package.json` + `vitest.config.ts` (root)

The root is a tooling package only: it owns the test runner and typecheck
scripts for the package-less source folders — `shared/` (§2.4),
`providers/` (§2.4.5), and `eval/` (§7) — and nothing else. Application
packages own their dependencies individually — this repo is a _flat_ layout
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
its predecessor _and_ that predecessor's children; pieces pack to
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
comment and _executed_ as a property test), and `toPgvector`/`fromPgvector`
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
never pass as an api_keys row id. Since M7.3 the SECRET key lives here for
the same reason: `newSecretKey` (`sk_live_<32 base32>` — same entropy,
different prefix, so each credential presented in the other's place is
refused for its shape before any lookup), `hashSecretKey` (sha256 hex — the
storage form `api_keys.secret_hash` holds; the dashboard writes it on issue,
realtime recomputes it per request, and two packages hashing "the same way"
by convention is how one of them ends up hashing differently; plain sha256
rather than a slow KDF because the input is 160 random bits, not a password —
sessions.id's argument), and `secretKeySuffix` (the last four characters,
the only plaintext fragment the dashboard keeps).

#### §2.4.10 `shared/utils/visitorIds.ts`

The rule that keeps two kinds of visitor apart in one column (M7.3).
ANONYMOUS visitors are `vis_<32 hex>`, minted by the browser route with the
publishable key — generated by the server, stored by the widget, handed back
on the next mint so a reload keeps its thread; unguessable, which is the
whole of their security. IDENTIFIED visitors are anything else well-formed
(`[A-Za-z0-9_-]{1,100}`, the schema's ceiling): a customer's own stable user
id, minted ONLY by `POST /v1/sessions` with the secret key. The split is a
hard rule rather than a convention because the browser mint takes a
client-supplied id (that is how reloads work) and a customer's user ids are
GUESSABLE — sequential integers, often. If the browser route accepted any
well-formed id, anyone on an allowlisted origin could mint a session as "42"
and, to the agent reading the inbox, BE user 42; so the browser route accepts
only the anonymous shape, the server route refuses it, and a non-anonymous
id can only have entered a session through the tenant's own secret key —
which is what lets the dashboard label it "identified by your server"
truthfully (web/src/lib/conversations/visitors.ts). The customer's id is
stored verbatim so the dashboard shows the id THEY know; the docs say to send
a user id rather than an email, so our database never becomes a copy of
theirs. Tests pin that the two namespaces are DISJOINT — every value is
anonymous, identified, or malformed, never two of those — including the
near misses (31 hex characters, uppercase hex, `vis-`) that must read as
identified so a browser presenting them is refused.

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
  M4.6 added the frame that ends it. **`closed`** is terminal — the server
  sends it and hangs up — and it exists even though hanging up ALONE would
  eventually produce the same conclusion (the reconnect's ticket mint 404s).
  The difference is ambiguity: a closed socket looks exactly like a dropped
  one, so without the frame a client must spend a reconnect and a mint to
  distinguish "your agent finished" from "your wifi blinked", and shows the
  wrong thing meanwhile. One frame removes the ambiguity before it exists.

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

#### §2.4.9 `shared/billing/plans.ts`

The plan catalog (M5.3) — what each tier is called, costs, and allows. One
table read by three surfaces that must agree: realtime enforces the answer
ceiling before every model call (§3.18), the dashboard shows a tenant where
they stand against it (§9.7), and M5.4's checkout turns a plan id into a
Stripe price. Three copies of "the free tier stops at 200" would eventually
disagree on the number a customer was charged against.

The ids are the same three the schema's CHECK allows, and that coupling has
TWO enforcers because neither alone is enough: `shared/db/schema.ts` types
`organizations.plan` as `PlanId`, so a plan the catalog does not know is a
compile error at every query — and a DB-gated test inserts an org at every
catalog id, so a plan the CHECK does not know fails loudly in CI instead of
at a customer's upgrade. The compiler cannot read SQL; the test cannot
catch the typo the compiler catches first.

Deliberately three tiers with ONE axis that bites (answers per day): a
portfolio product with five tiers and eleven feature flags is inventing a
business, and the engineering worth showing is enforcing one quota
correctly before the model call rather than modelling many. `sources` spent
two milestones stated and not enforced — the file's own comment called that
"worse than none", and the billing page was showing the number the whole
time — until M8.5 closed it: both create routes now check it with the org
row locked (§3.22), and sources became deletable in the same increment,
because a cap on an add-only resource would trap a free tenant's single
slot forever.

#### §2.4.8 `shared/pricing/models.ts`

The per-provider price list — the one thing M5's cost metric was blocked
on. Token COUNTS are a measurement the pipeline stores; token PRICES are
published third-party facts with a date on them, which is why they live in
their own file behind `PRICES_AS_OF` rather than inline in a query: a price
list without a date is a rumor, and Google cut Gemini's free quotas 50–80%
in December 2025.

In shared/ even though pricing is a provider fact, because web/ renders the
number and resolves only `@/*` and `@shared/*` by design — an alias into
providers/ would let a Server Component import an adapter that opens
sockets, in order to read a constant. The file has no imports at all.

Two rules carry it, and each prevents a plausible-looking wrong number.
**Unknown is null, never 0**: a tenant on self-hosted Ollama pays for
electricity and a GPU, and "$0.00" is a specific falsehood where "—" is
correct; the only zero in the table is `mock-llm`, which really is free and
is priced so that keyless stacks report an honest $0.00 instead of an
unhelpful "unknown". **Matching is EXACT** — `gemini-2.5-pro` shares a
prefix with the Flash entries and costs an order of magnitude more, so a
helpful prefix match would report a tenant's bill at a tenth of its size
and be believed, because it looks like a real number. The unit-testable
half is exactly those refusals; whether Groq really charges $0.59/MTok is
checked by reading their pricing page on the date in the file.

M7.8 added Anthropic's rows (§2.4.5n), and they are where the exactness
rule earns the most: Anthropic's model ALIASES float to newer snapshots
with different prices, so the table keys on dated ids and an alias resolves
to null — unpriced, which is honest — rather than to whatever its
predecessor cost. It is also the only provider here without a free tier, so
it is the one where "cost per 1k answers" is a bill a tenant is really
paying rather than the what-would-this-cost-at-scale figure it is
everywhere else.

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
arrangement fastembed has for providers/local.ts (§2.4.5c). Since M7.5 the
file also carries `SourceUploadsTable` and `UploadBlockSpan` (migration 009,
M7.6b — the span-only block shape whose text is reconstructed by slicing, so
the parser contract cannot be violated by a stale second copy), and one
runtime VALUE beside the types: `MAX_RECORDED_SKIPPED_PAGES`
(50), the cap on `ingest_jobs.skipped_pages` that migration 008 enforces
by CHECK — the PADDED_DIM / halfvec(1024) arrangement, a schema fact stated
once where both packages can read it (the worker stops recording there; the
dashboard says "and N more").

### §2.4.5 `providers/`

The model-provider abstraction — the BYO-provider feature's foundation.
Same no-package-json pattern as shared/ (consumers compile it through the
`@providers/*` alias; the root runner owns its tests), with one extra rule:
**implementations that need real dependencies load them with a dynamic
import**, and the dependency is declared by whichever package actually runs
that code. That is what lets every consumer import the _files_ freely while
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
The constructor takes a `model`
override since M7.7, because two mocks in one test are otherwise
indistinguishable and an assertion that cannot tell them apart passes without
proving anything — which is exactly how the fallback's "the transcript names
the model that answered" test stayed green over a real bug (§3.15.5).
Since M7.7 a scripted response may also carry an `error` to THROW instead of
streaming — how a test says "the provider refused this call" (a 429 from a
free tier, a 503 mid-outage), thrown before any delta because that is where a
rejected request really fails: a non-2xx response never becomes a stream.
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

Since M7.11 the request also carries a BOUNDED thinking budget whenever the
caller sets maxTokens, and the reason is measured rather than defensive:
Gemini 3.x reasons by default and spends those tokens from the SAME
`maxOutputTokens` the answer does. A live call with 300 spent 285 thinking and
emitted nothing at all — in the pipeline, a truncated JSON document blamed on
the model's JSON discipline rather than on never having had room. Zero is not
an option (`thinkingBudget: 0` is a 400 on 3.x, where 2.5 accepted it), so the
budget is small and positive; 128 against the pipeline's 1024 leaves 87% for
output. Only with maxTokens, because that is when the two compete. Usage now
ADDS `thoughtsTokenCount` to output tokens, because thinking is billed as
output and reported separately — counting only the visible half under-reported
every reasoning model, in the direction that gets believed. The default model
moved to `gemini-3.6-flash` in the same pass: 2.5 Flash is 404 for keys
created now, though the /models listing still lists it.

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

#### §2.4.5n `llm/anthropic.ts`

The last row of the plan's provider table (M7.8), and the only one it marks
"paid; supported, never required". Native rather than a preset of the compat
adapter (§2.4.5g), for Gemini's reason: **its structured-output mechanism is
not the OpenAI one**, and translating it away would delete the interesting
part. Anthropic does ship an OpenAI-compatible endpoint and using it was the
cheap move; it is rejected deliberately, because that endpoint is a
documented migration shim whose JSON mode is "please emit JSON" — it would
file this provider in the WEAKEST structured-output tier when natively it
belongs in the strongest.

**The mechanism is the file's one novel idea.** There is no `response_format`
on the Messages API. What there is instead is TOOL USE: declare one tool
whose `input_schema` is `ANSWER_JSON_SCHEMA` verbatim, then force it with
`tool_choice: {type: "tool", name}`. The model cannot answer any other way,
Anthropic constrains a tool's arguments to that tool's schema server-side,
and the "arguments" ARE the answer document. Streamed, they arrive as
`input_json_delta` fragments — whose concatenation is exactly what
§2.4.5d's contract already calls a delta stream, so the pipeline needs no
special case, `parseAnswerText` sees the same text every other provider
produces, and TTFT still measures the first real content. Four providers,
four mechanisms (JSON mode, native JSON schema, Ollama's `format`, forced
tool use) is the honest shape of structured output across the ecosystem, and
is what makes the schema-violation metric a comparison rather than a
constant.

Five smaller decisions, each a place a plausible implementation would be
wrong:

- **Prose beside the tool call is DROPPED, not concatenated.** A model may
  emit a text block before calling the tool ("Let me check the docs…"), and
  forwarding it would hand the parser `Let me check…{"claims"` — output that
  looks valid enough to be misdiagnosed as the model breaking the contract.
  Under a schema, only `partial_json` is answer text; a test pins it.
- **`stop_reason: "tool_use"` is a NORMAL stop.** With the tool forced it is
  how every well-formed answer ends, so mapping it to "other" (the obvious
  reading of "not end_turn") would make the finish-reason metric say the
  model never once stopped cleanly.
- **A mid-stream `error` event throws with the status its type MEANS.** This
  provider has a failure mode the others do not: a 200 that turns into a
  failure, which `postStream`'s non-2xx path never sees. `ERROR_TYPE_STATUS`
  maps Anthropic's error vocabulary onto HTTP status, so §3.15.5's retry
  policy can still tell "overloaded, wait 250 ms" (529) from "your key is
  wrong, stop" (401) — without it, every mid-stream failure would be
  classified identically and half of them retried pointlessly.
- **Usage arrives in two halves**: input tokens at `message_start`, output
  tokens restated cumulatively on `message_delta`. Taking either alone would
  report null for a call that really did report its usage, and the cost
  metric (§2.4.8) treats null as unknown.
- **`max_tokens` is REQUIRED** by the Messages API — the one provider here
  where omitting it is a 400 rather than "use your default" — so the adapter
  carries one, matching the pipeline's cap so behavior does not change with
  who is calling.

Auth is `x-api-key` plus the mandatory `anthropic-version` header (which is
what stops a future API default from silently reshaping the stream), the
system turn is a top-level `system` field as in Gemini while the turn roles
are already ours, and the default model is dated (`claude-haiku-4-5-…`)
rather than an alias, because aliases float to newer snapshots with
different prices and §2.4.8 matches EXACTLY. `sseData`'s deliberate
blindness to `event:` lines costs nothing here even though Anthropic sends
them, because each payload restates its own `type` — the tests write the
real two-line framing to prove it.

The plan's `$0` constraint holds by **nobody selecting it**: it is never a
default, CI sets no key, and no keyless stack reaches the file. What it buys
is a tenant who already pays Anthropic, and the fifth row of a table this
project can now fill in.

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
