# Realtime service image — multi-stage on node:22-alpine.
#
# Build context is the REPO ROOT (set in compose), not realtime/: the service
# imports shared/ and providers/ through path aliases, and both must exist
# inside the image for dev (tsx resolves them live) and build (esbuild
# inlines them).
#
# Stages:
#   deps   — npm ci only; cached until package-lock.json changes
#   dev    — bind-mount target for compose dev; runs tsx watch
#   build  — esbuild bundles src + shared into dist/server.js
#   prod   — runtime-only deps + the bundle; non-root; healthchecked

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app/realtime
COPY realtime/package.json realtime/package-lock.json ./
RUN npm ci

# ── dev ──────────────────────────────────────────────────────────────────────
# Compose bind-mounts ./realtime/src and ./shared over these paths, so edits
# on the host restart the server through tsx watch without a rebuild.
FROM deps AS dev
WORKDIR /app/realtime
COPY realtime/tsconfig.json ./
COPY realtime/src ./src
COPY shared /app/shared
COPY providers /app/providers
CMD ["npx", "tsx", "watch", "src/server.ts"]

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app/realtime
COPY realtime/tsconfig.json ./
COPY realtime/src ./src
COPY shared /app/shared
COPY providers /app/providers
# esbuild inlines src + shared + providers into one CJS bundle.
# --packages=external keeps node_modules imports (express, kysely, pg,
# undici, htmlparser2) external — installed in the prod stage.
# @shared/@providers are passed as explicit --alias flags in the build
# script: --packages=external classifies them as scoped npm packages before
# tsconfig paths are consulted (they LOOK like @scope/name), and alias
# substitution is the one mechanism that takes precedence over it. The @/
# alias needs no flag — "@" alone is not a valid package name, so it falls
# through to tsconfig path resolution.
RUN npm run build

# ── prod ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app/realtime
COPY realtime/package.json realtime/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/realtime/dist ./dist

# Run as the unprivileged user the base image ships. A container escape from
# root is a much worse day than one from node.
USER node

# busybox wget ships in alpine — no extra package for the healthcheck.
# /api/health is the DB-free liveness route, so a database outage does not
# make the orchestrator kill a healthy process.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/api/health || exit 1

# Plain `node`, not `npm start`: npm swallows SIGTERM, which would turn every
# graceful shutdown into a 10-second kill -9. The signal must reach node.
CMD ["node", "dist/server.js"]
