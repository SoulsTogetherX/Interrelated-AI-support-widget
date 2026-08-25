# 04 — Using it: run, demo, operate

## The fastest path: the live deployment

| Thing | URL |
|---|---|
| **Demo** (the widget over real Fastify docs) | <https://interrelated-realtime-rtue.onrender.com/demo> |
| Dashboard | <https://interrelated-ai-support-widget-beta.vercel.app> |
| Data-plane health | <https://interrelated-realtime-rtue.onrender.com/api/health> |

Ask the demo things the Fastify docs answer ("How do I register a plugin?",
"How do hooks work?", "How do I validate a request body?") and things they
don't ("What's your refund policy?") to see a grounded answer with
citations vs. an honest refusal.

Realities of a $0 deployment, all deliberate and documented:

- **First load after an idle spell can take up to a minute** — Render's
  free tier spins down after ~15 min idle, and the keepalive cron only
  *reduces* how often that happens (measured: it fires 24–54 min apart, not
  the requested 10).
- **The demo org answers at most 18 questions a day** — our own cap, set
  below Gemini's free 20-generations/day so exhaustion is a graceful "demo
  quota reached", never a provider error. Resets midnight Pacific.
- Generation runs on `gemini-3.5-flash-lite` (measured 22× faster than
  `3.6-flash` under free-tier contention); embeddings on
  `gemini-embedding-001`; both via the demo org's own vault credentials —
  i.e. the demo exercises the real BYO-provider machinery.

## Run the whole thing locally with one command

```bash
npm run playground
```

That boots everything — Postgres (Docker), the realtime service (:3000),
the dashboard (:3001), fixture "customer websites" with the widget
installed (:4400) — seeds a real documentation corpus and a dashboard
login, and prints every URL and credential. **No API keys needed**: a
deterministic mock answers by quoting the retrieved documentation, so
retrieval, verification, citations, refusals, handoff, and the dashboard
are all real even where the model is not. [PLAYGROUND.md](../PLAYGROUND.md)
is the guided tour. Generated secrets persist in `.playground/secrets.json`
so saved provider keys survive restarts.

## Manual dev setup (when you want the pieces separately)

```bash
cp .env.example .env            # the registry of every env var, documented
docker compose up -d database   # Postgres 18 + pgvector on host port 5433
cd realtime && npm ci && npm run dev    # migrates at boot, listens on :3000
cd ../web   && npm ci && npm run dev    # dashboard on :3001
cd ../widget && npm ci && npm run build && npm run fixtures  # host pages :4400
```

Things to know:

- `.env.example` is the **single registry** of every variable the system
  reads; a module reading an undocumented variable is, by project rule, a
  bug in the module.
- The realtime *dev server* does not read `.env` (the CLIs do). The ingest
  worker only runs with `INGEST_WORKER=1`.
- Vitest does not load `.env` either — DB-gated suites need the variables
  exported in the shell, and only the `database` compose service should be
  up while suites run (a live realtime container would steal queued jobs).
- Pasting a free Gemini/Groq key into `.env` lights up three things at once
  with no code change: the server's fallback provider, `npm run ask --llm`,
  and the key-gated live test suite.

## Every tool in the repo

### Product CLIs (in `realtime/`, all keyless by default)

| Command | What it does |
|---|---|
| `npm run ask -- "question" [--org N] [--llm gemini] [--tamper]` | The full grounded loop from the terminal; `--tamper` corrupts a quote so you can watch the verifier strip it |
| `npm run search -- "question" [--dense-only]` | Hybrid retrieval only, with per-arm ranks |
| `npm run enqueue -- <url> [--depth N] [--sitemap]` | Register a source + queue a crawl |
| `npm run seed-demo [-- --corpus fastify] [--origin url]` | Seed the demo org (toy corpus, or the real 31-page Fastify corpus) |
| `npm run seed-security -- --out fixture.json` | Seed the tenants the security/injection probes attack |

### Measurement harnesses (in `realtime/`; results published in `eval/RESULTS.md` / `loadtest/RESULTS.md`)

| Command | Produces |
|---|---|
| `npm run eval [-- --embedder gemini] [--sweep-threshold]` | recall@k / MRR / nDCG vs. the golden set; the CI floor; the refusal-threshold curve |
| `npm run compare` | The provider comparison table (strip rate, schema violations, TTFT per generation provider) |
| `npm run tenant-scan` | What pgvector iterative scans are worth under multi-tenant filtering |
| `npm run ingest-bench` | Ingest throughput (and the recrawl short-circuit's 216×) |
| `npm run loadtest` | Handoff-socket concurrency/latency |

### Zero-dependency probes (repo-root `scripts/`, run with **no npm install**, point at any deployment)

| Command | Checks |
|---|---|
| `node scripts/smoke-test.mjs <url>` | Health, readiness, every surface mounted-and-closed |
| `node scripts/security-probe.mjs <url> --fixture …` | 57 adversarial checks across the trust model |
| `node scripts/injection-probe.mjs <url> --fixture …` | Poisoned-document containment |
| `node scripts/widget-size.mjs` | The 15 KB budget + the no-extra-requests static checks |
| `node scripts/measure-ttft.mjs <url> <pk> <origin>` | Mint / TTFT / total latency against a live deployment |

### One-off M9 operations tools (in `realtime/scripts/`, scratch-grade)

`embedExistingChunks.ts` (re-embed an org's corpus *paced under* a metered
free tier — the tool that embedded the deployed demo), `localReembed.ts`,
`probeVaultEmbed.ts`, `check-neon.mjs`.

## Being a tenant (the dashboard walkthrough)

1. Sign up → create an org. The overview shows your plan, today's usage
   meter, and your publishable key (shown in full — it's public by design;
   the page explains why that's safe).
2. **Providers**: pick a provider per role (generation / embedding), paste
   a key, click Test (a real round trip; you see the resolved model,
   latency, and measured dimension), then Save. Changing the embedding
   model warns you it will re-index your sources — and then does.
3. **Sources**: paste a docs URL or upload a file (PDF/markdown — parsed in
   the request so refusals like "this PDF is a scan, run OCR" arrive while
   you still have the file open; the bytes are never stored, the extracted
   text is). Watch progress live; expand "N skipped — why" to see exactly
   what robots.txt or errors excluded. Re-crawl and Delete per source.
4. **Widget**: add your site to the allowlist (layer 1), copy the snippet,
   add the two CSP directives if your site is locked down. The traffic
   table shows where your snippet loaded — including *refused* origins,
   with a one-click Allow for the staging domain you forgot.
5. **Conversations / Inbox / Metrics**: read transcripts with per-claim
   verdicts; answer escalated visitors live; watch deflection, strip rate,
   latency, and cost.

## Installing the widget on a real site

```html
<script async src="https://interrelated-realtime-rtue.onrender.com/widget.js"
        data-key="pk_live_…"
        data-api="https://interrelated-realtime-rtue.onrender.com"
        data-title="Acme Support"
        data-accent="#0f766e"></script>
```

- The origin serving the page **must be on the org's allowlist**, or every
  session mint is refused (and counted, so you'll see it in the dashboard).
- Strict-CSP sites need `connect-src` to name the API origin **twice**:
  `https://…` *and* `wss://…` (CSP never upgrades http→ws; chat would work
  and handoff would silently fail).
- Strong mode: replace `data-key` with
  `data-session-url="/api/support-session"` and have your backend mint
  sessions with your secret key — the install page generates the exact
  recipe.

## Operating notes (the deployed instance)

- **Secrets** live in the Render/Vercel dashboards, mirrored locally in
  gitignored files (`.env.neon`, `.probe/m9-secrets.env`). Nothing secret
  is in the repo; `render.yaml` marks them `sync: false` on purpose.
- **Provider quotas you will actually meet** (Gemini free tier, measured):
  generations are per-model per-day (20 — hence the 18 cap); embeddings are
  1,000/day per project, metered **per item**, and — measured the expensive
  way — **a refused batch still bills its items**, so retry storms
  self-defeat. Bulk re-embedding must pace *under* the limit:
  `embedExistingChunks.ts` does 8 per call, ~80/min, resumable.
- **Changing the demo's model** is a one-call credential save through the
  internal API (each model has its own daily quota bucket, which is also
  the escape hatch when one is spent).
- **The verification ladder** for any change: typecheck → unit tests →
  DB-gated integration tests → `docker compose -f docker-compose.prod.yaml
  up --wait` + the smoke/injection/security probes for anything touching a
  public surface, the trust model, or the answer path. CI runs all of it
  keylessly on every push.
- **Git**: two branches only. Work lands on `dev`; `main` is the release
  snapshot, advanced by squash-merge on request; Vercel deploys `main`,
  Render deploys `dev`.
