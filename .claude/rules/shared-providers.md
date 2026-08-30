---
paths:
  - "shared/**"
  - "providers/**"
---

# shared/ + providers/ — contract-layer rules

- **No package.json, no runtime dependencies, ever.** Heavy deps load via
  dynamic `import()` and are declared by whichever package actually runs
  the code (fastembed/unpdf pattern).
- Type-only imports (kysely) are fine — they erase at compile time.
- **Error messages never carry keys, request headers, or URLs** —
  provider errors land in logs; `postStream` truncates bodies and tests
  assert the key is absent.
- Adapters: **streaming-first LLM** (deltas, then exactly one `done`),
  **batch-first embeddings** (task hint + AbortSignal). Retry/backoff
  belongs to the CALLER, never the adapter.
- Anything here is a cross-package contract: change every consumer in the
  same commit (schema types ↔ migrations; protocol ↔ both socket ends).
- Prices: EXACT model-id match only; unknown = `null`, never 0; keep
  `PRICES_AS_OF` honest.
- Depth: `docs/reference/02-shared-and-providers.md` (§2).
