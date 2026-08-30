<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §1 Project rules

## §1 Project rules

### §1.1 Git

Exactly two branches: `main` and `dev`. All commits land on `dev`, only when
Xavier asks for them; `main` advances only by a merge he requests. No
force-push, no history rewriting.

### §1.2 Build discipline

Additive increments on a green tree. Nothing proceeds on a red build; every
new behavior lands with a test that would fail without it. A step that can't
finish cleanly is reverted, not parked.

Verification ladder per increment: typecheck → unit tests → integration
tests against real Postgres → and, for any increment touching migrations,
boot, Dockerfiles, or compose, **re-boot the prod compose stack and re-run
the smoke probe** (`docker compose -f docker-compose.prod.yaml up --wait`
then `node scripts/smoke-test.mjs`). Unit-level green is not "the project
runs"; the prod boot is. Since M6, an increment touching any public
surface, the trust model, or the answer path also re-runs the security and
injection probes against that same stack, exactly as CI's e2e job does
(§4.4 has the three commands): the fixture seeded through the probe
override, then `injection-probe.mjs`, then `security-probe.mjs` last.

### §1.3 House style

2-space indent, no semicolons, double quotes, `//#region` folding markers,
PascalCase component directories (later, in web/), camelCase modules,
comments that explain WHY (including rejected alternatives), and hand-written
DB types kept in lockstep with raw-SQL migrations (§3.1).

---
