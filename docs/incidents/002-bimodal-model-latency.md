# Incident 002 — Bimodal free-tier model latency

**Date:** 2026-08-25 · **Environment:** deployed demo (Render data plane, Neon
Postgres, Gemini free tier) · **Detected by:** `scripts/measure-ttft.mjs`
against the live service · **Resolved in:** `65baf70` · **Related:** the answer
deadline, `51f15d8` (2026-08-22) · **Status:** resolved by model choice; the
underlying variance is a property of the tier

## Impact

On the deployed demo, answers generated with `gemini-3.6-flash` took **tens of
seconds** to first content, and some never arrived at all — one run hit the 60 s
answer deadline and returned the ordinary failure state to the visitor.

For a support widget, a 35-second answer is a failed answer whether or not it
eventually renders. The product's own README claims sub-two-second
time-to-first-token; the deployed configuration was delivering roughly **20x**
that, with no error, no alert, and nothing in the logs saying anything was
wrong. Every claim that did arrive was verified correctly — this was purely a
latency failure, not a correctness one.

## Timeline

1. **2026-08-22 (`51f15d8`).** The answer path gets a hard deadline:
   `ANSWER_DEADLINE_MS`, 60 s, after which every in-flight provider call is
   aborted and the visitor gets the ordinary failure state with their input
   recovered. This is not a response to the present incident — it predates it —
   and exists because the earlier provider comparison measured **one answer
   reaching its first token after 310 seconds**. It is the reason this incident
   degraded rather than hung.
2. **2026-08-25 (`65baf70`).** With the stack live end to end,
   `scripts/measure-ttft.mjs` measures the visitor's actual path — session mint
   reported separately from the answer, TTFT counted to the first **content**
   event rather than the first byte (headers flush before retrieval by design).
3. **The measurement.** Same corpus, same prompt, minutes apart:

   | Model                   | TTFT per run                  | Outcome                    |
   | ----------------------- | ----------------------------- | -------------------------- |
   | `gemini-3.6-flash`      | 34.7 s, 40.9 s, 36.3 s, 2.4 s | then hit the 60 s deadline |
   | `gemini-3.5-flash-lite` | 1.9 s, 1.4 s, 1.7 s, 1.8 s    | every claim verified       |

   Roughly **20x at the median**, on identical inputs, minutes apart, through
   the same code path. Note the `2.4 s` in the slow row: the distribution is
   bimodal, not uniformly slow, which is what makes it so easy to miss.

4. **Resolution.** The deployed demo switched generation to
   `gemini-3.5-flash-lite`. Warm, deployed, measured after the switch: **TTFT
   p50 1.65 s / p95 1.88 s**, mint p50 88 ms, 0 schema violations, every
   citation verified.

## Root cause

**Free-tier capacity is contended, and contention varies by model and by hour.**
Nothing in this system was slow. The retrieval, the gate, the verifier and the
stream all behaved identically in both rows of that table; the entire difference
was time spent waiting for a provider on a shared free tier.

The product's contribution to the incident was **assuming a model choice was a
quality decision when it was also a latency decision.** `gemini-3.6-flash` was
selected as the stronger model, on the reasonable assumption that a heavier
model costs somewhat more time. On a contended free tier that relationship does
not hold linearly — it is bimodal, and the tail crosses the deadline.

## Why local tests could not catch it

- **CI answers from a context-quoting mock**, by design. That mock measures the
  pipeline, not a model: it makes retrieval quality, injection containment and
  the claims contract real numbers in CI without needing a key. What it cannot
  produce is a _provider's_ latency, because it is not a provider.
- **TTFT is a per-model number that needs a key**, and CI has none. The README
  already said so before this incident — the gap was known, and this is what it
  cost.
- **The local machine is not the contended path.** Even a keyed local run
  measures a different queue than a Render container hitting the same tier at a
  different hour.
- **The failure is intermittent by nature.** A single sample lands on `2.4 s` a
  quarter of the time. Any test asserting a latency bound off one observation
  would have been flaky, and flaky tests get deleted.

## Detection gap

This is the part worth keeping, because the incident was found **by choosing to
measure**, not by anything reporting a problem:

- **Nothing alerted.** A 40-second answer that eventually succeeds is, to every
  piece of instrumentation that existed, a success.
- **The deadline bounded the damage but did not announce it.** A run that hits
  `ANSWER_DEADLINE_MS` is recorded as a failed answer, indistinguishable from a
  provider outage or a bad key.
- **No latency series existed for the deployed service.** TTFT was a number a
  committed script produced when a human ran it, not a continuously observed
  quantity — so "how fast is the demo right now" had no answer between runs.

That gap is the direct argument for the observability work: a p95 TTFT series
with an alert would have reported this within one scrape interval instead of
waiting for someone to decide to measure.

## Remediation

**Done:**

- The deployed demo generates with `gemini-3.5-flash-lite`. This is recorded as
  **a measurement rather than a preference** — the README carries the numbers,
  not the conclusion alone.
- The 60 s answer deadline stays as the bound on the bad tail. The division of
  labour is explicit: **the deadline is what keeps the bad tail bounded; a
  lighter model is what keeps it rare.**
- `scripts/measure-ttft.mjs` is committed as the reproducible producer of the
  claim, so the number can be re-measured rather than re-argued.
- Two related free-tier facts measured in the same session are in the README
  because each contradicts something previously assumed: the keepalive cron runs
  24–54 minutes apart rather than every 10 (so cold starts persist; one health
  request took 12.3 s against ~0.25 s warm), and each model carries its own
  daily quota, so switching models is also how a spent bucket is worked around.

**Accepted, not fixed:**

- **The variance itself is the tier's**, not the product's. It cannot be
  engineered away on a free plan; it can only be bounded (deadline), made rare
  (lighter model), and stated honestly (README). A real customer should bring a
  paid key, which the README says.

**Open:**

- **No continuous latency signal on the deployed service.** TTFT is measured on
  demand. A p95 series with an alert is the remaining work, and it is the
  generalisable lesson: this incident was invisible not because it was subtle
  but because nothing was watching between deliberate measurements.

## What this changed about how the project is run

The rule this produced is stated in the README as _the mock measures the
pipeline, not a model._ Every number the project claims now carries the
provenance of how it was produced and against what — a mock, a local model, a
real key, the deployed stack — because this incident showed those four things
can differ by more than an order of magnitude while every test stays green.
