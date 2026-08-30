---
paths:
  - "**/__tests__/**"
  - "**/*.test.ts"
---

# Test rules

- **DAMP over DRY**: a test body should read complete on its own; size and
  complexity rules are OFF here on purpose. `.only` is an error.
- **DB-gated pattern**: `describe.skipIf(!POSTGRES_PASSWORD)` plus a
  keyless placeholder asserting the gate — "gated off" must never be
  mistakable for "passed". Key-gated live suites read the SAME env names
  production reads; no test-only variables.
- **Prove a new test can fail** (break the code briefly, watch it go red,
  restore) — the repo tradition; a test never seen red proves nothing.
- Suites that queue ingest jobs must park or delete them in `finally`:
  `tick()` claims the OLDEST queued row, so residue hijacks later suites
  and benches.
- pgvector plan-sensitive tests run on ONE connection with
  `enable_seqscan`/`enable_sort` off (the §3.8 starvation lesson).
- Rate math uses injected clocks/sleeps; providers are tested against
  loopback servers speaking the real wire protocol, not mocks of our own
  code.
