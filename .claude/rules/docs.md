---
paths:
  - "docs/**"
  - "*.md"
---

# Documentation rules

- **CLAUDE.md stays under 200 lines.** A new convention becomes a config,
  hook, or lint rule first; prose only when no tool can check it.
- **Milestones append to `docs/history.md`** (newest first) — never to
  CLAUDE.md.
- **§ numbers are immutable.** New reference content gets new numbers;
  renumbering is forbidden (~350 citations resolve through the lookup
  table). Every source file is described somewhere in `docs/reference/` —
  an undescribed file is a documentation bug.
- README claims require a committed producer script, and limits publish
  beside numbers.
- **`eval/corpus/` bytes are frozen** (prettier-ignored): golden-set
  anchors and content hashes depend on them.
- Keep Diátaxis forms unmixed: `docs/01–05` teach, `docs/reference/`
  documents, `DATAFLOW.md` traces, `docs/history.md` narrates.
