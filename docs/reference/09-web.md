<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §9 web/ — the dashboard

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
  install page prints into the snippet (§9.11). Since M5.4, optionally
  the Stripe set (§9.15): STRIPE_SECRET_KEY (**sk_test\_ only — a live key
  is refused by name**), STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER,
  STRIPE_PRICE_PRO, and NEXT_PUBLIC_APP_URL for the checkout return.
  All five are OPTIONAL: unset, the webhook route 404s and the billing
  page renders the tiers read-only, while quotas keep working — they come
  from the plan column, not from Stripe. Locally the webhook is reached
  with `stripe listen --forward-to localhost:3001/api/stripe/webhook`,
  which prints the whsec_ value to use. Zero config files
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
  sources, and the snippet. Since M5.3 it also carries **Today** — the
  same `usage_daily` counter realtime checks before every model call
  (§3.26), against the plan's ceiling, as a `role="meter"` because a quota
  is a measurement within a known range and a screen reader then reads
  "37 of 200" without the numbers being duplicated in a label. The bar
  clamps at 100%: a counter can overshoot by the answers in flight when
  the ceiling was reached, and a bar wider than its track reads as a
  rendering bug rather than as the honest overshoot it is. Since M7.1 the
  key card is also where rotation lives (§9.17): the current key, the
  owner's Rotate button, the retiring keys with when each stops being
  accepted and when it was last used, and a one-line history of revoked
  ones. `getPublishableKey` (the one row with `revoked_at IS NULL`) still
  serves callers that only need the current value; the pages that show
  the whole picture read `listPublishableKeys`. Since M7.2 the overview
  also carries layer 4's FLAG (§9.18): one sentence, only when the trailing
  week had refused loads — "N loads refused from M origins you have not
  allowlisted; if one is yours, allow it; if not, someone has a copy of
  your snippet and the allowlist is doing its job" — linking to the
  install page where the origins are listed. A quiet week renders nothing,
  not a reassurance nobody asked for. Since M7.3 a **Secret key —
  server-side sessions** card follows the publishable one (§9.19): a lead
  note saying what the key buys and that it belongs in a server, never a
  page; the current key as `sk_live_…k3p9` with issued and last-used
  instants (or "No secret key issued."); the owner's Generate/Rotate form
  with its one-time reveal; a Revoke on the CURRENT key ("stop server-side
  sessions" — allowed here where it is not for the publishable key); the
  retiring list with "accepted until" and "last used"; and the revoked
  history line.
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
  matrices: no Groq and, since M7.8, no Anthropic under embedding, and
  different model defaults for the same vendor) and the embedding card is
  real — current model, measured dimension, and the sentence a tenant needs
  BEFORE pressing save: changing this re-indexes your sources. M7.8's row
  is labelled **"Anthropic Claude (paid)"** and sits last among the hosted
  providers on purpose: it is the only one with no free tier, so it is the
  only one where clicking Test spends money, and the label is where a
  tenant learns that rather than on a bill.

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

**M7.5 — what a crawl left out, and Re-crawl.** The plan parked robots.txt
"with the dashboard, where a customer can see WHY a page was skipped"; this
is that page.

- **queries.ts** carries the latest job's `skippedCount` and `skippedPages`
  (§3.3.10) with each source — the count is the truth, the list is what was
  kept — pinned by a DB-gated suite of its own
  (`lib/sources/__tests__/queries.test.ts`, the first for this file): a
  source crawled twice showing the LATEST run's record with its document
  count, a running crawl with nothing skipped yet and `hasActiveJob` true,
  and another tenant's busier record invisible in both directions.
- **The page** says "N pages indexed · M skipped" (the skipped count rides
  along while a crawl runs too, growing with the progress) and, under any
  source with skips, a collapsed `<details>` — "M pages skipped — why" —
  listing each url with the crawler's sentence verbatim ("disallowed by
  robots.txt (User-agent: *, Disallow: /private/)", "HTTP 404") and, past
  the cap, "…and K more not listed". A failed crawl's reason is a sentence
  now ("nothing crawlable — disallowed by robots.txt (User-agent: *,
  Disallow: /)"), so the status cell WRAPS instead of `nowrap` and the row
  stacks its two halves under 480px — §9.16's automatic-minimum trap,
  avoided rather than found. The intro promises robots.txt is honored.
- **Re-crawl** — an owner-only button on every crawlable source without a
  job queued or running (sources were add-only until now: a fixed
  robots.txt, or docs that changed, had nowhere to go). A plain form action,
  the install page's Allow pattern: `recrawlSourceAction` re-checks the
  ladder (signed-in → member → OWNER, since a Server Action is reachable as
  a direct POST), calls lib/realtime's `recrawlSource` (§3.22 — the wake is
  the reason it goes through realtime), and revalidates; the re-rendered
  list IS the message, the source flipping to "queued…" and AutoRefresh
  taking it from there. `queued: false` needs nothing said — the page
  already shows that state. lib/realtime's client test pins the wire: POST,
  the path, the secret header, and `queued` read back with `false` a normal
  answer.

**M7.6b — uploading a file.** The sources page gained a second card, "Or
upload a file", whose lead note states the one thing a tenant should know
before using it: the file is read when they upload it and is NOT stored —
what is kept is the text extracted from it, which is what gets indexed and
cited — and that a scanned PDF is refused rather than indexed as an empty
document. `UploadSourceForm` is useActionState-shaped where Re-crawl is a
plain form action, because an upload is the one source operation that can
fail for reasons only the FILE knows, and those sentences have to land
somewhere the tenant is looking. It checks the size before sending (Next's
Server Action limit would fail the request before the action ran, and
realtime's fires after 10 MB has crossed the wire; neither can produce a good
message from inside the browser) and names the file it is about to send,
because a file input renders differently in every browser and a tenant who
picked the wrong document should learn that before waiting for it to index.
`uploadSourceAction` re-checks the OWNER ladder — a Server Action is
reachable as a direct POST — and reports the character count, the only honest
answer to "did that work?" about a file the service did not keep.
`queries.ts` carries each upload's format and size beside its row and
deliberately selects NEITHER `text` NOR `blocks`: this page shows what the
file WAS, and a multi-megabyte extraction has no business crossing the wire
to render a list item (providers/queries.ts's greppable rule about
`key_ciphertext`, applied to a second column). The row shows "pdf · 2.1 MB"
where a crawl shows its kind and depth, "indexed" rather than "1 pages
indexed" (an upload is always one document, and the plural reads as a crawl
that went nowhere), and its button says **Re-index**. `next.config.ts` raises
`serverActions.bodySizeLimit` to 12mb — deliberately ABOVE realtime's 10 MB
cap, so the answer to an oversized file is the 413 with the number in it
rather than a framework error the tenant cannot act on.

**M7.6b verified live** against the dev servers and the compose database,
with a REAL document rather than a fixture — M7.6a's lesson, since a
hand-built PDF has none of the compressed streams, embedded fonts and xref
streams a document toolchain emits: RFC 9309's own PDF (12 pages, 177 KB)
uploaded through the form, parsed IN the request, and stored as 22,117
characters of text with 12 span-only blocks and the title "RFC 9309: Robots
Exclusion Protocol" from its Info dictionary; the worker ingesting it from
that stored text into one document, 12 chunks and 12 embeddings; the success
line reading "RFC 9309 robots.pdf read — 22,117 characters of text. Indexing
starts now."; the row reading "pdf · 174 KB · indexed" with a **Re-index**
button; a SCAN (a PDF with no text layer, built by the test suite's own
fixture writer) refused with "The PDF has no text layer — it is probably a
scan, which needs OCR before it can be indexed." and no source created;
Re-index queued, run, and leaving one source with the same 12 chunks rather
than a duplicate; an 11 MB file refused by the form itself ("enormous.pdf is
11.0 MB — the limit is 10 MB") with the button disabled, before the upload
was spent; and `npm run search` returning the uploaded document's chunks
through BOTH retrieval arms, cited under the FILENAME and each marked "(no
heading)" — the documented PDF limitation, visible rather than asserted. At
375px the page never scrolled sideways with nothing past the viewport edge,
including a 99-character filename, the row stacked; at 1280px the two halves
sat side by side. The check found one wart and fixed it: a re-indexing upload
said "crawling — 1/1 pages", which is the product describing itself doing the
one thing it promises not to do with a file, so `jobLabel` now says
"indexing…" and "not indexed" for uploads.

**M8.5 — the ceiling, said where sources are added, and Delete.** The page
now opens with "N of M sources on the <plan> plan", computed from the same
catalog realtime enforces (`planFor(org.plan).sources`), so the page can
never promise room the route will refuse; at the ceiling the sentence adds
both ways out. Beside Re-crawl, an owner-only **Delete** — a plain form
action, Re-crawl's shape: `deleteSourceAction` re-checks the ladder and
calls lib/realtime's `deleteSource`, and the re-rendered list IS the message
(the row gone, a slot freed). Hidden while a crawl is RUNNING, because
realtime refuses that delete (409) and a button that always refuses is worse
than none; a QUEUED row keeps it, since a queued job dies with its source.
No confirmation step, the house rule (§9.12's close, §9.17's rotate): the
content is re-creatable — a crawl by re-adding the URL, an upload by
re-uploading the file — and transcripts that cited it keep their verdicts by
design. The cap's 409 sentence surfaces through the add and upload forms'
existing error states; both refusals name delete-or-upgrade, and the delete
button is on the same page.

**Verified live** against the dev servers and the compose database, with
two REAL sites rather than fixtures: `https://nodejs.org/en` connected at
depth 1 crawled 9 pages and recorded one skip, `/docs/latest/api/` under
nodejs.org's own `Disallow: /docs/` — the page reading "9 pages indexed · 1
skipped" with the URL and the rule under "1 page skipped — why";
`https://www.reddit.com/` (`Disallow: /`) reading "failed: nothing crawlable
— disallowed by robots.txt (User-agent: *, Disallow: /)" with a Re-crawl
button beside it; Re-crawl on the nodejs source producing a second job that
ran in 4 seconds (the recrawl short-circuit), refreshed all nine documents,
and recorded the same skip; and the layout measured from the DOM (the
Browser pane was not displayed): at 375px `scrollWidth === clientWidth ===
375` with the details opened and no element past the viewport edge, the row
stacked (`flex-direction: column`), the failure sentence wrapping in 243px
and the Re-crawl button intact at 71px; at 1280px both rows side by side
with the status column right-aligned to the row's edge. The dev server
needed `INGEST_WORKER=1` (with `INGEST_POLL_MS=0`, production's mode) in the
throwaway live env before any crawl ran — without a worker the enqueue
wakes nothing — and its first boot tick went to a stale queued job a test
suite had left behind, which is one-job-per-tick behaving as documented.

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
- **visitors.ts** (M7.3) — how the dashboard names the other party.
  `describeVisitor` classifies by the shape rule realtime enforces on both
  mint routes (§2.4.10): an anonymous `vis_<hex>` handle is "visitor" and
  truncated to twelve characters (nobody recognizes a random string), a
  server-identified id is "user" and shown whole, with `IDENTIFIED_SUFFIX`
  ("— identified by your server") wherever it is named in full — the
  transcript title, the inbox row (§9.12), and the live conversation's
  header. The label is trustworthy by construction rather than by
  convention: the browser mint refuses anything but the anonymous shape, so
  a non-anonymous id can only have entered a session through the org's
  secret key. Keyless test in `__tests__/visitors.test.ts`, including the
  near-miss shapes that must read as identified.
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

### §9.12 `src/lib/handoff/` + HandoffChat + the inbox (M4.5)

The agent's end of the handoff socket — the protocol's last consumer, and
the first surface in the dashboard that is not a form.

- **lib/handoff/queries.ts** — the queue reads `handoff_sessions`, not
  `conversations.status`, because the row is the RECORD of an escalation
  with its own timestamps (§3.3.4) and M5's headline metric is a duration
  between two of them. Ordering is the whole design: unclaimed first,
  longest wait first — deliberately NOT by recency, which is the
  conversations list's job (§9.10); an inbox sorted by recency buries
  whoever has been waiting longest, who is exactly the person the tenant
  is failing. The sort happens in JS because the status strings do not
  sort that way and a CASE expression would hide the intent.
  `getOpenHandoff` returning null is a NORMAL state — closed, never
  escalated, another tenant's, or malformed, all indistinguishable.
- **lib/handoff/actions.ts** — two Server Actions. The ticket one is
  called once per connection ATTEMPT because tickets are single-use. The trust ladder is
  one rung shorter than providers/sources: signed-in → member, with no
  owner check, because answering a waiting visitor IS the agent role. The
  ladder is not decoration — a Server Action is reachable as a direct
  POST, which Next's own docs say in as many words, so authorization
  lives inside it and realtime checks membership again anyway. The M4.6
  close action shares that ladder for the same reason — the agent who
  answered the conversation is the person who knows it is finished, and
  requiring an owner's click would leave conversations claimed forever.
  It revalidates the QUEUE rather than the open chat, because the chat
  learns from the socket's `closed` frame; nothing in the component sets
  the ended state on its own, so the UI can never claim an ending the
  server did not perform.
- **lib/realtime/index.ts → mintHandoffTicket** — the ticket is signed by
  realtime rather than here because the key is derived from
  WIDGET_TOKEN_SECRET (§3.24), which that service alone holds: the
  dashboard proves who the agent is, realtime decides what that is worth
  — the same split as credentials.
- **components/HandoffChat/** — `useHandoffSocket.ts` owns the connection
  and the frame reducer, `index.tsx` renders. Reimplemented rather than
  shared with widget/src/handoff.ts for the reason sse.ts is not shared
  with realtime's parser: the PROTOCOL is the contract (both import the
  same frame types, so a change breaks both at compile time), the
  transport is not — one copy is framework-free under a 15 KB budget, the
  other is React state with no budget at all. What is identical is what
  the protocol dictates: a ticket per attempt, backoff reset by the
  `ready` FRAME rather than by the socket opening, and the incoming
  typing hint expiring on THIS side after TYPING_TTL_MS. Sent messages
  are not rendered locally — the echo is the render — and a send that
  could not go keeps the agent's words in the box. Refs hold what the
  socket owns and state holds what the UI draws, so a re-render cannot
  burn a ticket; the effect's teardown is total, because React Strict
  Mode double-invokes it in development and a phantom agent in the room
  is the exact failure the heartbeat exists to prevent.
- **dashboard/[orgId]/inbox/** — the queue, and per-conversation the live
  surface. The thread is NOT server-rendered there: the socket replays it
  on attach (DATAFLOW §8.4), so a server copy would be a second, staler
  one that disagrees the moment a message lands. The transcript view
  stays the audit surface and each page links to the other. AutoRefresh
  runs unconditionally on the queue — unlike the sources page's
  conditional mount — because the thing that changes it is a VISITOR
  escalating, an event this page can never learn about from its own
  render.
- **Tests** — DB-gated: the queue's ordering (longest wait first, claimed
  last), closed and never-escalated conversations absent, another
  tenant's waiting visitor invisible even though they have waited longer
  than anyone, and every single-lookup miss collapsing to null.

The header also carries the M4.6 **Close conversation** button, with no
confirmation dialog on purpose: closing is reversible by the product's own
rules — the visitor can escalate again, and the partial index over open
rows lets them — so "are you sure?" would be ceremony over a decision that
costs one click to undo.

Verified live end to end with the widget and the dashboard in two
browsers against one realtime process: a visitor escalated from the
Tailwind fixture, appeared in the inbox with their wait time, and the
agent opening the conversation replayed both turns (the bot's included)
and claimed it — after which a reply typed in the dashboard rendered in
the widget, the visitor's answer rendered in the dashboard, and "Visitor
is typing…" appeared while they composed and expired on its own TTL.
M4.6 closed the same loop: the button flipped the widget to "the support
chat has ended — the assistant is back" through the `closed` frame (not
through a failed reconnect), turned the dashboard page into its
nobody-is-waiting state, and the very next question in the widget was
answered by the bot again.

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
  withholding one. Since M7.4 `connect-src` names the API host TWICE, as
  `https://…` and as `wss://…` (derived from the same URL by swapping the
  scheme, exactly as widget/src/handoff.ts builds the socket URL): CSP's
  scheme matching goes http→https and never http→ws, so a directive that
  listed only the https origin let chat work and silently blocked the
  handoff socket — found by the M7.4 rejoin check on the hostile fixture,
  a gap that had been there since M4.4 (§8.4), and the page's note now says
  why the host appears twice. `NEXT_PUBLIC_WIDGET_API_URL` is CONFIG, not derived:
  the dashboard is on Vercel and the widget API on Render, so this host
  cannot infer the other's; unset renders a visible placeholder and says
  so, rather than emitting a snippet that would fail silently on the
  customer's site. Since M7.1 the snippet always carries the CURRENT key,
  and while a rotation is in progress the page says so with the grace end
  (§9.17): this is where the customer copies from, and the old snippet on
  their site is what the window is keeping alive. Since M7.2 the allowlist
  card also carries **"Where your snippet loaded — last 7 days"** (§9.18):
  the week's origins with sessions and refusals, refused-and-unlisted rows
  flagged and sorted first, and beside each allowlistable one an owner-only
  **Allow** — `allowOriginNowAction` in lib/origins/actions.ts, the typed
  form's ladder, validator, and idempotent insert behind a hidden field,
  because a hidden field is still a request field. The forgotten staging
  domain is one click from working; the copy on someone else's site is a
  name the tenant now knows. Since M7.3 a fourth section, **"Optional —
  sessions minted by your server"** (§9.19): what strong mode changes,
  stated as WHO proves the visitor is allowed — the browser by default, the
  customer's server with the secret key; whether the org has a secret key
  (suffix and in-use, or a link to the overview to generate one); the
  endpoint recipe — a `GET /api/support-session` on the customer's server,
  behind their login, making one POST to `/v1/sessions` with the key from
  its environment and passing the answer through verbatim, the origin in
  the sample being the org's first allowlisted one so what they copy is what
  the route checks; and the snippet with `data-session-url` in place of
  `data-key`. Two honest sentences ride along: a 403 "origin not allowed"
  means the origin the server named is not in section 1 (and shows up in
  its table with an Allow button), and a signed-out user gets whatever the
  endpoint answers, so most sites omit the snippet on pages that do not
  require sign-in.
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
same origin to 403 on the next request, with the other origin still at 200. A bare host was rejected in the form with the scheme sentence.

---

### §9.13 `src/lib/metrics/` + the metrics page (M5.1)

The plan's "instrument from day one" bill, come due. Nothing here needed a
migration: `messages` has carried refused/model/ttft_ms/total_ms since
§3.3.2, `message_citations` has carried every claim's verdict verified and
stripped alike, and `handoff_sessions` has carried requested_at since
§3.3.4. This is the first surface that adds them up.

- **queries.ts** — four aggregates rather than one heroic join, because
  they have four grains (messages, citations, conversations, handoffs) and
  a single query would either fan out — counting one answer once per
  citation — or need subqueries that read worse than four honest
  statements. Everything is computed IN SQL: `percentile_cont` over the
  (org_id, created_at) index §3.3.2 already added for the daily cap, where
  pulling a month of answers into Node to sort them would be megabytes to
  produce six numbers. Every rate is `number | null`, never a silent zero
  — a tenant with no answers has no deflection rate, and a dashboard that
  prints "0%" for "no data yet" lies during exactly the week someone is
  deciding whether the product works.

  Four definitions carry the file, and each rejects an easier one:
  **deflection is per CONVERSATION**, not per message (per message
  flatters: a long thread ending in escalation would still contribute a
  dozen "deflected" answers), and its denominator excludes conversations
  the bot never answered in — a visitor who opened the bubble and typed
  nothing is neither deflected nor escalated. **Time-to-first-human-
  response measures to the first agent MESSAGE**, not to claimed_at:
  attaching is what claims a handoff (§3.25), so measuring the easy way
  would score a queue where agents open tabs promptly and answer slowly as
  perfect; the query takes each handoff's earliest agent turn only, since
  later replies are the same person still talking. And **latency
  percentiles exclude refusals** — a gate refusal never calls a model, so
  it has a total_ms but no ttft_ms, and mixing the two produced a live page
  where the full answer (99 ms) was faster than its own first token
  (110 ms). That bug was found in a browser, not by a test, and the test
  that now pins it would have failed the old behavior.

  The fourth arrived with M5.2: **cost per 1k answers is over GENERATED
  answers** — refusals excluded, because a refusal never calls a model and
  folding it into the denominator would make a bot that refuses more look
  cheaper rather than more cautious. It is derived from the by-model rows
  (`costMetrics`, pure and testable without a database) rather than
  queried, since prices are per model and any total is a sum over exactly
  those groups. A row contributes only when BOTH its model is priced and
  its provider reported usage; everything else lands in `unpricedAnswers`,
  which the page shows — a cost figure silently covering 40% of the
  traffic is worse than no cost figure.

  M5.2 also DELETED a column that could only ever read zero. The by-model
  breakdown carried a per-model refusal count, and it passed its test —
  because the fixture set a model on a refused row where the pipeline never
  does: the gate refuses before a model is chosen (§3.15.1), so those rows
  carry `model = NULL` and never reach a model group at all. The fixture
  now matches production and the column is gone; refusals are counted once,
  at org level, where they are real.

  M7.10 added the column the plan's provider comparison is really about:
  **schema violations per model**, summed from `messages.schema_violations`
  (§3.3.12) over the same rows the rest of the breakdown uses, with
  `answers` as the denominator — every row there ran a model, since the gate
  refuses before choosing one. Its companion is an org-level **contract
  failures** count read from `usage_daily`, the ONE number on the page that
  does not come from `messages`, because what it counts is the absence of
  one. That read rounds to whole UTC days where the rest of the window is an
  instant, which the file states: a coarser boundary is the right trade for
  a number read as "is this happening at all?" rather than as a rate.

- **metrics/page.tsx** — Answering, Grounding, Latency, Handoff, Cost, and
  a by-model table that is the provider comparison made concrete: answers,
  tokens in and out, cost, and both latency medians per model. Rates with
  no denominator render "—", and USD renders to four decimals below a
  dollar, because a Groq answer costs ~$0.0004 and a 2-decimal currency
  format would print an entire day's traffic as "$0.00" and read as broken.
  The strip rate gets the same prominence as deflection deliberately: a bot
  that deflects everything by answering confidently from nothing is the
  failure this whole project exists to prevent, so the number that would
  expose it sits next to the number it would flatter. The cost section
  states what the figure IS in as many words — what this usage would cost
  at list price, not what the tenant was billed (every provider here has a
  free tier, so a demo org's real spend is $0 while the number is
  positive), and generation only, since query embeddings are not metered.

- **Tests** — DB-gated, over a hand-built fixture small enough that every
  expectation is computed by reading it (3 answered conversations, 5
  answers across three models, 5 claims, 2 handoffs, one of them still
  waiting): counts and percentiles; the strip rate split by failure mode;
  deflection ignoring the conversation with no answer; first-human-response
  taking the first agent turn and not the second; the by-model breakdown
  with its token sums; a busier OTHER tenant that must stay invisible;
  null-not-zero for an empty org; and a zero-day window excluding
  everything. The cost cases cover all three states one fixture can hold at
  once — a priced model with usage, a priced model whose provider reported
  none, and a self-hosted model nobody can price — plus an org running
  ENTIRELY self-hosted, whose cost must be "—" rather than $0.00.

Verified live: seeded traffic through `npm run ask` (three grounded
answers, one `--tamper` producing a stripped claim, one refusal) plus an
answered handoff, and the page reported 85.7% deflection, 57.1% refusals,
16.7% strip rate, and a 2-minute first human response — each matching the
fixture by hand.

### §9.14 `src/lib/usage/` + the overview's Today card (M5.3)

The dashboard's read side of the quota counters — the same `usage_daily`
rows realtime writes on the answer path and reads before every model call
(§3.26), shown to the tenant so the ceiling is never a surprise.

- **queries.ts** — `getTodayUsage` is one primary-key read joining the org's
  plan to today's counter; `listRecentUsage` is the trailing window, the
  `usage_daily_recent` index's only caller. Straight from Postgres like
  every dashboard read: a realtime outage must not blank the page whose job
  is telling a customer whether their widget is still answering. **Zeros
  here are honest**, unlike the rates in §9.13 — "0 answers today" is a fact
  about a quiet morning, where "0% deflection" would be a claim about a
  product nobody has used. The day boundary is computed by POSTGRES
  (`(NOW() AT TIME ZONE 'UTC')::date`), matching what realtime writes, so a
  Vercel instance's clock is never in charge of it. The deployment override
  is deliberately NOT applied: it lives in realtime's environment, and a
  dashboard guessing at it would state a limit the service might not
  enforce — what this page promises is what the PLAN promises.

- **The Today card** on the org overview (§9.7) renders it as a
  `role="meter"`, clamped at 100%. The clamp is the honest handling of a
  real thing: the check runs before an answer and the increment after it, so
  answers in flight when the ceiling is reached can overshoot it. DATAFLOW
  §10 states that imprecision and why closing it — a reservation before
  every model call, released on failure, leaked on every crash — costs more
  than the overshoot the token buckets already bound.

- **Tests** — DB-gated: a quiet day reading zero against the plan's ceiling,
  counters read and a plan change followed (the limit is the plan's, not a
  copy taken when the counter was written), the overshoot clamped, yesterday
  not counted against today, and one tenant's usage invisible to another.

### §9.15 `src/lib/stripe/`, `src/lib/billing/`, the webhook and billing page (M5.4)

Billing lives in web/ for the reason the control-plane split exists: a
webhook is a short request/response with no stream and no socket, and it
belongs beside the tables it writes. realtime has no billing code at all.

- **stripe/signature.ts** — the only thing standing between a public URL
  and an UPDATE on `organizations.plan`. Hand-rolled for the reason RRF and
  the session tokens are: 40 lines of HMAC over a documented format, and
  reading it is how someone convinces themselves it is right. Three checks
  in a deliberate ORDER — the MAC (constant-time; length compared first,
  because timingSafeEqual throws on a mismatch and would turn a short
  forgery into a 500), then freshness, then shape. Signature BEFORE
  freshness because the timestamp is only meaningful once the MAC has proven
  nobody chose it; the timestamp is inside the signed payload, which is
  exactly what makes it usable as a replay bound. MULTIPLE `v1` signatures
  are accepted if ANY matches, because that is how Stripe's endpoint-secret
  rotation works — taking only the first would break every rotation, the one
  operation this must not discourage. Failure reasons are returned for
  LOGGING and never for the response body: invalid-versus-stale
  distinguishable to an unauthenticated caller is an oracle, the same stance
  as the session token's payload-or-null.

- **stripe/client.ts** — the two REST calls this product makes (Checkout
  session, Billing Portal session), form-encoded over fetch. **The `stripe`
  SDK was considered and rejected, with the case for it written down**:
  retries, idempotency keys, version pinning, typed responses, a decade of
  edge cases — against two endpoints and several megabytes in a serverless
  bundle, when the security-critical piece is the file above. If this grew
  invoices, refunds, or tax, that trade flips; saying so makes the reversal
  a decision rather than a rediscovery. Two details carry the webhook side:
  `subscription_data[metadata]` puts org and plan on the SUBSCRIPTION, so
  every later `customer.subscription.*` event already says which tenant and
  tier it concerns — the alternative is a price-id to plan table that must
  stay in sync with Stripe's dashboard. And **a live secret key is REFUSED
  by name**: this is a demo deployment that must never charge a real card,
  and lifting the guard is a deliberate one-line act.

- **billing/apply.ts** — the event applied in ONE transaction with its own
  id, which is what makes redelivery safe: either the event is recorded AND
  applied, or neither happened and Stripe's retry does it. Only
  `customer.subscription.created|updated|deleted` are acted on;
  `checkout.session.completed` is deliberately ignored, because it says a
  checkout finished rather than what the subscription IS, and handling both
  would put two writers on one row whose outcome depended on delivery order
  Stripe does not promise. Three judgments worth their comments: `past_due`
  KEEPS the plan (Stripe retries a card for days, and breaking a customer's
  support widget the hour their card expired is the worse product) while
  `unpaid`/`canceled` drop to free; a `deleted` event is cancellation
  whatever the payload's status field claims; and once a subscription id is
  cancelled, later events for the SAME id change nothing — the out-of-order
  case that would otherwise resurrect a cancelled subscription. Everything
  non-applied — duplicate, ignored type, unknown org, malformed — is still a
  2xx, because anything else is redelivered forever.

- **api/stripe/webhook/route.ts** — `req.text()` and never `req.json()`
  (the signature covers the exact bytes); nodejs runtime (node:crypto);
  404 when unconfigured, the same indistinguishable-from-absent stance as
  realtime's internal API (§3.22); 400 on a bad signature with the reason
  logged, not returned; 500 ONLY on a database failure, which is the one
  case where a Stripe retry is what we want.

- **billing/actions.ts + PlanCards + the billing page** — the trust ladder
  is providers'/sources' (signed-in → member → OWNER: billing is
  unambiguously the owner's, and the page 404s an agent rather than
  explaining what they may not do). Return URLs are built from
  `NEXT_PUBLIC_APP_URL`, never from the request's Host header — a redirect
  target derived from an attacker-controllable header is how open redirects
  happen, and this one is handed to a third party to bounce a user through.
  Cards, invoices, downgrades and cancellation all go to Stripe's hosted
  portal: every one is a payment surface with regulatory weight, and the
  engineering worth showing here is the webhook that makes their outcome
  true in our database, not a second copy of their UI. One form per plan so
  a pending state belongs to the button that was pressed. The page says out
  loud that it is test mode.

- **Tests** — keyless for signatures (accepted; body tampered; wrong secret;
  replay outside tolerance in BOTH directions with the boundary pinned;
  multiple v1 signatures in either order; nine malformed headers that must
  400 rather than throw; a correctly signed body that is not an event) and
  for the client against a loopback fake (the live-key refusal, absence
  reported as absence, the form Stripe actually receives including the
  subscription metadata, customer reuse, a missing price refusing to check
  out rather than charging for another tier, Stripe's error surfaced without
  the key anywhere in it). DB-gated for application: the upgrade, a
  REDELIVERED event applying exactly once (with a downgrade in between that
  the redelivery must not undo), five CONCURRENT redeliveries producing one
  application, the dunning path (past_due keeps the plan, unpaid drops it
  while the row still records what was bought), cancellation ignoring a
  contradictory status field, the late-update resurrection refused while a
  NEW subscription id still resubscribes, the period end read from either
  place the API version puts it, unknown types recorded and ignored, missing
  or unknown metadata refused rather than guessed, and one tenant's
  subscription invisible to another.

**Verified live** against the running dev server, with an authenticated
session and Stripe configured in TEST mode with fake keys (no Stripe
account involved): an unsigned delivery, a wrong-secret signature, and an
hour-old replay were each refused 400 by the ROUTE with the org's plan
unchanged; a correctly signed delivery returned 200 and upgraded the org
through the real handler; the SAME event redelivered returned 200 and
applied nothing a second time (the org was downgraded in between to prove
it); and a new event id applied again. The pages were then rendered in a
browser: the overview's quota meter measured 6.85% of its track for 137 of
2,000 answers with the correct ARIA values, and the billing page showed the
tiers, the current-plan badge, the past-due explanation, and the renewal
date. Two layout defects were found that way and fixed — the plan grid's
15rem minimum wrapped the third tier onto its own row inside the
dashboard's 720px content column (a pricing table that is not a row is not
a comparison), and the org nav's eighth link pushed the whole dashboard
into horizontal scroll at 375px, now wrapped. A third, pre-existing one was
recorded rather than quietly fixed, because it predates M5 and lives in a
file this milestone did not touch: the shell header's email did not shrink,
so a long address still overflowed a phone viewport. It has since been
closed — §9.16.

**What was NOT verified, and why:** a real Checkout round-trip. It needs a
Stripe account with test-mode price ids, which this repo deliberately does
not carry — the moment `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
the two price ids are in web's environment, the Upgrade buttons hit the
real API and `stripe listen --forward-to localhost:3001/api/stripe/webhook`
delivers genuine events to the handler proven above. There is deliberately
no keyless substitute for that last step: a fake that satisfied it would
have to forge Stripe's signature, which is the one thing about this surface
that must never be made easy.

### §9.16 The shell header at phone widths

Closes the third defect M5.4 recorded above. The file is
`dashboard/layout.css`, styling the chrome §9.7 describes — shared by every
`/dashboard/*` route, which is why one header made every dashboard page
scroll sideways.

The header is `justify-content: space-between` over two items, and neither
could give ground: a flex item's automatic minimum size is its content
width, so `.dashshell-session` (email + sign-out) held its full intrinsic
width and carried the row past the viewport — measured at 375px, where the
document was 453px against a 375px client, because
`m5webhook+1755102000000@example.test` renders at 275px. `min-width: 0` on
the session lifts that floor, and `overflow: hidden` + `text-overflow:
ellipsis` + `white-space: nowrap` on `.dashshell-email` spend the
difference there. The brand and the sign-out form take `flex-shrink: 0` so
the loss lands on the one part that can afford it; without it on the form,
the button shrinks and "Sign out" wraps onto two lines. No `min-width: 0`
on the email itself — `overflow` other than `visible` already zeroes the
automatic minimum, and a declaration that does nothing is a claim that it
does something.

**Hiding the address under a media query was the rejected alternative.** It
is identity confirmation rather than navigation, which is the argument for
dropping it on a phone. Against that: it is the ONLY place the chrome names
the signed-in account, on a dashboard whose whole premise is that several
tenants look alike — and the local part that distinguishes an account is
exactly the part an end ellipsis keeps. Truncation degrades, hiding
deletes. Ordinary addresses still render whole at every width.

**Verified live** the same way the defect was found: a 375px viewport, an
authenticated session on that 36-character address. `/dashboard`,
`/dashboard/[orgId]`, and its billing, metrics, and widget pages each
report `document.documentElement.scrollWidth === clientWidth === 375`, with
a sweep for elements crossing the viewport edge returning none; the email's
275px of text sits in a 148.5px box (truncated) while the sign-out button
keeps its full 77.7px on a single line box, a clean 0.75rem gap between
them. Disabling ONLY the new declarations at runtime restores exactly
453px, so the fix is what carries it rather than something incidental. At
1265px the box measures 275.3px and the address shows in full — the
truncation costs nothing where there is room.

### §9.17 `src/lib/keys/` + RotateKeyForm — one-click key rotation (M7.1)

Trust-model layer 5, the first increment of M7 (the plan's own trust-model
section, layers 4–6, which no scheduled milestone ever named). The schema
had been shaped for it since 001 — `api_keys` revokes by TIMESTAMP rather
than by delete, and its uniqueness index covers live keys only, so a
rotation is one INSERT and one UPDATE with the retired key left standing as
the audit trail. M6.4 recorded the gap honestly and had the security fixture
write those two rows by hand; this closes it.

- **lib/keys/index.ts** — three functions and one constant, every timestamp
  Postgres's own. `listPublishableKeys` returns every public key the org has
  ever had, newest first, with its standing computed IN SQL against `NOW()`
  — `current` (revoked_at NULL), `retiring` (revoked_at in the future),
  `revoked` (past) — so the dashboard can never call a key "retiring" that
  realtime already refuses: it is the identical comparison the session
  route makes (§3.18). `rotatePublishableKey(orgId, fromKeyId)` schedules
  the CURRENT key's revocation `ROTATION_GRACE_HOURS` (24) out and inserts
  the new key in one transaction; `revokePublishableKeyNow(orgId, keyId)`
  ends a retiring key's window at once. **The grace window is the whole
  design.** Rotation does not kill the old key on the click: the new one is
  usable immediately, the snippet already on the customer's site keeps
  working until they redeploy, and there is never a keyless window — a
  rotation that broke the widget until someone edited HTML would be a
  rotation nobody performed. "Revoke now" is the incident-response half.
  Two guards make it safe to click without ceremony: only a RETIRING key
  can be revoked now (the current key cannot be revoked without a
  replacement — the org must never be left keyless by a click; the way to
  retire it is to rotate), and an already revoked key is left alone so its
  `revoked_at` stays the honest instant it actually stopped.

  Idempotence is the guarded UPDATE, §3.23's playbook: the caller names the
  key it SAW as current, and `WHERE revoked_at IS NULL` is the atomic claim
  — a second click, a retried POST, or two owners at once find the row
  already scheduled and get `rotated: false` with nothing written, instead
  of two rotations and three live keys. No lock, no read-then-check; the
  race resolves in Postgres, and a test fires five rotations concurrently
  to prove exactly one wins. Org scoping is in every WHERE, so an owner of
  org A posting org B's key id gets the same `false` a malformed id gets,
  and the two are indistinguishable on purpose. Written directly through
  Kysely like the origin allowlist (§9.11): these rows hold no secret — the
  pk is public by design — so routing them through realtime's internal API
  would be ceremony without a reason.

  **Why every clock here is Postgres's.** The dashboard runs on Vercel and
  the session route on Render; the grace end is written by one and read by
  the other, and Neon's `NOW()` is the ONE clock both can share — the
  handoff socket's argument for message ordering (§3.25), applied to a
  deadline. A grace end written with a Vercel `Date` would be off by the two
  machines' skew, harmless over 24 hours and not harmless for "revoke now";
  and the tests measure the window in SQL (`revoked_at - NOW()`) so a
  host-versus-container skew can never make an assertion lie in either
  direction. The same reasoning moved the fixture's and the widget suite's
  "revoked" rows onto `NOW()` (§3.27, §3.8).

  **The honest limit, stated where the feature is.** For a PUBLIC key,
  rotation is hygiene rather than defense: the value is scraped from the
  customer's page, so an attacker who re-scrapes has the new one, and what
  bounds a scripted abuser is layer 1 (the allowlist) and layer 3 (the
  buckets and daily ceiling). Nor does ending a window evict live visitors —
  a session token is bound to the org, not to the key that opened it, and
  lasts its 30 minutes (§3.17.1); revocation stops NEW sessions, and the
  widget suite pins that a token minted inside the window still chats after
  it closes. What rotation does buy: every deployed snippet can be
  invalidated at once without downtime, and — the real reason to build it
  now — the same rows and the same lookup rule are what will make the
  SECRET key (layer 6) safe to issue: a bearer credential nobody can rotate
  without an outage is one nobody rotates.

- **lib/keys/actions.ts** — the providers/sources/origins trust ladder
  verbatim (signed-in → member → OWNER), re-checked in the action because a
  Server Action is reachable as a direct POST. `rotatePublishableKeyAction`
  is useActionState-shaped and reports the grace end in the dashboard's UTC
  convention; its success sentence says "unless you revoke it sooner",
  because that sentence lives in the form's client-held state and survives
  a later "Revoke now" re-render — found in the live check, where the
  24-hour promise sat one line above the revocation that had just cut it
  short. `revokePublishableKeyNowAction` is a plain form action: a `false`
  return needs no message, since the re-rendered list IS the answer. Both
  revalidate the overview AND the install page — the snippet must now say
  the new value.

- **components/RotateKeyForm/** — one button, one click, the plan's words.
  No confirmation step, for M4.6's reason: the consequence is bounded and
  stated beside the button (the current key keeps working through the
  window; "revoke now" is a separate control), so "are you sure?" would be
  ceremony over a decision the page has already explained. What guards an
  accidental double click is the hidden `keyId`: the action rotates FROM the
  key this page showed, and a second submit finds it already retiring.

- **The pages** — the overview's key card (§9.7) shows the current key, the
  owner's Rotate control, each retiring key with when it stops being
  accepted and when it was LAST USED (realtime stamps `last_used_at` on
  every mint, so "last used a minute ago" means the old snippet is still
  deployed somewhere — the one signal a customer needs before revoking
  early), and a one-line history of revoked keys. The install page (§9.11)
  always carries the current key and says when a rotation is in progress.
  The retiring row takes `min-width: 0` on its text column so the long
  `pk_live_…` value truncates instead of pushing the button off a phone —
  §9.16's automatic-minimum trap, avoided rather than fixed later.

- **Tests** — `lib/keys/__tests__/keys.test.ts`, DB-gated: one current key
  and no history at birth; rotation producing a new current key with the
  old one retiring `ROTATION_GRACE_HOURS` from the DATABASE's now (measured
  in SQL); the stale-key no-op (rotating from a key no longer current writes
  nothing, same rows same timestamps); five concurrent rotations from one
  key resolving into exactly one; revoke-now refusing the current key,
  ending a retiring one on the DB clock, and leaving an already revoked one
  byte-identical; both mutations refusing another tenant's key ids with the
  other tenant's rows untouched; malformed ids refused before any query. The
  realtime half is in `routes/__tests__/widget.test.ts` (§3.8): a key with a
  future `revoked_at` mints AND its token chats, and once the window closes
  the key is byte-identical to an unknown one while that token still chats.

**Verified live** against the dev servers and the compose database: an org
created in the dashboard, `https://rotation.example` allowlisted, the
original key minting a real session (200); Rotate clicked on the overview —
the new key in the card, the success sentence with the grace end, the old key
under RETIRING with "last used" stamped by that very mint; the retiring key
and the new key BOTH minting against realtime while an unknown key got 401;
"Revoke now" moving the old key to the history line and its next mint
returning a 401 whose body is byte-identical to the unknown key's, with the
new key still minting; a second rotation, then the install page carrying the
newest key in the snippet with the rotation-in-progress notice; and at 375px
`scrollWidth === clientWidth === 375` with the key value truncated (286px of
text in a 145px box) and the Revoke button intact at 91px, while at 1265px
the value shows in full. Host and database clocks agreed to the second during
the check, so none of it was masked by skew.

### §9.18 `src/lib/traffic/` + the traffic table and flag — per-origin visibility (M7.2)

Trust-model layer 4, the dashboard's half. realtime writes one counter row
per (org, UTC day, origin) on every mint attempt that names an org (§3.28,
§3.3.8); this reads a week of them back and puts the answer where it can be
acted on.

- **lib/traffic/queries.ts** — `listOriginTraffic(orgId, days = 7)`: every
  origin seen in the window, summed, WORST FIRST — refusals ahead of the
  merely busy, because a refusal is the thing the tenant should look at —
  with an `allowlisted` flag computed against the allowlist as it is NOW
  (a refused origin that has since been allowed needs no button).
  `refusedSummary` is the overview's one-line flag: total refused and
  distinct refused origins, zero-zero for a quiet week. Straight from
  Postgres like every dashboard read: a realtime outage must not blank the
  page whose job is saying whether somebody else is presenting the key.
  The window is drawn by POSTGRES ((NOW() AT TIME ZONE 'UTC')::date), the
  clock that wrote the rows, so a Vercel instance is never in charge of
  which day is today — lib/usage's rule. `originLabel` spells out the three
  non-origin values realtime can write ("null — a file:// page or sandboxed
  iframe", "other origins — past the daily distinct-origin cap", "malformed
  Origin headers — not from a browser"), because "(other)" alone reads as
  a bug; `isAllowlistable` is what decides whether a row gets an Allow.

- **The table** (install page, §9.11) — under the allowlist, since that is
  where a refused origin is answered. Four columns: origin with its
  last-seen day folded underneath, sessions, refused, and the owner's
  Allow. Refused-and-unlisted rows are tinted and sorted first; the section
  opens with one sentence saying what those rows mean and what to do about
  them. Zero rows is "No widget loads yet." The origin cell wraps
  (`word-break: break-all` — an origin has no spaces, so word-breaking
  would never fire) so the table's intrinsic width is bounded by the fixed
  columns whatever the origin's length; the wrapper's `overflow-x: auto` is
  a backstop, not the plan.

- **The flag** (overview, §9.7) — rendered only when the week had refusals.
  The allowlist already refused every one of them; this is visibility, and
  the sentence says which way to read it before linking to the table.

- **`allowOriginNowAction`** (lib/origins/actions.ts) — the one-click Allow.
  The typed OriginForm's ladder (signed-in → member → OWNER), validator, and
  idempotent insert, behind a hidden field — validated again regardless,
  because a hidden field is still a request field. A plain form action: the
  re-rendered table (the row turns from refused to allowlisted, and the
  widget accepts the origin on the very next mint) is the message.

- **Tests** — `lib/traffic/__tests__/traffic.test.ts`, DB-gated over rows
  inserted directly (writing them is realtime's job and tested there): the
  window summed per origin in refused-first order with the allowlisted flag
  right, seven days ago excluded from "the last 7 days, today included",
  the window widening with `days`, the summary's total and distinct count
  and its zero-zero for a quiet tenant, and another tenant's busier week
  invisible in both directions — with the flag per tenant, not per string.
  Keyless: the labels and the allowlistable rule.

**Verified live** against the dev servers and the compose database: an org
created, `https://docs.traffic.example` allowlisted, then five kinds of
origin sent at the real session route — three allowlisted mints (200), five
from `https://thief.example` (403), two from
`https://staging.traffic.example` (403), one `Origin: null` (403), one
`javascript:alert(1)` (403) — landing as five rows: thief refused 5, staging
refused 2, `(malformed)` 1, `null` 1, docs minted 3. (Two of those requests
first met the per-IP mint bucket's 429 and were correctly NOT counted: a
rate-limited request names no org.) The overview flag read "9 widget loads
were refused from 4 origins"; the install page's table listed the four
refused rows first, tinted, with Allow only on the two allowlistable ones;
Allow on the staging row moved it to the allowlist, cleared its tint and
button, dropped the warning to "3 origins", and the very next mint from
that origin was answered 200 — the same row then reading minted 1 /
refused 2, the staging-domain story in one line.

The 375px check found two things. The five-column table with `nowrap`
cells was 682px wide inside its scrolling wrapper, and Chrome's mobile
emulation reported the layout viewport at 667px for it — with the page not
actually able to scroll (`scrollX` stayed 0 on `scrollTo(300, 0)`), the
visual viewport at 375, and the same page at 768px (no emulation) showing
the wrapper containing its table with the document at exactly
`clientWidth`; the wide `<pre>` snippet on the same page, also a scroll
container, never triggered it. Emulator artifact or not, a five-column
table in 277px is unreadable, so the last-seen day moved under the origin,
the origin cell wraps, and the table now measures 366px intrinsic — under
the viewport, `innerWidth === clientWidth === scrollWidth === 375`,
scrolling ~90px inside its wrapper on the narrowest phones. The second was
pre-existing: the allowlist row's `<code>` kept its intrinsic width and
pushed Remove 10px past the viewport once a 31-character origin was
allowlisted — §9.16's automatic-minimum trap in a third place, fixed the
same way (`min-width: 0` + ellipsis on the code, `flex-shrink: 0` on the
form), the buttons then measuring 313px right on a 375px viewport.

### §9.19 `src/lib/keys/` (secret half) + SecretKeyForm — server-side sessions (M7.3)

Trust-model layer 6, the dashboard's half, and the last layer the plan's
trust model names. realtime mints on `POST /v1/sessions` (§3.18); this is
where the secret key comes from, is shown once, is rotated, and is revoked —
the same file and the same rows as the publishable key (§9.17), because
M7.1 was built to be exactly this reusable.

- **lib/keys/index.ts, the secret functions** — `listSecretKeys` (suffix
  and standing only; nothing here could show a value, the row holds a
  hash), `issueSecretKey`, `rotateSecretKey`, `revokeSecretKeyNow`.
  Standing is the publishable list's CASE against the same `NOW()`
  realtime compares with; rotation is the same guarded UPDATE plus INSERT in
  one transaction, the old key retiring `ROTATION_GRACE_HOURS` out so the
  customer's backend keeps minting until they have redeployed. Three things
  follow from the key being a secret. **Shown once**: `newSecretKey`'s
  plaintext exists only in the return value on its way to the owner's
  screen; the row gets `hashSecretKey` and `secretKeySuffix` (§2.4.1) —
  the sessions-table posture applied to a credential a customer's server
  will hold. **Issue is idempotent by SCHEMA**: a first issue has no key to
  rotate FROM and so nothing to guard on, so 007's one-current-secret-per-org
  index is the guard — the second of two simultaneous Generates is a unique
  violation this file catches (SQLSTATE 23505) and reports as
  `issued: false`; five concurrent issues yield one row, and a test fires
  them together. **Revoke is allowed on the CURRENT key**, where the
  publishable half refuses it: an org with no publishable key has a dead
  widget, but an org with no secret key is simply not using server-side
  sessions — a legitimate state, and the way a customer turns the mode
  off; after which a fresh issue is allowed again, since the index covers
  live rows only. Every mutation is scoped by org AND kind in its WHERE, so
  a foreign key id, a malformed one, and a secret row named to a publishable
  mutation (or the reverse) are all the same no-op — tests pin each.
- **lib/keys/actions.ts** — `secretKeyAction` is issue-OR-rotate in one
  useActionState action, dispatched on whether the form carried a `keyId`:
  ONE action because the form is one component that must stay mounted
  across the change from "no key" to "a key" (below). It returns the
  plaintext in the state exactly once, with the row id it belongs to and a
  sentence that, for a rotation, says the old key keeps minting until the
  grace end "unless you revoke it sooner" (§9.17's reason: that sentence
  survives a later re-render). `revokeSecretKeyNowAction` is a plain form
  action. Both re-check the OWNER ladder — a Server Action is reachable as
  a direct POST — and revalidate the overview and the install page.
- **components/SecretKeyForm/** — one button (Generate when the org has no
  current secret key, Rotate when it has), and the only place the value is
  ever shown. The client state is load-bearing rather than cosmetic: the
  action returned the value once, the row holds only its hash, and this
  component's state is where the value lives until the owner has copied it
  or navigated away — which is why it stays mounted at the same place in
  the card in both states (a component that unmounted on the change would
  take the just-issued value with it). The reveal is tied to the key it
  belongs to: the box renders only while the page's current key IS the row
  the action returned, so a later rotation shows the newer value and a
  revocation makes the box go away rather than display a key that no longer
  works — checked live. The value box is a scroll container of its own
  (`overflow-x: auto`, nowrap): an `sk_live_…` is 40 characters, wider than
  a phone, and it must be selectable in full rather than truncated, this
  being the one time it is shown. No confirmation step, for RotateKeyForm's
  reason; the hidden keyId makes a double click a no-op.
- **The pages** — the overview card (§9.7) and the install page's section 4
  (§9.11) are described where they live; the transcript, inbox, and live
  conversation name an identified user through `describeVisitor` (§9.10).
- **Tests** — `lib/keys/__tests__/keys.test.ts`, a second DB-gated suite in
  the same file (its own orgs; the pool now ended once at file level): no
  key at birth; issue returning `sk_live_…` with the row holding
  `sha256(value)` and the suffix and NOT the value or any fragment of it;
  five concurrent issues yielding one row and four `issued: false`;
  rotation with the new plaintext returned once and the old key retiring
  `ROTATION_GRACE_HOURS` from the DATABASE's now; the stale-key no-op; five
  concurrent rotations resolving into one; revoke-now ending a retiring key
  on the DB clock (and a second revoke leaving the honest instant), and —
  unlike the publishable key — revoking the CURRENT key outright, after
  which a fresh issue succeeds; org scoping in every mutation; malformed
  ids refused before any query; and the two kinds of key kept apart in both
  directions.

**Verified live** against the dev servers and the compose database, the
whole strong-mode loop with a stand-in customer backend (§8.4): an org
created in the dashboard, `http://localhost:4400` allowlisted, **Generate
secret key** clicked — the full value revealed once, the standing line
reading `sk_live_…n1rr` (its suffix), the buttons flipping to Rotate and
Revoke; the install page's section 4 naming that suffix, the recipe carrying
the allowlisted origin, the strong-mode snippet with no key in it; the
fixture server handed the key through its environment and
`fixtures/strong.html` — whose source contains no `data-key` and no
`pk_live` — mounting the widget, the bubble-open fetching
`GET /api/support-session` on its own origin and receiving a token whose
payload named `{org, origin: http://localhost:4400, visitor: user_42}`; a
question going out on `POST /v1/widget/chat` (200) and the gate's refusal
streaming back (the org has no corpus — the auth path is what was under
test); the transcript titled "Conversation with user user_42 — identified by
your server" and the overview's key line reading "last used" a minute later;
**Rotate** revealing a second value with the first retiring for 24 hours and
its "last used" intact; a reload of the strong page still minting on the OLD
key (the grace window); **Revoke now** moving it to the history line, the
reveal box still showing the current key (its id still matched), and the
next reload's mint answered 401 through the customer endpoint with the
widget degrading to its notice rather than bricking; the fixture server
"redeployed" with the new key and minting again; and, from the fixture page
itself, a browser mint of `pk + user_42` never becoming a session (the 400
carries no CORS echo, so the page saw only a network error), an anonymous
mint still answered `vis_…`, and the secret key tried FROM the page stopped
by the browser at preflight — "Response to preflight request doesn't pass
access control check", the exact feedback a customer would get. At 375px:
overview and install page both `scrollWidth === clientWidth === 375` with
nothing crossing the viewport edge, the reveal box scrolling its 332px value
inside a 251px box, the retiring row truncating its key with the Revoke
button intact at 91px, and both recipe blocks scrolling inside their own
boxes. The Browser pane was not displayed for most of it, so every one of
those numbers was read from the DOM rather than a screenshot.
