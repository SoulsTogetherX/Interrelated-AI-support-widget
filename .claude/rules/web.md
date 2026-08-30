---
paths:
  - "web/**"
---

# web/ — dashboard rules

- **Server Actions re-check the whole auth ladder** (signed-in → member →
  OWNER for writes): every action is reachable as a direct POST.
- **Never select `key_ciphertext`** — the greppable rule. Reads show a
  suffix; vault writes go through realtime's internal API only.
- **web/ never migrates.** Dashboard reads go straight to Postgres so a
  realtime outage cannot blank a page.
- **Rates are null-not-zero** when there is no denominator; plain counts
  may be honest zeros.
- Plain CSS per component, class names prefixed by component; no UI
  libraries. `next build` rewrites tsconfig.json — accept its edits.
- **Phone widths**: the flex automatic-minimum trap (§9.16) has bitten
  three times — new pages get a 375 px `scrollWidth === clientWidth` check.
- `providers/` imports are forbidden here (adapters open sockets;
  dependency-cruiser enforces).
- Depth: `docs/reference/09-web.md` (§9).
