# Build history — the milestone narrative

Moved verbatim from CLAUDE.md's header at the 2026-08 org overhaul.
APPEND-ONLY: new milestones are recorded here (newest first, matching
the existing order), never in CLAUDE.md — instruction files are for
instructions, history is for reading on demand. Each entry cites the
reference sections (docs/reference/) it touched.

---

**The org overhaul is done — the repo enforces its own conventions
(2026-08-26/27).** Requested as "stronger checks... primarily
limitations", planned from a three-agent research survey (~90 primary
sources; the plan and its evidence live in
`~/.claude/plans/code-organization-overhaul.md`), executed in five
phases, each ladder-green and squash-merged. What changed: the repo
gained its first enforcement layer — Prettier 3.9 (the house style,
mechanized), ESLint 10 + typescript-eslint strict-type-checked with
complexity as ERRORS (cyclomatic/cognitive 15, params 4, depth 4) and
size as WARN budgets (1000/file, 200/function, comments excluded; tests
exempt by DAMP doctrine), dependency-cruiser turning the layering prose
into nine forbidden-edge rules, knip for dead exports, lefthook
pre-push, a PreToolUse hook that physically blocks editing applied
migrations, and a keyless CI `quality` job gating all of it. The
whole-repo reformat landed as one mechanical commit, blame-ignored on
both branches (`.git-blame-ignore-revs` carries the dev SHA and the
squash SHA — a squash changes the SHA, the trap the research flagged).
CLAUDE.md shrank 6,985 → 124 lines: this file took the milestone
narrative; `docs/reference/` took the §-numbered reference split
losslessly at its own boundaries (6,037 section lines in, 6,037 out;
every § citation still resolves through the lookup table; the strays
the monolith accumulated — §6.2 inside §7, §9.13–9.19 inside §10 —
rehomed); `.claude/rules/` took six short lazy-loading per-area
convention files; §11 documents the layer itself. The restructure was
deliberately evidence-calibrated to named pains: `realtime/src/widget/`
→ `widgetAuth/` (killing the collision with the widget package),
`routes/internal.ts` (955 lines) → a six-file directory by resource,
`routes/widget.ts` (672) → a seven-file directory by route group —
handler bodies moved VERBATIM, 148 unused imports trimmed from the
compiler's own error lists, registration order preserved, and the
cohesive big files (socket, worker, pipeline) left intact under their
budgets, because the literature supports complexity limits and not
length limits. Three lessons were earned and recorded: knip's fixer
stripped exports from the handoff protocol — a CONTRACT file — and
broke four typechecks, so contract files are knip-exempt with the
reasoning in §11.5; the Bash tool's Windows layer collapses double
backslashes in heredocs (two silent no-op fix loops before the
backslash-free rewrite); and piping typecheck output through `tail`
swallowed a red exit code once, which is exactly why the ladder ends at
CI rather than at a local incantation. Proof the reorganization changed
shape and nothing else: 457+139+60 tests green throughout, the prod
image rebuilt and probed — injection containment green, **security
57/57** — and the LIVE deployment redeployed from both branches serving
a real grounded answer through the split routes (mint 506 ms, TTFT
2.8 s). Two grandfathered complexity warnings dissolved as a side
effect of the splits (8 → 6).

**Current milestone: M9 — ship, bank, stop — underway, and the product is
LIVE.** Every milestone the plan SCHEDULED (M0–M6) is complete, M7 — what
the plan states but never scheduled — is complete through M7.12, and M8
through M8.8.

M9 deployed the whole system on free tiers: the data plane on Render
(`render.yaml`, migrations 001–010 applied at boot, 12/12 smoke checks
green from outside), the dashboard on Vercel, Postgres on Neon, and one
Gemini key. **A visitor question on the deployed demo runs the entire
thesis** — Gemini embedding → hybrid retrieval → groundedness gate →
Gemini generation → span verification → streamed claims deep-linking into
fastify.dev — with every verdict recorded: 15 of 15 citations verified, 0
schema violations, warm TTFT **p50 1.65 s / p95 1.88 s** (§6.6's
`scripts/measure-ttft.mjs`, the committed producer for the last metric in
the plan's latency list). Four things the deployment TAUGHT, each now in
the README because each contradicts something previously assumed: the
ingest worker had no embed retry, so one 429 mid-page made a large page
permanently un-ingestable (§3.10.5a, fixed); a REFUSED embedding batch
still bills the daily quota, so retry storms are self-defeating and bulk
embedding must pace UNDER the limit rather than discover it; the keepalive
cron runs 24–54 minutes apart rather than every 10, so cold starts still
happen (12.3 s measured); and free-tier model latency is bimodal enough
that the model choice IS the fix — `gemini-3.6-flash` returned 34.7/40.9/
36.3/2.4 s and then hit the 60 s deadline where `gemini-3.5-flash-lite`
returned 1.9/1.4/1.7/1.8 s on identical inputs minutes apart.

M7
began as the plan's own trust-model section (layers 4–6, which no milestone
ever named), taken in order of size, and finished that at M7.3; since then
it has worked through the rest of what the plan's prose commits to and its
milestone list never carried — the README's named gaps (M7.4–M7.6), the
risk table's "handle 429s with jittered retry" (M7.7), and the provider
table's fifth row (M7.8). **M7.1 is done — one-click key rotation, layer 5**
(§9.17, §3.18, §3.27, DATAFLOW §7.12): the schema had revoked-by-timestamp
and uniqueness-among-live-keys since 001 precisely for this, and what was
missing was the click. Rotation issues a new key and schedules the old one's
revocation ROTATION_GRACE_HOURS (24) out; realtime's session route now
treats a FUTURE `revoked_at` as live and a past one as gone, both decided by
Postgres's clock — Vercel wrote it, Render reads it, and Neon is the one
clock they share — so a snippet the customer has not redeployed keeps
working and there is never a keyless window. "Revoke now" ends the window
at once, only for a retiring key (the org can never be left keyless by a
click; the current key retires by being rotated). Idempotence is the guarded
UPDATE from §3.23's playbook — the action rotates FROM the key the page
showed, and five concurrent clicks yield one rotation, proven by a test that
fires them together. The honest limit is stated where the feature is: for a
PUBLIC key rotation is hygiene rather than defense (an attacker who
re-scrapes the page has the new one; layers 1 and 3 do the bounding), and
ending a window does not evict live visitors (a session token is bound to
the org, not the key, and lasts its 30 minutes — pinned by a test). Its real
value is that the same rows and the same lookup rule are what will make the
SECRET key (layer 6) safe to issue. Verified live: an org created in the
dashboard, its origin allowlisted, the key rotated from the overview, the
retiring key minting a real session against realtime while the new one did
too, "Revoke now" flipping the old key to a 401 byte-identical to an unknown
key's, the install page carrying the new key with a rotation-in-progress
notice, and the retiring row truncating rather than overflowing at 375px.
The full ladder also caught a latent flake that has nothing to do with
keys and everything to do with the flagship regression test: the retrieval
suite's starvation sanity check (§3.8) went red inside the full run and
green alone, because at the fixture's size an exact plan (index scan plus
Sort) and the HNSW plan sat at the planner's break-even and autoanalyze
timing decided which ran; `enable_sort = off` on the test's single
connection now closes every exact route, so the check bites by construction.
M7.2 is done — **per-origin traffic visibility, layer 4** (§3.3.8, §3.28,
§3.18, §9.18, DATAFLOW §7.13): every session mint that names an org is now
counted per Origin per UTC day in `origin_daily` — MINTED for an
allowlisted origin, REFUSED for one the allowlist turned away — and the
dashboard shows the week's rows next to the allowlist. The refused count is
the point: layer 1 already stops an unlisted site, so what changes is what
the tenant can SEE — a copy of their snippet, or their own forgotten staging
domain, shows up as a name and a number instead of nothing, with a one-click
Allow for the second case and a flag on the overview when the week had any.
Refused origins are attacker text and are bounded twice — by SHAPE (only
strings shaped like an origin, or the literal `null`, are stored as
themselves; the rest under a sentinel) and by VOLUME (a per-org, per-day cap
on distinct refused origins, past which new ones collapse into `(other)`) —
and the counter write is awaited so the dashboard never lags the widget but
wrapped so it can never fail a mint. Nothing here identifies a visitor: an
origin and a count, no IP, no visitor id, no Referer (a browser's default
Referrer-Policy strips the path cross-origin, so it would only repeat the
Origin). Verified live: five kinds of origin sent at the real route
(allowlisted, a copy on another site, a forgotten staging domain, `null`, and
garbage), each landing as designed; the overview flag reading "9 loads
refused from 4 origins"; the install page's table with Allow only on the
allowlistable refused rows; Allow clicked on the staging row, the row
flipping to allowlisted, and the very next mint from it answered 200 with
the same row now reading minted 1 / refused 2 — and at 375px the page never
scrolling sideways, after two layout fixes the check found (§9.18).
M7.3 is done — **server-side session minting with the secret key, layer 6,
and with it the plan's trust model is BUILT IN FULL** (§2.4.1, §2.4.10,
§3.3.9, §3.18, §8.1, §9.19, DATAFLOW §5.5, §7.14). A customer's own backend
presents an `sk_live_…` key to `POST /v1/sessions` and mints a session for a
user IT has signed in; the page carries `data-session-url` instead of a
publishable key, so there is nothing on it worth copying, and only that
customer's logged-in users can open a chat. Same token, same routes, same
grace-window rotation as the publishable key (M7.1 was built for exactly
this) — the differences all follow from the key being a secret: shown once,
stored as a hash and a four-character suffix (migration 007), revocable
outright (an org without one is simply not in strong mode), and minted on a
route that never speaks CORS, so a secret key pasted into a page cannot work
even by mistake. The load-bearing decision is the visitor-id NAMESPACE: the
browser mint accepts only the anonymous `vis_<hex>` shape and the server
mint refuses it, so a visitor id that is not anonymous can only have come
from the tenant's own server — which is what lets the dashboard say "user 42
— identified by your server" and an agent act on it, and what stops anyone
on an allowlisted origin from minting a session AS user 42 (a customer's
user ids are guessable; the impersonation is exactly what identity
verification exists to prevent). Verified live end to end: a secret key
generated in the dashboard and shown once; a fixture "customer backend"
(`widget/scripts/serve.mjs`) minting through `/v1/sessions` for the
strong-mode host page (`fixtures/strong.html`, no publishable key anywhere in
its source); the widget fetching its session from that endpoint, chatting on
it, and the transcript naming "user user_42 — identified by your server";
rotation with the old key still deployed (it kept minting), "Revoke now"
ending it (the deployment got a 401 passed through and the widget degraded
to its notice), and a redeploy with the new key restoring service; a real
browser's impersonation mint (pk + `user_42`) never becoming a session and
its attempt to use the secret key from the page stopped at preflight; and at
375px both changed pages never scrolling sideways, the show-once value
scrolling inside its own box. The probe's new section [I] found one bug of
its own on its first run — its CONTROL consumed the response body inside a
failure message and then failed to parse it — recorded in §6.3 beside the
two M6.4 recorded, because that is the tradition.
M7.4 is done — **a handoff that survives a page load** (§8.1, §8.1c, §8.3,
DATAFLOW §8.5). A widget lives one page at a time, so a reload and a click
to the next docs page are the same event to it, and until now both lost the
handoff: the conversation id lived in memory, and the agent's replies landed
in a room the visitor was no longer in. Now the LIVE handoff is bookmarked
in localStorage — conversation, whether the panel was open, and a timestamp;
never the token, never the visitor id, never a bot conversation — and the
next page rejoins it through the socket's own reconnect loop, whose first
ticket mint IS the probe. Nothing is drawn until the server confirms
(`ready`): a bookmark for a conversation the agent closed while the visitor
was away is forgotten silently and the page is left exactly as one that had
no bookmark, so "the support chat has ended" never appears on a page nobody
escalated from. Once confirmed, the status line, the socket's composer, and
the panel come back as they were (no greeting over the transcript, no focus
stolen), the backlog replays, and a person writing while the panel is closed
badges the bubble. Bounded twice: a bookmark untouched for 24 hours is
dropped without a request, and an unconfirmed rejoin gives up after 60
seconds keeping the bookmark for the next page (the case where the mint
itself keeps failing — a signed-out user in strong mode — would otherwise
poll the customer's endpoint for as long as the tab is open). Verified live
in a real browser with the dashboard inbox as the agent: escalate on the
Tailwind fixture, reload → the panel back in handoff mode with the
transcript, one mint and one ticket per page load; the agent attaching and
replying; a click to the Bootstrap fixture → rejoined with the agent's
message; the panel closed and the page reloaded → closed but connected, the
agent's next message raising the badge, opening clearing it; the agent
closing → "ended" and the bookmark gone, the next reload spending no request
at all; a stale bookmark → one mint, one 404, nothing drawn; an expired one
→ dropped without a request. The same check on the HOSTILE fixture found a
pre-existing gap: its strict CSP listed `connect-src http://localhost:3000`
only, and Chrome refused the `ws://` upgrade — CSP's scheme matching goes
http→https, never http→ws — so a handoff on a locked-down host had never
worked; the fixture and the Install page's directive now name the socket
origin too (§8.4, §9.11). The bundle is 6.52 KB gzipped against the 15 KB
budget. Nothing server-side changed: the ticket route's 404 and the
socket's replay-on-attach were already the whole of what a rejoin needs.
M7.5 is done — **robots.txt honored, skipped pages visible, and Re-crawl**
(§3.10.6, §3.10.4, §3.10.5, §3.3.10, §3.22, §9.9, §3.8, DATAFLOW §3.2–§3.3,
§7.9). A source is any public URL a tenant types, not necessarily their own
site, so honoring robots.txt is what separates a crawler from a scraper —
and the plan had parked it "with the dashboard, where a customer can see
WHY a page was skipped", which is exactly the shape it landed in. The
parser is hand-written to RFC 9309 (`ingest/robots.ts`): the group is chosen
by product token (`InterrelatedBot`, exported from safeFetch so the header
and the match can never disagree — a specific group REPLACES the wildcard's
rules, several groups for one agent merge), the most specific rule wins with
Allow winning ties, `*` and `$` are matched by a linear-time glob rather
than a compiled regex (a pattern is untrusted text from a fetched file, and
`/*a*a*a*b` would send a backtracking engine exponential), paths compare
in percent-encoded form on both sides, and the OUTCOME of the fetch is part
of the policy — 4xx is "no file, everything allowed", 5xx or a request that
never produced a status is "unreachable, nothing allowed", which the RFC
mandates and which fails closed VISIBLY: the crawl is refused with a
sentence naming the cause. Same-origin scope means one file governs a whole
crawl, so it is read once, first, and every URL — root, discovered link,
sitemap entry, child sitemap, and the FINAL url of a redirect — is checked
against it; a disallowed root is a source failure whose text names the rule
("nothing crawlable — disallowed by robots.txt (User-agent: *, Disallow:
/)"), a disallowed link is a new `skipped` crawl event that costs no fetch,
and Crawl-delay is honored up to a 5-second cap. What the worker did with
those events is the visibility half: migration 008 gives `ingest_jobs` a
true `skipped_count` and a `skipped_pages` list of `{url, reason}` capped by
CHECK at 50 (the count keeps counting past it), robots skips and page errors
alike, written with every page's progress UPDATE — which now also RENEWS the
lease (`locked_at = NOW()`), because a crawl slowed by a Crawl-delay must
never read as a crashed one to a second worker. The sources page shows "N
pages indexed · M skipped" with a collapsed "why" list under each source,
and — the action the visibility exists for, since sources were add-only —
an owner's **Re-crawl** button: `POST
/internal/orgs/:orgId/sources/:sourceId/recrawl` inserts the job and wakes
the worker, idempotent by SCHEMA through 008's other statement, a partial
unique index allowing one LIVE job per source, so five concurrent clicks
insert one job and the credential re-index that races them can no longer
roll back a save on a unique violation (both use ON CONFLICT DO NOTHING).
Verified live against two real sites from the dashboard: `https://nodejs.org/en`
at depth 1 crawled 9 pages and recorded ONE skip — `/docs/latest/api/`,
"disallowed by robots.txt (User-agent: *, Disallow: /docs/)", nodejs.org's
actual rule — shown as "9 pages indexed · 1 skipped" with the reason under
"1 page skipped — why"; `https://www.reddit.com/` (`Disallow: /`) failed
with "nothing crawlable — disallowed by robots.txt (User-agent: *,
Disallow: /)" and no page fetched; Re-crawl clicked on the nodejs source
queued a second job that ran in 4 seconds (nine unchanged pages
short-circuiting on their hash), refreshed all nine documents in place, and
recorded the same skip; and at 375px the page never scrolled sideways with
the row stacked and the failure sentence wrapping, while at 1280px the two
halves sat side by side. The full ladder ran green against the prod image
with 008 applying at boot: smoke, injection 0/8, security 54/54. Two things
the check taught, both recorded rather than smoothed over: the dev server
runs no ingest worker unless `INGEST_WORKER=1` (the enqueue then wakes
nothing — the M3.6a check must have set it), and its first boot tick was
spent on a stale queued job a test suite had left in the dev database, so
the crawl waited for a second boot — one job per tick, wake-driven, exactly
as documented, and a reminder that suites which queue jobs must park or
delete them.
M7.6a is done — **PDFs are read** (§3.10.7, §3.10.3, §3.10.4, §3.8,
DATAFLOW §3.3), the first half of the README's last named gap. The M1
review that removed `pdf-parse` made two objections — 21 MB of image weight,
and no caller — and both had to be answered before the format could come
back. They are: the dependency is `unpdf` (2.1 MB, zero dependencies of its
own, against pdf-parse's 21 MB and its two), loaded by DYNAMIC IMPORT so a
stack that never meets a PDF never pays for it; and the caller is the
crawler, which stopped refusing to spend a fetch on a `.pdf` link — the
datasheet or policy PDF a docs site links is exactly the content a support
answer needs. The parser earns its own section because two mechanical facts
about pdf.js drive it, both learned from it failing: it TRANSFERS (detaches)
the array it is handed, so the document is opened once into a proxy that
both the title and the text are read from — a parser that passed its
caller's buffer through would work on a crawl's first page and throw on its
second, which a test now pins by parsing one buffer twice — and a Node
Buffer is a pooled view that cannot be transferred at all, so the bytes are
copied first. The offset contract holds by construction as it does for HTML
(layout is not text, so the extraction IS the document), lines are grouped
into paragraphs because the chunker blank-line-joins the blocks it packs and
one-block-per-line would split every wrapped sentence, and what that means
in practice was MEASURED rather than assumed: pdf.js emits no blank line
however large the vertical gap, so a page is one block that the chunker
splits at sentence bounds. Every refusal is a sentence a tenant can act on
— not a readable PDF, password-protected, over 10 MB, and the one worth
naming, a PDF with no text layer, which is a SCAN whose content is pixels
and which is refused with a sentence naming OCR rather than stored as a
source that answers nothing. Two limits are stated rather than smoothed
over: a PDF gets no heading trail (headings there are a font-size
convention, and inferring them would be a heuristic with silent failures),
and the size cap bounds the INPUT rather than the WORK. The fixtures are a
hand-written PDF writer with a real xref table, so the suite ships no opaque
blobs. Verified live end to end against a REAL document rather than a
fixture — which is the half the unit tests cannot reach, since hand-built
PDFs have none of the compressed streams, embedded fonts and xref streams a
document toolchain emits: `https://www.rfc-editor.org/rfc/rfc9309.pdf` (the
PDF of the very RFC M7.5 implemented — 12 pages, 177 KB) connected from the
dashboard as a depth-0 source, crawled, and stored as one document titled
"RFC 9309: Robots Exclusion Protocol" from its Info dictionary, 5,529
tokens, 12 chunks, 12 embeddings; the sources page reading "1 pages
indexed"; and `npm run search` returning its chunks through both retrieval
arms under the correct source URL, each marked "(no heading)" — the
documented limitation, visible rather than asserted. The full ladder ran
green against the rebuilt prod image: smoke, injection, security 54/54, and
— the check the container exists to make, since a dynamically-imported
dual-format dependency is exactly what an image can break — `unpdf`
resolving and extracting text from a PDF built inside the shipped image.
M7.7 is done — **surviving a provider's rate limit** (§3.15.5, §3.18, §3.7,
§2.4.5e, §2.6, §3.8). The free tiers this product is designed around are 30
requests/minute (Groq) and 10–15 (Gemini), one question costs one model call,
and until now a 429 threw straight out of the pipeline and reached the
visitor as the same opaque error a real outage gives — the plan names that
twice, as "handle 429s with jittered retry before failing" and as the demo
dying mid-recruiter-visit. `answer/retry.ts` is the caller's half of a
division of labor providers/llm/types.ts declared at M2 ("retry/backoff
belongs to the caller"): jittered exponential backoff honoring `Retry-After`,
retrying only what a wait can fix (429, 408, 5xx, transport) and never a
configuration fact (401, 400, 404) or an abort, bounded by attempts AND by a
WALL-CLOCK budget — a `Retry-After: 60` is refused rather than honored,
because failing now beats failing in a minute with the same error. It is safe
to retry at all only because nothing generated reaches the visitor until it
is verified (§2.4.4c), so a half-streamed call has shown nobody anything.
`LLM_FALLBACK_PROVIDER` adds a second platform provider, tried once after the
first is spent — and the rule that makes it safe is enforced at the route and
tested there: **it is a fallback for the PLATFORM's provider, never for a
tenant's.** An org that saved a credential chose a vendor and a data
processor, and a transient 429 does not justify sending their customers'
questions elsewhere on our key. One thing was deliberately NOT changed and is
recorded rather than quietly skipped: a failure the policy cannot clear still
reaches the visitor as §3.18's single opaque error event, because the
"one moment" state the plan asks for already exists for OUR limits (§8.1) and
making the PROVIDER's state visible would trade a deliberate trust-model
property for something the visitor can act on no differently.

M7.7 was verified live against the real SSE route rather than only in tests,
with a loopback stand-in provider that rate-limits on demand: with it
refusing the first two calls, the visitor's stream was `meta → claim → done`
— an ordinary answer 2.4 s later instead of 0.4 s, with no error event and
nothing the UI had to say — and the provider's log showed 429, 429, 200. With
it refusing EVERY call, the platform fallback answered instead and the
service logged "fake-retry-model failed after retries; trying mock-llm". That
second run is what caught the `answeredBy` bug above: the transcript named
the primary for an answer the standby wrote. No browser check was run, and
deliberately: M7.7 changed nothing a visitor sees — the retry being invisible
IS the feature — so the surface worth checking is the SSE stream, which is
what the driver above reads.

M7.8 is done — **the Anthropic provider, and with it the plan's provider
table is COMPLETE** (§2.4.5n, §3.21, §3.15.4, §2.4.8, §9.8, §3.8, §2.6).
Four of the plan's five providers shipped at M2.4; the fifth was schema
without code — migration 001's CHECK allowed `anthropic`, shared/db typed
it, and `resolve.ts` threw "no adapter yet", which meant a provider the
SCHEMA accepts could be stored and then break every answer for that tenant
at question time. It is now an adapter like its siblings, and the reason it
is NATIVE rather than a preset of the compat adapter is the whole content:
**its structured-output mechanism is not the OpenAI one.** There is no
`response_format` on the Messages API — what there is is forced TOOL USE, a
tool whose `input_schema` is our claims schema verbatim and a `tool_choice`
that leaves the model no other way to answer, with the arguments arriving as
`input_json_delta` fragments whose concatenation IS the JSON the parser
already expects. So the pipeline needs no special case, and the table now
reads four providers, four mechanisms (JSON mode, native JSON schema,
Ollama's `format`, forced tool use) — which is what makes the
schema-violation metric a comparison rather than a constant. Three things
this provider has that none of the others do, each pinned by a test: a 200
that can turn into a failure mid-stream (`event: error`), which
`postStream` never sees, so Anthropic's error vocabulary is mapped onto HTTP
status and §3.15.5's retry policy can still tell 529-overloaded from
401-wrong-key; a `stop_reason` of `tool_use` that is a NORMAL stop rather
than an anomaly; and a REQUIRED `max_tokens`. Prose emitted beside the tool
call is dropped rather than concatenated, or the parser would be handed
"Let me check the docs…{"claims"" and the model blamed for it. The plan's
`$0` constraint holds by nobody selecting it: never a default, no key in
CI, unreachable from every keyless stack — its cost lives in a dated price
row (aliases float to newer snapshots, and §2.4.8 matches EXACTLY, so an
alias is unpriced rather than priced as its predecessor) and behind a
dashboard label that says "(paid)" where a tenant reads it before clicking
Test. Verified with the full ladder against the rebuilt prod image — smoke,
injection 0/8, security 57/57 — plus 795 tests across the repo, 9 of them
the adapter's own protocol cases against a loopback server writing
Anthropic's real two-line SSE framing. NOT verified: a live call, which
needs a paid key this repo deliberately does not carry; the key-gated suite
(§3.8) covers it the moment `ANTHROPIC_API_KEY` is in `.env`, with no code
change and no test-only variable — the same standing arrangement Groq and
Gemini have, and the same honest gap the embedding path had at M3.6b.

M7.9 is done — **what the widget costs a host page** (§6.2, §8.3, §8.4).
The plan names three widget metrics as CI-enforced; only the first, the
gzipped size budget, had been enforced since M2.6. The other two are now
produced by committed scripts. "Added requests and bytes on the host page"
splits by how its halves FAIL: statically, the built bundle must contain no
dynamic `import()`, no `@import` or `url()`, no injected `<link>` or
`new Image`, and no absolute URL literal — six patterns, each one request a
customer never agreed to pay for, each proven to bite by appending a
violation to a copy of the bundle; behaviorally, a new jsdom suite drives
the REAL ApiClient and the real mountWidget against a counting fetch,
because the fake client every other UI test injects is exactly what would
hide a request. What it pins is the product promise: **a page nobody chats
on pays for one request and nothing else** — zero fetches and zero sockets
at mount, one at bubble-open, one more per question, and the deliberate
exception named rather than hidden (a page loaded mid-handoff spends a mint
and a ticket at once, because a person is waiting). "Time from snippet load
to interactive bubble" cannot be measured by a .mjs probe at all, so it got
a fifth fixture page whose job is measurement rather than survival, and a
real number: **p50 9.5 ms** over ten reloads, nine of them 7.3–16.3 ms,
against **168 ms cold**, with the one 522.8 ms sample recorded rather than
dropped because it landed in a burst of racing reloads. The browser
confirmed from outside what the static check asserts — one request at load
— and that the thing measured was a real 56×56 button in a shadow root.
What is NOT claimed: these are loopback numbers, so a CDN's TTFB and
transfer are still to be added, and the page says so on its face.

M7.10 is done — **schema violations counted** (§3.3.12, §3.15.3, §3.26,
§9.13, §3.8). The plan's anti-tutorial rules say "schema violations are a
counted metric, not a swallowed exception"; the pipeline has validated,
retried once and given up loudly since M2.3, but nothing recorded WHETHER an
answer needed that retry, so the rate was an exception being handled rather
than a number anyone could read. Migration 010 adds the two columns that
count it, and the split between them is the whole design.
`messages.schema_violations` is per answer and therefore per MODEL, which is
what makes it a comparison: four providers enforce a schema four different
ways (§2.4.5n) and should not produce the same rate. It is NULLABLE on 003's
argument — NULL means no model ran, where 0 would claim one ran and held the
contract, padding the denominator with answers nobody generated — and a
CHECK pairs it with `model` exactly. That constraint earned itself
immediately by catching FOUR test fixtures building assistant rows the
pipeline cannot produce, the same class of bug as M5.2's per-model refusal
column that passed a test whose fixture did not match production.
`usage_daily.schema_failures` is the case the message column CANNOT hold and
the one that matters most: when the retry also fails there is NO assistant
row, so counting only per answer would make a systematically failing
provider read as perfect — its worst outcome recorded as no outcome. It is
deliberately not part of `answers`, because charging a tenant's daily quota
for a question the product failed to answer would let a misbehaving model
burn a customer's plan. The dashboard shows both: a per-model violation
count with its rate, and a "Contract failures" stat for the org. Verified
with the full ladder against the rebuilt prod image with 010 applying at
boot — smoke, injection 0/8, security 57/57 — plus 804 tests. What this does
NOT do is make the plan's provider-comparison TABLE exist: that is an eval
run across providers and it needs keys this repo does not carry. What it
does is make that table's hardest column computable at all.

M7.11 is done — **what a real Gemini key found** (§2.4.5h, §2.4.8, §3.8,
§9.8, §2.6). The key-gated live suite has existed since M3.6b and had never
run; given a real free-tier key for one session it ran, and found two bugs no
keyless test could see, both instances of the plan's own "free tiers move
without notice" risk. First, **the default model was dead for new keys**:
`gemini-2.5-flash` answers 404 to a newly created key ("no longer available to
new users"), while the /models listing still advertises it — so an existing
credential kept working and a new tenant would 404 at their visitors' first
question. The default is now `gemini-3.6-flash`. Second, and worse, **a
reasoning model ate the entire answer budget**: Gemini 3.x thinks by default
and draws those tokens from the SAME `maxOutputTokens` the answer uses — a
measured call with 300 spent 285 thinking, emitted ZERO characters, and
finished MAX_TOKENS, which in the pipeline is a truncated JSON document, a
schema violation, the one retry, and an opaque error for the visitor. The fix
is a bounded `thinkingConfig.thinkingBudget` sent alongside maxOutputTokens;
zero is not available (a 400 on 3.x, unlike 2.5), so it is small and positive
— 128 against the pipeline's 1024 leaves 87% for output, and the call that
produced nothing returns valid claims JSON with it set. That exposed a third,
quieter bug: thinking tokens are BILLED as output but reported separately from
`candidatesTokenCount`, so every reasoning model's cost was under-reported;
thoughts are now added. `gemini-3.6-flash` deliberately gets NO price row —
its price was not read off the pricing page, and unknown is null (§2.4.8)
rather than a guess that would be believed. The suite now passes end to end
against real Gemini and prints what it measured: 6127 ms to a first answer,
structured output VALID under real server-side enforcement,
`gemini-embedding-001` returning 768-d in 295 ms, and task types doing real
work — 0.834 for a query-vs-document pair of the same text against 0.555 for
an unrelated one, the number the mock can never produce and the honest gap
M3.6b recorded.

M7.11 also produced the project's **first numbers from a real model**, which
the README had been explicitly declining to claim: nine grounded answers
through the live pipeline on `gemini-3.6-flash` — TTFT **p50 2,204 ms, p95
27,851 ms** (bimodal on the free tier: six under 5 s, three between 13 and
28 s), 612 input / 18 output tokens each, and **0 of 9 schema violations**,
which is the first real data in M7.10's new column and confirms §2.4.5h's
prediction that Gemini's native server-side enforcement makes the retry path
near-dead. Two honest limits ride with them: n=9 from one borrowed key is
evidence the path works rather than a benchmark, and TTFT came within ~300 ms
of total on every sample — under a server-enforced JSON schema the answer
arrives essentially whole, so streaming buys the visitor nothing that the
claim-granular protocol was not already going to withhold until verification
(§2.4.4c). Cost per 1k answers remains unclaimed, because the new default
model is deliberately unpriced.

M8.8 is done — **the first CI run on GitHub's runners, and the race it
found** (§3.8, §5.1). Pushing 56 commits of M7/M8 work (the remote had not
moved since before M7.1) gave the verify job its first run on shared
hardware, and it went red on one assertion no local machine had ever lost:
the M4.6 endRoom case asserted the room EMPTY immediately after the
clients saw their own closes — but entries are reaped in the SERVER's
per-socket close handler, and nothing orders that against the CLIENT side
of the handshake; the two ends finish independently. On a dev box the
server always won that race; on a loaded runner it lost, and the second
`endRoom` still counted 2. The product is untouched — reap-on-close plus
the heartbeat is the designed cleanup, and `send` guards readyState so a
polled `endRoom` cannot error into a closing socket — the TEST was
asserting an instant nobody promised, and now polls the drain, bounded
loudly, the suite's own idiom. Proven able to fail before committing: a
temporary 30 ms delay in the close handler reproduced CI's `expected 2 to
be +0` byte-identically, the polled version stayed green under the same
delay, and the delay was reverted. Diagnosed from the run's PUBLIC
annotations (log text requires sign-in and this box has no `gh`), after a
fresh CI-identical pgvector container ruled the long-lived dev database
out. Ladder: typecheck + 456 tests green against that fresh container.
The e2e and eval jobs had still never run on GitHub's runners — verify
failed before them — so the push carrying this fix was their first
chance, and it was taken: the re-run on `94793cf` completed GREEN across
all three jobs. The e2e gate's first execution on GitHub's own hardware
built the prod image, booted the stack, seeded the probe fixture, and
held against the smoke, injection, and security probes — closing the one
verification M6.4 recorded as impossible from a local machine.

M8.7 is done — **ingest throughput, measured** (§3.31, §3.3.1, §3.10.5,
eval/RESULTS.md, §9.9). The last metric in the plan's latency list with no
producer at all — retrieval latency and TTFT have had committed producers
for milestones while ingest speed existed only as anecdotes. `npm run
ingest-bench` serves the committed eval corpus (31 pages, ~584 KB) over
loopback HTTP as a sitemap source and drives the REAL worker — the real
crawler under the worker suite's permissive-hostGuard idiom, real parsers,
real chunker, the per-page short transactions production uses — so the
number is the production path with only the network made free, and the
exclusions (loopback, politeness zeroed, ONNX warmed outside the window)
are printed with the table because a throughput figure that hides its
exclusions reads as a promise. Three rows, three findings: **embedding is
~98% of the wall** (215 s with the local CPU model against 4.6 s for
everything else over the same 661 chunks) — §3.3.1's claim that the
queue's ceiling is embedding rather than Postgres, as a measurement, and
the reason the worker embeds outside its transaction; the pipeline itself
sustains **~144 chunks/s stored** with HNSW maintenance included; and the
content-hash short-circuit is worth **216×** — an unchanged re-crawl costs
1.0 s and embeds ZERO texts, proven by a counting embedder rather than
assumed, which is what a tenant's Re-crawl button costs when nothing
changed. Two wrongness guards, both earned: the runner REFUSES to start
when the queue holds live jobs (tick() claims the OLDEST queued row, so
suite residue would hijack the bench — it fired on the very first run, on
a worker-test job the day's full suite had left `running`), and a run with
any skipped page fails loudly rather than publishing a rate over a
silently shrunken denominator. Glue-only by §3.11's stance, so no suite of
its own; not a CI gate, for loadtest's reason. The same commit refreshed
the README rows M8.6 dated: the key-gated count is 15 now (the three xAI
cases skip keylessly, so the 836 passing stays), and the never-run-live
list names the compat adapter's xAI cases beside Groq, Anthropic and
Ollama, each waiting on exactly one thing.

M8.6 is done — **the compat adapter meets a real endpoint, and what a
fresh Gemini key found** (§3.8, §2.4.5g, §2.6). Two keys arrived for one
session, each for testing only, and each verified something no loopback
test can. The first closes the live suite's blindest spot: the generic
OpenAI-compatible adapter — the one row of the plan's table that covers
OpenRouter, Together, vLLM and LM Studio — had never met a real remote
endpoint, because Groq shares the code path but its gated cases have never
had a key either. The suite now carries an xAI-gated entry (`XAI_API_KEY`,
read by nothing else in the repo): the exact self-hosted credential shape
a tenant would save — provider openai_compatible, base URL
https://api.x.ai/v1, an explicit non-reasoning model (`XAI_MODEL`
overrides; a reasoning default would re-arm M7.11's thinking trap with no
thinking-budget knob to bound it) — with the base URL through the
PRODUCTION SSRF vet. What the key found is recorded rather than smoothed
over: a newly created xAI team has NO credits, and until it is funded on
console.x.ai every endpoint (the models listing included) answers one 403
naming that console — `GET /v1/api-key` calls the key itself fine while
`team_blocked` is true. All three cases were run against that state ON
PURPOSE: the validator accepted the shape, the vet resolved api.x.ai, the
vault cycle encrypted and decrypted the real key, the adapter made a real
HTTPS call, and each case failed with the provider's own sentence — no
crash, no key echoed — so the moment the team is funded they go green with
no code change, M7.8's standing arrangement extended to a fourth key.

The same run fixed a bug that had sat latent in the suite for five
milestones because only Gemini had ever run it: the structured-output
case's hand-built system prompt said "match the provided schema" while
PROVIDING none — Gemini and Anthropic survive that because responseSchema
reaches them natively (responseJsonSchema; a forced tool), but a
json_object provider (Groq, the compat adapter) receives no schema at all
and would have been asked to guess the shape. The case now sends the
PRODUCTION prompt (buildAnswerMessages over a fixture RetrievedChunk) and
mirrors the pipeline one step further: on a schema violation, ONE retry
through the real buildRetryMessages, both outcomes printed so the
per-provider violation rate stays observable. That mirror earned itself
the same afternoon: gemini-3.7-flash (new since M8.3) hit a demand spike —
503s, and one 200 stream that died after 10 characters with finish=other —
while a manual replication of the identical request answered perfectly a
minute later, the exact transient §3.15.2's one retry absorbs. Re-run, the
case answered valid in 6.9 s, first try.

What the fresh Gemini key measured, and the rate-limit fact the suite had
been stating wrong. The new `AQ.`-format key authenticates (header auth is
format-agnostic); gemini-3.6-flash is ALIVE for a new key — round trip
1,095 ms, the vault-cycled key answering at a 22.8 s free-tier tail — and
the embedding path reproduced M7.11's numbers exactly: 768-d in 294 ms,
task types 0.834 same-text vs 0.555 unrelated. The /models listing has
moved again (gemini-3.7-flash and gemini-embedding-2 are new; 2.5-flash is
still advertised despite M7.11 finding it dead for new keys — unprobed
here, because the listing is not the truth and a generate call costs
quota). Then the suite's own three back-to-back generate calls tripped the
per-MINUTE limit, and its failure message — written after M8.3 met the
per-DAY quota — blamed the day, advice that sends the reader the wrong
way. Both fixes are in: the structured case waits one bounded 60 s for the
window the suite itself spent (a rate limit says nothing about the claims
contract the case measures), and the 429 sentence now names BOTH limits
and how to tell them apart. The daily quota's exact shape is confirmed
from the 429 body: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
limit 20, per MODEL — so `GEMINI_MODEL=gemini-3.7-flash` pinned the re-run
to a fresh bucket, which is what the override exists for — and its
RetryInfo ("retry in 11s") is fiction: the bucket is hard until the
rollover. Part of the day's 20 was spent before this session touched the
key, which is worth knowing when a fresh key 429s early: AI Studio usage
bills the same per-model bucket as the API. Ladder: realtime typecheck and
456 keyless tests green; nothing outside a test file and .env.example
changed, so no prod boot and no probes (§1.2).

M8.5 is done — **the source ceiling is enforced, and sources became
deletable** (§3.22, §2.4.9, §9.9, §3.8, DATAFLOW §7.9b). The plan catalog
had advertised a per-tier source limit on the billing page since M5.3 while
its own comment admitted nothing checked it — "a limit we advertise and do
not check would be worse than none", which was for two milestones exactly
the product's state. Both create routes (crawl/sitemap and upload) now
refuse past the ceiling with a 409 whose sentence names the plan, the
count, and both ways out; the check runs INSIDE the create transaction with
the org row LOCKED, because count-then-insert races and five concurrent
creates would all count zero — a test fires exactly that and one lands. The
upload route checks twice: an advisory read before the parse (refusing a
full plan after seconds of PDF decompression would do the expensive thing
first — the 413-before-parse argument) and the locked check in its
transaction. Enforcement forced the second half: sources had been add-only
since M3.6a, and a cap on an add-only resource would spend a free tenant's
single slot forever on their first typo, so `DELETE
/internal/orgs/:orgId/sources/:sourceId` now takes the whole subtree
(documents, chunks, embeddings, upload text, job history — all CASCADE)
while every transcript keeps its verdicts (§3.3.2's deliberate missing FK,
leaned on outside a test for the first time). The queue interaction is the
careful part: a QUEUED job dies with its source — the DELETE holds the row
lock and the worker's SKIP LOCKED claim cannot take a locked row — while a
RUNNING one refuses the delete (409), checked after the queued-delete and
rolled back together so a refusal changes nothing. The sources page says "N
of M sources on the <plan> plan" from the same catalog realtime enforces,
and grows an owner-only Delete hidden only while a crawl runs. Two seeded
orgs whose sources are later touched through the tenant surface moved to
`pro` — the security fixture's probe orgs (the malformed-upload case is
about the parser's 422, not the cap's 409) and seed-demo's demo org (the
playground tour's first sources step is "crawl nodejs.org", which a full
free org would refuse). Verified with the full ladder against the rebuilt
prod image — smoke, injection, security 57/57 — plus 456 realtime tests (8
new) and web's suite and build, then verified LIVE in a real browser against
the dev servers: a fresh free org reading "0 of 1 source on the Free plan",
a connect flipping it to "the plan is full" with both buttons on the row, a
second connect surfacing the exact 409 sentence in the form with nothing
landed, Delete emptying the subtree (checked in the database) and freeing
the slot, a QUEUED row offering Delete but not Re-crawl and its job dying
with the source, and at 375px `scrollWidth === clientWidth === 375` with
nothing past the viewport edge. One flake recorded rather than shrugged at:
the wake-driven worker test's 2-second poll ceiling went red once on an
idle machine and green on every re-run; the ceiling is 10 s now, binding
only when something is really wrong since the loop exits on success.

M8.4 is done — **the answer path has a deadline** (§3.15.6, §3.18, §3.8,
§2.6, DATAFLOW §5.2, §14). M8.3 found the gap and deliberately did not fix
it in a measurement commit: nothing bounded a provider that accepts the
connection and goes quiet — Node's `fetch` has no default timeout,
`postStream` passes only a caller-supplied signal, and the only abort on the
whole path was the visitor closing the tab, so one measured answer held its
SSE stream open for 310 seconds to a first token. The fix is sixty seconds
of wall clock on the WHOLE answer — embed, retrieve, generate, the schema
retry included — as `AbortSignal.timeout` composed with the visitor's signal
by `AbortSignal.any`, so both aborts travel one wire through every provider
call. The number is bounded on both sides by measured facts (free-tier TTFT
p95 27.9 s doubled by the one schema retry is ~56 s below it; nobody watches
a chat bubble for a minute above it), and killing mid-stream is safe for the
retry policy's own reason: nothing generated reaches the visitor until it is
verified, so an aborted stream has shown nobody anything. The composition
cost almost nothing because the earlier layers were already shaped for it —
a deadline abort is a `TimeoutError`, which retry.ts's `isAbort` has refused
to retry since M7.7 — and the two places that DID need care are each pinned
by a test: the platform fallback now checks the COMPOSED signal (a deadline
that has passed is a visitor already gone, and the standby would spend
tokens on an answer nobody will be shown), and the route keeps its own
controller SEPARATE so its catch can tell the aborts apart — a visitor who
left gets silence, a deadline that fired mid-answer gets the ordinary opaque
error event, because someone is still watching the stream and the widget
recovers their input. `ANSWER_DEADLINE_MS` overrides per deployment in
EITHER direction (an operational bound, unlike the daily cap's
tighten-only), guarded POSITIVE at boot because its zero is uniquely
destructive — `AbortSignal.timeout(0)` fires before the first provider byte,
an outage wearing a configuration's clothes. Verified with the full ladder
against the rebuilt prod image — smoke, injection, security 57/57 — plus 448
realtime tests (4 new: the hung provider cut off once and unretried with the
question kept, the happy path untouched, the fallback refused after the
deadline, and the route's stream CONCLUDING at the deadline as meta → one
opaque error with elapsed asserted). The README's known-limitations bullet
this replaces is deleted, and the compare harness now reports a slow answer
against the deadline instead of reporting that nothing exists.

M8.3 is done — **the provider comparison table, both halves** (§7.9, §7.10,
§3.30, §3.14, eval/RESULTS.md). The plan calls this table "the strongest
evidence the author evaluated rather than guessed", and it was the last of
its named metrics with no producer at all — M7.10 said so in as many words
("what this does NOT do is make the plan's provider-comparison TABLE exist").
The first decision is that the plan's five columns are **not one
measurement**: recall@5 belongs to the EMBEDDING provider and the other four
to the GENERATION provider, so they are produced by two harnesses and
published as two tables — mixing them would let a better embedder flatter a
worse model. `npm run compare` (new) asks the golden set through the REAL
answer pipeline once per generation provider, reading schema violations back
from `messages.schema_violations` so the published number is the product's
own record; `npm run eval -- --embedder gemini` (the M7.12 flag, never run
until now) produces the embedding half. **The headline is the strip rate:**
a real model had **23.8% of its claims stripped** where the context-quoting
mock strips 0% — the mock being the control that proves the number is about
the model rather than the harness, and the delta being this project's thesis
as a measurement. Beside it: **1 schema violation in 19 answers** (M7.11 saw
0 in 9, so Gemini's native enforcement is near-dead rather than dead), and on
the embedding side **+15.0 points of recall@5** for `gemini-embedding-001`
over the local `bge-small-en-v1.5` (90.0% vs 75.0% hybrid), with the hybrid
miss list falling from 12 questions to 2 and the lexical arm byte-identical
across both runs as the control that says only the dense arm moved. Three
limits are stated where the numbers are rather than smoothed over: the free
tier is **20 generate requests per DAY** for `gemini-3.6-flash` (which is why
n is 20 and not 80, and which the harness records as an ordinary `error`
outcome rather than crashing), `gemini-3.6-flash` stays deliberately unpriced
so cost per 1k reads "—" while the token counts are published for anyone
holding the price sheet, and **`batchEmbedContents` is metered PER ITEM** —
100/minute on the free tier — which contradicts §2.4.5a's stated rationale
for the batch-first interface and is why the local model remains the default
and the CI path. Groq, Anthropic and Ollama appear as SKIPPED rows naming
their reason, never omitted. The run also surfaced a gap it deliberately did
not fix: **nothing in the answer path imposes a deadline** — one answer
reached its first token after 310 seconds, and the only abort in the whole
path is the visitor closing the tab (§7.10, §3.18).

M8.2 is done — **the Test button calibrated to the provider it tests**
(§3.21, §3.8). The playground's own "paste a free key" step failed, and the
cause was a guess made before this project had ever called a real provider:
`testGenerationRoundTrip` waited 15 s and never retried. M7.11 had since
MEASURED the free tier this product is designed around at a TTFT p95 of
27.9 s; the live suite watched a structured-output call take 29.4 s; and the
playground produced a 503 after 11 s. Both failure modes told a tenant with a
perfectly good key that something was wrong with it. The budget is now 25 s —
bounded by the 30 s web already waits for the whole internal call, because
anything at or past that turns a provider timeout into a dashboard timeout
that names nothing — with ONE extra attempt for the retryable class only
(429/408/5xx/transport), sharing the same wall clock so two waits cannot
become two budgets. A 401 is never retried (§3.15.5's weather-versus-fact
distinction, applied to a form), and neither is an adapter's own contract
violation. The tail is answered by a sentence rather than a bigger number:
"free tiers are often slow — try again before assuming the key is wrong."
Eight keyless tests pin the policy, and the fix was verified against real
Gemini through the internal route: two Test calls succeeded at 16.3 s and
19.4 s of provider latency, both of which the old cap would have refused.

M8.1 is done — **the whole product in one command** (§6.5, PLAYGROUND.md).
Every milestone so far measured, hardened or documented the product; none of
them made it easy to USE. Booting the stack by hand is six coordinated steps
whose failure modes are all silent — realtime's dev server does not read
`.env` while its CLIs do, the dashboard degrades to setup notices unless three
variables agree across two processes, the seeded demo org has no dashboard
login, and `/demo`'s own origin is not on the allowlist `seed-demo` writes
(a bug found by this increment: the page rendered and then 403'd every mint).
`npm run playground` owns all of it: preflight (Docker, deps, ports, `.env`),
database, widget build, three dev servers, two seeds, and a banner with the
URLs and credentials. Keyless — the mock answers by quoting retrieved
documentation, so the grounded loop is real even where the model is not.
Three decisions carry it: generated secrets PERSIST in gitignored
`.playground/secrets.json`, because `CREDENTIAL_MASTER_KEY` encrypts tenant
provider keys and resolve.ts throws loudly rather than degrading — a fresh key
per run would break every answer for an org whose key was saved last session;
env layering is four rules with `EMBEDDING_PROVIDER=local` a HARD override,
since seed and query sides disagreeing means the dense arm sees nothing and
every question refuses; and children spawn as direct node entrypoints rather
than npm shims, so the recorded pid is the true supervisor and `taskkill /T`
clears the tree (verified live: ten processes, one call, all three ports
freed). Verified end to end on a cold boot — banner, a grounded cited answer
and a refusal through the real SSE route, dashboard login, the widget mounted
on the Tailwind fixture answering with citations, `/demo` minting 200 from its
own origin, teardown leaving the database up, and a `--skip-seed` reboot
reusing both the corpus and the secrets. It also surfaced a product bug it did
not fix: the Providers page's Test button waits 15 s with no retry, and this
machine's free-tier Gemini answered in 5.9 s, 0.9 s and then 503'd at 11 s —
recorded for the next increment rather than smuggled into this one.

M7.12 is done — **the number that justifies iterative scans** (§3.29, §7.8,
§3.14, eval/RESULTS.md). The plan's metrics list asks for "recall with and
without iterative scans under tenant filtering", and §3.12 had been claiming
for six milestones that "the eval harness measures the with/without delta —
the number that justifies the setting" when no such measurement existed. It
does now: `npm run tenant-scan` seeds N tenants of 30 chunks into ONE shared
index and asks each for its own five nearest rows, with the setting on and
off. **With iterative scans off, starvation begins at 8 tenants and by 16
tenants 15 of 16 lose more than half their own corpus — a 52.5-point recall
loss — while every query still returns 200.** With it on, every tenant gets
exactly k at every measured size, and the latency cost is inside the noise.
The harness verifies the PLAN per sweep point and reports a row that left
HNSW as unmeasured rather than as a finding, because an exact plan sorts
every matching row and therefore cannot starve — its 100% would read as
"iterative scans are unnecessary", the exact opposite of the truth. That
check earned itself on the first run: without it the sweep reported 5/8
starved at 240 vectors beside 0/32 at 960, non-monotonic and impossible if
both rows had measured the same plan.

The same increment gave the eval harness a `--embedder` flag (the plan's
"per embedding provider" retrieval metric needs one) and, with it, the
jittered retry the plan's risk table asks for — a PATIENT policy, because a
corpus ingest is background work where a visitor's three-attempts-in-eight-
seconds would abandon a run that a 30-second wait would finish. Making the
harness able to switch models exposed a real bug it had carried all along:
its content-hash short-circuit did not know about models, so a Gemini run
that died partway on a rate limit left 196 of the corpus's 661 chunks
embedded under one model and none under the other, and the next local run
skipped exactly those documents as "unchanged" — hybrid recall@5 fell from
75.0% to 46.3%, a floor violation whose cause was invisible in the score.
The fix is the ingest worker's own second condition (§3.10.5), which the
harness never had: unchanged text is enough only if the chunks already carry
vectors under the model about to be scored. Found by running it, not by
reading it.

M7.6b is done, and with it **the README's last named gap is closed** —
**a customer can hand the product a file** (§3.3.11, §3.10.8, §3.10.5,
§3.22, §9.9, §6.1, §6.3, DATAFLOW §3.2, §7.9a). `sources.kind` has allowed
'upload' since 001 and nothing could produce one; the worker failed such a
job loudly because there was no other honest thing to do with it. The split
of work is the whole design and it falls exactly where the
control-plane/data-plane split already falls: the file is PARSED IN THE
REQUEST and EMBEDDED BEHIND THE QUEUE. Parsing in the request is what makes
the refusals useful — "this PDF is a scan, its content is pixels, run OCR
first", "it is password-protected" — sentences worth the most while the
tenant still has the file in front of them rather than minutes later on a
row that says failed; and parsing is the cheap half, CPU bounded by a 10 MB
cap (the PDF parser's own number, so one cap governs). Embedding stays
queued because it is external network measured in minutes for a large file,
and the dashboard runs on Vercel, whose functions cannot hold a request open
that long. **The bytes are never stored, and the extracted TEXT is** —
migration 009's `source_uploads` — which is not thrift but a REQUIREMENT the
naive design would have missed: when an org changes its embedding model
§3.22 re-queues every source, a crawl answers that by being fetched again,
and an upload has nothing to re-fetch, so without the stored text a model
change would silently orphan every uploaded document. Blocks are stored as
SPANS and sliced back out, so the parser contract holds by construction in
both directions rather than by two copies agreeing. The worker treats an
upload as a crawl of ONE page whose fetch is a database read, emitting the
crawler's own event shape — which is why progress, lease renewal, the
vanished-document sweep and the failure path all work on it unchanged, and
why there is no second ingest path to keep in step. Two consequences worth
naming: Re-crawl now works on uploads (the button says "Re-index"), because
an upload whose first ingest failed on a wrong credential previously left
the tenant nothing to click but "upload it again"; and the file travels to
realtime as `application/octet-stream` with its name and declared type in
headers, because app.ts mounts a 64 KB JSON parser across every route and a
customer's `.json` upload would otherwise be claimed and refused by that
parser before the upload route ran. The security probe's **oversized-upload
case — the one M6.4 recorded as deferred (§6.3) — is now written**, and it
asserts not just that 11 MB is refused but that it is refused BEFORE the
parser runs, since a PDF parser decompresses and refusing afterwards would
have already done the expensive thing. M6.1 is done — the security probe (§6.3, §3.27, §4.4,
DATAFLOW §12): a seeded pair of tenants to attack, and 36 black-box checks
across the trust model's layers — origin allowlist and CORS posture, key
state (a revoked key byte-identical to an unknown one), token tamper and
cross-origin replay, tenant isolation with a positive control, input
bounds, the handoff socket (single-use ticket, role from the ticket, bad
frames without a disconnect), and the rate limits last because they drain
the buckets — run in CI against the shipped image as a merge-blocking gate,
with the fixture seeded from INSIDE the compose network so neither the image
nor its network posture changes for the harness. M6.2 is done — the
internal-API probes (§6.3's section H, §4.3): nine checks behind a
throwaway secret CI now generates, every one refused BEFORE any egress —
fifteen SSRF payloads (loopback in four spellings, link-local metadata,
RFC1918, CGNAT, ULA, v4-mapped v6, a metadata hostname) refused as crawl
targets and as self-hosted provider base URLs with one generic sentence,
and the credential read-back denial proven against a seeded canary whose
plaintext the probe knows and whose suffix is the only thing the status
route may show. M6.3 is done — the injection probe (§6.4, §7.7): nine
hand-written poisoned pages seeded into a probe tenant's corpus, each with
a canary that appears only in the attacker's half, and the three
containment properties ASSERTED as observable facts of the SSE stream — no
uncited channel, citations from documents rather than model text, the
system prompt never in anything the visitor sees — while the relay rate is
REPORTED as the per-model number it is (0/8 under the mock, which measures
the pipeline; a real provider measures the model). M6.4 closed the
milestone with the documentation and a full verification ladder. Two things
the plan's M6 list names are covered differently than a reader might
expect, and are stated rather than fudged: "oversized uploads" — at M6.4 file
uploads did not exist (deferred with PDF support), so what the probe bounded
was every payload the surface DID accept, the 64 KB JSON body, the 2,000-char
question, and the 4,000-char socket frame. M7.6a built the PDF parser with
its own size cap tested at the parser (§3.10.7), and M7.6b built the upload
route and with it the probe's own oversized case — so this one is now CLOSED
rather than deferred (§6.3); and
"rotated keys" — at M6.4
one-click rotation was a dashboard feature that had not been built, so the
fixture performed a rotation by hand (a key created live, then revoked) and
the probe asserted the property rotation depends on, that a rotated-out key
is byte-identical to one that never existed. M7.1 has since built the
feature (§9.17); the fixture still writes those rows itself, because the
e2e stack has no dashboard, and they are exactly the rows the dashboard's
rotation writes. And one thing that could not be
verified from here: the e2e job's YAML was exercised command-for-command
against the prod compose stack on this machine, but its first run on GitHub's
runners is the next push to `dev`.
M5.1 is done — the metrics layer (§9.13): deflection, refusal and claim-strip
rates, latency percentiles, time-to-first-human-response, and a by-model
breakdown, all computed in SQL from columns the pipeline has been writing
since M2, with every rate null-not-zero when it has no denominator. M5.2 is
done — **cost per 1k answers** (§2.4.8, §3.3.5, §9.13, DATAFLOW §9): the
provider's own token counts persisted per answer and SUMMED across the retry
because both calls were billed, a dated price list matched EXACTLY so no
model is ever priced as a cheaper sibling, and unknown priced as null rather
than as free — the figure says what it is (list price, generation only, not
what a free tier billed) and reports how many answers it could not price.
The same pass deleted a by-model refusal column that could only ever read
zero and had passed a test whose fixture did not match the pipeline. M5.3
is done — **plan quotas, enforced pre-flight** (§2.4.9, §3.3.6, §3.26,
§3.18, §9.7, DATAFLOW §10): migration 004's `usage_daily` counters, written
in the same transaction as the answers and escalations they count so they
cannot drift, and read as ONE primary-key lookup before every model call
against the org's plan ceiling — the check that used to scan a day of
messages now costs the same on a tenant's busiest day as on their first,
and the deployment override can only TIGHTEN a plan, never widen it. The
plan catalog has two enforcers, a compile error and a DB-gated test, because
neither the compiler nor the test can see what the other does. M5.4 is done,
and with it **M5 IS COMPLETE**: Stripe test-mode billing (§3.3.7, §9.15,
DATAFLOW §11) — Checkout out, a signature-verified webhook back, and an
event ledger keyed by STRIPE's own event id, so a redelivery applies exactly
once by SCHEMA rather than by a check-then-act read that would race the
retry storm it exists to survive. The signature check is hand-rolled and the
`stripe` SDK is rejected with the case FOR it written down; a live secret key
is refused by name, because a portfolio demo that could charge a real card is
a liability rather than a feature; and entitlement stays a column on
`organizations` rather than a join, so a billing outage can never reach the
answer path. M0–M2 are complete: the full
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
bundle is 5.65 KB gzipped against the 15 KB budget. M4.5 is done — the
AGENT's end (§9.12, DATAFLOW §8.6): an inbox ordered by who has waited
longest, and a live conversation view where attaching claims the handoff
and the socket replays what the bot already said. Verified live with the
widget and the dashboard in two browsers against one realtime process —
escalation appearing in the queue, both turns replayed to the agent, a
reply crossing to the widget, the visitor's answer crossing back, and
"Visitor is typing…" appearing and expiring on its own TTL. M4.6 is done,
and with it the handoff LIFECYCLE is complete (§2.4.7, §3.23, §3.22,
§3.25, §9.12, DATAFLOW §8.7): an agent can finish a conversation, the
room is TOLD rather than left to infer it from a dropped socket, and the
bot takes the thread back — verified live, including the very next
question being answered by the bot again. M4.7 is done, and with it **M4 IS
COMPLETE**: the socket is MEASURED (§10, loadtest/RESULTS.md) — 300
concurrent sockets carried with nothing dropped, a 26 ms p50 / 72 ms p95
round trip (which includes the Postgres write, since the server persists
before it broadcasts) below ~100 messages/second, and a knee between 200
and 250 msg/s whose arithmetic points at the 5-connection pool rather than
at the socket layer. The write-up records two harness bugs that produced
wrong numbers first, because a load result nobody can reproduce or
criticize is a claim rather than a measurement. One thing was recorded
honestly rather than half-built at the time: resuming a handoff across a
page RELOAD (the widget kept its conversation id in memory only). M7.4 has
since built it — §8.1's bookmark and §8.1c's rejoin, DATAFLOW §8.5.

---
