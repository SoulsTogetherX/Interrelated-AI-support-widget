# Playing with Interrelated

```bash
npm run playground
```

That boots the whole product locally — database, the realtime service, the
dashboard, and a set of pretend customer websites with the widget installed
on them — seeds a real documentation corpus, creates a dashboard login, and
prints where everything is. It needs **no API keys**: answers come from a
deterministic mock that quotes the retrieved documentation, so the full
grounded loop (retrieve → verify → cite → refuse) is real even though the
model is not.

Stop it with Ctrl-C. The database container is left running on purpose (your
data lives in its volume); `docker compose stop database` shuts that down too.

**First run takes a few minutes** — it downloads a ~30 MB embedding model and
embeds 31 documentation pages. Every run after that:

```bash
npm run playground -- --skip-seed
```

Prerequisites: Docker Desktop running, and `npm ci` already done in
`realtime/`, `web/`, `widget/`, and the repo root. The script checks all of
this before doing anything and tells you exactly what is missing.

---

## The tour

Roughly fifteen minutes, in the order that makes the design legible. Each
step names what to look at, not just what to click.

### 1. The widget on someone else's website

Open **http://localhost:4400/fixtures/tailwind.html** — a pretend customer's
docs site. The chat bubble is bottom-right.

Ask something the documentation actually covers:

> How do I make Fastify listen on all network interfaces?

You get an answer where **every sentence carries a citation** — a link to the
page it came from and the heading it lived under. That is the whole thesis of
the project: the model had to answer as a list of claims, each quoting the
source verbatim, and code checked each quote actually appears in the chunk it
claims to come from before you were allowed to see it.

Now ask something it cannot know:

> What is the best banana bread recipe?

It refuses — "I don't have enough information in the documentation to answer
that confidently" — and the refusal was decided **before any model was
called**, by a numeric threshold on retrieval distance. That threshold was not
picked by feel: it came from a sweep over 80 answerable and 40 unanswerable
questions (see `eval/RESULTS.md`).

The other fixture pages are the same widget on hostile hosts, which is the
point of having three of them:

- `bootstrap.html` — high-specificity CSS and a fixed navbar.
- `hostile.html` — `* { all: unset }` plus a strict Content-Security-Policy.
  The widget still renders correctly; its styles live in a shadow root that
  severs inheritance, and it loads no external stylesheet at all.
- `measure.html` — measures how long the widget takes to become clickable
  (~9 ms warm on this machine) and how many requests it costs a host page
  (exactly one: itself).

### 2. Escalating to a human

After a refusal the widget offers **"Talk to a person"**. Click it.

Now open the dashboard at **http://localhost:3001**, sign in with the
credentials the banner printed, and go to **Inbox**. Your escalation is
waiting, sorted by who has waited longest.

Open it. The conversation replays — *including what the bot already said*,
because that is what an arriving agent needs to read. Type a reply: it appears
in the widget instantly over a WebSocket. Type in the widget: "Visitor is
typing…" appears in the dashboard and expires on its own.

Two details worth noticing:

- Your message is not drawn locally in the widget — it is echoed back from
  the server and rendered from that, so both ends render one order from one
  source of truth.
- **Reload the fixture page mid-conversation.** The handoff survives: the
  widget rejoins the same conversation and replays the transcript. Nothing is
  drawn until the server confirms the conversation is still open.

Click **Close conversation** in the dashboard. The widget says the chat ended
and the bot takes the thread back — ask another question to see it answer.

### 3. What the visitor was spared

Go to **Conversations** and open the one you just had.

Every claim the model made is listed with its verdict — including the ones
that were **stripped**. A stripped claim is one whose quote could not be found
in the source it cited; the visitor never saw it, and the dashboard shows you
what they were spared. This is the product explaining its own honesty.

To see a stripped claim on purpose, run this in `realtime/`:

```bash
npm run ask -- "How do I make Fastify listen on all network interfaces?" --org "Widget Demo Org" --tamper
```

`--tamper` corrupts one quote before verification. The transcript will show it
marked *stripped — quote not found in the cited source*.

### 4. Indexing your own documentation

Go to **Sources**. Two ways in:

**Crawl a site.** Try `https://nodejs.org/en` at depth 1. Watch the page count
climb, then look at the "why" list under the source: it will show
`/docs/latest/api/` skipped, with the reason `disallowed by robots.txt
(User-agent: *, Disallow: /docs/)`. That is nodejs.org's real rule, honored by
a hand-written RFC 9309 parser. A crawler that ignores robots.txt is a
scraper; this one shows you what it left out and why.

For a site that refuses everything, try `https://www.reddit.com/` — it fails
with `nothing crawlable — disallowed by robots.txt`, before a single page is
fetched.

**Upload a file.** Any PDF or Markdown file. The file is parsed *in the upload
request*, so a refusal reaches you while the file is still in front of you —
try a scanned PDF and it will tell you it has no text layer and needs OCR
rather than silently indexing an empty document. The bytes are never stored;
the extracted text is.

Either way, ask the widget about the new content afterwards.

### 5. Bringing your own model

Go to **Providers**. This is where the product stops being a demo: paste a
free [Groq](https://console.groq.com) or
[Google AI Studio](https://aistudio.google.com) key (neither needs a card),
press **Test & save**, and the next question in the widget is answered by a
real model — grounded and verified exactly the same way.

What happens when you press it: the key is validated for shape, the endpoint
is vetted (a private or loopback address is refused — this server fetches URLs
tenants give it), a **real completion is requested** so an expired or
out-of-quota key fails here rather than at a visitor's first question, and only
then is it encrypted with AES-256-GCM and stored. From that moment it is shown
only as its last four characters and is never returned by any API.

> **Free tiers are slow and flaky by nature.** The Test button waits 15
> seconds; a free-tier provider can exceed that or answer 503 on a good key.
> If Test fails, press it again before concluding the key is bad.

Connect an **embedding** provider too and watch the sources page re-index
itself: vectors are stored per model, so changing the model would otherwise
make your existing corpus invisible. The product re-queues every source in the
same transaction that changed the credential.

### 6. The trust model, from the outside

The **Install** page is what a customer would follow. Two things there are
worth reading rather than skimming:

- The **origin allowlist**. The widget's publishable key is public by design —
  it is in the snippet on every page. What makes a copied snippet useless is
  that the browser sends an `Origin` header that page JavaScript cannot forge,
  and an unlisted origin is refused before any database read. Try it: add
  `https://example.com` to the allowlist, then remove it, and watch the widget
  keep working (its session was already minted) while a *new* session from
  that origin is refused.
- **"Where your snippet loaded — last 7 days"**. Every session mint is counted
  per origin: allowed ones and refused ones. If somebody copies your snippet
  onto their own site, it shows up here as a name and a number instead of as a
  surprise on your bill. Refused origins you recognize get a one-click
  **Allow**.

On the **Overview** page, rotate the publishable key. The old one keeps
working for 24 hours so a customer can redeploy without downtime — and
"Revoke now" ends that window immediately. Generate a **secret key** too, and
the Install page grows a fourth section: your own server mints widget sessions
for users *it* has signed in, and the page carries no public key at all.

To see that mode running, export the secret key and restart the fixture
server; `http://localhost:4400/fixtures/strong.html` has no key in its source
at all and gets its session from a stand-in "customer backend".

### 7. The numbers

**Metrics** aggregates everything the pipeline has been recording since the
first question: deflection rate, refusal rate, **claim strip rate**, latency
percentiles, time-to-first-human-response, and a per-model breakdown with
tokens, cost at list price, and schema-violation counts.

The strip rate sits next to the deflection rate deliberately. A bot that
deflects everything by answering confidently from nothing is the exact failure
this project exists to prevent — so the number that would expose it is shown
beside the number it would flatter.

**Billing** shows the plan tiers. Without Stripe configured it is read-only,
and quotas still work: they come from the plan column, not from Stripe. Both
ceilings are real — answers per day before every model call, and sources at
the moment you connect one (the demo org is seeded on the Pro tier so the
tour above never bumps into the source limit; an org you create yourself
starts on Free, where the ceiling is one source and the sources page says
so).

### 8. The public demo page

**http://localhost:3000/demo** is the widget over the same corpus, served by
the realtime service itself — the page a recruiter would be sent to. It uses
the same public routes as everything above.

---

## Useful commands

Everything below assumes the playground is running (it uses the same database).

| Command | What it does |
|---|---|
| `npm run playground -- --skip-seed` | Boot without re-seeding (much faster) |
| `npm run ask -- "<question>" --org "Widget Demo Org"` | The whole answer pipeline from the CLI, printing tokens, cost and citations |
| `npm run ask -- "<q>" --org "Widget Demo Org" --tamper` | Same, with one quote corrupted, to watch verification strip it |
| `npm run search -- "<question>" --org "Widget Demo Org"` | Retrieval only: what the model would have been shown |
| `npm run eval` | Score retrieval against the 80-question golden set |
| `npm run tenant-scan` | Measure what multi-tenant iterative scans are worth |
| `node scripts/smoke-test.mjs` | The probe CI runs against the shipped image |

(The `npm run` entries above live in `realtime/`.)

---

## When something is wrong

**"port 3000 is already in use"** — a dev server from a previous run outlived
its parent. The script prints the fix; on Windows it is
`netstat -ano | findstr :3000` then `taskkill /pid <PID> /T /F`.

**"Docker is not reachable"** — start Docker Desktop, wait for the engine, and
re-run.

**Realtime exits at startup with a Postgres auth error** — your `.env`'s
`POSTGRES_PASSWORD` does not match the existing database volume. Either
restore the old password or `docker compose down -v` (which **destroys** the
local database) and re-run.

**The widget refuses everything after you ran the test suite** — `npm test` in
`realtime/` drops and recreates the schema, which deletes the seeded corpus.
Re-run `npm run playground` (without `--skip-seed`) to seed it again.

**Ctrl-C left processes behind** — this can happen in Git Bash/mintty, which
sometimes hard-kills Node before its shutdown handler runs. Windows Terminal
or PowerShell are more reliable; either way the port check on the next boot
tells you what to kill.

---

## What is real and what is not

Worth being explicit, since a demo that overstates itself is worse than one
that does not exist:

- **Real**: retrieval and its measured quality, the citation verification and
  stripping, the refusal threshold, multi-tenancy and its isolation, the
  origin allowlist, key rotation, the handoff socket, the crawler and its
  robots.txt handling, PDF parsing, quotas, and every number on the metrics
  page.
- **A mock unless you connect a provider**: the model. The mock answers by
  quoting the retrieved documentation, which makes the pipeline honest to
  exercise but says nothing about how a real model behaves. Connect a key
  (step 5) and everything downstream is unchanged — that is the point of the
  provider abstraction.
- **Not exercised locally**: Stripe (test mode needs keys), and the deployed
  cold-start behavior that only a free-tier host exhibits.
