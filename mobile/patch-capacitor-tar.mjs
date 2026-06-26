// Make @capacitor/cli@6 work with the security-pinned node-tar 7.
//
// `package.json` overrides node-tar to ^7.5.17 to clear the GHSA path-traversal
// advisories (tar <=7.5.15). But @capacitor/cli@6's template.js does
// `tar_1.default.extract(...)`, and tar 7's CJS interop leaves `.default`
// undefined (it exports named functions only), so `cap add/sync` crashes with
// "Cannot read properties of undefined (reading 'extract')". Rewrite that one
// call to `(tar_1.default || tar_1).extract`, which resolves under BOTH tar 6 and
// 7. Runs as mobile's postinstall so CI and local both get a working build while
// keeping the tar fix. Idempotent; a no-op if the CLI ever ships a tar-7-safe import.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const file = 'node_modules/@capacitor/cli/dist/util/template.js';
if (existsSync(file)) {
  const src = readFileSync(file, 'utf8');
  const patched = src.replace(/tar_1\.default\.extract/g, '(tar_1.default || tar_1).extract');
  if (patched !== src) {
    writeFileSync(file, patched);
    console.log('[patch] @capacitor/cli template.js → node-tar 7 interop fix applied');
  }
}
