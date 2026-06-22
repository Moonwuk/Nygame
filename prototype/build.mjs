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

// --- Iron Order / Bytro war-room chrome (responsive) over our galaxy map -----
const css = `
:root{
  --gold:#c9a24a;--gold-hi:#ecd591;--gold-dim:#8a6f2e;
  --bar-a:#2c2517;--bar-b:#140f08;--wood-a:#3c2d1c;--wood-b:#241a10;
  --panel-a:#2a2114;--panel-b:#181109;--ink:#ece6d8;--dim:#a59f8e;
  --up:#86cf57;--dn:#e07358;--p1:#2e86d8;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{height:100%;}
body{margin:0;overflow:hidden;background:#04060c;color:var(--ink);
  font:13px/1.4 system-ui,"Segoe UI",Roboto,sans-serif;user-select:none;
  overscroll-behavior:none;touch-action:none;}
#map{position:fixed;inset:0;z-index:0;display:block;touch-action:none;}

#top{position:fixed;top:0;left:0;right:0;height:52px;z-index:30;display:flex;align-items:center;
  background:linear-gradient(180deg,var(--bar-a),var(--bar-b));border-bottom:2px solid var(--gold);
  box-shadow:0 2px 12px rgba(0,0,0,.6);}
.crest{display:flex;align-items:center;gap:9px;padding:0 10px 0 12px;height:100%;flex:0 0 auto;}
.flag{width:30px;height:30px;border-radius:50%;flex:0 0 auto;
  background:radial-gradient(circle at 50% 38%,#56a0e8,#17579c);
  border:2px solid var(--gold);box-shadow:0 0 0 1px #000,0 1px 3px rgba(0,0,0,.6);}
.who{line-height:1.05;min-width:0;}
.who b{display:block;color:#fff;font-weight:800;font-size:12px;letter-spacing:.4px;white-space:nowrap;}
.who span{color:var(--gold-hi);font-size:10px;letter-spacing:.4px;white-space:nowrap;}
.who .xpbar{height:3px;background:#0a0805;border:1px solid #4a3a1a;margin-top:3px;width:116px;border-radius:2px;overflow:hidden;}
.who .xpbar i{display:block;height:100%;width:38%;background:linear-gradient(90deg,var(--gold),var(--gold-hi));}
.standing{display:flex;align-items:center;gap:8px;padding:0 10px;border-left:1px solid #3e3118;height:62%;flex:0 0 auto;}
.standing .rank{color:var(--gold-hi);font-weight:800;font-size:13px;}
.standing .alive{color:var(--ink);font-size:12px;opacity:.85;}
.standing .alive::before{content:"\\1F465 ";font-size:11px;}
#purse{display:flex;align-items:center;flex:1 1 auto;min-width:0;overflow-x:auto;
  border-left:1px solid #3e3118;height:100%;scrollbar-width:none;}
#purse::-webkit-scrollbar{display:none;}
.res{display:flex;align-items:center;gap:7px;padding:0 11px;height:100%;flex:0 0 auto;}
.res+.res{border-left:1px solid #2a2113;}
.res i{font-size:17px;line-height:1;font-style:normal;}
.res .rv{display:flex;flex-direction:column;line-height:1.04;}
.res .rv b{color:#fff;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;}
.res .rv em{font-style:normal;font-size:10px;font-weight:700;}
.res em.up{color:var(--up);}.res em.dn{color:var(--dn);}
.premium{display:flex;align-items:center;gap:5px;padding:0 10px;color:var(--gold-hi);font-weight:800;
  border-left:1px solid #3e3118;height:62%;flex:0 0 auto;}
.premium i{color:var(--gold);font-size:15px;font-style:normal;}
.shop{flex:0 0 auto;width:36px;height:100%;border:0;border-left:1px solid #3e3118;cursor:pointer;
  background:linear-gradient(180deg,#3a2f17,#211808);color:var(--gold-hi);font-size:16px;}
.spd{display:flex;align-items:center;gap:3px;padding:0 8px;flex:0 0 auto;border-left:1px solid #3e3118;height:100%;}
.spd button{width:30px;height:28px;border-radius:3px;cursor:pointer;font-size:13px;
  background:linear-gradient(180deg,#39301a,#221a0c);color:var(--gold-hi);border:1px solid #50401f;}
.spd button.on{background:linear-gradient(180deg,var(--gold-hi),var(--gold));color:#1c1405;border-color:var(--gold-hi);}

#devline{position:fixed;top:52px;left:0;right:0;height:19px;z-index:24;display:flex;align-items:center;gap:14px;
  padding:0 12px;background:rgba(6,8,6,.55);color:#5f7d52;font:11px/1 ui-monospace,Menlo,monospace;
  white-space:nowrap;overflow:hidden;}
#devline #clock{color:#9bbb86;}

#rail{position:fixed;left:0;top:71px;bottom:0;width:46px;z-index:24;display:flex;flex-direction:column;
  align-items:center;gap:1px;padding-top:5px;
  background:repeating-linear-gradient(180deg,rgba(0,0,0,.20) 0 2px,rgba(255,255,255,.018) 2px 5px),
    linear-gradient(90deg,var(--wood-a),var(--wood-b));
  border-right:1px solid #160f08;box-shadow:3px 0 12px rgba(0,0,0,.5);}
#rail button{position:relative;width:46px;height:42px;background:transparent;border:0;cursor:pointer;
  font-size:18px;opacity:.92;filter:drop-shadow(0 1px 1px rgba(0,0,0,.7));}
#rail button:hover{background:rgba(201,162,74,.13);}
#rail .badge{position:absolute;right:5px;top:5px;min-width:15px;height:15px;border-radius:8px;
  background:#d9772a;color:#1a0f04;font:800 9px/15px system-ui;text-align:center;box-shadow:0 0 0 1px rgba(0,0,0,.5);}

#side{position:fixed;right:14px;top:84px;width:330px;max-height:calc(100vh - 170px);overflow:auto;z-index:20;
  display:none;padding:12px 14px;border-radius:3px;touch-action:pan-y;
  background:linear-gradient(180deg,var(--panel-a),var(--panel-b));
  border:1px solid #5a4622;border-top:2px solid var(--gold);box-shadow:0 12px 30px rgba(0,0,0,.6);}
#side h3{margin:0 0 8px;font-size:15px;font-weight:800;letter-spacing:1px;text-transform:uppercase;
  color:var(--gold-hi);border-bottom:1px solid #463719;padding-bottom:6px;}
#side .sec{margin:13px 0 5px;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--gold-dim);
  border-bottom:1px solid #3a2d15;padding-bottom:3px;}
#side .row{margin:3px 0;}
#side .dim{color:var(--dim);font-size:12px;}
#side b{color:#fff;}
#side .hint{color:#cdbd97;font-size:12px;margin-top:8px;line-height:1.5;}
button.b{background:linear-gradient(180deg,#3a2e19,#241a0d);color:#e7dcc4;border:1px solid #5a4622;border-radius:2px;
  padding:5px 10px;margin:2px 3px 2px 0;cursor:pointer;font:700 12px system-ui;letter-spacing:.2px;}
button.b:hover:not(:disabled){border-color:var(--gold);color:var(--gold-hi);}
button.b:disabled{opacity:.4;cursor:not-allowed;}

#botleft{position:fixed;left:6px;bottom:8px;z-index:24;display:flex;align-items:center;gap:8px;}
.chat{width:44px;height:44px;border-radius:3px;cursor:pointer;font-size:20px;
  background:linear-gradient(180deg,var(--wood-a),var(--wood-b));border:1px solid #5a4622;color:#e3d2a4;}
#daytimer{color:#d6c69d;font-size:12px;background:rgba(8,6,3,.6);padding:6px 11px;border:1px solid #463719;
  border-radius:3px;white-space:nowrap;}
#log{position:fixed;left:60px;bottom:60px;width:360px;height:96px;z-index:20;overflow:auto;touch-action:pan-y;
  padding:7px 11px;border-radius:3px;background:rgba(16,12,7,.78);border:1px solid #3a2d15;
  font:11px/1.5 ui-monospace,Menlo,monospace;color:#b6a98c;scrollbar-width:thin;}
#log div::before{content:"— ";color:var(--gold-dim);}

#banner{display:none;position:fixed;inset:0;margin:auto;height:fit-content;width:fit-content;z-index:40;
  padding:20px 36px;border-radius:4px;font-size:22px;font-weight:800;letter-spacing:1.5px;text-align:center;
  background:rgba(10,8,4,.95);border:2px solid var(--gold);color:var(--gold-hi);box-shadow:0 0 50px rgba(0,0,0,.7);}

@media (max-width:720px){
  #top{height:48px;}
  .who,.standing,.premium{display:none;}
  .crest{padding:0 6px;}
  #purse{border-left:0;}
  .res{padding:0 9px;gap:5px;}
  .res i{font-size:15px;}
  .shop{display:none;}
  #devline{display:none;}
  #rail{top:48px;width:42px;}
  #rail button{height:40px;font-size:17px;}
  #side{right:0;left:0;bottom:0;top:auto;width:auto;max-height:56vh;border-radius:10px 10px 0 0;border-top:3px solid var(--gold);}
  #log{left:50px;right:8px;width:auto;bottom:56px;height:70px;}
  #botleft{left:48px;bottom:6px;}
  .chat{width:40px;height:40px;}
  #banner{font-size:18px;padding:16px 22px;}
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
  <div class="crest">
    <div class="flag"></div>
    <div class="who"><b>COMMANDER</b><span>Azure Compact</span><div class="xpbar"><i></i></div></div>
  </div>
  <div class="standing"><span class="rank">1ST</span><span class="alive">2</span></div>
  <div id="purse"></div>
  <div class="premium"><i>◆</i>—</div>
  <button class="shop" title="Store">🛒</button>
  <div class="spd">
    <button data-speed="0">⏸</button><button data-speed="2" class="on">▶</button><button data-speed="6">⏩</button>
  </div>
</header>
<div id="devline">VOID CORE v0.1 · SESSION skirmish-1 · MAP sector-7 · <span id="clock">Day 1</span></div>
<nav id="rail">
  <button title="Dispatches">📰</button>
  <button title="Diplomacy (soon)">🕊️</button>
  <button title="Economy">⚖️</button>
  <button title="Military">⚔️</button>
  <button title="Army">🪖</button>
  <button title="Espionage (soon)">🕵️</button>
  <button title="Markers">🚩</button>
  <button title="Research (soon)">🔬</button>
  <button title="Alerts">⚠️<span class="badge" id="alertbadge" style="display:none">0</span></button>
</nav>
<aside id="side"></aside>
<footer id="botleft"><button class="chat" title="Comms">💬</button><span id="daytimer">Day 1</span></footer>
<div id="log"></div>
<div id="banner"></div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
