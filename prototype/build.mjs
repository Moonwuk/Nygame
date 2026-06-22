// Bundles the prototype into a single self-contained HTML file you can open
// straight from disk (no server). Run: node prototype/build.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['prototype/src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
});
const js = res.outputFiles[0].text;

// --- Tactical command-console chrome (DEFCON vibe): vector/wireframe, neon
// --- glow, monospace, minimalist HUD on near-black. Responsive. -------------
const css = `
:root{
  --cyan:#35d6e6;--cyan-dim:#1c6f78;
  --grn:#5ff0c0;--grn-dim:#2b7a66;
  --red:#ff5a4d;--amber:#ffb43a;
  --ink:#bfeee6;--dim:#5f8f8c;
  --line:#0e3b40;--line-hi:#1d6b70;
  --glass:rgba(3,14,18,.82);
  --up:#5ff0a8;--dn:#ff7a6a;--p1:#35d6e6;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{height:100%;}
body{margin:0;overflow:hidden;color:var(--ink);
  font:12px/1.45 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;letter-spacing:.2px;
  user-select:none;overscroll-behavior:none;touch-action:none;
  background:radial-gradient(125% 105% at 50% 38%,#04141c 0%,#02080e 58%,#01040a 100%);}
/* CRT scanlines + faint vignette over the map, beneath the HUD */
body::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;mix-blend-mode:multiply;opacity:.5;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.16) 2px 3px);}
#map{position:fixed;inset:0;z-index:0;display:block;touch-action:none;}

#top{position:fixed;top:0;left:0;right:0;height:46px;z-index:30;display:flex;align-items:center;
  background:linear-gradient(180deg,rgba(3,13,18,.94),rgba(2,8,12,.82));border-bottom:1px solid var(--line-hi);
  box-shadow:0 0 22px rgba(40,200,210,.10),inset 0 -1px 0 rgba(53,214,230,.28);}
.crest{display:flex;align-items:center;gap:10px;padding:0 14px;height:100%;flex:0 0 auto;}
.dia{width:15px;height:15px;transform:rotate(45deg);flex:0 0 auto;border:1.5px solid var(--cyan);
  box-shadow:0 0 9px rgba(53,214,230,.7),inset 0 0 5px rgba(53,214,230,.35);}
.who{line-height:1.1;min-width:0;}
.who b{display:block;color:#eafffb;font-weight:700;font-size:12px;letter-spacing:2px;white-space:nowrap;}
.who span{color:var(--cyan-dim);font-size:9px;letter-spacing:2.5px;white-space:nowrap;}
#purse{display:flex;align-items:center;flex:1 1 auto;min-width:0;overflow-x:auto;height:100%;margin:0 4px;
  border-left:1px solid var(--line);border-right:1px solid var(--line);scrollbar-width:none;}
#purse::-webkit-scrollbar{display:none;}
.res{display:flex;align-items:center;gap:7px;padding:0 12px;height:100%;flex:0 0 auto;}
.res+.res{border-left:1px solid var(--line);}
.res i{font-style:normal;font-size:9px;letter-spacing:1.5px;color:var(--cyan-dim);}
.res .rv{display:flex;flex-direction:column;line-height:1.05;}
.res .rv b{color:#eafffb;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;}
.res .rv em{font-style:normal;font-size:9px;font-weight:700;}
.res em.up{color:var(--up);}.res em.dn{color:var(--dn);}
.spd{display:flex;align-items:center;gap:4px;padding:0 10px;flex:0 0 auto;height:100%;}
.spd button{min-width:30px;height:26px;padding:0 5px;border-radius:2px;cursor:pointer;font:11px ui-monospace,monospace;
  background:transparent;color:var(--cyan-dim);border:1px solid var(--line-hi);}
.spd button.on{background:rgba(53,214,230,.16);color:var(--cyan);border-color:var(--cyan);box-shadow:0 0 10px rgba(53,214,230,.4);}

#devline{position:fixed;top:46px;left:0;right:0;height:18px;z-index:24;display:flex;align-items:center;gap:12px;
  padding:0 14px;background:rgba(2,8,11,.5);color:var(--cyan-dim);font-size:10px;letter-spacing:1px;
  white-space:nowrap;overflow:hidden;border-bottom:1px solid rgba(14,59,64,.5);}
#devline #clock{color:var(--grn);}

#rail{position:fixed;left:0;top:66px;bottom:0;width:44px;z-index:24;display:flex;flex-direction:column;
  align-items:center;gap:2px;padding-top:6px;background:rgba(2,9,13,.6);border-right:1px solid var(--line);}
#rail button{position:relative;width:44px;height:40px;background:transparent;border:0;cursor:pointer;
  font-size:16px;color:var(--cyan-dim);}
#rail button:hover{color:var(--cyan);background:rgba(53,214,230,.08);text-shadow:0 0 8px rgba(53,214,230,.6);}
#rail .badge{position:absolute;right:5px;top:4px;min-width:15px;height:15px;border-radius:8px;
  background:var(--red);color:#180605;font:700 9px/15px ui-monospace,monospace;text-align:center;
  box-shadow:0 0 8px rgba(255,90,77,.7);}

#side{position:fixed;left:58px;right:14px;bottom:56px;top:auto;width:auto;max-height:34vh;overflow:auto;z-index:20;
  display:none;padding:13px 15px;touch-action:pan-y;background:var(--glass);border:1px solid var(--line-hi);
  box-shadow:0 0 26px rgba(0,0,0,.6),0 0 0 1px rgba(53,214,230,.08),inset 0 0 30px rgba(53,214,230,.04);
  clip-path:polygon(0 9px,9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%);}
#side .sec{margin:14px 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--grn-dim);
  border-bottom:1px solid var(--line);padding-bottom:4px;}
#side .row{margin:4px 0;}
#side .dim{color:var(--dim);}
#side b{color:#eafffb;}
#side .hint{color:#74b0aa;font-size:11px;margin-top:9px;line-height:1.55;border-left:2px solid var(--line-hi);padding-left:8px;}
.phead{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding-bottom:10px;border-bottom:1px solid var(--line-hi);}
.pflag{width:14px;height:14px;transform:rotate(45deg);flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(0,0,0,.4);}
.ptitle{flex:1 1 auto;min-width:0;}
.ptitle b{display:block;color:#eafffb;font-size:15px;font-weight:700;letter-spacing:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ptitle span{color:var(--cyan-dim);font-size:10px;letter-spacing:1px;}
.pclose{flex:0 0 auto;width:26px;height:26px;cursor:pointer;font-size:11px;border-radius:2px;
  background:transparent;border:1px solid #7a221c;color:var(--red);}
.pstats{display:flex;gap:7px;flex-wrap:wrap;margin:2px 0 4px;}
.pstats span{background:rgba(53,214,230,.06);border:1px solid var(--line);padding:4px 9px;font-size:11px;color:var(--ink);}
.bicon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:7px;
  border:1px solid var(--line-hi);background:rgba(53,214,230,.07);color:var(--cyan);font-size:12px;}
button.b{background:transparent;color:var(--cyan);border:1px solid var(--cyan-dim);border-radius:2px;
  padding:5px 10px;margin:3px 4px 2px 0;cursor:pointer;font:700 11px ui-monospace,monospace;letter-spacing:.4px;}
button.b:hover:not(:disabled){background:rgba(53,214,230,.14);box-shadow:0 0 10px rgba(53,214,230,.35);}
button.b:disabled{opacity:.32;cursor:not-allowed;color:var(--dim);border-color:var(--line);}

#botleft{position:fixed;left:6px;bottom:8px;z-index:24;display:flex;align-items:center;gap:8px;}
.chat{width:40px;height:40px;cursor:pointer;font-size:16px;border-radius:2px;
  background:rgba(2,9,13,.7);border:1px solid var(--line-hi);color:var(--cyan-dim);}
#daytimer{color:var(--dim);font-size:11px;background:rgba(2,9,13,.6);padding:6px 11px;border:1px solid var(--line);
  border-radius:2px;white-space:nowrap;letter-spacing:.5px;}
#log{position:fixed;left:58px;bottom:58px;width:360px;height:92px;z-index:20;overflow:auto;touch-action:pan-y;
  padding:7px 11px;background:rgba(2,9,13,.72);border:1px solid var(--line);border-left:2px solid var(--grn-dim);
  font:11px/1.55 ui-monospace,Menlo,monospace;color:#73b6a2;scrollbar-width:thin;}
#log div::before{content:"> ";color:var(--grn-dim);}
body.sheet-open #log{display:none;}

#banner{display:none;position:fixed;inset:0;margin:auto;height:fit-content;width:fit-content;z-index:40;
  padding:18px 34px;font-size:20px;font-weight:700;letter-spacing:3px;text-align:center;text-transform:uppercase;
  background:rgba(2,9,13,.94);border:1px solid var(--cyan);color:var(--cyan);
  box-shadow:0 0 40px rgba(53,214,230,.25),inset 0 0 30px rgba(53,214,230,.06);
  clip-path:polygon(0 12px,12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%);}

@media (max-width:720px){
  #top{height:44px;}
  .who{display:none;}
  .crest{padding:0 10px;}
  .res{padding:0 9px;gap:5px;}
  #devline{display:none;}
  #rail{top:44px;width:40px;}
  #rail button{height:38px;font-size:15px;}
  #side{right:0;left:0;bottom:0;top:auto;width:auto;max-height:56vh;z-index:28;clip-path:none;
    border-left:0;border-right:0;border-top:1px solid var(--cyan);}
  #log{left:48px;right:8px;width:auto;bottom:54px;height:66px;}
  #botleft{left:46px;bottom:6px;}
  .chat{width:38px;height:38px;}
  #banner{font-size:16px;padding:14px 20px;letter-spacing:2px;}
  body.sheet-open #log,body.sheet-open #botleft{display:none;}
  button.b{padding:7px 12px;font-size:12px;}
}
@media (max-width:430px){
  .res .rv em{display:none;}
  #log{display:none;}
}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<canvas id="map"></canvas>
<header id="top">
  <div class="crest"><span class="dia"></span>
    <div class="who"><b>VOID DOMINION</b><span>SECTOR COMMAND</span></div>
  </div>
  <div id="purse"></div>
  <div class="spd">
    <button data-speed="0">‖</button><button data-speed="2" class="on">▶</button><button data-speed="6">▶▶</button>
  </div>
</header>
<div id="devline">VOID CORE v0.1 · SESSION skirmish-1 · GRID sector-7 · <span id="clock">Day 1</span></div>
<nav id="rail">
  <button title="Dispatches">≡</button>
  <button title="Diplomacy (soon)">⬡</button>
  <button title="Economy">¤</button>
  <button title="Military">△</button>
  <button title="Army">▤</button>
  <button title="Espionage (soon)">◎</button>
  <button title="Markers">⚑</button>
  <button title="Research (soon)">✛</button>
  <button title="Alerts">⚠<span class="badge" id="alertbadge" style="display:none">0</span></button>
</nav>
<aside id="side"></aside>
<footer id="botleft"><button class="chat" title="Comms">◈</button><span id="daytimer">Day 1</span></footer>
<div id="log"></div>
<div id="banner"></div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
