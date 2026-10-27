# SOL_Tea runtime image.
#
# Multi-stage so the shipped image carries no TypeScript toolchain, no dev
# dependencies and no test fixtures — a trading process should contain only what
# it runs. better-sqlite3 is a native module, so its build toolchain is confined
# to the builder stage and the compiled binding is copied across.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# python3/make/g++ are required to compile better-sqlite3 from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so dependency layers cache independently of source churn.
COPY package.json package-lock.json ./
# `npm ci` (not install) so the build is reproducible from the lockfile.
RUN npm ci

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY chains ./chains
COPY scripts ./scripts
COPY config ./config
COPY tests ./tests
RUN npm run build

# Re-resolve production dependencies only, into a clean tree.
RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `tini` reaps zombies and forwards SIGTERM, so the graceful-shutdown handler in
# each entrypoint actually receives the signal instead of the container dying
# under it mid-transaction.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user: a leaked exploit in a dependency must not own the
# process that holds signing authority.
RUN groupadd --system --gid 10001 soltea \
    && useradd --system --uid 10001 --gid soltea --create-home soltea

COPY --from=builder --chown=soltea:soltea /app/node_modules ./node_modules
COPY --from=builder --chown=soltea:soltea /app/dist ./dist
COPY --from=builder --chown=soltea:soltea /app/package.json ./package.json
COPY --chown=soltea:soltea config ./config

# Writable state: SQLite store, journal, pause file. Mount a volume here so the
# durable record survives a container replacement.
RUN mkdir -p /app/var/state /app/var/journal && chown -R soltea:soltea /app/var

USER soltea
ENV STORE_PATH=/app/var/state/sol-tea.db \
    JOURNAL_DIR=/app/var/journal \
    HEALTH_PORT=8787

EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default role is the trading worker; compose overrides command per service.
CMD ["node", "dist/apps/solana-worker/src/main.js"]
