<!-- New at the 2026-08 org overhaul (phases 1-2c). Section numbers are
append-only; §11 is the enforcement layer's home. -->

# Architecture reference — §11 The enforcement layer

## §11.1 Why it exists, and the shape of the argument

Until the 2026-08 overhaul this repo had **no formatter and no linter**:
every convention lived as prose in a 7,000-line CLAUDE.md. Three research
findings (surveyed across ~90 primary sources; the survey itself is
recorded in `docs/history.md`) reshaped that:

1. A 1,650-session controlled study found instruction-file size has no
   measurable effect on AI adherence — **mechanical checks are what
   change behavior**. "An instruction is a request; a hook is
   enforcement" (Anthropic's own guidance).
2. File-size hard caps are minority practice with weak evidence (Google's
   TS guide is silent on them; Airbnb ships them off; the classic studies
   found _larger_ routines had fewer errors per line). Complexity limits,
   by contrast, are defect-predictive. Hence: **size = warn budget,
   complexity = error**.
3. Test code is deliberately exempt from size/DRY pressure (Google SWE
   book: DAMP over DRY — duplication that makes a test self-contained is
   a feature).

The division of labor: **configs are the law; the reference explains
why.** A rule that can be a check must be a check; prose is reserved for
what tools cannot see (cohesion judgments, rationale, history).

## §11.2 `.prettierrc.json` + `.editorconfig` — style is not a discussion

Prettier 3.9 (`semi: false`, `singleQuote: false`, `tabWidth: 2`,
`printWidth: 100`, `trailingComma: "all"`, `endOfLine: "lf"`) — the house
style §1.3 described, now produced mechanically. 3.9 matters: it landed
the `--no-semi` idempotency fixes, and in no-semicolon mode Prettier
prepends the defensive `;` to lines opening with `(`/`[`, which is how an
ASI-hazard never ships. The one deliberate exclusion (`.prettierignore`):
**`eval/corpus/`** — those files' exact bytes anchor the golden set's
`mustContain` substrings and every `content_hash`; reformatting them
would invalidate measurements. `.editorconfig` mirrors the basics for
editors that act before Prettier does.

The whole-repo reformat is one mechanical commit, listed in
`.git-blame-ignore-revs` (both its dev SHA and the squash SHA it became
on main — a squash changes the SHA, so the file carries each). GitHub's
blame view honors the root file automatically; locally it needs
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

## §11.3 `eslint.config.mjs` — one root flat config, four tiers

ESLint 10 + typescript-eslint 8 (`strictTypeChecked`) via
`projectService`, which resolves each package's own tsconfig — one config
file governs a flat multi-package repo without workspaces. The tiers:

1. **All TypeScript** — the type-aware rules that matter most to an async
   streaming service: `@typescript-eslint/no-floating-promises` and
   `switch-exhaustiveness-check` as errors (the reason ESLint beat Biome
   here: Biome's equivalents were nursery/~85%-coverage at evaluation
   time). Budgets and caps:
   - `max-lines`: **warn 1000** (`skipComments` + `skipBlankLines` — the
     repo's WHY-comment density is deliberate and must not count against
     a file)
   - `max-lines-per-function`: **warn 200**
   - `complexity` (cyclomatic): **error 15** · `sonarjs/cognitive-complexity`:
     **error 15** · `max-params`: **error 4** · `max-depth`: **error 4**
2. **Tests** (`**/__tests__/**`, `*.test.ts`): size and complexity rules
   OFF (DAMP), `vitest/no-focused-tests` ERROR (a `.only` that lands
   silently disables a suite).
3. **Probes and harnesses** (`scripts/*.mjs`, `realtime/scripts/`):
   size/complexity off — a single-file zero-dependency probe is the
   design (§6), and harnesses are glue by doctrine (§3.11).
4. **`.mjs` generally**: type-checked rules disabled (no tsconfig owns
   them); correctness there is the probes' own runtime assertions.

**Grandfathering**: 25 pre-existing complexity hot spots carry
`eslint-disable-next-line` with a dated reason after `--`. The contract:
simplify when touched, never grow; a new violation cannot be waved
through without the same dated-reason form, and `--max-warnings` keeps
warn-budget breaches visible in every CI log without failing the build.

## §11.4 `.dependency-cruiser.cjs` — the architecture as forbidden edges

Nine rules turn the layering that was prose into CI failures:

| Rule                                  | The law it encodes                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `shared-is-dependency-free`           | `shared/` imports nothing at runtime (type-only imports allowed — the kysely arrangement, §2.4.6)                                        |
| `providers-import-only-shared`        | adapters see interfaces and `shared/`, never app code                                                                                    |
| `widget-runtime-imports-nothing`      | the 15 KB budget's structural half: type-only from `shared/`, sole value exception `shared/handoff/protocol.ts` (esbuild inlines it, §8) |
| `widget-never-touches-app-code`       | no realtime/web/providers import, ever                                                                                                   |
| `web-is-control-plane-only`           | `web/` never imports `providers/` (adapters open sockets) or `realtime/`                                                                 |
| `realtime-never-imports-web`          | the split runs one direction only                                                                                                        |
| `production-code-never-imports-tests` | nothing outside `__tests__` imports from it                                                                                              |
| `no-circular`                         | value cycles forbidden repo-wide                                                                                                         |
| `no-orphans`                          | warn — a module nothing imports is either dead or missing its registration                                                               |

dependency-cruiser was chosen over eslint-plugin-import (no ESLint 10
release at evaluation time) and eslint-plugin-boundaries (mid-rename
churn) because it is the only tool indifferent to package-less folders:
it cruises the filesystem graph and resolves `@shared/*` via tsconfig
paths, and it treats `type-only` as a first-class dependency class —
which is exactly the distinction `shared/` and `widget/` are built on.
Core `no-restricted-imports` (with `allowTypeImports`) mirrors the
widget/web rules in-editor so violations surface while typing, not at CI.

## §11.5 `knip.json` — dead exports are findings

Knip maps the flat layout explicitly (workspaces need a `package.json`,
so `shared/`, `providers/`, `eval/`, `loadtest/`, and the probes are
covered from the root workspace's globs). Entries are the real roots:
`server.ts`, the migration files, every CLI, `instrumentation.ts`,
`widget/src/index.ts`, every test file, the `.mjs` probes.
Knip's own convergence pass (2026-08) resolved the dynamic imports
(`unpdf`, `fastembed`) unaided, and its `--fix` swept ~20 needlessly
exported internal types. Two files are `ignore`d as CONTRACT files:
`shared/handoff/protocol.ts` and `providers/llm/http.ts` — their exports
are the public API of package-less modules, consumers may type
structurally today, and deleting a documented contract export because
nobody names it _yet_ is how a wire protocol rots. The first fixer run
proved the hazard: it stripped `HandoffTranscriptRole` from the protocol
and broke four typechecks at once.

## §11.6 Hooks — the checks that run before CI can

- **`lefthook.yml`**: `pre-push` runs `prettier --check` + `eslint`, in
  parallel. Pre-PUSH, not pre-commit, deliberately: interactive rebase
  replays commits and fires pre-commit hooks on intermediate states never
  meant to pass. CI remains the real gate; the hook just shortens the
  loop.
- **`.claude/hooks/guard-migrations.mjs`** (PreToolUse on `Edit|Write`,
  wired in `.claude/settings.json`): editing an EXISTING file under
  `realtime/src/db/migrations/` is blocked with exit 2 and a message
  naming the fix (new `NNN_*.ts` + registry + schema types in one
  change). Creating a new migration passes — append-only is the point.
  This is the doctrine of §3.3/§3.4 as physics instead of prose.
- **`.claude/rules/*.md`**: per-area conventions with `paths:`
  frontmatter, so an AI session loads the realtime rules only when it
  touches realtime files. Short by contract (<150 lines each); anything
  that grows past a screen belongs here in §11 or in the area's reference
  section instead.

## §11.7 CI wiring, and what is deliberately NOT enforced

The `quality` job (ci.yml) runs keyless on every push/PR beside `verify`:
four `npm ci`s, then `prettier --check`, `eslint`, `depcruise`, `knip`. A
violation is a red merge exactly like a failed test.

Not enforced, on purpose:

- **No pre-commit hooks** (rebase-replay problem, §11.6) and no
  `--fix`-on-save automation in CI — fixes are commits a human reviews.
- **No duplication gate.** `jscpd` was surveyed and deferred: the corpus
  and test exemptions make its signal weak here, and the measured
  AI-duplication problem (+81% industry-wide) is already bounded by
  review plus the budgets above. Revisit if a real duplication incident
  occurs.
- **No coverage threshold.** The suites' value is behavioral specificity,
  not a percentage; a coverage gate optimizes the number, not the tests.
- **File splits are never automatic.** The budgets warn; the split
  decision stays a cohesion judgment ("two audiences or two reasons to
  change"), made in review, recorded in the reference when taken.
