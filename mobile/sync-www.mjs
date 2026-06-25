// Builds the prototype (single self-contained HTML) and stages it as the
// Capacitor web root (mobile/www/index.html). Paths are relative to this file,
// so it works regardless of the current working directory.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = fileURLToPath(new URL('../prototype/dist/void-dominion.html', import.meta.url));
const wwwDir = fileURLToPath(new URL('./www/', import.meta.url));
const dest = fileURLToPath(new URL('./www/index.html', import.meta.url));

execSync('node prototype/build.mjs', { cwd: root, stdio: 'inherit' });
mkdirSync(wwwDir, { recursive: true });
copyFileSync(src, dest);
console.log('staged mobile/www/index.html from the prototype build');
