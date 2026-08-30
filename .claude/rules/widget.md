---
paths:
  - "widget/**"
---

# widget/ — embeddable-bundle rules

- **Zero runtime dependencies, 15 KB gzipped CI budget.** Check
  `node scripts/widget-size.mjs` after any change.
- **`textContent`, never `innerHTML`** — claim text is model output relayed
  from crawled pages (attacker-reachable); one `innerHTML` is stored XSS on
  a customer's site. Citation hrefs re-vetted http(s).
- **Type-only imports from `shared/`** (esbuild erases them). Sole value
  exception: `shared/handoff/protocol.ts` constants, inlined at build.
- **The cost contract is tested and sacred**: zero requests at mount, one
  at bubble-open, one per question. `cost.test.ts` uses the REAL client on
  purpose — do not convert it to a fake.
- Session mint is single-flight; a 401 gets ONE silent re-mint. Never
  persist tokens or identified visitor ids; bookmark rules in §8.1.
- Depth: `docs/reference/08-widget.md` (§8).
