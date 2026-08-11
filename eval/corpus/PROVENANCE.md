# Corpus provenance

**Upstream:** https://github.com/fastify/fastify, tag `v5.11.3`, paths
`docs/Reference/` and `docs/Guides/` (31 of 41 files — meta-documents that a
support widget would never field questions from were excluded: Contributing,
Style-Guide, Ecosystem, LTS, Benchmarking, the version migration guides, and
the two Index files).

**License:** MIT (see `LICENSE` in this directory, copied verbatim from the
upstream repository). Redistribution of the documentation inside this repo
is what the license permits; attribution is this file.

**Why Fastify's docs:** the eval needs a corpus that behaves like a real
customer's support content — technical, heading-structured, code-heavy,
written by many hands over years — and that is legally clean to commit.
Fastify's docs are MIT, actively maintained, and the questions people
actually ask about them ("how do I register a plugin?", "why is my hook not
firing?") are exactly the register a support widget answers in. Choosing
docs for software this project itself does NOT use for its data plane was
deliberate too: no confusion between corpus content and our own stack — with
one accepted exception, Fastify being a Node web framework means generic
HTTP vocabulary ("request", "route", "hooks") appears on many pages, which
makes retrieval harder, not easier. A corpus that makes the retriever look
good by being trivially separable would defeat the eval.

**This snapshot is FROZEN.** The golden set (`../golden.jsonl`) hand-anchors
questions to verbatim substrings of these exact files; refreshing the
snapshot invalidates anchors and every committed baseline number. To
upgrade: re-download a pinned tag, re-verify every golden anchor resolves
(`npm run eval` fails loudly on broken anchors), and re-baseline the floor
in the same change. There is deliberately no "update corpus" script — an
upgrade is a reviewed decision, not a chore to automate.

**URL mapping:** each file is ingested under its real public URL,
`https://fastify.dev/docs/latest/<Section>/<Page>/` — so eval citations
deep-link to pages that exist, and the same corpus can seed the M2 public
demo without re-anchoring.
