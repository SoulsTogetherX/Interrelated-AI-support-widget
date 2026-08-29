# Understanding Interrelated — the guided documentation

This folder is the **learning path** for the project. The repo's other
documents are references — exhaustive, precise, and dense. These are the
opposite: they explain the system top-down, in plain language, assuming you
know how to program but not what any of this jargon means.

## Reading order

| Doc                                     | Question it answers                                                                            | Time   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| [01 — What and why](01-what-and-why.md) | What is this product? What problem does it solve? What is the one idea everything hangs off?   | 10 min |
| [02 — Architecture](02-architecture.md) | What are the pieces, and how does each one work?                                               | 40 min |
| [03 — Logic flows](03-logic-flows.md)   | What actually happens, step by step, when a page crawls / a visitor asks / a human takes over? | 30 min |
| [04 — Using it](04-using-it.md)         | How do I run it, demo it, operate the deployed instance, and use every tool in the repo?       | 20 min |
| [05 — Glossary](05-glossary.md)         | What does that word mean?                                                                      | lookup |

## How this folder relates to the other documents

- **[README.md](../README.md)** (repo root) — the public face: the pitch, the
  measured numbers, the trust model, known limitations. Read it first if you
  have five minutes; read this folder if you have two hours.
- **[CLAUDE.md](../CLAUDE.md)** — the file-by-file architecture reference.
  Every file in the repo is described there, with the reasoning and the
  rejected alternatives, in numbered sections (`§3.15.1`) that code comments
  cite. It is the _depth_ document: when a doc here says "see §3.15.1", that
  is where the full story lives.
- **[DATAFLOW.md](../DATAFLOW.md)** — request-by-request traces naming the
  exact function at every hop. The precise version of doc 03.
- **[PLAYGROUND.md](../PLAYGROUND.md)** — a hands-on fifteen-minute tour of
  the product running locally, with no API keys.
- **[eval/RESULTS.md](../eval/RESULTS.md)** and
  **[loadtest/RESULTS.md](../loadtest/RESULTS.md)** — the published
  measurements and how they were produced, including the failure analyses.

## The one-paragraph version, if you read nothing else

Interrelated is a multi-tenant SaaS: a business signs up, pastes its own AI
provider key, points the product at its documentation, and gets a `<script>`
tag that renders a support-chat bubble on its website. The bubble answers
visitor questions **only from that documentation**, citing the exact passage
each sentence came from — and the citations are not decorative: the model is
forced to quote its evidence verbatim, deterministic code checks the quote
really occurs in the cited source, and any claim that fails the check is
deleted before the visitor sees it. When the docs don't cover a question it
refuses instead of guessing, and can hand the conversation to a human over a
live WebSocket. Everything runs on free-tier infrastructure for $0, and every
quality claim in the README is a number produced by a committed script.
