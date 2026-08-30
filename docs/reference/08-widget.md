<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §8 widget/ — the embeddable widget

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

**M7.3 — where the session comes from.** The one thing strong mode changes
is the mint. `ApiClientOptions` takes EITHER `publishableKey` (the default:
POST /v1/widget/session, as always) OR `sessionUrl` (strong mode: a URL on
the CUSTOMER's own site whose server minted the session with the SECRET
key for a user it signed in — index.ts reads it from `data-session-url`,
and given both, strong mode wins, since its point is that the publishable
key need not be on the page at all). Everything after the mint is identical:
same token, same routes, same 401 → re-mint dance — a re-mint in strong mode
is simply another fetch of that URL, so an expiring token stays invisible
there too, and a customer's endpoint has only to keep answering while the
user is signed in. Three decisions in `#fetchServerMintedSession`: **GET**
rather than POST, so the endpoint sits outside every framework's CSRF check
by default (Rails and Django refuse an unadorned POST; a token mint has no
state to protect from forgery, and a cross-origin page cannot read the
answer); `credentials: "include"`, which is same-origin-with-cookies for the
relative URL the snippet carries and still works for a customer pointing it
at their API host with credentialed CORS; and `cache: "no-store"`, because a
cached token is one that expires mid-chat. The response shape is the browser
mint's, so the customer's endpoint proxies realtime's answer verbatim. And
the identified visitor id is deliberately NOT persisted to localStorage: the
customer's server names the user on every mint, and a stored copy would only
ever be sent back on some later publishable-key mint on another of the
customer's pages — where realtime refuses anything but the anonymous shape
by design (§2.4.10), and the widget would break. A signed-out user gets
whatever the endpoint answers; a 401 surfaces as a mint failure and the
widget's ordinary notice, which is why the Install page suggests omitting
the snippet on pages that do not require sign-in.

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

**M7.4 — the handoff bookmark.** Three more members on the same client:
`rememberHandoff(conversationId, panelOpen)`, `forgetHandoff()`, and
`storedHandoff()`. The bookmark lives beside the visitor id under the same
localStorage guard, and holds exactly three things — the conversation, how
the visitor left the panel, and `at`, the last time the widget touched it.
What it deliberately does NOT hold decides its safety. Not the token: a
session is re-minted on the next page as it always was (one POST, the same
handshake bubble-open makes), which is what keeps strong mode's "only
signed-in users" true across pages — a cached token would outlive a
sign-out by up to thirty minutes. Not the visitor id: in the default mode it
is already stored beside this, and in strong mode it is the customer's own
user id, which this file refuses to persist; ownership is the server's check
anyway (a ticket mint for a conversation that is not this visitor's answers
404 and the bookmark is dropped — the same recovery path as a closed
handoff, so user B signing in on user A's browser gets one refused probe and
nothing else). And never a bot conversation: only the UI's live handoff
writes it (§8.1c's `touchBookmark`), because rejoining a bot thread would
continue a conversation the widget has no way to show — the transcript
arrives only over the socket — and nobody is waiting on it. `storedHandoff`
is a storage read and nothing else: no request until the UI opens the
socket, and a page with no bookmark costs nothing. It drops a bookmark older
than `HANDOFF_BOOKMARK_TTL_MS` (24 h, measured from the last touch, so a
long live conversation never expires under the visitor) rather than probing
it — the "expiry" DATAFLOW §8.5 said this needed; the recovery for a stale
bookmark INSIDE the window is the socket's own null ticket. Storage on the
customer's origin is writable by anything on the page, so the value is
shape-checked (junk is no bookmark, never a throw), and the id's own shape
is the SERVER's to judge: `handoffTicket` now treats a 400 like a 404 —
nothing to rejoin — because a tampered id is the only way to get one and a
reconnect loop arguing with a 400 forever is precisely what a bounded rejoin
exists to avoid.

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
the handoff is over. (M7.4's page-load rejoin points this same loop at a
stored conversation and bounds it from the OUTSIDE — §8.1c's 60-second
timer — for the one case where the visitor has been shown nothing yet;
the probe IS the loop. The class changed by one line for it: `#stopped`
is now checked right after the ticket mint resolves, BEFORE the null case,
so a socket closed while its mint was in flight reports nothing — a late
"ended" would otherwise land on a UI that has moved on, and make an
abandoned rejoin forget the bookmark it meant to keep.)
Composing hints are throttled here to the protocol's
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
pipeline stops finding an open handoff and answers again. Since M4.6 that
state usually arrives as the socket's `closed` FRAME rather than as a
failed reconnect, so a visitor whose agent just finished reads "the
assistant is back" instead of watching a reconnection they do not need.

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

**M7.4 — the rejoin.** A fourth entry point, taken at mount: if
`client.storedHandoff()` finds a bookmark (§8.1), the UI adopts the
conversation id, opens the socket for it, and sets `rejoining` — a state in
which `handoff` is the probing socket and NOTHING is drawn: no status line,
no composer switch, and the composer still talks to the bot. The socket's
own first ticket mint is the probe, which is why there is no separate
"is this still open?" request: a reconnect loop with backoff is exactly the
right thing to point at that question — a transient failure retries, and the
server's answer is terminal either way. `socketHandlers()` is one set of
callbacks for a handoff entered here and one rejoined, because after
confirmation they ARE the same handoff; the rejoin differs only in its first
status. `ended` before confirmation means the bookmark was stale (the agent
closed the conversation while the visitor was away, or it was never this
visitor's): forgotten silently, conversation id dropped, and the page is left
exactly as one that had no bookmark — "the support chat has ended" must not
appear on a page nobody escalated from. `waiting`/`connected` (from `ready`)
confirms: `showHandoffChrome` draws the status line and switches the
composer, `greeted` is set (the replayed transcript is the greeting — a "Hi!
Ask me anything" under an agent's last message would read as the bot
interrupting), and the panel is re-opened iff the bookmark says the visitor
had it open, through `setOpen`, which never steals focus (only the visitor's
click does). The rejoin is bounded by `REJOIN_TIMEOUT_MS` (60 s): the live
loop is unbounded on purpose (§8.1b), but an unconfirmed rejoin has shown
the visitor nothing, so giving up costs nothing visible — the bookmark is
KEPT for the next page and, unlike the stale case, so is the conversation
id, so a question asked once an outage clears lands in the thread a person
may own and the `handoff` event catches the visitor up on a fresh socket
(the file states the price: a shared computer whose previous user's bookmark
met an outage at load gets the opaque error until a reload). What the bound
buys is the case where the mint itself keeps failing — a signed-out user in
strong mode — which would otherwise poll the customer's endpoint at the
loop's ceiling for as long as the tab is open. During the probe a question
goes to the BOT under the stored id: a person owning the thread answers as
`handoff`, which `enterHandoff` leaves to the socket already probing (its
guard is `handoff !== null`; one socket, never two), and the escalation
offer treats an unconfirmed rejoin as no handoff at all — if it confirms,
the replayed backlog wipes the offer with the rest of the log. Two smaller
things landed with it. `touchBookmark` is the bookmark's ONE writer — on
entering, on every attach and reconnect (so a long conversation with the
panel left alone never expires), and on every panel toggle — and a no-op
outside a confirmed handoff, which is what keeps bot conversations out of
storage. And a person writing while the panel is closed badges the bubble
(one class, one `::after`, an aria-label that says "new message"); opening
clears it; the replayed backlog and the visitor's own echo from another tab
are not news. `statusBar` is now held rather than closed over so a handoff
after the last one ended REPLACES the line instead of stacking under "the
support chat has ended" — a wart the rejoin would have made routine.

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
mid-wait, and the closed-handoff null vs the 500 that still throws. Strong
mode (M7.3): the session fetched from the customer's URL by GET with
credentials and no-store and no publishable key anywhere in the request;
the server-minted token used on chat while a stored anonymous id stays
untouched in localStorage; the 401 re-mint going back through the
customer's URL; a signed-out user's 401 surfacing as a mint failure rather
than a hang; the URL winning when both are configured; and construction
with neither refused. ui:
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
retrying (an outage is not a decision), and close() stops everything.
M4.6 adds the `closed` frame ending the session WITHOUT a reconnect —
pinned by leaving a second ticket available and asserting it is never
minted. The UI suite covers the same states through the DOM: the offer appearing only
after a refusal and only once, escalation switching the panel, the
transcript rendering the bot's turns alongside the agent's, sends going
to the socket instead of the bot with unsent text kept, catching up on a
`handoff` event this tab did not start, ending handing the composer back
to the assistant, and the XSS probe repeated for socket text — because
agent prose is as attacker-reachable as model output.

The rejoin (M7.4), on all three suites. handoff: a socket closed while its
ticket mint is in flight reports nothing when that mint then answers null —
no `ended`, no socket. api: the bookmark written and read back
with no request spent (a page load without one costs nothing), holding
exactly `conversationId`/`panelOpen`/`at` and nothing else; a bookmark past
the TTL dropped from storage rather than probed while one just inside it
is still offered; five junk shapes read as no bookmark; and a 400 for the
ticket answered as null rather than thrown. ui, through the fake client's
scripted `storedHandoff` and recorded bookmark writes: a handoff bookmarked
on entering, following the panel's toggles, forgotten on ending — and a
bot conversation never bookmarked at all; a stored handoff rejoined at
mount with NOTHING drawn until `ready` (no status line, panel closed,
composer the bot's, log empty, no bubble-open mint) and then the panel
back open with the socket's composer, no greeting, the transcript replayed,
and sends going to the socket; a bookmark saying the panel was closed
keeping it closed while connected, the backlog and the visitor's own echo
never badging, an agent's message badging the bubble, and opening clearing
the badge without greeting over the transcript; a stale bookmark (`ended`
before confirmation) forgotten silently with the page left as one that had
no bookmark — greeting on open, the next question starting a NEW
conversation; an unconfirmed rejoin closed at exactly the 60-second bound
with the bookmark and the conversation id KEPT, and the next question
catching up through `handoff` on a second socket; a question typed during
the probe going to the bot under the stored id and the confirmation still
landing on the ONE socket; and a handoff after the last one ended replacing
the status line rather than stacking a second.

cost (M7.9) is the one suite here that uses the REAL ApiClient and the real
mountWidget against a counting fetch, rather than the fake client every
other UI case injects — because a fake client is precisely the thing that
would hide a request. It pins the product promise that a page nobody chats
on pays for one request and nothing else: ZERO fetches and zero sockets at
mount (the microtask queue flushed first, so a request fired without being
awaited still fails the test), exactly ONE at bubble-open (the session
mint, which is also the Neon-warming handshake — and opening the panel
again re-mints nothing), exactly one MORE per question, and the deliberate
exception stated rather than hidden: a page loaded with a live handoff
bookmark spends a mint AND a ticket at once, because a person is waiting
and the rejoin IS the probe (§8.1c).

### §8.4 `fixtures/` + `scripts/serve.mjs`

The three host pages the plan requires, each testing a distinct failure
mode: Tailwind (preflight reset), Bootstrap (high-specificity components

- a fixed navbar; also proves data-accent wins), and hostile —
  `* { all: unset }` plus a strict CSP whose every directive is explained
  in the page source (connect-src is the ONE thing customers must add —
  and since M7.4 it names the API host TWICE, `http://…` and `ws://…`,
  because CSP's scheme matching goes http→https and never http→ws, so a
  directive listing only the http(s) origin lets chat work and silently
  blocks the handoff socket; the M7.4 rejoin check on this page found the
  socket refused at "Connecting…" with the ws: URL in the console as a CSP
  violation, a gap that had been there since M4.4's socket, verified only on
  the Tailwind fixture — the Install page prints both origins now, §9.11;
  style-src deliberately excludes anything the widget would need, pinning
  the adoptedStyleSheets path). serve.mjs hosts them on :4400 because
  file:// sends `Origin: null`, which the allowlist rightly rejects — the
  fixtures exercise the SAME origin rules production enforces. Verified
  live in a real browser at M2.6: grounded answers with citations on all
  three pages, refusal on off-corpus questions, 56px styled bubble under
  the hostile reset. Prerequisite: `npm run seed-demo` (§3.19), `npm run
build`, `npm run fixtures`.

M7.3 added a fourth, `strong.html`, whose test is what is NOT on it: no
`data-key`. It names `data-session-url="/api/support-session"`, and
serve.mjs answers that path as a stand-in for a CUSTOMER'S BACKEND — the
Install page's recipe minus the login: one POST to realtime's
`/v1/sessions` with the secret key from `INTERRELATED_SECRET_KEY` (plus
`INTERRELATED_API`, `INTERRELATED_ORIGIN`, `INTERRELATED_USER`, defaults
shown in the file), the JSON passed through verbatim, status included, so a
403 "origin not allowed" reaches the browser console legibly. Without the
key exported it answers 503 with a sentence and the widget says it could not
start — exactly what a customer sees with an unconfigured server. What is
worth noticing is what the handler never does: send the secret to the
browser, or touch realtime's answer beyond passing it on. It is what the
M7.3 live check ran the strong-mode loop against, rotation and revocation
included (the summary at the top).

M7.9 added a fifth, `measure.html`, and it is the odd one out: the other
four test that the widget SURVIVES a host, and this one tests nothing — it
MEASURES, and it is the committed script behind the plan's third widget
metric, "time from snippet load to interactive bubble". Four decisions make
its number honest. `t0` is taken immediately before the `<script>` is
appended, which is literally what "snippet load" means — everything after
it (fetch, parse, evaluate, mount) is ours. `t1` is taken by a
MutationObserver the instant the bubble BUTTON exists inside the shadow
root, not when the host `<div>` appears and not when the script finishes
evaluating, because "interactive" means a visitor could click it. The
observer is installed BEFORE the script is appended, which is the whole
reason the page exists — a measurement bolted on after load can only read
resource timing and guess at the mount. And the snippet is appended from an
inline script at the end of `<body>`, so the widget's own
wait-for-DOMContentLoaded branch is INCLUDED, as it would be for a customer
who pastes the tag in `<head>`: the faithful choice rather than the
flattering one. It reports the network/our-code split from the browser's own
resource timing, keeps this session's samples in sessionStorage (one sample
of a first-paint-adjacent number is noise), and says on its face that a
number measured over loopback is not a number measured over a CDN.

**Measured at M7.9**, ten reloads in a real browser: **p50 9.5 ms** from
snippet append to a clickable bubble, nine of ten between 7.3 and 16.3 ms,
against **168 ms on the cold first load** — the JIT-and-cold-cache case a
visitor pays once. One sample read 522.8 ms and is recorded rather than
dropped: it landed during a burst of back-to-back reloads fired faster than
the pages could settle, and every carefully spaced reload after it came back
in the 7–17 ms band. The browser also confirmed from the outside what §6.2
asserts statically — exactly ONE request attributable to the widget at load
— and that what was measured is a real widget: a 56×56 `BUTTON` in a shadow
root with one adopted stylesheet and nothing in the light DOM.

---
