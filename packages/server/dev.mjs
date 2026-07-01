// Transpiles + bundles the dev server (TypeScript, importing the workspace's
// `@void/shared-core` TS source) and runs it. Mirrors prototype/build.mjs so we
// reuse the repo's existing esbuild — no extra runtime dependency.
// Run from the repo root: node packages/server/dev.mjs  (or: pnpm dev:server)
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const outfile = 'packages/server/dist/dev-server.mjs';
mkdirSync('packages/server/dist', { recursive: true });

await build({
  entryPoints: ['packages/server/src/main.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `ws`, `pg` and `fastify` ship native/optional bits and dynamic requires (fastify's
  // avvio/find-my-way/pino); leave them for Node to resolve at runtime. Everything else
  // (incl. the @void/shared-core TS source) is bundled. `pg` only loads with DATABASE_URL.
  external: ['ws', 'pg', 'fastify'],
});

await import(pathToFileURL(outfile).href);
