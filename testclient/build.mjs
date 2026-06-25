// Bundles the multiplayer test client into a single self-contained HTML you can
// open straight from disk (file://) — it talks to `pnpm dev:server` over ws://.
// Run from the repo root: node testclient/build.mjs  (or: pnpm dev:client)
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['testclient/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
});
const js = res.outputFiles[0].text;

const css = `
:root{--bg:#02080e;--panel:rgba(3,14,18,.85);--ink:#bfeee6;--dim:#5f8f8c;--cyan:#35d6e6;
  --grn:#5ff0c0;--red:#ff5a4d;--amber:#ffb43a;--line:#0e3b40;}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;background:radial-gradient(120% 100% at 50% 0%,#04141c,#01040a);
  color:var(--ink);font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:10px;}
h3{margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--grn);}
#bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;background:var(--panel);
  border:1px solid var(--line);border-radius:4px;margin-bottom:10px;}
#bar label{font-size:11px;color:var(--dim);}
#bar input{background:#021016;border:1px solid var(--line);color:var(--ink);padding:5px 7px;border-radius:3px;
  font:inherit;width:170px;}
#bar input[size]{width:64px;}
#bar button{background:transparent;border:1px solid var(--cyan);color:var(--cyan);padding:6px 12px;
  border-radius:3px;cursor:pointer;font:700 12px ui-monospace,monospace;}
#bar button:active{background:rgba(53,214,230,.16);}
#status{margin-left:auto;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:3px;border:1px solid var(--line);}
#status.open{color:var(--grn);border-color:var(--grn);}
#status.connecting{color:var(--amber);border-color:var(--amber);}
#status.closed{color:var(--red);border-color:#7a2a22;}
#seq{margin-left:8px;color:var(--dim);font-size:11px;}
#state{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
#state .col{flex:1 1 200px;min-width:180px;background:var(--panel);border:1px solid var(--line);
  border-radius:4px;padding:9px 11px;}
#state .col div{margin:2px 0;}
.mine{color:var(--grn);}
.dim{color:var(--dim);}
em{color:var(--amber);font-style:normal;}
#actions{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:9px 11px;margin-bottom:10px;}
.fa{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:5px 0;}
.fa b{min-width:64px;}
.fa button,.fa select{background:transparent;border:1px solid var(--cyan);color:var(--cyan);
  padding:6px 10px;border-radius:3px;cursor:pointer;font:700 12px ui-monospace,monospace;min-height:38px;}
.fa button:active{background:rgba(53,214,230,.16);}
#logwrap{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:9px 11px;}
#log{max-height:30vh;overflow:auto;font-size:11px;color:var(--dim);}
#log div{padding:1px 0;border-bottom:1px solid rgba(14,59,64,.4);}
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Void Dominion — MP Test Client</title><style>${css}</style></head><body>
<div id="bar">
  <label>Server <input id="base" value="ws://127.0.0.1:8787"></label>
  <label>Match <input id="match" value="dev" size="6"></label>
  <label>Player <input id="player" value="green" size="6"></label>
  <button id="connect">Connect</button>
  <button id="disconnect">Disconnect</button>
  <span id="status">CLOSED</span><span id="seq"></span>
</div>
<div id="state"></div>
<div id="actions"></div>
<div id="logwrap"><h3>Log</h3><div id="log"></div></div>
<script>${js}</script>
</body></html>`;

mkdirSync('testclient/dist', { recursive: true });
writeFileSync('testclient/dist/test-client.html', html);
console.log(`wrote testclient/dist/test-client.html (${Math.round(html.length / 1024)} KB)`);
