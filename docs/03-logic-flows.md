# 03 — Logic flows: what actually happens, step by step

Six walkthroughs, in the order a real tenant would trigger them. Each step
names the file doing the work; [DATAFLOW.md](../DATAFLOW.md) has the same
traces at function-call precision.

---

## Flow A — A tenant onboards

1. **Sign up** (`/signup`, `web/src/lib/auth/`): password is checked against
   bounds and the HaveIBeenPwned breach corpus (only a 5-char hash prefix
   ever leaves the server), then scrypt-hashed. The email is AES-GCM
   encrypted at rest; a separate "blind index" digest makes login lookups
   possible without storing plaintext. The session cookie carries 256
   random bits; the database stores only its sha256.
2. **Create an organization** (`web/src/lib/orgs/`): org + owner membership
   - a publishable widget key (`pk_live_…`) land in **one transaction** — an
     org missing any of the three would be corruption, not a partial state.
3. **Save a provider credential** (Providers page →
   `web/src/lib/providers/actions.ts` → realtime's internal API
   `POST /internal/orgs/:id/credentials`): the payload is shape-checked
   (e.g. Ollama must _not_ carry a key; hosted providers must; self-hosted
   base URLs go through the SSRF vet), then a **real test call** is made —
   one 16-token completion, or one embedding whose dimension is measured
   and stored. Only then is the key AES-256-GCM encrypted into the vault.
   Saving a _different embedding model_ than before automatically queues a
   re-index of every source, because vectors from different models live in
   different spaces and the old corpus would otherwise become invisible.
4. **Connect a source** (Sources page → internal API): the URL passes the
   same SSRF vet, a `sources` row + queued `ingest_jobs` row land in one
   transaction, and the enqueue **wakes** the ingest worker (Flow B).
5. **Allowlist the site + copy the snippet** (Widget page,
   `web/src/lib/origins/`): pasted URLs are normalized to the exact origin
   a browser will send (`https://Docs.Acme.com/help/` →
   `https://docs.acme.com`), because a stored variant that can never match
   reads as "the allowlist mysteriously doesn't work". The page shows the
   snippet and the two CSP directives a locked-down host needs — including
   both `https://` and `wss://` forms of the API origin, because CSP scheme
   matching never upgrades http→ws.

---

## Flow B — A crawl (source → searchable chunks)

All in `realtime/src/ingest/`, driven by the worker (`worker.ts`):

1. **Claim.** One atomic `UPDATE … FOR UPDATE SKIP LOCKED` takes the oldest
   queued job. Concurrent workers skip each other's rows; a crashed
   worker's stale lease gets requeued (bounded by an attempts cap).
2. **robots.txt first.** One fetch, parsed by a hand-written RFC 9309
   implementation. A `Disallow` that covers the root fails the source with
   a sentence naming the rule; an unreachable robots file (5xx) refuses the
   whole crawl, as the RFC mandates — visibly, not silently.
3. **BFS crawl** from the root (or the sitemap's URL list): same-origin
   only, checked against the _final_ URL of any redirect; every fetch goes
   through the SSRF-guarded client; politeness delay between fetches
   (plus any `Crawl-delay`, capped at 5 s); depth and page caps enforced.
   A dead page is a recorded skip, not a crawl failure.
4. **Per page:** parse (markdown/HTML/PDF → blocks with exact character
   offsets) → sha256 the text → **if the hash is unchanged and vectors
   already exist under this org's model, stop here** (the short-circuit
   that makes an unchanged re-crawl 216× cheaper) → chunk (heading-aware,
   ~400 tokens) → embed in batches of 32 under the _org's own_ embedding
   credential, with a patient rate-limit retry (8 attempts / 5-minute
   budget — background work waits where a visitor wouldn't) → one short
   transaction writes document + chunks + embeddings. Embedding happens
   _outside_ the transaction: it's seconds of external network, and holding
   a DB connection across it buys nothing.
5. **Bookkeeping as it goes:** every landed page updates progress _and
   renews the job lease_ (a slow-but-polite crawl must never look crashed);
   every skip is recorded `{url, reason}` for the dashboard; pages that
   existed last crawl but not this one are soft-deleted so retrieval stops
   seeing them while history survives.

---

## Flow C — A visitor asks a question (the core flow)

### C.1 Getting a session (trust layers 1–2)

1. Visitor clicks the bubble. The widget (`widget/src/api.ts`) POSTs
   `/v1/widget/session` with the publishable key; the browser attaches the
   page's `Origin` header, which page JavaScript cannot forge.
2. The route (`realtime/src/routes/widget/`): per-IP token bucket → key
   lookup (unknown and revoked keys collapse into one identical 401 — key
   state is not probeable) → **exact-match allowlist check** (failures get
   no CORS headers, so an unlisted site's page can't even read the error;
   the attempt is still _counted_ so the tenant can see it) → mint a
   30-minute HMAC token binding org + origin + visitor id.
3. Side effect by design: this handshake is what wakes the sleeping
   database while the visitor is still typing their question.

### C.2 The answer

4. Widget POSTs `/v1/widget/chat` with the token and question (≤2,000
   chars). The route re-checks the _live_ Origin against the token's
   (kills replay from another site), applies per-visitor rate limits, then
   checks the org's **daily answer cap** — one primary-key read against
   `usage_daily`, before any model call. Past the cap: a graceful "quota
   reached", never a provider error.
5. SSE headers flush immediately (fast first byte), then the pipeline
   (`realtime/src/answer/pipeline.ts`) runs:
   - **Persist the visitor's message first** — a model failure must never
     erase the question.
   - **Resolve providers per request** from the org's vault credentials
     (decrypted for the lifetime of the request, deliberately uncached so
     key rotation bites on the next question); fall back to the platform
     provider only if the org saved nothing.
   - **Embed the question** (task="query") → **hybrid retrieval** (dense +
     lexical → RRF, top 10).
   - **The gate:** if the _minimum_ dense distance across results is worse
     than the calibrated threshold (0.34 for the local model), emit a
     refusal — persisted as `refused=true`, `model=NULL`, zero tokens
     spent. Off-topic questions cost nothing.
   - **Prompt assembly:** the system prompt is a constant (instructions +
     the JSON contract + the org's persona); retrieved chunks ride in the
     _user_ turn inside `<context>` delimiters declared as
     data-not-instructions. Crawled pages are untrusted input; they never
     concatenate into the system prompt.
   - **Generation** with three safety nets stacked: jittered retry on
     429/408/5xx (three attempts inside 8 s — how long a person watches a
     bubble); the platform fallback provider (only for credential-less
     orgs); and a **60-second wall-clock deadline** over the whole answer,
     composed with the visitor's own disconnect signal.
   - **Parse** the response as claims JSON. On a schema violation: one
     retry that replays the exchange plus every validator error. On a
     second violation: fail loudly, count it (`usage_daily.schema_failures`),
     write no assistant row, and never bill the tenant's quota for an
     answer they didn't get.
   - **Verify** every claim against the chunks the model was actually
     shown; **strip** failures.
   - **One transaction:** assistant message (content = only what the
     visitor will see) + every citation verdict (stripped included) +
     token usage + the daily counters.
6. The stream the widget receives: `meta` (ids) → one `claim` event per
   _verified_ claim (text + citation URL + heading) → `done` (claims shown
   vs. claims emitted). A refusal replaces the claims. Any failure past
   the SSE boundary is exactly one opaque `error` event.
7. The widget renders claims with citation links (everything through
   `textContent` — model output is never HTML), and keeps the conversation
   id so follow-ups thread.

### C.3 What the tenant sees afterwards

The transcript page shows the full exchange **including stripped claims**
("stripped — quote not found in the cited source") — the verifier's work
made visible. The metrics page aggregates deflection, strip rate, latency
percentiles, per-model schema violations, and list-price cost.

---

## Flow D — Escalation to a human

1. **The offer.** After a refusal (or a `handoff` event from another tab),
   the widget offers "Talk to a person".
2. **Escalate:** `POST /v1/widget/escalate` → `handoff/escalate.ts`. A
   partial unique index (one _open_ handoff per conversation) makes the
   transition exactly-once no matter how many retries or double-clicks
   race; the loser of a race reads back the winner. The bot goes silent on
   this conversation — visitor messages still persist (the agent needs to
   read them), but no model runs.
3. **The socket.** A browser can't put credentials in WebSocket headers, so
   each side spends its real credential (widget session token / dashboard
   cookie) on a **60-second single-use ticket**, and the upgrade handler
   verifies-and-spends the ticket _before_ the handshake completes — an
   unauthenticated connection never becomes a WebSocket.
4. **In the room** (`handoff/socket.ts`): an agent attaching _is_ the claim
   (guarded update — two agents arriving together produce one claim);
   attach replays the backlog (the bot's turns included) exactly once, on
   Postgres's clock; messages are persisted before broadcast with the role
   taken from the ticket; typing hints are ephemeral, TTL'd, coalesced;
   a heartbeat reaps half-open sockets so nobody shows as present forever.
5. **Reload survival:** the widget bookmarks a live handoff in localStorage
   (conversation id + panel state — never the token). The next page load
   rejoins through the normal reconnect path, draws _nothing_ until the
   server confirms, and silently forgets a bookmark whose conversation was
   closed while the visitor was away.
6. **Close:** the agent's Close button → internal API → both rows move in
   one transaction, the room is told (`closed` frame) _then_ hung up, and
   the bot answers the very next question. The same conversation can be
   escalated again later — that's why the unique index covers open rows
   only.

---

## Flow E — Money and limits

1. Every answered question increments `usage_daily` **in the same
   transaction** as the message row (counters that can't drift from what
   they count). Refusals count too — they spent retrieval.
2. Before every model call, the chat route reads plan + today's counter in
   one lookup. `WIDGET_DAILY_ANSWER_CAP` (deployment env) can only
   _tighten_ a plan — one typo must never hand every tenant an unlimited
   allowance. On the deployed demo it is 18/day, deliberately below
   Gemini's free 20-generations/day so a visitor sees a graceful cap
   instead of a provider error.
3. Upgrades go through Stripe test-mode Checkout; the **webhook** (hand-
   rolled signature verification) applies `customer.subscription.*` events
   in one transaction with an event-ledger insert keyed by Stripe's own
   event id — a redelivered event applies exactly once _by schema_. The
   outcome is a write to `organizations.plan`, the only thing the answer
   path ever reads: Stripe being down cannot stop a widget from answering.

---

## Flow F — Key lifecycles

- **Publishable key rotation** (Overview page): one click inserts a new key
  and schedules the old one's revocation 24 h out — the snippet already
  deployed on the customer's site keeps working through the grace window,
  and there is never a keyless moment. "Revoke now" ends the window early,
  and is allowed only on a _retiring_ key (a click can never leave the org
  keyless). All comparisons happen on Postgres's clock — the dashboard
  (Vercel) wrote the deadline, realtime (Render) reads it, and Neon is the
  one clock they share.
- **Secret key ("strong mode")**: generated once and shown once (the row
  stores only a hash + 4-char suffix). The customer's _backend_ presents it
  to `POST /v1/sessions` to mint sessions for users it has signed in; the
  page then carries `data-session-url` instead of any key. Anonymous ids
  (`vis_…`) and server-asserted ids are disjoint namespaces, so nobody on
  an allowlisted origin can mint a session _as_ "user 42" — that's the
  impersonation identity verification exists to prevent. The route speaks
  no CORS at all, so a secret key pasted into a page can't work even by
  mistake.
