# Incident 001 — A page that could never be ingested

**Date:** 2026-08-24 · **Environment:** deployed demo (Render data plane, Neon
Postgres, Gemini free tier) · **Detected by:** an ingest that would not finish
· **Fixed in:** `e8be06b`, with `dd05ce6`, `7ba4317` and `150835b` around it
· **Reference:** §3.10.5a · **Status:** resolved

## Impact

The deployed demo's corpus could not finish re-embedding under the org's own
Gemini credential. Any documentation page holding more chunks than the
provider's per-minute allowance would **never ingest — on any attempt, ever**.
Not a slow ingest: a permanently un-ingestable page, and one failed page failed
the whole job.

A customer hitting this would see a source stuck at `failed` with a provider
error, and re-indexing would reproduce it byte for byte. The blast radius was
every tenant on a per-item-metered embedding tier, which is the tier this
product is explicitly designed around.

No visitor-facing answer was ever wrong: content that never ingested is content
the retriever cannot cite. The failure was in getting knowledge _in_, not in
what came out.

## Timeline

All times 2026-08-24 unless noted.

1. **Setup (by design).** Saving a credential queues a re-index of every source
   (§3.22), so the deployed demo's corpus had to be re-embedded under the org's
   own Gemini key rather than the platform's.
2. **Symptom.** On Render the re-index would not finish. Every attempt died on a
   429 from the embedding endpoint.
3. **Wrong diagnosis #1 — a per-minute window.** Plausible: the failures were
   minutes apart. Waiting did not help.
4. **Wrong diagnosis #2 — a per-IP throttle on the host.** Also plausible: it
   explained why a developer machine seemed unaffected. It predicted that the
   same call from elsewhere would succeed, which turned out to be true for the
   wrong reason.
5. **Wrong diagnosis #3 — a spent daily bucket.** The closest miss: the daily
   bucket was real and was being spent, but it was not what killed the run.
6. **The probe (`dd05ce6`).** A probe was written that reproduced the call with
   **full-size texts** and printed the **entire** error body. The real limit
   surfaced: `EmbedContentRequestsPerDayPerProjectPerModel-FreeTier`, 1,000
   embeddings per day per Google project, metered per item, hard until midnight
   Pacific. `RetryInfo`'s "retry in 30 s" on that bucket is fiction — which is
   exactly what had kept the per-minute and per-IP theories alive.
7. **The real defect (`e8be06b`).** With the provider's behaviour finally
   legible, the loop was re-read: the worker's embed call had **no retry at
   all**. The batch that crossed the per-minute line threw, the page failed, the
   job failed — and because the recrawl short-circuit works at **page**
   granularity, the next attempt re-embedded that same page from its first
   chunk and died in the same place. Measured on the live deployment as **three
   consecutive rounds of byte-identical failure with zero forward progress**,
   while an identical 8-item call from the same machine, through the same
   adapter, with the same vault-resolved credential, succeeded on demand. That
   contrast is what proved the fault was the **loop**, not the key, the
   project's quota, or the adapter.
8. **The measurement worth more than the fix (`7ba4317`).** A **refused batch
   still bills its items.** The arithmetic that proves it: a day in which 27
   embeddings were successfully stored and the 1,000-item bucket was
   nevertheless exhausted — the balance spent entirely by 429'd attempts.
9. **Pacing (`150835b`).** `scripts/embedExistingChunks.ts` now paces bulk
   embedding at ~80 items/minute against the tier's ~100.

## Root cause

Two independent facts that only bite when combined:

- **The worker's embed loop had no retry.** A transient, expected, documented
  refusal was treated as a permanent failure of the page.
- **The recrawl short-circuit is page-granular.** Retrying the _job_ restarts
  the _page_, so every attempt re-spends the earlier chunks and arrives at the
  same chunk with the same minute-bucket exhausted.

Either alone is survivable. Together they turn a rate limit — a condition whose
entire purpose is to be waited out — into a deterministic, permanent failure.
The provider was behaving exactly as documented; the product had no mechanism
to absorb it.

## Why local tests could not catch it

- **The mock embedding provider never refuses.** Every local and CI run used an
  embedder that always succeeds, so the retry path had nothing to exercise and
  its absence was invisible.
- **CI's corpus is small and its pages are short.** The bug needs a _single
  page_ with more chunks than a minute's allowance. Nothing in the frozen eval
  corpus is that large, so even a rate-limiting mock would likely not have
  reproduced it.
- **The failure is a property of a metered hosted tier**, which is precisely
  what a hermetic test suite is built to exclude. The suite was right to be
  hermetic; the gap was that nothing else was measuring the real thing.
- **The truncated error body actively misled.** `postStream` truncates the 429
  body one character before the `quotaId`, so the one field that identifies
  _which_ limit was hit was the one field never printed. Three diagnoses were
  built on the remaining text.

## Detection gap

The ingest failed loudly — but "loudly" meant a `failed` row and a provider
error string, which is the same signal a wrong API key produces. Nothing
distinguished _this page cannot be ingested, ever_ from _this credential is
bad_. What was missing:

- No metric on embed refusals, so "three rounds, zero forward progress" was
  something a human noticed rather than something the system reported.
- No visibility into which quota bucket a 429 named, because the body was
  truncated before the field that says so.
- Progress was measurable only by querying chunk counts by hand.

## Remediation

**Done:**

- The embed call is wrapped in `withRetry` under a **patient** policy — 8
  attempts inside a 5-minute waiting budget, 2 s base, 60 s ceiling
  (`realtime/src/ingest/worker.ts`). Deliberately _not_ the answer path's 3
  attempts in 8 seconds: that number comes from how long a visitor watches a
  chat bubble, and nobody is watching an ingest.
- The retry **resumes the batch that failed**, so each attempt is cheaper than
  the last instead of re-spending the page's earlier items.
- The **waiting budget** keeps it honest: a page that cannot embed inside five
  minutes fails loudly with the provider's own error rather than holding the
  queue's single worker forever.
- A regression test in `realtime/src/ingest/__tests__/worker.test.ts`, **proven
  able to fail** before being committed: with `maxAttempts` temporarily set to
  1 it fails with `expected 'failed' to be 'done'` — the deployment's exact
  symptom — and passes with the policy restored.
- Bulk embedding **paces under the limit rather than discovering it**
  (`scripts/embedExistingChunks.ts`, ~80 items/min against ~100).
- The quota arithmetic and the retry-storm conclusion are written into §3.10.5a
  so the next person meets the fact before the bill.

**Verification ladder run:** realtime typecheck clean, 461 tests green against
real Postgres (456 before, plus the new case and the live Gemini cases).

**Still open — accepted, not forgotten:**

- **A retry cannot outwait a daily bound.** The patient policy handles transient
  refusals; the 1,000-per-day wall is absorbed only by pacing. On this provider
  a retry storm is self-defeating, because every refused attempt bills.
- **The truncated 429 body is unfixed.** `postStream` still cuts one character
  before the `quotaId`. The mitigation is procedural and recorded in §3.10.5a:
  _reproduce the call and print the whole body before theorizing._ A real fix
  belongs in the adapter's error surfacing.

## What this changed about how the project is run

Three wrong diagnoses were each defensible from the evidence available, and all
three were downstream of one truncated string. The lesson recorded in §3.10.5a
is not "think harder" — it is **reproduce the call and print the entire error
body before forming a theory.** The probe that finally did that took minutes to
write and ended the investigation immediately.

The corollary is the one the whole project already runs on: this defect existed
in green CI, on a tree where every test passed. Deploying it and running it
against a real metered provider is what found it, which is why the deployment
is treated as a source of measurements rather than as the end of the work.
