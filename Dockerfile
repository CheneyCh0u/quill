# Two-stage build:
#  1. builder — install full deps + compile apps/web → apps/web/dist
#  2. runtime — same Bun base, copy the build output + workspace sources;
#     `bun install --production` drops devDeps so the runtime layer is lean.
#
# Bun runs TypeScript directly so the server itself doesn't need compilation;
# only the browser bundle does. Everything is in one image — single container,
# single port. apps/desktop is intentionally excluded (electron-builder
# concerns, native deps) and isn't part of the server deployment.

# ---------- builder ----------
FROM oven/bun:1.3-alpine AS builder

WORKDIR /build

# Copy lockfiles + workspace package manifests first so the layer hashes
# only change when manifests do. The source COPY below invalidates a
# separate later layer.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/vault-adapter/package.json packages/vault-adapter/

RUN bun install --frozen-lockfile

# Now the source. Changing source code rebuilds from this layer onward,
# not from the install layer.
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages

# Build the browser bundle. The server runs from source, no compile step.
RUN bun --filter @quill/web build

# ---------- runtime ----------
FROM oven/bun:1.3-alpine AS runtime

# Drop root for runtime. The bun image already ships a non-root `bun` user.
WORKDIR /app

COPY --from=builder /build/package.json /build/bun.lock /build/tsconfig.base.json ./
COPY --from=builder /build/apps/server apps/server
COPY --from=builder /build/apps/web/dist apps/web/dist
COPY --from=builder /build/apps/web/package.json apps/web/package.json
# Desktop is excluded at runtime — server doesn't depend on it. But the
# lockfile records it as a workspace, so we ship its package.json to keep
# `bun install --frozen-lockfile` from complaining about a missing
# workspace member.
COPY --from=builder /build/apps/desktop/package.json apps/desktop/package.json
COPY --from=builder /build/packages packages

# Production install — drops devDependencies (vite, typescript, @types/*, etc.).
# Workspace packages (`@quill/*`) stay symlinked because they're listed as
# regular `dependencies` in each consuming package.json.
RUN bun install --frozen-lockfile --production

# Default config + data layout — bind-mount these from the host or via
# docker-compose volumes. The vault and config live OUTSIDE the image so
# you can rebuild without losing data.
ENV QUILL_CONFIG=/data/config.yaml
ENV QUILL_WEB_DIST=/app/apps/web/dist

# Drop to the non-root user that the base image ships.
USER bun

EXPOSE 3000

# Lightweight healthcheck — apps/server exposes /health without auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["bun", "run", "apps/server/src/index.ts"]
