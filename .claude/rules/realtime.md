---
paths:
  - "realtime/**"
---

# realtime/ — data-plane rules

- **Migrations are append-only** (a PreToolUse hook blocks editing applied
  ones). New table shape = new `NNN_*.ts` + registration in `migrate.ts` +
  `shared/db/schema.ts` updated in the SAME change.
- **Counters live in the transaction of the rows they count**
  (`usage_daily`, `origin_daily`): a counter that can drift is not a counter.
- **Public-surface failures are opaque**: one `{type:"error"}` SSE event,
  uniform 401s, no detail (failure detail on a public stream is
  reconnaissance). Authenticated/internal surfaces explain themselves.
- **Every tenant-supplied URL goes through the SSRF vet** (crawl targets,
  self-hosted base URLs). Tests reach loopback only via an injected
  hostGuard — never by weakening the default.
- **Provider credentials resolve per request, uncached** — rotation must
  bite on the next question. The platform fallback LLM is NEVER used for an
  org that saved its own credential.
- **Worker doctrine**: wake-driven in prod (no timers), one job per tick,
  embed OUTSIDE the transaction, lease renewed per page, patient retry
  (8 attempts / 5 min) — interactive paths use 3 attempts / 8 s. Pick the
  policy by who is waiting (§3.15.5 vs §3.10.5a).
- **Cross-service time is Postgres's clock** (`NOW()`), never a process
  `Date` — Render, Vercel and Neon share exactly one clock.
- New env vars must be documented in `.env.example` or they are a bug.
- Depth: `docs/reference/03-realtime.md` (§3).
