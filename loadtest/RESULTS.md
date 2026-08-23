# Handoff socket — measured concurrency and latency

What the handoff WebSocket (CLAUDE.md §3.25) actually does under load, and
where it stops. Produced by `npm run loadtest` in `realtime/`; the harness is
`loadtest/handoffLoad.ts`, the percentile code is unit-tested
(`loadtest/__tests__/histogram.test.ts`) because these are the numbers the
README quotes.

## What is measured

One **session** is one conversation: a visitor socket *and* an agent socket,
which is the product's actual unit — somebody waiting, somebody answering.

| Metric | What it covers |
|---|---|
| **connect** | ticket → upgrade → `ready` → `history`. Includes the backlog read, so a slow replay would show up here. |
| **round trip** | a client's own message coming back to it. The server persists **before** it broadcasts, so this contains a real Postgres write — it is "did my message land", not a relay benchmark. |
| **delivery** | one end's message arriving at the **other** end. Both timestamps come from one process, so there is no clock skew in the number. |

Percentiles are nearest-rank, never interpolated: printing a latency nobody
measured is the one thing a report like this must not do.

## Results

Measured 2026-08-13 on the dev machine (Windows 11, Docker Desktop Postgres 18
+ pgvector, realtime under `tsx`, all on one host). **These are not production
numbers** — Render and Neon are different machines on a network, and the
round-trip figure there will be dominated by the hop this setup does not have.
What transfers is the *shape*: where the knee is, and what causes it.

| Sessions | Sockets | Offered | Sustained | connect p50 / p95 | round trip p50 / p95 | delivery p50 / p95 | unfinished |
|---|---|---|---|---|---|---|---|
| 100 | 200 | ~50/s | 32/s | 9.6 / 20.7 | 24.3 / 57.0 | 24.6 / 56.9 | 0 |
| 100 | 200 | ~100/s | 100/s | 9.4 / 18.4 | 26.0 / 72.5 | 26.1 / 72.4 | 0 |
| 100 | 200 | ~200/s | 192/s | 9.2 / 18.7 | 60.3 / 410.3 | 60.5 / 408.6 | 0 |
| 150 | 300 | ~600/s | 233/s | 11.6 / 28.3 | 2306 / 3027 | 2304 / 3027 | 758 |

All latencies in milliseconds. "Unfinished" counts messages that had not
echoed when the drain window closed — past the knee they are *late*, not
dropped: no socket errored, no send failed, and the count is what a queue
looks like when it is longer than the patience of the measuring tool.

**300 concurrent sockets connect and stay connected.** Nothing in the four
runs errored, dropped, or crossed rooms. The connect number barely moves
between 200 and 300 sockets (9.2 → 11.6 ms p50), which is the useful part:
attaching is cheap and stays cheap, so replay-on-attach is not what limits
this service.

**The knee is between 200 and 250 messages/second on this machine.** Below
~100/s the round trip sits at 26 ms p50 / 72 ms p95. At ~200/s it holds
throughput but p95 degrades 6× (410 ms) — the queue is forming. Offer 600/s
and throughput flattens at 233/s while p50 goes to 2.3 s: the service is past
capacity and everything after that is waiting.

**What the ceiling is made of.** Every message is one transaction (INSERT
RETURNING + the conversation's recency bump), and the pool is capped at 5
connections (§3.2, sized for Neon's free tier). ~233 tx/s through 5
connections is ~21 ms of database time each, which matches the low-load round
trip almost exactly — so the ceiling is *database concurrency*, not the
socket layer, and the honest way to raise it is a bigger pool against a
bigger database, not a rewrite here.

## Two findings about the harness itself

Both of these produced wrong numbers first, which is why they are written
down rather than quietly fixed:

1. **Synchronized senders measure the herd, not the service.** With every
   client starting its loop at the same instant, 200 clients on a 4-second
   interval offered 38/s *on average* but arrived as bursts of 200, and the
   p50 that came out — 365 ms — was almost entirely queue wait. Staggering
   each client across one interval dropped the same run to 24 ms p50 and
   57 ms p95. Two hundred people do not type in unison; the jittered arrival
   is both the more honest model and the number that means something.
2. **Throughput must not be divided by the drain window.** Elapsed time
   originally ran to the end of the drain wait, so a 6-second drain on a
   9-second run reported 106/s for what was really 178/s. It now measures
   first send → last receive.

## Why this is not a CI gate

The retrieval eval is a merge-blocking gate because recall is deterministic.
Latency on a shared runner measures the runner: a p95 threshold here would
flake, everyone would learn to re-run it, and the gate would be worse than
nothing. This is a measurement tool a human runs when the socket path
changes, and whose output gets published.

## Reproducing

```bash
npm run loadtest -- --sessions 100 --messages 6 --interval 2000
```

Needs a running realtime service started with the *same* `WIDGET_TOKEN_SECRET`
this process reads (tickets are signed with a key derived from it), and
`POSTGRES_*` pointing at that service's database. The harness seeds its own
org, conversations, and handoffs, and deletes all of it — including on Ctrl-C.

It mints tickets with the server's own signer rather than driving
`/v1/widget/session` and `/v1/widget/escalate`, deliberately: those routes are
rate-limited per IP (§3.17.2), so a hundred sessions from one machine would
measure the token bucket doing its job instead of the socket. The HTTP surface
has its own tests.
