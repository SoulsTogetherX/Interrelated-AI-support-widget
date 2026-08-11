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
