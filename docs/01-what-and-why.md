# 01 — What this is, and why it exists

## The product in one story

Imagine you run a small SaaS called Acme. Your customers keep emailing
support questions whose answers are already in your documentation. You sign
up for Interrelated, and in about ten minutes you:

1. Create an organization in the dashboard.
2. Paste your own Google Gemini (or Groq, Ollama, any OpenAI-compatible, or
   Anthropic) API key. The dashboard makes one real test call before saving
   it, so a dead key fails at the button, not in front of a customer.
3. Type `https://docs.acme.com` into the Sources page. A crawler fetches
   your docs (politely — it honors robots.txt), slices them into chunks, and
   indexes them for search.
4. Add `https://acme.com` to your origin allowlist and copy a `<script>`
   tag onto your site.

Now every visitor to acme.com sees a small chat bubble. They type "how do I
rotate my API key?" and get back two or three sentences, each with a link to
the exact section of your docs it came from. If they ask "what's your
refund policy for enterprise contracts?" and your docs never mention it, the
bot says it doesn't know and offers to connect a person — and if the visitor
accepts, the conversation appears in your dashboard's inbox, an agent clicks
it, and the two of them are talking live over a WebSocket, in the same
bubble.

You pay Interrelated nothing for the AI: the model calls run on *your* key,
against *your* provider account, under *your* data-processing terms. That is
the "bring your own provider" model, and it is a first-class feature, not a
cost dodge.

## The problem it exists to solve

"Chat with your docs" bots are easy to build and easy to build **badly**.
The standard failure is *hallucination with confidence*: the model produces
a fluent, plausible answer that the documentation does not support — a
refund policy that doesn't exist, a config flag that was never shipped. For
a support product this is worse than useless, because the customer acts on
the answer.

The standard mitigations are weak: asking the model to "only use the
context" is a suggestion, not a mechanism; asking the model to add citation
markers like `[1]` produces citations nobody verifies; and asking the model
whether it is confident measures nothing.

## The one design decision everything follows from

**The model's claims are verified by code, not trusted.**

Concretely: the model is *not allowed* to answer in prose. It must answer as
a JSON list of claims, where each claim has three fields:

```json
{
  "text":    "Refunds are processed within five business days.",
  "chunkId": "chk_01h2x9...",
  "quote":   "refunds are issued within five (5) business days of the request"
}
```

- `text` is the sentence the visitor will see.
- `chunkId` names the specific retrieved passage the claim is based on.
- `quote` is a **verbatim** span copied from that passage.

Then a deterministic checker (`shared/grounding/verify.ts` — no AI involved,
~100 lines of string matching that tolerates only whitespace differences)
confirms the quote actually occurs in the chunk the claim cites. Three
outcomes are possible per claim:

| Verdict | Meaning | What happens |
|---|---|---|
| `verified` | The quote is really there | Shown to the visitor, with a citation link |
| `quote_not_found` | Real chunk, but the "quote" isn't in it | **Stripped** — the visitor never sees the sentence |
| `unknown_chunk` | The model cited a chunk it was never shown | **Stripped** |

Every verdict — including the stripped ones — is stored in the database, so
the tenant's dashboard shows what the visitor was *spared*, and the **strip
rate is a published metric**. Measured against a real model: 23.8% of its
claims were stripped, versus 0% for a deterministic control — which is the
project's thesis expressed as a number. There is deliberately **no uncited
channel** in the wire protocol at all: the stream can carry verified claims,
a refusal, or an error, and nothing else, so unverifiable prose has no way
to reach a visitor even if the model produces it.

Two companion mechanisms complete the honesty story:

- **The refusal gate.** Before any model call, the system checks whether the
  retrieved passages are actually *close* to the question (a numeric cut on
  embedding distance, threshold derived from an 80-question answerable set
  vs. a 40-question unanswerable set — not picked by feel). Off-topic
  questions are refused for free, without spending the tenant's tokens.
- **Measured retrieval.** Whether search finds the right passage at all is
  scored (recall@k, MRR, nDCG) against a hand-written golden set on every CI
  run, and the build fails if quality regresses.

## Why "bring your own provider" is load-bearing

Every organization supplies its own AI credentials, for three reasons:

1. **Economics** — the platform never pays for a tenant's model usage, which
   is what makes a $0-infrastructure SaaS possible at all.
2. **Trust** — a tenant chose a vendor and a data processor. Their
   customers' questions go to *that* provider on *that* key, never silently
   to some cheaper alternative (this rule is enforced and tested: the
   platform's fallback provider is never used for an org that saved its own
   credential).
3. **Engineering content** — supporting five LLM providers and four
   embedding providers behind one interface, each with a *different*
   structured-output mechanism, is where much of the interesting work lives.
   Tenant keys are treated as the dangerous objects they are: AES-256-GCM
   encrypted at rest, displayed only as a four-character suffix after save,
   and a security probe attempts (and fails) to read them back.

## What it deliberately is not

The project has explicit anti-goals, chosen and documented (CLAUDE.md's
"anti-tutorial rules"):

- **No RAG framework.** No LangChain, no LlamaIndex. Retrieval is
  hand-written SQL — hybrid vector + full-text search fused by Reciprocal
  Rank Fusion — because the retrieval layer *is* the technical content.
- **No vendor citation feature.** Anthropic ships a native citations mode;
  building verification ourselves means it works identically across all
  five providers and the hard decisions are visibly ours.
- **No trusting a first response.** Structured output enforcement varies
  wildly by provider (from real server-side schema enforcement to "please
  emit JSON"), so every response is validated, retried exactly once on
  violation, and the violation *counted* as a per-model metric.
- **No unmeasured claims.** Every number in the README is produced by a
  committed script anyone can re-run, and the documents publish the
  failures alongside (the 12 questions retrieval still misses, the harness
  bugs that produced wrong numbers first, the limits of each measurement).

## Where it is right now

The system is **deployed and live**, end to end, on free tiers:

- **Live demo** (the widget over real Fastify documentation):
  <https://interrelated-realtime-rtue.onrender.com/demo>
- **Dashboard**: <https://interrelated-ai-support-widget-beta.vercel.app>
- Data plane on Render, dashboard on Vercel, Postgres (with pgvector) on
  Neon, generation and embeddings on a free-tier Gemini key.

A visitor question on the demo runs the entire thesis in production:
embedding → hybrid retrieval → refusal gate → generation → span
verification → streamed verified claims deep-linking into fastify.dev — at
~1.7 seconds to first token, with every verdict recorded.
