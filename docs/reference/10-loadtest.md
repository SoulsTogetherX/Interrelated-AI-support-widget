<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §10 loadtest/

## §10 `loadtest/` — the handoff socket under load (M4.7)

The measurement layer for the socket, and the last package the plan's repo
layout names. Same no-package-json pattern as eval/ (§7): the root runner
owns its tests and `typecheck:loadtest` its types, the runner
(`realtime/scripts/runLoadtest.ts`, `npm run loadtest`) consumes it through
the `@loadtest/*` alias. Zero dependencies — Node's global WebSocket has
been stable since 22, so the harness runs with nothing installed, the same
standard the .mjs probes hold themselves to.

### §10.1 `loadtest/histogram.ts`

Samples in, percentiles out. Kept as raw samples rather than buckets: a run
against a free-tier stack produces thousands, not millions, so exact
percentiles cost one sort and remove the "which bucket did p95 land in"
question. **Nearest-rank, never interpolated** — interpolation invents a
latency nobody measured, which is precisely the wrong thing to print beside
"p95" in a README. Invalid samples throw rather than skew everything after
them, and an empty run reports NaN → "—" rather than 0.0, because "0 ms"
reads as impossibly fast where "—" reads as never happened. Unit-tested
against hand-computed fixtures for the same reason eval/metrics.ts is: the
numbers it produces are published.

### §10.2 `loadtest/handoffLoad.ts`

The scenario. One **session** is one conversation — a visitor socket AND an
agent socket — because that is the product's unit: somebody waiting,
somebody answering. Three measurements, each chosen for what it contains:
**connect** covers ticket → upgrade → `ready` → `history`, so it includes
the backlog read and would expose a slow replay; **round trip** is a
client's own echo, which contains a real Postgres write because the server
persists before it broadcasts (§3.25); **delivery** is one end reaching the
other, measured across two sockets in ONE process so no clock skew enters
the number. Messages carry their id in the TEXT, since the server assigns
message ids and a sender cannot correlate an echo by an id it never chose.

Two harness bugs are recorded in the file and in RESULTS.md rather than
quietly fixed, because each produced a wrong number first: senders that all
start together measure the drain of a synchronized herd (365 ms p50) rather
than the service (24 ms with arrivals staggered across one interval), and
throughput divided by an elapsed that included the drain window understated
178/s as 106/s.

### §10.3 `realtime/scripts/runLoadtest.ts`

The runner: seeds its own org, conversations, and open handoffs, mints
tickets with the SERVER'S signer, runs the scenario, prints the table, and
deletes everything — including on Ctrl-C, via one cascading delete. It
signs tickets directly instead of driving `/v1/widget/session` +
`/v1/widget/escalate` deliberately: those routes are per-IP rate limited
(§3.17.2), so a hundred sessions from one machine would measure the token
bucket doing its job rather than the socket. It refuses to run without a
`WIDGET_TOKEN_SECRET` matching the live service, because the alternative is
100 upgrade refusals and a confusing report.

### §10.4 `loadtest/RESULTS.md`

The published measurement, in eval/RESULTS.md's shape: the table, the knee,
and the failure analysis. The findings — 300 concurrent sockets with
nothing dropped, connect flat at ~10 ms p50 across that range, a round trip
of 26 ms p50 / 72 ms p95 below ~100 msg/s, and a knee between 200 and 250
msg/s whose arithmetic points at the 5-connection pool (§3.2) rather than
at the socket layer — plus the honest note that these are one machine's
numbers and Render/Neon will add a network hop this setup does not have.

**Not a CI gate, deliberately.** The retrieval eval blocks merges because
recall is deterministic; latency on a shared runner measures the runner, and
a flaky p95 threshold would train everyone to re-run it. CI typechecks the
harness and runs the histogram's tests; the load run is a tool a human uses
when the socket path changes.
