# syntax=docker/dockerfile:1
#
# Mirsal — multi-stage build.
# builder: full workspace install (dev deps needed to build web + compile server),
#          then prune to production deps for a lean runtime.
# runtime: same base (identical glibc/ABI so the natively-compiled better-sqlite3
#          and argon2 binaries copied from the builder load correctly), non-root.

# ---------- builder ----------
FROM node:20-slim AS builder

# better-sqlite3 and argon2 are native modules. This box reaches npm behind a VPN
# where the prebuilt-binary CDN is often unreachable, so both may source-compile —
# which needs a C/C++ toolchain + python3 (node-gyp). ca-certificates for TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install with the lockfile first (better layer caching): only manifests change → reinstall.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

# Sources (node_modules/dist/data excluded via .dockerignore).
COPY server ./server
COPY web ./web

# Cap the JS heap so the Vite build stays within this RAM-constrained host.
ENV NODE_OPTIONS=--max-old-space-size=768

# Build the SPA (→ web/dist) and compile the server (→ server/dist/src, with
# schema.sql copied beside the compiled migrate.js by the server build script).
RUN npm run build --workspace=web \
 && npm run build --workspace=server

# Drop dev dependencies from the (hoisted) node_modules for the runtime copy.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Damascus
WORKDIR /app

# Production deps (incl. the compiled native modules) + package.json markers that
# findServerRoot() walks to (nearest package.json above server/dist/src/app.js is
# server/package.json → WEB_DIST resolves to /app/web/dist) + built artifacts.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

# Data dir (db + blob storage) — bind-mounted in production; owned by the
# unprivileged runtime user so first-boot migrate/seed can write.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8084
# index.ts binds 127.0.0.1:8084 and installs SIGTERM/SIGINT graceful shutdown;
# exec-form CMD makes node PID 1 so `docker stop` delivers the signal directly.
CMD ["node", "server/dist/src/index.js"]
