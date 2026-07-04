// Transpiles + bundles the prototype dev server (TypeScript, importing the
// workspace's @void/server + @void/shared-core TS source and the prototype's own
// game wiring) and runs it. Mirrors prototype/build.mjs and packages/server/dev.mjs
// so we reuse the repo's existing esbuild — no extra runtime dependency.
// Run from the repo root: node prototype/netserver.mjs  (or: pnpm dev:proto-server)
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Output next to the other server bundle: `ws` is left external (below) and is a
// dependency of @void/server, so the bundle must sit where pnpm can resolve `ws`
// at runtime — packages/server/dist, not prototype/dist.
const outfile = 'packages/server/dist/proto-server.mjs';
mkdirSync('packages/server/dist', { recursive: true });

await build({
  entryPoints: ['prototype/netserver.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `ws`, `pg` and `fastify` ship native/optional bits and dynamic requires (fastify's
  // avvio/find-my-way/pino); leave them for Node to resolve at runtime. Everything else
  // (the @void/* TS source + game) is bundled — mirrors packages/server/dev.mjs.
  external: ['ws', 'pg', 'fastify'],
});

await import(pathToFileURL(outfile).href);
