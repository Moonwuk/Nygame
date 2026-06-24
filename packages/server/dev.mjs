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
  // `ws` ships its own optional native bits; leave it for Node to resolve at
  // runtime. Everything else (incl. the @void/shared-core TS source) is bundled.
  external: ['ws'],
});

await import(pathToFileURL(outfile).href);
