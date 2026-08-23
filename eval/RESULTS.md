# Retrieval evaluation — baseline results

Measured 2026-08-10 on the committed corpus snapshot (31 Fastify v5.11.3
documentation pages — see `corpus/PROVENANCE.md`) against the 80
hand-written questions in `golden.jsonl` (84 relevant chunks; no question
has more than 2). Embeddings: `bge-small-en-v1.5` (384-d, local, keyless).
Retrieval depth k=10, `hnsw.ef_search=40`, iterative scans `relaxed_order`,
chunk target 400 tokens. Reproduce with:

```
docker compose up -d database
cd realtime && npm run eval
```

Numbers are percentages except latency. Latency is retrieval-only (query
embedding excluded), measured warm on a dev machine — indicative, not a
production claim.

## Strategy comparison

| Strategy | recall@1 | recall@5 | recall@10 | MRR@10 | nDCG@10 | p50 | p95 |
|---|---|---|---|---|---|---|---|
| dense only | 35.6 | 72.5 | 81.3 | 51.4 | 58.1 | 62 ms | 92 ms |
| lexical only | 6.9 | 13.8 | 13.8 | 10.4 | 11.3 | 2 ms | 5 ms |
| **hybrid (RRF)** | **35.6** | **75.0** | **83.8** | **52.6** | **59.7** | 70 ms | 107 ms |

Hybrid beats dense-only by +2.5 recall@5, +2.5 recall@10, +1.2 MRR@10 —
every gain, no metric regresses. The delta is modest, and the reason is
worth stating precisely: the golden questions are full natural-language
sentences, and `websearch_to_tsquery` requires (in effect) all meaningful
terms to match, so the lexical arm alone answers almost nothing (13.8
recall@5). It still helps the fusion because *when* it fires, it is very
precise — exact API names and error codes — and RRF only needs its ranks.
Real widget traffic will include short keyword queries ("bodyLimit",
"FSTWRN003") where the lexical arm is at its best; the M2 conversation logs
will show the real query mix, and this table should be re-read then.

## recall vs ef_search

| ef_search | dense @5 | dense @10 | hybrid @5 | hybrid @10 |
|---|---|---|---|---|
| 10 | 72.5 | 81.3 | 75.0 | 83.8 |
| 20 | 72.5 | 81.3 | 75.0 | 83.8 |
| 40 | 72.5 | 81.3 | 75.0 | 83.8 |
| 80 | 72.5 | 81.3 | 75.0 | 83.8 |
| 120 | 72.5 | 81.3 | 75.0 | 83.8 |
| 200 | 72.5 | 81.3 | 75.0 | 83.8 |

Flat, and honestly so: at ~380 vectors the HNSW graph is small enough that
every ef_search returns effectively exact neighbors, and iterative scans
top up anything the filter discards. This knob starts to matter at
production index sizes (tens of thousands of vectors); the sweep exists so
that the day the curve stops being flat is *observed*, not guessed.

## Iterative scans under tenant filtering

The plan asks for "recall with and without iterative scans under tenant
filtering", and this is the number that justifies
`hnsw.iterative_scan = 'relaxed_order'` being on. It is measured by
`npm run tenant-scan` (realtime/), which seeds N tenants of 30 chunks each
into ONE shared index and asks each of them for its own five nearest rows.

| tenants | vectors | plan | starved (on) | recall (on) | starved (off) | recall (off) | p50 on | p50 off |
|---|---|---|---|---|---|---|---|---|
| 2 | 60 | HNSW | 0/2 | 100.0% | 0/2 | 100.0% | 50 ms | 48 ms |
| 4 | 120 | HNSW | 0/4 | 100.0% | 0/4 | 100.0% | 49 ms | 49 ms |
| 8 | 240 | HNSW | 0/8 | 100.0% | **5/8** | **77.5%** | 48 ms | 55 ms |
| 16 | 480 | HNSW | 0/16 | 100.0% | **15/16** | **47.5%** | 49 ms | 49 ms |
| 32 | 960 | exact — unmeasured | — | — | — | — | — | — |

*Starved* means a tenant asked for k=5 rows of its own corpus and got fewer.
*Recall* is rows delivered over rows asked for. `ef_search = 40` throughout.

**The finding: with iterative scans off, starvation begins at 8 tenants and
by 16 tenants 15 of 16 lose more than half their own corpus — a 52.5-point
recall loss — while every query still returns HTTP 200.** With the setting
on, every tenant gets exactly k at every measured size. The latency cost is
inside the noise here (48–55 ms either way), so at this scale the setting is
free; that is not a promise about a 100k-vector index, which is why the
harness sweeps rather than asserting a constant.

Two things about the method, because both are ways this measurement could
have been wrong and one of them *was*:

- **The plan is verified per row, and a row that left the index is reported
  as unmeasured rather than as a finding.** An exact plan sorts every
  matching row, so it cannot starve — its 100% would read as "iterative
  scans are unnecessary", the exact opposite of the truth. The 32-tenant row
  is that case. The first run of this harness had no such check and produced
  5/8 starved at 240 vectors beside 0/32 at 960: non-monotonic, and
  impossible if both rows had measured the same plan.
- **Mock embeddings, deliberately**, where the quality eval above refuses
  them by name. What is under test is the FILTER, not which chunk answers
  better: uniform random directions make the discard rate depend on tenant
  count alone, while real embeddings cluster by topic and would confound it.

## Chunk size ablation (400 vs 800 target tokens)

| Target | hybrid @5 | hybrid @10 | MRR@10 | nDCG@10 |
|---|---|---|---|---|
| **400 (default)** | **75.0** | **83.8** | 52.6 | 59.7 |
| 800 | 73.8 | 82.5 | 53.2 | 59.8 |

400 wins on recall; 800's slightly better MRR says bigger chunks
occasionally rank the right *page region* higher while containing the
target passage less often. 400 stays the default — it also gives M2's
span-level citations tighter quotes to verify against.

## Failure analysis — the 12 hybrid misses at k=10

All 12 misses are `paraphrase`-style questions; every `verbatim`-style
question succeeds. The misses split into three honest categories:

**1. Right page, wrong chunk (3: q008, q019, q077).** The top hit is the
correct document, but the golden chunk lost to a sibling chunk of the same
page. A page-level citation would be right; the chunk-level metric is
deliberately stricter because M2 quotes *chunks*, not pages.

**2. Plausible sibling page (5: q032, q037, q044, q064, q033).** The
question is genuinely answerable from the page retrieval chose — e.g. "How
do I limit body size for a single route?" (q032) retrieves `Server.md`'s
global `bodyLimit` option; the golden anchor is `Routes.md`'s per-route
version. The golden set was NOT padded after the fact to bless these: an
eval whose relevant sets grow whenever retrieval disagrees stops being a
measurement. If M2 answer quality shows these are true product successes,
the fix is adding the second anchor at *question-authoring* time with a
review note, not silently.

**3. True semantic misses (4: q029, q030, q034, q079).** The clearest
pattern: the answer lives in one bullet of a long API list (`Reply.md`'s
intro packs ~30 method bullets into a couple of chunks), and the embedding
of a 400-token bullet salad averages away any single method. Hypothesis:
list-aware chunking (each bullet keeps a heading-trail context but embeds
in smaller groups) would recover several of these. Deliberately NOT
implemented on a hunch — it goes in as a measured experiment against this
baseline when retrieval work resumes.

## The CI floor

`floor.json` gates CI at **hybrid recall@5 ≥ 70.0** (baseline 75.0, ~5
points of headroom for cross-machine ONNX and HNSW-construction noise).
A broken tenant filter, fusion bug, or chunker regression lands far below
this; embedding-library jitter does not. Raise the floor when the baseline
durably improves.

## The refusal threshold (M2.7)

Measured 2026-08-11 with `npm run eval -- --sweep-threshold`: the
groundedness gate's signal (minimum dense cosine distance across the
retrieved set, computed by the production `evaluateGroundedness`) on the
80 answerable golden questions versus the 40 hand-written questions in
`noanswer.jsonl` the corpus can NOT answer, in three categories. Full
curve: `results/threshold-sweep.csv`.

**Signal distributions:**

| Set | n | min | p25 | median | p75 | max |
|---|---|---|---|---|---|---|
| golden (answerable) | 80 | 0.084 | 0.155 | 0.201 | 0.240 | **0.304** |
| off_topic (refuse) | 12 | **0.386** | 0.403 | 0.462 | 0.521 | 0.562 |
| adjacent (refuse) | 14 | 0.260 | 0.269 | 0.303 | 0.323 | 0.406 |
| absent_detail (refuse) | 14 | 0.217 | 0.259 | 0.267 | 0.300 | 0.342 |

**The chosen operating point is 0.34** (correct-refusal vs false-refusal
at selected thresholds):

| threshold | false refusal | correct refusal | off_topic | adjacent | absent_detail |
|---|---|---|---|---|---|
| 0.30 | 1.3% | 57.5% | 100% | 57% | 21% |
| 0.31 | 0% | 50.0% | 100% | 43% | 14% |
| **0.34** | **0%** | **40.0%** | **100%** | 21% | 7% |
| 0.39 | 0% | 30.0% | 92% | 7% | 0% |

Three findings, stated in the order they matter:

**1. Off-topic separates PERFECTLY.** The furthest answerable question
(0.304) and the nearest off-topic one (0.386) leave a clean window, so
the gate refuses every "banana bread recipe" and "reset my Gmail
password" at zero cost to answerable questions. This is the gate's
primary product job — never let the model improvise off-corpus — and it
is fully achieved. 0.34 sits mid-window with margin on BOTH sides, the
same headroom logic as the recall floor: a threshold hugging the golden
max (0.309 would maximize the metric) flips on cross-machine ONNX noise,
and an eval-overfit constant is worse than an honest one.

**2. On-topic-but-unanswerable is NOT distance-separable, and no
threshold fixes that.** `absent_detail` questions ("who created Fastify
and when?", "what's on the v6 roadmap?") retrieve genuinely close,
genuinely relevant text — the corpus just doesn't contain the answers —
so their signals sit inside the answerable range and the gate catches
only 7% at FR=0. This is a property of the problem, not a tuning
failure: retrieval distance measures TOPICALITY, and these questions are
on topic. Coverage failures are the CLAIM VERIFIER's job — an answer
that isn't in the context cannot be quoted verbatim from it, so these
questions produce empty-claims refusals or fully-stripped answers
downstream. The system's two gates split the no-answer problem: distance
catches off-topic before any tokens are spent; verification catches
missing-coverage after, at the cost of one model call. What this table
really documents is that boundary.

**3. The threshold is a per-model constant, and the sweep is its
calibration procedure.** 0.34 is a fact about `bge-small-en-v1.5`'s
distance scale, nothing more. When BYO embedding providers land (M3), an
org on a different model needs its own sweep — which is why the tool is
a repeatable command, not a one-off notebook, and why
`ANSWER_MAX_DISTANCE` exists as the per-deployment override.

## Provider comparison — generation (M8.3)

The plan asks for "the same eval run across every provider — recall@5,
citation-verification rate, schema-violation rate, p50 TTFT, cost per 1k
answers". Those five columns are not one measurement: **recall@5 is a
property of the embedding provider** (the section below) and the other four
are **properties of the generation provider**, measured here by
`npm run compare` (realtime/). Mixing them would let a better embedder
flatter a worse model, which is the opposite of what the table is for.

Method: the first 20 questions of `golden.jsonl`, asked through the **real
answer pipeline** (`answerQuestion` — retrieve → gate → prompt → stream →
parse → verify → strip → persist), with the embedder pinned to
`bge-small-en-v1.5` for every provider so retrieval is identical across
rows. Schema violations are read back from `messages.schema_violations`,
the column the product itself writes. Reproduce with:

```
docker compose up -d database
cd realtime && npm run eval && npm run compare -- --questions 20
```

| provider | model | answered | refused | failed | citation ✓ | strip | violations/answer | TTFT p50 | TTFT p95 | $/1k answers |
|---|---|---|---|---|---|---|---|---|---|---|
| mock | `mock-llm` | 20 | 0 | 0 | 100.0% | 0.0% | 0.00 | 313 ms | 344 ms | $0.0000 |
| gemini | `gemini-3.6-flash` | 19 | 0 | 1 | **76.2%** | **23.8%** | **0.05** | 6,938 ms | 309,743 ms | — |
| groq | *skipped — no `GROQ_API_KEY`* | | | | | | | | | |
| ollama | *skipped — no `OLLAMA_MODEL`* | | | | | | | | | |
| anthropic | *skipped — no `ANTHROPIC_API_KEY`* | | | | | | | | | |

Blank rows are **skipped, not zero**: `groq` and `anthropic` have no key in
this environment and `ollama` no local model, and the harness prints each
one's reason rather than omitting the row — "gated off" silently dropped is
indistinguishable from "passed" (§3.8's stance).

**The headline is the strip rate.** The mock quotes retrieved chunks by
construction, so it verifies at 100% and is the control that proves the
measurement is of the model rather than of the harness. A real model asked
the same 20 questions over the same retrieved chunks had **23.8% of its
claims stripped** — very nearly one citation in four quoted something that
was not verbatim in the chunk it named, and the visitor never saw any of
them. That number is this project's entire thesis expressed as a
measurement: a citation is not a citation because a model emitted one.

Four more readings, and the last two are limits rather than results:

- **Schema violations: 0.05 per answer** — one of 19 answers needed the
  contract retry. M7.11 measured 0 of 9 on the same model and concluded
  Gemini's native `responseJsonSchema` enforcement makes the retry path
  near-dead; at n=19 it is near-dead rather than dead, which is the more
  useful statement and the one only a larger run could make. No answer
  failed the contract twice, so `usage_daily.schema_failures` stayed 0.
- **The one failure was a quota wall, not a model fault.** The free tier for
  `gemini-3.6-flash` is **20 generate requests per day** — the harness spent
  19 answers plus one contract retry and hit `RESOURCE_EXHAUSTED` on the
  20th question. That is a real constraint on the plan's `$0` design and the
  reason n is 20 rather than 80: the full golden set is four days of free
  tier per provider.
- **TTFT p95 is one sample, and nothing bounds it.** At n=19 the nearest-rank
  p95 IS the worst observation, and that observation was 310 seconds. The
  mechanism is confirmed even though the run that saw it did not keep the
  per-question record (the harness now writes one to
  `eval/results/provider-comparison.json`): **nothing in the answer path
  imposes a deadline.** Node's `fetch` has no default timeout, `postStream`
  passes only a caller-supplied signal, and the widget route's only abort is
  `req.on("close")` — the visitor closing the tab (§3.18). A provider that
  accepts a connection and goes quiet therefore holds an SSE stream open for
  as long as it likes. p50 6.9 s is the number that describes the experience;
  p95 here describes a gap. **Not fixed in this increment** — a deadline on
  the answer path is a change to a public surface and belongs with its own
  verification, not smuggled into a measurement. (M8.4 has since built it:
  a 60-second wall-clock deadline on the whole answer, `ANSWER_DEADLINE_MS`
  to override, with its own test ladder — so on a re-run this sample would
  record as an `error` outcome at 60 s rather than as a 310-second answer.)
- **Cost per 1,000 answers is still unclaimable for this model.**
  `gemini-3.6-flash` has no row in `shared/pricing/models.ts`, and this
  project prices unknown models as `null` rather than guessing (§2.4.8), so
  the column reads "—" rather than a believable wrong number. What is
  published instead is the input the reader needs: **70,514 input and 2,185
  output tokens over 19 answers**, or ~3,711 in / ~115 out per answer, from
  which anyone holding the current price sheet can compute the figure. (The
  mock is priced at a true $0.00 and reports $0.0000, which is the one
  honest zero in the table.) Note these prompts are larger than M7.11's
  ~612 input tokens because the eval corpus retrieves ten chunks of real
  documentation rather than a six-chunk toy corpus.

**Not measured, and why:** Groq (no key here), Anthropic (no free tier and
no paid account — the plan's `$0` constraint), Ollama (no local model on
this machine). The key-gated suite covers each the moment its key is in
`.env`, with no code change. An xAI (Grok) key was available for this
session and is *not* in the table: xAI is not one of the product's five
providers, and the key's team carried no credits, so an adapter written for
it could not have been exercised — adding an unverifiable provider is the
one thing this repo's provider table exists to not do.

## Provider comparison — embeddings (M8.3)

The other half of the plan's provider table: **recall@k per embedding
provider**, which `runEval`'s `--embedder` flag has supported since M7.12
and which had never been run against anything but the local model. Same
corpus, same 80 questions, same k, `ef_search`, and chunk target — the only
thing that changes is which model turns text into vectors. Reproduce with:

```
cd realtime && npm run eval -- --embedder gemini
```

| strategy | metric | `bge-small-en-v1.5` (384-d, local) | `gemini-embedding-001` (768-d) | delta |
|---|---|---|---|---|
| dense | recall@1 | 35.6 | **58.8** | +23.2 |
| dense | recall@5 | 72.5 | **87.5** | +15.0 |
| dense | recall@10 | 81.3 | **95.6** | +14.3 |
| dense | MRR@10 | 51.4 | **73.1** | +21.7 |
| dense | nDCG@10 | 58.1 | **78.0** | +19.9 |
| hybrid | recall@1 | 35.6 | **57.5** | +21.9 |
| hybrid | recall@5 | 75.0 | **90.0** | +15.0 |
| hybrid | recall@10 | 83.8 | **96.9** | +13.1 |
| hybrid | MRR@10 | 52.6 | **73.1** | +20.5 |
| hybrid | nDCG@10 | 59.7 | **78.4** | +18.7 |
| hybrid | misses at k=10 | 12 / 80 | **2 / 80** | −10 |
| lexical | recall@5 | 13.8 | 13.8 | 0.0 |

**The hosted model is worth 15 points of recall@5 and drops the failure list
from twelve questions to two.** Both surviving misses are paraphrase
questions whose answer is a behaviour rather than a phrase — q030 ("check
whether the response has already been sent") and q033 ("does a response
schema actually make my API faster") — the same category the local model's
failure analysis above identified, now with the easier ten removed.

Three things about the method:

- **The lexical row is the control.** It is byte-identical across the two
  runs (recall@5 13.8, MRR@10 10.4, nDCG@10 11.3) because it never touches
  an embedding — so anything that moved, moved because of the dense arm.
  A lexical row that had drifted would mean the corpus or the chunking had
  changed underneath the comparison and neither column meant anything.
- **Fusion costs a little at rank 1 and pays at rank 5.** Under Gemini,
  hybrid recall@1 (57.5) is *below* dense recall@1 (58.8): RRF damps a
  strong dense rank-1 by consensus with a weak lexical arm. It is a real
  cost, it is small, and it buys +2.5 points at k=5 and +1.3 at k=10 — the
  trade RRF exists to make, visible here because a better dense arm is what
  makes the top-1 worth losing.
- **Retrieval latency does not pay for the quality.** p50 56–57 ms against
  the local model's 62 ms, measured the same way (retrieval only, query
  embedding excluded). The 768-d vectors zero-pad into the same
  `halfvec(1024)` column, so the index does the same amount of work.

**What it costs, which is the reason the local model is still the default.**
`gemini-embedding-001`'s free tier is
`EmbedContentRequestsPerMinutePerUserPerProjectPerModel = 100`, and
**`batchEmbedContents` is metered per ITEM, not per request** — a 50-text
batch spends 50 of that 100. Embedding this 661-chunk corpus therefore costs
661 requests and takes a minimum of ~7 minutes of pure quota time; the run
above spent most of its wall clock inside the harness's patient retry
(§3.14) absorbing 429s. That is worth stating plainly because §2.4.5a
justifies the batch-first `EmbeddingProvider` interface on the grounds that
"free tiers rate-limit per REQUEST" — for Gemini's embedding endpoint that
is **not** true, and batching there buys round-trips, not quota. The local
model remains the CI and default path: it is keyless, unmetered, and
reproduces the floor on every run, and the eval gate has to run on every
pull request from a fork.

One practical note for anyone reproducing this: **the two embedded corpora do
not coexist.** Re-ingesting a document deletes and recreates its chunks, and
`chunk_embeddings` cascades from chunks, so switching `--embedder` drops the
previous model's vectors with the rows they hung on. Nothing is left *wrong*
— the per-(chunk, model) property still holds, and the model-aware
short-circuit added at M7.12 is what makes the switch back re-embed instead
of skipping — but each direction of this comparison costs a full re-embed of
the corpus, which is the dominant cost of the whole measurement on a metered
tier. Switching back to the local model afterwards reproduced the published
75.0% baseline exactly, which is the check that the corpus survived the trip.

## Ingest throughput (M8.7)

The last metric in the plan's latency list with no producer: how fast the
production ingest path actually is. `npm run ingest-bench` serves this
corpus (31 pages, ~584 KB) over loopback HTTP as a sitemap source and
drives the REAL worker — one `IngestWorker.tick()` per row over the real
crawler, the real parsers, the real chunker, and the per-page short
transactions production uses — so the number is the production path with
only the network made free. Reproduce with:

```
cd realtime && npm run ingest-bench       # -- --mock-only skips the local model
```

| configuration | pages | chunks | texts embedded | wall | pages/s | chunks/s |
|---|---|---|---|---|---|---|
| cold, mock embedder (everything but embedding) | 31 | 661 | 661 | 4.60 s | 6.7 | 144 |
| cold, local `bge-small-en-v1.5` (the CI model, CPU) | 31 | 661 | 661 | 214.7 s | 0.1 | 3 |
| unchanged re-crawl (content-hash short-circuit) | 31 | 661 | **0** | 1.00 s | 31.1 | — |

Three findings, in decreasing order of how much they matter:

- **Embedding is ~98% of the wall.** 4.6 s of fetch + parse + chunk + store
  against 215 s once a real (local, CPU) embedder is in the loop. §3.3.1
  has claimed since M1 that the queue's real throughput ceiling is
  embedding, not Postgres — this is that claim as a measurement, and it is
  why the worker embeds OUTSIDE its transaction and why a second worker
  would buy almost nothing.
- **The re-crawl short-circuit is worth 216×.** An unchanged site re-crawls
  in 1.0 s with zero texts embedded — the harness wraps the embedder in a
  counter to prove the zero rather than assume it — which is what a
  tenant's Re-crawl button costs when nothing changed, and why it is safe
  to click freely.
- **The pipeline itself sustains ~144 chunks/s stored**, HNSW index
  maintenance included (the mock's partial index is registered, so every
  insert pays it) — at the free tier's ~78k-chunk ceiling (§3.3.1), the
  non-embedding half of a full corpus rebuild is minutes, not hours.

What the numbers exclude, on purpose: network (loopback fetches),
politeness (`fetchDelayMs` 0 here, where production paces every fetch plus
any robots.txt Crawl-delay up to 5 s — deliberate per-page floors that
would otherwise BE the measurement), and model load (the ONNX engine is
warmed outside the timed window — a boot cost, not a per-crawl cost).
These are single runs on one machine: a second mock run measured 3.6 s
where the first measured 4.6, so read the orders of magnitude, not the
third digit. And the local-model row is the KEYLESS stack's number — a
hosted embedding tier is metered (per ITEM on Gemini's batch endpoint,
above), so its ingest throughput is its quota, not this pipeline.
