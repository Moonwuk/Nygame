# Deploys the Void Dominion prototype multiplayer server — the in-memory proto
# server that hosts the prototype's own world AND serves the game HTML at `/`. One
# deploy gives a permanent URL: both players just open it (the connect overlay
# auto-fills the same-origin wss://), pick Azure / Crimson, and play. State is
# in-memory and the handshake is unauthenticated — this is for testing, not prod.
#
#   docker build -t void-dominion . && docker run -p 8788:8788 void-dominion
#   (or one-click via render.yaml — see docs/multiplayer.md)
#
# Multi-stage: a full node:22-slim builder installs deps and bakes the prototype HTML,
# then a distroless runtime carries only the installed /app and runs `node` as non-root.
# Distroless drops the entire Debian userland (perl, pam, bsdutils, gpg, apt, …) that the
# Node-only server never touches — that base-OS layer was the source of nearly all the
# `trivy image` MEDIUM CVEs (audit SD-5.1 / F-15). It has no shell or package manager,
# which also removes the npm/corepack tooling the old single-stage image had to delete.
#
# Runtime note: `prototype/netserver.mjs` transpiles the server with esbuild AT STARTUP
# (writing packages/server/dist/proto-server.mjs) and the server appends to playtest-logs/.
# Both dirs are pre-created in the builder and the whole tree is owned by the non-root
# user, so those writes succeed without a writable top-level /app.

# ---- Stage 1: build (full toolchain) ----
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable

# Install deps first (cached unless the lockfile/manifests change), then the source.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-core/package.json packages/shared-core/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/action-layer/package.json packages/action-layer/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run prototype # bake prototype/dist/void-dominion.html (served at /)

# Pre-create the two dirs the server writes at runtime so they exist (and, after the
# COPY --chown below, are owned by the non-root user) before the server starts:
# playtest-logs/ (event JSONL) and packages/server/dist/ (the startup esbuild bundle).
RUN mkdir -p playtest-logs packages/server/dist

# ---- Stage 2: runtime (distroless, no shell, non-root by default) ----
# The :nonroot tag runs as uid 65532. TODO: digest-pin this image (same hardening
# TODO as the scanner images in .github/workflows/security.yml).
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
# Bring the fully-installed app (source + node_modules incl. esbuild/ws/pg + baked HTML)
# and hand the whole tree to the non-root user so startup writes (esbuild bundle, logs)
# succeed. node_modules uses pnpm's relative symlink layout, so copying all of /app keeps
# the links valid.
COPY --from=build --chown=nonroot:nonroot /app /app
WORKDIR /app
USER nonroot

ENV HOST=0.0.0.0
ENV PORT=8788
EXPOSE 8788
# distroless/nodejs ENTRYPOINT is already ["/usr/bin/node"], so CMD is just the script.
# The proto-server reads $PORT (platforms like Render/Fly inject their own).
CMD ["prototype/netserver.mjs"]
