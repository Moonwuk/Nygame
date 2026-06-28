# Deploys the Void Dominion prototype multiplayer server — the in-memory proto
# server that hosts the prototype's own world AND serves the game HTML at `/`. One
# deploy gives a permanent URL: both players just open it (the connect overlay
# auto-fills the same-origin wss://), pick Azure / Crimson, and play. State is
# in-memory and the handshake is unauthenticated — this is for testing, not prod.
#
#   docker build -t void-dominion . && docker run -p 8788:8788 void-dominion
#   (or one-click via render.yaml — see docs/multiplayer.md)
FROM node:22-slim
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

# Harden the shipped image (audit SD-5.1 / F-09). Drop build-only tooling the running
# server never uses (it runs `node` directly): the corepack/pnpm build cache and the
# base image's global npm — both carry CVEs that `trivy image` flags but that have no
# runtime path here. Then run as the built-in non-root `node` user; it must own /app
# because the server writes playtest-logs/ at startup.
RUN rm -rf /root/.cache /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && chown -R node:node /app
USER node

ENV HOST=0.0.0.0
ENV PORT=8788
EXPOSE 8788
# The proto-server reads $PORT (platforms like Render/Fly inject their own).
CMD ["node", "prototype/netserver.mjs"]
