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
#speedbar{position:fixed;right:14px;bottom:14px;z-index:24;display:flex;align-items:center;gap:4px;
  padding:5px 7px;background:rgba(3,12,16,.78);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 16px rgba(40,200,210,.10);}
#fps{position:fixed;top:50px;right:10px;z-index:25;pointer-events:none;
  font:700 10px ui-monospace,Menlo,monospace;color:var(--grn);opacity:.72;letter-spacing:.5px;
  text-shadow:0 0 6px rgba(0,0,0,.85);}
@media (max-width:720px){#fps{top:48px;}}
.spd button{min-width:30px;height:26px;padding:0 5px;border-radius:2px;cursor:pointer;font:11px ui-monospace,monospace;
  background:transparent;color:var(--cyan-dim);border:1px solid var(--line-hi);}
.spd button.on{background:rgba(53,214,230,.16);color:var(--cyan);border-color:var(--cyan);box-shadow:0 0 10px rgba(53,214,230,.4);}
.spd .sep{width:1px;height:18px;background:var(--line-hi);margin:0 4px;flex:0 0 auto;}
.spd button[data-fog]{min-width:40px;letter-spacing:1px;font-weight:700;}
#cmdbar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:26;display:none;align-items:center;
  gap:6px;padding:6px 8px;background:rgba(3,12,16,.88);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 22px rgba(40,200,210,.14);}
#cmdbar.show{display:flex;}
#cmdbar .cmdlabel{color:var(--cyan-dim);font-size:9px;letter-spacing:1.5px;padding-right:4px;white-space:nowrap;}
#cmdbar button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  min-width:50px;height:46px;padding:4px 8px;cursor:pointer;font:700 11px ui-monospace,monospace;
  letter-spacing:.5px;background:transparent;color:var(--cyan);border:1px solid var(--cyan-dim);border-radius:2px;}
#cmdbar button .ci{font-size:17px;line-height:1;}
#cmdbar button .cl{font-size:8px;letter-spacing:.6px;opacity:.82;text-transform:uppercase;}
#cmdbar button:hover:not(:disabled){background:rgba(53,214,230,.14);box-shadow:0 0 10px rgba(53,214,230,.35);}
#cmdbar button:disabled{opacity:.3;cursor:not-allowed;color:var(--dim);border-color:var(--line);}
#cmdbar button.on{background:rgba(53,214,230,.18);border-color:var(--cyan);}
#cmdbar button.danger{color:var(--red);border-color:#7a2a22;}
#cmdbar button.danger:hover:not(:disabled){background:rgba(255,90,77,.12);box-shadow:0 0 10px rgba(255,90,77,.3);}

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
.ptabs{display:flex;gap:6px;margin:10px 0 4px;flex-wrap:wrap;}
.ptab{cursor:pointer;background:rgba(53,214,230,.04);border:1px solid var(--line);color:var(--cyan-dim);
  padding:6px 10px;font:700 10px ui-monospace,monospace;letter-spacing:1px;text-transform:uppercase;border-radius:2px;}
.ptab b{margin-left:7px;color:var(--ink);}
.ptab.on{color:var(--cyan);border-color:var(--cyan);background:rgba(53,214,230,.14);box-shadow:0 0 12px rgba(53,214,230,.2);}
.asset-row{display:flex;align-items:center;gap:8px;margin:5px 0;min-height:24px;}
.asset-row b{min-width:120px;font-size:12px;}
.bicon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:7px;
  border:1px solid var(--line-hi);background:rgba(53,214,230,.07);color:var(--cyan);font-size:12px;}
.asset-row .bicon{margin-right:0;flex:0 0 auto;}
.conveyor{margin:6px 0 8px;padding:8px;border:1px solid var(--line);background:rgba(53,214,230,.04);}
.conveyor .current{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;font-size:11px;}
.conveyor .current span{color:var(--grn);letter-spacing:1.5px;font-size:9px;}
.conveyor .current.idle span{color:var(--dim);}
.conveyor .current em{color:var(--cyan-dim);font-style:normal;}
.conveyor .bar{height:4px;margin:7px 0;background:rgba(53,214,230,.08);overflow:hidden;}
.conveyor .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--grn),var(--cyan));box-shadow:0 0 10px rgba(125,240,208,.6);}
.conveyor .queue{display:flex;gap:6px;flex-wrap:wrap;}
.conveyor .queue span{border:1px solid var(--line);background:rgba(2,9,13,.55);padding:3px 6px;font-size:10px;color:var(--ink);}
.conveyor .queue em{font-style:normal;color:var(--grn-dim);margin-right:5px;}
.conveyor .queue.empty{color:var(--dim);font-size:10px;}
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

/* mobile chrome: hamburger + slide-in drawer. On desktop the drawer is a layout
   no-op (display:contents) so the rail / log / comms keep their fixed spots. */
#burger{display:none;flex:0 0 auto;width:42px;height:100%;border:0;border-right:1px solid var(--line);
  background:transparent;color:var(--cyan);font-size:18px;cursor:pointer;align-items:center;justify-content:center;}
#burger:active{background:rgba(53,214,230,.14);}
#topclock{display:none;flex:0 0 auto;padding:0 10px;color:var(--grn);font-size:11px;letter-spacing:.5px;
  white-space:nowrap;font-variant-numeric:tabular-nums;}
#scrim{display:none;position:fixed;inset:44px 0 0 0;z-index:34;background:rgba(1,5,9,.58);}
#drawer{display:contents;}
.rlabel{display:none;}

@media (max-width:720px){
  #top{height:44px;}
  .who{display:none;}
  .crest{padding:0 10px;}
  /* hamburger drops out of the top bar to a thumb-reachable button, lower-left */
  #burger{display:flex;position:fixed;left:8px;bottom:14px;top:auto;width:46px;height:46px;
    border:1px solid var(--line-hi);border-radius:4px;background:var(--glass);z-index:36;
    box-shadow:0 0 16px rgba(0,0,0,.5);}
  body.sheet-open #burger{display:none;}
  #topclock{display:block;}
  .res{padding:0 9px;gap:5px;}
  #devline{display:none;}

  /* left rail + event log + comms collapse into a slide-in drawer */
  #drawer{display:flex;flex-direction:column;position:fixed;left:0;top:44px;bottom:0;width:80vw;max-width:300px;
    z-index:35;transform:translateX(-100%);transition:transform .22s ease;overflow-y:auto;
    background:var(--glass);border-right:1px solid var(--cyan);box-shadow:0 0 40px rgba(0,0,0,.7);}
  body.drawer-open #drawer{transform:none;}
  body.drawer-open #scrim{display:block;}
  #drawer #rail{position:static;width:auto;flex-direction:column;align-items:stretch;gap:0;padding:6px 0;
    background:transparent;border:0;border-bottom:1px solid var(--line);}
  #drawer #rail button{width:100%;height:46px;display:flex;align-items:center;gap:14px;padding:0 18px;font-size:17px;}
  #drawer #rail button:active{background:rgba(53,214,230,.1);}
  #drawer #rail .rlabel{display:inline;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;}
  #drawer #rail .badge{left:auto;right:14px;top:50%;transform:translateY(-50%);}
  #drawer #log{position:static;left:auto;right:auto;bottom:auto;width:auto;height:150px;margin:0;border:0;
    border-bottom:1px solid var(--line);}
  #drawer #botleft{position:static;left:auto;bottom:auto;padding:12px 16px;}

  #side{right:0;left:0;bottom:0;top:auto;width:auto;max-height:50vh;z-index:28;clip-path:none;
    border-left:0;border-right:0;border-top:1px solid var(--cyan);}

  /* speed control sits at the bottom-right; it hides under the sheet, and a
     selection opens the sheet, so it never collides with the command bar */
  #speedbar{right:10px;bottom:12px;top:auto;padding:4px 6px;}
  body.sheet-open #speedbar{display:none;}

  #banner{font-size:16px;padding:14px 20px;letter-spacing:2px;}
  button.b{padding:9px 12px;font-size:12px;min-height:40px;}
  #cmdbar{bottom:10px;gap:5px;}
  #cmdbar .cmdlabel{display:none;}
  #cmdbar button{min-width:56px;height:52px;}
  #cmdbar button .ci{font-size:20px;}
  body.sheet-open #cmdbar{bottom:calc(50vh + 8px);}
}
@media (max-width:430px){
  .res .rv em{display:none;}
}
/* connect overlay — entry screen (single-player vs join a live session) */
#connect{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  padding:20px;background:radial-gradient(120% 100% at 50% 30%,rgba(4,20,28,.92),rgba(1,4,10,.97));
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#connect .cbox{width:min(420px,94vw);background:var(--glass);border:1px solid var(--line-hi);
  border-radius:12px;padding:22px 20px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#connect .ctitle{display:flex;align-items:center;gap:10px;font-size:18px;letter-spacing:3px;color:var(--cyan);}
#connect .ctitle .dia{width:12px;height:12px;transform:rotate(45deg);background:var(--cyan);box-shadow:0 0 10px var(--cyan);}
#connect .csub{margin:8px 0 18px;color:var(--dim);font-size:12px;line-height:1.5;}
#connect .cfield{display:block;margin:0 0 12px;color:var(--dim);font-size:11px;letter-spacing:1px;text-transform:uppercase;}
#connect .cfield input,#connect .cfield select{display:block;width:100%;margin-top:5px;padding:11px 12px;
  background:rgba(2,10,14,.9);border:1px solid var(--line-hi);border-radius:7px;color:var(--ink);
  font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3px;}
#connect .cfield input:focus,#connect .cfield select:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 0 2px rgba(53,214,230,.2);}
#connect .crow{display:flex;gap:10px;margin-top:18px;}
#connect .cbtn{flex:1;padding:13px 10px;border-radius:8px;border:1px solid var(--cyan);background:rgba(53,214,230,.12);
  color:var(--cyan);font:600 13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;min-height:46px;}
#connect .cbtn:active{background:rgba(53,214,230,.24);}
#connect .cbtn.ghost{border-color:var(--line-hi);background:transparent;color:var(--dim);}
#connect .cstat{margin-top:14px;min-height:16px;font-size:12px;color:var(--amber);text-align:center;}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<canvas id="map"></canvas>
<header id="top">
  <button id="burger" title="Menu" aria-label="Menu">☰</button>
  <div class="crest"><span class="dia"></span>
    <div class="who"><b>VOID DOMINION</b><span>SECTOR COMMAND</span></div>
  </div>
  <span id="topclock">Day 1</span>
  <div id="purse"></div>
</header>
<div id="devline">VOID CORE v0.1 · SESSION skirmish-1 · GRID sector-7 · <span id="clock">Day 1</span></div>
<div id="scrim"></div>
<div id="drawer">
  <nav id="rail">
    <button title="Dispatches">≡<span class="rlabel">Dispatches</span></button>
    <button title="Diplomacy (soon)">⬡<span class="rlabel">Diplomacy</span></button>
    <button title="Economy">¤<span class="rlabel">Economy</span></button>
    <button title="Military">△<span class="rlabel">Military</span></button>
    <button title="Army">▤<span class="rlabel">Army</span></button>
    <button title="Espionage (soon)">◎<span class="rlabel">Espionage</span></button>
    <button title="Markers">⚑<span class="rlabel">Markers</span></button>
    <button title="Research (soon)">✛<span class="rlabel">Research</span></button>
    <button title="Alerts">⚠<span class="rlabel">Alerts</span><span class="badge" id="alertbadge" style="display:none">0</span></button>
  </nav>
  <div id="log"></div>
  <footer id="botleft"><button class="chat" title="Comms">◈</button><span id="daytimer">Day 1</span></footer>
</div>
<aside id="side"></aside>
<div id="speedbar" class="spd">
  <button data-speed="0">‖</button><button data-speed="2" class="on">▶</button><button data-speed="6">▶▶</button>
  <span class="sep"></span><button data-fog title="Fog of war — dev preview (variant A)">FOG</button>
</div>
<div id="cmdbar"></div>
<div id="fps"></div>
<div id="banner"></div>
<div id="connect">
  <div class="cbox">
    <div class="ctitle"><span class="dia"></span><b>VOID DOMINION</b></div>
    <p class="csub">Join a live sector with a friend, or run a local skirmish against the AI.</p>
    <label class="cfield">Server
      <input id="csrv" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="wss://… or ws://host:8788">
    </label>
    <label class="cfield">Command
      <select id="cwho"><option value="p1">Azure Compact (you · green)</option><option value="p2">Crimson Hegemony (you · green)</option></select>
    </label>
    <div class="crow">
      <button id="cgo" class="cbtn">Connect</button>
      <button id="csolo" class="cbtn ghost">Single player</button>
    </div>
    <div id="cstatus" class="cstat"></div>
  </div>
</div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
