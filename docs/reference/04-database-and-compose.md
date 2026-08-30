<!-- Split from the original single-file CLAUDE.md at the 2026-08 org
overhaul. Section numbers (§) are PRESERVED VERBATIM: ~350 references in
code comments, DATAFLOW.md and docs/ resolve here via the lookup table in
CLAUDE.md. Append-only growth caution applies: new sections get new
numbers, existing numbers are never reused. -->

# Architecture reference — §4 database/ and compose

## §4 `database/` and compose

### §4.1 `database/Dockerfile`

`FROM pgvector/pgvector:pg18` — the pgvector project's official layer over
Postgres 18. One line of intent; compiling the extension into
postgres:18-alpine ourselves was rejected as maintenance for no gain.

### §4.2 `docker-compose.yaml` (dev)

Hot-reload stack: database + realtime (target `dev`, tsx watch) with
`./realtime/src` and `./shared` bind-mounted. Postgres publishes
`${POSTGRES_PORT:-5432} → 5432` so host-side `npm test` can reach it;
containers always use `database:5432` internally. Two hard-won details:

- The data volume mounts at **`/var/lib/postgresql`** (not `…/data`): the
  PG18 image moved the convention up a level; the old path makes the
  container refuse to initialize.
- `depends_on.condition: service_healthy` — realtime migrates immediately at
  boot, and racing Postgres init would make every `up` a coin flip.

Both compose stacks set `INGEST_WORKER: "1"` — polling a LOCAL Postgres is
free, and the dev loop (`npm run enqueue`, §3.11) depends on a live worker.
(Corollary, learned the hard way: bring up ONLY the database service when
running the DB-gated test suite — §3.8's worker-test note.) Both stacks
also mount the widget surface: dev passes through LLM_PROVIDER and the
provider keys from .env (mock default), prod pins LLM_PROVIDER=mock so
the e2e job drives the real chat route keylessly; token secrets are
ephemeral in both, which is correct for stacks whose sessions should not
outlive them.

### §4.3 `docker-compose.prod.yaml`

Production shape: prod image target, no bind mounts, Postgres **not**
published to the host. This is the stack CI's e2e job boots — the artifact
probed is the artifact shipped. Since M6.2 it passes `INTERNAL_API_SECRET`
and `CREDENTIAL_MASTER_KEY` through from `.env` with EMPTY defaults: empty is
"unconfigured" to server.ts (the routes do not mount), so a local boot with
neither behaves exactly as before, while CI's throwaway pair mounts the
surface so the security probe can attack it.

### §4.4 `docker-compose.probe.yaml` — the harness half of e2e (M6)

Layered OVER the prod stack, never used alone: one profile-gated, one-shot
`seed` service that gives the security and injection probes a tenant to
attack. A black-box probe needs orgs, keys, an allowlisted origin, and
known content, and none of that can be created through the public surface
by design — so it is seeded from INSIDE the compose network by
`realtime/scripts/seedSecurityFixture.ts` (§3.27), and the fixture the
probes read lands in `.probe/` through a bind mount.

Why a service and not a host-side script: the prod stack deliberately does
not publish Postgres, and the probes deliberately need no npm install; a
container reaches `database:5432` without conceding either, and the realtime
image under test stays exactly the artifact that ships. Why the Dockerfile's
DEV stage: it already holds realtime's deps, src, shared/ and providers/ —
the seed script and eval/ ride in as read-only mounts the same way compose
dev mounts src — and it builds as one cached layer set over the deps stage
the prod build shares. `profiles: [probe]` keeps `up` from starting it: it
is a command, not a service, and `run --rm seed` targets it explicitly.
`.probe/` is gitignored — per-run droppings, like eval/results/.

**The three commands §1.2's ladder means**, in order, since "run the probes"
is ambiguous about arguments and every probe takes the base URL as a
POSITIONAL argument before its flags (passing only `--fixture` makes the
first one concatenate the path onto the route and fail with an unparseable
URL):

```
docker compose -f docker-compose.prod.yaml -f docker-compose.probe.yaml run --rm --build seed
node scripts/injection-probe.mjs http://localhost:3000 --fixture .probe/security-fixture.json
node scripts/security-probe.mjs  http://localhost:3000 --fixture .probe/security-fixture.json
```

`smoke-test.mjs` runs before them and needs no fixture. Security is LAST
because its final section drains the token buckets on purpose, and section
H needs `INTERNAL_API_SECRET` exported in the probe's own environment (a
throwaway pair, as ci.yml generates — the same pair the stack booted with,
or the internal routes do not mount and the section skips).

---
