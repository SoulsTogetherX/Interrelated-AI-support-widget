# 05 — Glossary

Every term of art used in this repo, in plain words. Alphabetical.

**Allowlist (origin allowlist)** — the per-org list of exact web origins
(`https://docs.acme.com`) allowed to open widget sessions. Browsers attach
the `Origin` header themselves and page JavaScript cannot forge it, so this
single check kills the copied-snippet attack. Trust-model layer 1.

**BYO provider** — "bring your own": every organization supplies its own AI
provider API key; the platform never pays for or proxies a tenant's model
usage on its own account.

**Chunk** — the unit of retrieval: a passage of ~400 tokens cut from a
document by the heading-aware chunker, carrying its heading trail
("Billing > Refunds"), its exact character offsets into the source, and its
own embedding(s).

**Claim** — one sentence of an answer, as structured output:
`{text, chunkId, quote}`. The atomic unit of the verification thesis — the
smallest thing that can be verified is the smallest thing a visitor may see.

**Cold start** — the delay when a free-tier service that spun down must
boot to serve a request (~tens of seconds for Render's container; Neon's
database has its own, hidden by the bubble-open handshake).

**CORS** — the browser mechanism deciding which origins may _read_ a
cross-origin response. Here it is allowlist-scoped: refused origins get no
CORS headers, so their pages cannot even read the error.

**Deflection rate** — the product metric: the share of conversations the
bot handled without a human. Counted per conversation, not per message.

**Dense retrieval** — finding passages by _meaning_: embed the question,
find the nearest chunk vectors by cosine distance via the HNSW index.
Catches paraphrases the words don't share.

**Embedding** — a vector of numbers (here 384 or 768 floats) representing a
text's meaning, produced by an embedding model. Texts with similar meaning
get nearby vectors; that geometry is what dense retrieval searches.

**Escalation / handoff** — the transition where a conversation stops being
the bot's and becomes a human agent's, carried live over a WebSocket.

**Gate (groundedness gate / refusal threshold)** — the pre-model check: if
the best retrieved evidence is farther than a calibrated cosine-distance
threshold (0.34 for the local model), refuse instead of generating. Derived
from data (answerable vs. unanswerable question sets), not picked by feel.

**HNSW** — Hierarchical Navigable Small World, pgvector's graph index for
approximate nearest-neighbor search. Chosen over IVFFlat because it builds
incrementally and holds recall under continuous ingest.

**halfvec(1024)** — pgvector's 2-bytes-per-dimension vector column; halves
storage so ~78k chunks fit Neon's free 0.5 GB. Shorter vectors are
zero-padded to 1024 (rank-preserving, proven).

**Hybrid retrieval** — running dense and lexical search together and fusing
their rankings; beats either alone on every measured metric.

**Ingest** — the whole path from a tenant's URL/file to searchable chunks:
crawl → parse → chunk → embed → store.

**Iterative scans** — a pgvector 0.8 setting (`hnsw.iterative_scan`) that
keeps scanning the index until enough _post-filter_ results are found.
Without it, a small tenant inside a shared index silently gets fewer than k
results. Measured value: 52.5 recall points at 16 tenants.

**Lexical retrieval** — Postgres full-text search (`tsvector` +
`ts_rank_cd`): finding passages by exact words. Catches identifiers and
error strings that embeddings blur.

**Mock (providers)** — deterministic stand-ins: the embedding mock hashes
text to a vector; the LLM mock either replays a script or answers by
quoting the retrieved context verbatim (grounded by construction). They are
what let CI and the playground run the _entire_ real pipeline with zero API
keys — and the LLM mock doubles as the 0%-strip control that makes the real
model's 23.8% strip rate meaningful.

**Origin** — scheme + host + port (`https://docs.acme.com`), the browser's
identity for a website. The unforgeable-from-a-browser fact the trust
model's first layer stands on.

**pgvector** — the Postgres extension adding vector columns, distance
operators, and ANN indexes. The reason retrieval needs no second database.

**Publishable key (`pk_live_…`)** — the org identifier in the public
snippet. Public _by design_ (same category as a Stripe publishable key);
everything protecting the tenant is the six-layer trust model, not secrecy.

**Quote (in a claim)** — the verbatim span the model must copy from the
chunk it cites. What the verifier checks; whitespace differences are
tolerated, nothing else.

**RAG** — Retrieval-Augmented Generation: retrieve relevant passages, put
them in the prompt, have the model answer from them. This project is RAG
plus an enforcement layer the term doesn't imply: verification.

**Recall@k / MRR / nDCG** — retrieval quality metrics over the golden set:
was a correct chunk in the top k; how high was the first correct one; how
well-ordered was the whole list.

**Refusal** — the bot declining to answer ("the docs don't cover this"),
either from the gate (before any model call) or because every claim was
stripped. A feature, not a failure: the counter-metric (false refusals on
answerable questions) is measured too.

**RRF (Reciprocal Rank Fusion)** — merging two rankings by summing
`1/(60+rank)` per item. Rank-based, so cosine scores and text-match scores
— incomparable numbers — never need calibrating against each other.

**Secret key (`sk_live_…`) / strong mode** — the optional server-held
credential: the customer's backend mints widget sessions for users _it_ has
authenticated, so nothing on the page is worth copying and only signed-in
users can chat. Shown once at creation; stored only as a hash.

**Session token** — the 30-minute HMAC credential the widget actually
chats with, bound to org + origin + visitor. Minted once per bubble-open.

**Span verification** — the deterministic check that a claim's quote occurs
in its cited chunk, with the found offsets stored so the dashboard can
highlight the exact evidence.

**SSE (Server-Sent Events)** — one-directional HTTP streaming; how answers
reach the widget (`meta` → `claim`× → `done`).

**SSRF** — Server-Side Request Forgery: tricking a server into fetching
internal addresses (cloud metadata, localhost). Every tenant-supplied URL
here (crawl targets, self-hosted provider base URLs) is vetted by DNS
resolution + connect-time re-checks against private ranges.

**Strip / strip rate** — deleting an unverified claim before display / the
published share of claims so deleted. The thesis as a number.

**Ticket** — the 60-second, single-use credential that authenticates a
WebSocket upgrade, bought with the real credential over ordinary HTTPS.

**TTFT** — time to first token: how long a visitor waits before the first
piece of the answer appears. Measured to the first _content_ event, not the
first byte.

**Vault** — the encrypted store for tenant provider keys: AES-256-GCM under
a server-held master key, decrypted per request, displayed only as a
four-character suffix, guarded by a read-back-denial test and probe.

**Verdict** — the stored outcome of verifying one claim: `verified`,
`quote_not_found`, or `unknown_chunk`.

**Wake-driven worker** — the production scheduling mode: no polling timer;
the ingest worker ticks once at boot and then only when an enqueue wakes
it, so the free-tier database sleeps whenever the product is idle.
