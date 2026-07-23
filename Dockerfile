# Deploys the Void Dominion prototype multiplayer server — the in-memory proto
# server that hosts the prototype's own world AND serves the game HTML (the player
# client at `/`, the dev client at `/dev` — see prototype/build.mjs). One
# deploy gives a permanent URL: both players just open it (the connect overlay
# auto-fills the same-origin wss://), pick Azure / Crimson, and play. State is
# in-memory and the handshake is unauthenticated — this is for testing, not prod.
#
#   docker build -t void-dominion . && docker run -p 8788:8788 void-dominion
#   (or one-click via render.yaml — see docs/multiplayer.md)
#
# Multi-stage: a full node:26-slim builder installs deps and bakes the prototype HTML,
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
# Both FROM lines are digest-pinned (audit F-15 / CWE-1357): a tag is mutable, a digest
# names the exact multi-arch index that was reviewed. To bump: re-resolve the tag's
# current digest (Docker Hub API `/v2/repositories/library/node/tags/26-slim` for node;
# `gcr.io/v2/distroless/nodejs22-debian13/manifests/nonroot` Docker-Content-Digest for
# distroless), update the digest + the refreshed-date below, and re-review .trivyignore.
# The dates live in these comments, not inline: a `#` after FROM's args would be parsed
# as extra arguments (Dockerfile comments only count at line start) and break the build.
# node:26-slim digest refreshed 2026-07.
FROM node:26-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583 AS build
WORKDIR /app
# Node ≥25 no longer ships corepack in the distribution (the 22→26 bump, PR #106,
# silently broke this line — caught by the SEC-1 blocking trivy-image gate), so install
# it explicitly (version-pinned; it then fetches the exact pnpm from `packageManager`).
RUN npm install -g corepack@0.35.0 && corepack enable

# Install deps first (cached unless the lockfile/manifests change), then the source.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-core/package.json packages/shared-core/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/action-layer/package.json packages/action-layer/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run prototype # bake dist/void-dominion{,-player}.html (player at /, dev at /dev)

# Pre-create the two dirs the server writes at runtime so they exist (and, after the
# COPY --chown below, are owned by the non-root user) before the server starts:
# playtest-logs/ (event JSONL) and packages/server/dist/ (the startup esbuild bundle).
RUN mkdir -p playtest-logs packages/server/dist

# ---- Stage 2: runtime (distroless, no shell, non-root by default) ----
# The :nonroot tag runs as uid 65532. Base is nodejs22-**debian13** (trixie): upstream
# deprecated the nodejs*-debian12 repos (their digests carry deprecated-public-image-*
# tags; last rebuild 2026-02), so debian12 is frozen with the libssl3/libc6 CVEs Trivy
# flags — debian13 is the actively rebuilt line with current trixie-security packages.
# Digest-pinned like the build stage (bump procedure in the Stage 1 comment);
# nodejs22-debian13:nonroot digest refreshed 2026-07.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50 AS runtime
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
# Liveness probe (Trivy DS026). Distroless has no shell or curl, so the probe is
# exec-form node hitting the server's own contentless GET /health. It reads $PORT the
# same way the server does, so a platform-injected PORT moves both together.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8788}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# distroless/nodejs ENTRYPOINT is already ["/nodejs/bin/node"], so CMD is just the script.
# The proto-server reads $PORT (platforms like Render/Fly inject their own).
CMD ["prototype/netserver.mjs"]
