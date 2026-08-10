# Postgres 18 with pgvector preinstalled.
#
# The pgvector project publishes official images layered on the Postgres
# images. Using their image (rather than compiling the extension into
# postgres:18-alpine ourselves) keeps this Dockerfile at one line of intent —
# and the version is pinned by tag so a `docker compose build` next year
# produces the same database as today.
#
# Migration 001 runs CREATE EXTENSION vector at boot, so a wrong image here
# fails loudly on first startup, not at first ingest.
FROM pgvector/pgvector:pg18

# Everything else (user, password, database name) is injected by compose from
# .env — the image itself carries no configuration and no secrets.
