// Bundles the prototype into self-contained HTML files you can open straight
// from disk (no server). Run: node prototype/build.mjs
// Two artifacts from one source (the `__PLAYER_BUILD__` define, see main.ts):
//   dist/void-dominion.html        — dev client, today's full behavior;
//   dist/void-dominion-player.html — player client: test mode, single-player skirmish
//     and time-acceleration controls are compiled out of the JS, and the matching
//     markup (fenced with <!--dev-only--> … <!--/dev-only--> below) is stripped.
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const bundle = async (playerBuild) => {
  const res = await build({
    entryPoints: ['prototype/src/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    write: false,
    define: { __PLAYER_BUILD__: String(playerBuild) },
  });
  return res.outputFiles[0].text;
};

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

/* themed scrollbars — angular neon thumb on a dark grid track, in the HUD's tactical key.
   Firefox gets the colour pair; WebKit gets the full glow/gradient treatment. */
*{scrollbar-width:thin;scrollbar-color:var(--cyan-dim) rgba(2,9,13,.5);}
::-webkit-scrollbar{width:10px;height:10px;}
::-webkit-scrollbar-track{background:rgba(2,9,13,.55);
  box-shadow:inset 1px 0 0 var(--line),inset -1px 0 0 var(--line);}
::-webkit-scrollbar-thumb{border-radius:1px;border:1px solid var(--cyan-dim);
  background:linear-gradient(180deg,rgba(53,214,230,.5),rgba(28,111,120,.6));
  box-shadow:inset 0 0 6px rgba(53,214,230,.3),0 0 4px rgba(53,214,230,.15);}
::-webkit-scrollbar-thumb:hover{border-color:var(--cyan);
  background:linear-gradient(180deg,var(--cyan),var(--cyan-dim));
  box-shadow:0 0 10px rgba(53,214,230,.6),inset 0 0 6px rgba(53,214,230,.45);}
::-webkit-scrollbar-thumb:active{background:linear-gradient(180deg,#8ff4fa,var(--cyan));}
::-webkit-scrollbar-corner{background:transparent;}

#top{position:fixed;top:0;left:0;right:0;height:46px;z-index:30;display:flex;align-items:center;
  background:linear-gradient(180deg,rgba(3,13,18,.94),rgba(2,8,12,.82));border-bottom:1px solid var(--line-hi);
  box-shadow:0 0 22px rgba(40,200,210,.10),inset 0 -1px 0 rgba(53,214,230,.28);}
.crest{display:flex;align-items:center;gap:10px;padding:0 14px;height:100%;flex:0 0 auto;cursor:pointer;}
.crest:active{background:rgba(53,214,230,.12);}
.dia{width:15px;height:15px;transform:rotate(45deg);flex:0 0 auto;border:1.5px solid var(--cyan);
  box-shadow:0 0 9px rgba(53,214,230,.7),inset 0 0 5px rgba(53,214,230,.35);}
.who{line-height:1.1;min-width:0;}
.who b{display:block;color:#eafffb;font-weight:700;font-size:12px;letter-spacing:2px;white-space:nowrap;}
.who span{color:var(--cyan-dim);font-size:9px;letter-spacing:2.5px;white-space:nowrap;}
/* the five currencies always fit the bar — no scroll. Chips share the width and shrink
   together (flex:1 1 0; min-width:0) so the row scales down instead of overflowing. Each
   chip = a small coin-icon + tabular amount + flow, divided by a faint hairline. */
#purse{display:flex;align-items:center;flex:1 1 auto;min-width:0;overflow:hidden;height:100%;margin:0 2px 0 4px;
  border-left:1px solid var(--line);}
.res{display:flex;align-items:center;justify-content:center;gap:5px;padding:0 7px;height:100%;flex:1 1 0;min-width:0;
  position:relative;overflow:hidden;}
.res + .res::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:1px;height:20px;
  background:linear-gradient(180deg,transparent,rgba(53,214,230,.20),transparent);}
/* amount + flow share one "value line" (.rv); the amount owns the room (flex:0 0 auto),
   the flow rate clips first. On phones the chip stacks the icon OVER this value line. */
.rv{display:flex;align-items:baseline;justify-content:center;gap:3px;min-width:0;overflow:hidden;flex:0 1 auto;}
.res em{font:9px ui-monospace,monospace;font-style:normal;white-space:nowrap;
  flex:0 1 auto;min-width:0;overflow:hidden;}
.res em.up{color:var(--grn,#5ff0a8);}
.res em.dn{color:var(--red,#ff5a4d);}
.res.dead{opacity:.34;}
.res i{flex:0 0 auto;width:20px;height:20px;display:grid;place-items:center;border-radius:6px;
  font-style:normal;font-size:12px;line-height:1;color:var(--cyan);font-variant-emoji:text;
  background:rgba(53,214,230,.08);box-shadow:inset 0 0 0 1px rgba(53,214,230,.14);
  text-shadow:0 0 6px rgba(53,214,230,.35);}
.res.dead i{background:rgba(120,140,150,.05);box-shadow:inset 0 0 0 1px rgba(120,140,150,.14);
  color:var(--dim);text-shadow:none;}
.res.short i{color:var(--red,#ff5a4d);box-shadow:inset 0 0 0 1px rgba(255,90,77,.4);text-shadow:0 0 6px rgba(255,90,77,.5);}
.res b{color:#eafffb;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;
  white-space:nowrap;flex:0 0 auto;}
/* phones hide the flow digits — a NEGATIVE net income paints the stock itself red */
.res b.neg{color:var(--red,#ff5a4d);text-shadow:0 0 6px rgba(255,90,77,.35);}
/* player emblem — a console crest the player picks in the main menu (hub), worn in the
   TOP-LEFT corner. Tap → player dossier (bubbles to the .crest handler). */
#crestmark{width:32px;height:32px;border-radius:9px;flex:0 0 auto;cursor:pointer;padding:0;
  display:grid;place-items:center;font-size:17px;color:var(--cyan);font-variant-emoji:text;
  background:rgba(3,12,16,.7);border:1px solid var(--line-hi);
  box-shadow:inset 0 0 10px rgba(53,214,230,.14),0 0 10px rgba(53,214,230,.12);
  text-shadow:0 0 8px rgba(53,214,230,.5);}
#crestmark:hover,#crestmark:active{background:rgba(53,214,230,.16);}
/* donate currency (Суверены ◆, gold) sits UNDER the resource bar on the status line,
   pushed to the right end — so the resource chips get the full top-bar width for numbers. */
#devline .dl-donate{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:5px;
  padding:2px 9px;border-radius:11px;color:#fff2cf;font-weight:800;font-size:12px;line-height:1;
  letter-spacing:.3px;font-variant-numeric:tabular-nums;
  background:linear-gradient(180deg,rgba(255,206,92,.20),rgba(240,170,40,.10));border:1px solid rgba(255,208,96,.55);
  box-shadow:0 0 12px rgba(255,198,72,.30),inset 0 0 6px rgba(255,214,120,.16);
  animation:donatePulse 2.8s ease-in-out infinite;white-space:nowrap;}
#devline .dl-donate i{color:#ffd45e;text-shadow:0 0 9px rgba(255,212,94,.85);font-style:normal;font-size:14px;}
@keyframes donatePulse{
  0%,100%{box-shadow:0 0 10px rgba(255,198,72,.30),inset 0 0 7px rgba(255,214,120,.16);}
  50%{box-shadow:0 0 22px rgba(255,205,90,.7),inset 0 0 9px rgba(255,220,130,.30);}}
#toasts{position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:40;display:flex;
  flex-direction:column;align-items:center;gap:6px;pointer-events:none;max-width:min(92vw,520px);}
#toasts .toast{pointer-events:auto;cursor:pointer;background:rgba(3,14,18,.88);border:1px solid var(--line-hi);
  border-radius:3px;padding:7px 12px;font:12px ui-monospace,Menlo,monospace;color:var(--fg);
  box-shadow:0 0 14px rgba(40,200,210,.14);animation:toast-in .18s ease-out;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#toasts .toast.jump{border-color:var(--cyan);}
#toasts .toast.out{opacity:0;transform:translateY(-6px);transition:opacity .4s ease,transform .4s ease;}
@keyframes toast-in{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:none;}}
#speedbar{position:fixed;right:14px;bottom:14px;z-index:24;display:flex;align-items:center;gap:4px;
  padding:5px 7px;background:rgba(3,12,16,.78);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 16px rgba(40,200,210,.10);transition:bottom .2s ease;}
body.sheet-open #speedbar{bottom:calc(34vh + 12px);}
#fps{position:fixed;top:82px;right:10px;z-index:25;pointer-events:none;
  font:700 10px ui-monospace,Menlo,monospace;color:var(--grn);opacity:.72;letter-spacing:.5px;
  text-shadow:0 0 6px rgba(0,0,0,.85);}
@media (max-width:720px), ((hover: none) and (pointer: coarse) and (max-height: 520px)){#fps{top:78px;}}
.spd button{min-width:30px;height:26px;padding:0 5px;border-radius:2px;cursor:pointer;font:11px ui-monospace,monospace;
  background:transparent;color:var(--cyan-dim);border:1px solid var(--line-hi);}
.spd button.on{background:rgba(53,214,230,.16);color:var(--cyan);border-color:var(--cyan);box-shadow:0 0 10px rgba(53,214,230,.4);}
.spd .spddiv{width:1px;height:18px;background:var(--line-hi);margin:0 2px;}
.spd .spdmini{min-width:26px;font-size:10px;opacity:.9;}
.spd .sep{width:1px;height:18px;background:var(--line-hi);margin:0 4px;flex:0 0 auto;}
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
/* panel is glued to the bottom edge — lift the fleet command bar above it (mobile overrides below) */
body.sheet-open #cmdbar{bottom:calc(34vh + 12px);}

/* contextual build/ship tiles — live inside the build menu + fleet panel (icon +
   cost/count); tap one for the full dossier, with a "Build here" action for buildables. */
.ptiles{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px;}
.ptile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:54px;min-height:50px;
  padding:6px 7px;cursor:pointer;background:rgba(53,214,230,.05);border:1px solid var(--line-hi);border-radius:5px;color:var(--cyan);}
.ptile:hover{border-color:var(--cyan);background:rgba(53,214,230,.14);box-shadow:0 0 8px rgba(53,214,230,.25);}
.ptile:active{background:rgba(53,214,230,.24);}
.ptile .pt-ic{font-size:18px;line-height:1;}
.ptile .pt-c{font-size:9px;color:var(--dim);letter-spacing:.3px;white-space:nowrap;}
/* mini tile (ground garrison): a nameless icon·count chip — hover/tap dossier names it */
.ptile.mini{flex-direction:row;gap:6px;min-width:0;min-height:0;padding:7px 11px;}
.ptile.mini .pt-c{font-size:12px;color:var(--ink);font-weight:700;}
/* long-press name bubble over a codex tile (mobile — touch has no hover/title) */
#holdtip{position:fixed;z-index:60;display:none;max-width:70vw;padding:6px 10px;pointer-events:none;
  background:rgba(4,16,22,.96);border:1px solid var(--cyan);border-radius:7px;color:var(--cyan);
  font-size:13px;font-weight:600;letter-spacing:.3px;box-shadow:0 4px 14px rgba(0,0,0,.5);}
/* ONB-1 spotlight — guide-mark overlay (engine: src/spotlight.ts, adapter: src/spotlightDom.ts).
   z-50 sits ABOVE the HUD (top-bar 30, toasts 40) but BELOW critical modals (endscreen 56,
   settings 59, scipick/holdtip 60). The four .sl-dim panels frame the target; the element
   shows through the gap. .sl-passthrough (action/state steps) lets HUD clicks reach the map;
   default (tap steps) swallows them so «Далее» is the only way forward. */
#spotlight{position:fixed;inset:0;z-index:50;display:none;}
#spotlight .sl-dim{position:fixed;background:rgba(2,8,11,.72);pointer-events:auto;}
/* action/state steps: the player must operate the real HUD — let clicks through AND
   drop the dimming so the map stays fully legible (only the ring marks the target). */
#spotlight.sl-passthrough .sl-dim{pointer-events:none;background:transparent;}
#spotlight .sl-ring{position:fixed;border:2px solid var(--cyan);border-radius:8px;pointer-events:none;
  box-shadow:0 0 0 2px rgba(53,214,230,.25),0 0 18px rgba(53,214,230,.45);animation:sl-pulse 1.6s ease-in-out infinite;}
@keyframes sl-pulse{0%,100%{box-shadow:0 0 0 2px rgba(53,214,230,.2),0 0 14px rgba(53,214,230,.35);}
  50%{box-shadow:0 0 0 4px rgba(53,214,230,.35),0 0 22px rgba(53,214,230,.6);}}
#spotlight .sl-bubble{position:fixed;pointer-events:auto;max-width:min(320px,82vw);
  background:rgba(4,16,22,.97);border:1px solid var(--cyan);border-radius:10px;padding:13px 15px;
  box-shadow:0 6px 22px rgba(0,0,0,.55);color:var(--ink);}
#spotlight .sl-arrow{position:absolute;width:12px;height:12px;background:rgba(4,16,22,.97);
  border:1px solid var(--cyan);transform:rotate(45deg);}
#spotlight .sl-arrow[data-dir=up]{top:-7px;left:calc(50% - 6px);border-right:none;border-bottom:none;}
#spotlight .sl-arrow[data-dir=down]{bottom:-7px;left:calc(50% - 6px);border-left:none;border-top:none;}
#spotlight .sl-arrow[data-dir=left]{left:-7px;top:calc(50% - 6px);border-right:none;border-top:none;}
#spotlight .sl-arrow[data-dir=right]{right:-7px;top:calc(50% - 6px);border-left:none;border-bottom:none;}
#spotlight .sl-count{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--cyan);margin-bottom:5px;}
#spotlight .sl-copy{font-size:14px;line-height:1.42;color:var(--ink);}
#spotlight .sl-btns{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;}
#spotlight .sl-skip{background:none;border:none;color:var(--dim);font-size:12px;cursor:pointer;padding:4px 2px;}
#spotlight .sl-skip:hover{color:var(--ink);text-decoration:underline;}
#spotlight .sl-next{background:var(--cyan);border:none;color:#04121a;font-weight:700;font-size:13px;
  padding:7px 16px;border-radius:7px;cursor:pointer;}
#spotlight .sl-next:hover{filter:brightness(1.08);}
/* codex popup — full stats + description on tile click */
#codex{position:fixed;inset:0;z-index:46;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#codex.show{display:flex;}
#codex .cxbox{width:min(440px,94vw);max-height:84vh;overflow:auto;background:var(--glass);border:1px solid var(--cyan);
  border-radius:10px;padding:16px 18px 14px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.cx-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--line-hi);}
.cx-head .cx-ic{font-size:22px;color:var(--cyan);}
.cx-head b{font-size:16px;letter-spacing:1.5px;color:#eafffb;flex:1;}
.cx-head .cx-tag{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--cyan-dim);border:1px solid var(--line);padding:2px 6px;border-radius:2px;}
.cx-stats{display:flex;flex-direction:column;gap:3px;margin-bottom:12px;}
.cx-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-bottom:1px solid rgba(14,59,64,.4);}
.cx-row .cx-k{color:var(--dim);}
.cx-row .cx-v{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;text-align:right;}
.cx-desc{font-size:12px;line-height:1.6;color:#9fc9c4;}
.cx-build{margin-top:12px;width:100%;padding:12px;cursor:pointer;border-radius:6px;border:1px solid var(--grn-dim);
  background:rgba(95,240,168,.12);color:var(--grn);font:700 13px ui-monospace,monospace;letter-spacing:1px;}
.cx-build:active{background:rgba(95,240,168,.24);}
.cx-close{margin-top:8px;width:100%;padding:9px;cursor:pointer;border-radius:6px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.1);color:var(--cyan);font:600 12px ui-monospace,monospace;letter-spacing:1px;}

/* ONB-4 codex/help hub — searchable index over units/buildings/mechanics (pure
   index: src/codexIndex.ts). Sits at z-45, one below #codex (46) so tapping a
   result layers the single-article popup on top of the hub. */
#codexhub{position:fixed;inset:0;z-index:45;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.6);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#codexhub.show{display:flex;}
#codexhub .chbox{width:min(460px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--glass);
  border:1px solid var(--cyan);border-radius:10px;padding:14px 16px 12px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#codexhub .ch-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--line-hi);}
#codexhub .ch-head .cx-ic{font-size:20px;color:var(--cyan);}
#codexhub .ch-head b{font-size:15px;letter-spacing:1.5px;color:#eafffb;flex:1;}
#codexhub .ch-search{width:100%;box-sizing:border-box;padding:9px 11px;margin-bottom:10px;border-radius:7px;
  border:1px solid var(--line-hi);background:rgba(3,12,16,.7);color:var(--ink);font:13px ui-monospace,monospace;}
#codexhub .ch-search:focus{outline:none;border-color:var(--cyan);}
#codexhub .ch-body{overflow:auto;}
#codexhub .ch-sec{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:8px 0 6px;}
#codexhub .ch-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:6px;}
#codexhub .ch-item{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:pointer;text-align:left;
  border-radius:7px;border:1px solid var(--line-hi);background:rgba(3,12,16,.6);color:#dfeef2;font:600 12px ui-monospace,monospace;}
#codexhub .ch-item:active{background:rgba(53,214,230,.12);border-color:var(--cyan);}
#codexhub .ch-item .ch-ic{color:var(--cyan);flex:0 0 auto;}
#codexhub .ch-empty{padding:24px 8px;text-align:center;color:var(--dim);font-size:13px;}
#codexhub .cx-close{margin-top:10px;}
/* the always-present in-match «?» help button (rail tool) reuses the rail styles */
/* ONB-3 just-in-time intro card — one-screen first-contact explainer, z-58 so it
   layers ABOVE the panel it introduces (tech/market/… at z-47) but below settings(59). */
#intro{position:fixed;inset:0;z-index:58;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.62);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#intro.show{display:flex;}
#intro .inbox{width:min(400px,92vw);max-height:84vh;overflow:auto;background:var(--glass);border:1px solid var(--cyan);
  border-radius:10px;padding:16px 18px 14px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#intro .in-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--line-hi);}
#intro .in-ic{font-size:20px;color:var(--cyan);}
#intro .in-head b{font-size:15px;letter-spacing:1px;color:#eafffb;flex:1;}
#intro .in-tag{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--cyan-dim);border:1px solid var(--line);padding:2px 6px;border-radius:2px;}
#intro .in-body{font-size:13px;line-height:1.62;color:#cfe9e4;}
#intro .in-ok{margin-top:14px;width:100%;padding:10px;cursor:pointer;border-radius:7px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.12);color:var(--cyan);font:700 13px ui-monospace,monospace;letter-spacing:1px;}
#intro .in-ok:active{background:rgba(53,214,230,.24);}
/* ONB-5 return digest — "пока тебя не было": events since you left, attention first */
#recap{position:fixed;inset:0;z-index:57;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.62);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#recap.show{display:flex;}
#recap .rcbox{width:min(440px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--glass);
  border:1px solid var(--cyan);border-radius:10px;padding:14px 16px 12px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#recap .rc-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:8px;border-bottom:1px solid var(--line-hi);}
#recap .rc-head .cx-ic{font-size:19px;color:var(--cyan);}
#recap .rc-head b{font-size:14px;letter-spacing:1.5px;color:#eafffb;flex:1;}
#recap .rc-body{overflow:auto;}
#recap .rc-sec{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:10px 0 6px;}
#recap .rc-sec.hi{color:var(--amber);}
#recap .rc-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 10px;margin-bottom:5px;cursor:pointer;
  border-radius:7px;border:1px solid var(--line-hi);background:rgba(3,12,16,.6);color:#dfeef2;font:500 12px ui-monospace,monospace;line-height:1.4;}
#recap .rc-item[data-jump]:active{background:rgba(53,214,230,.12);border-color:var(--cyan);}
#recap .rc-item .rc-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--cyan-dim);}
#recap .rc-item.hi{border-color:rgba(255,180,58,.5);}
#recap .rc-item.hi .rc-dot{background:var(--amber);box-shadow:0 0 8px rgba(255,180,58,.6);}
#recap .cx-close{margin-top:10px;}
/* ONB-7 first-session goals — a small collapsible checklist, onboarding match only.
   Top-right under the top bar; z-32 above the HUD but below toasts/modals. */
#goals{position:fixed;top:52px;right:14px;z-index:32;display:none;max-width:min(230px,60vw);}
#goals.show{display:block;}
#goals .gl-box{background:rgba(4,16,22,.94);border:1px solid var(--cyan-dim);border-radius:9px;overflow:hidden;
  box-shadow:0 4px 16px rgba(0,0,0,.45);}
#goals .gl-head{display:flex;align-items:center;gap:7px;padding:7px 10px;background:rgba(53,214,230,.08);
  border-bottom:1px solid var(--line-hi);}
#goals .gl-head b{flex:1;font-size:11px;letter-spacing:.6px;color:var(--cyan);text-transform:uppercase;}
#goals .gl-count{font-size:11px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;}
#goals .gl-tg{width:20px;height:20px;border:none;background:none;color:var(--dim);cursor:pointer;font-size:11px;padding:0;}
#goals .gl-list{padding:7px 10px 9px;display:flex;flex-direction:column;gap:5px;}
#goals .gl-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim);line-height:1.3;}
#goals .gl-item .gl-ck{color:var(--cyan-dim);flex:0 0 auto;font-size:13px;}
#goals .gl-item.done{color:#dfeef2;}
#goals .gl-item.done .gl-ck{color:var(--grn);text-shadow:0 0 8px rgba(95,240,192,.5);}
@media (max-width:640px){#goals{top:auto;bottom:70px;right:8px;}}

/* player card — tap the top-left crest for your session dossier */
#playercard{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#playercard.show{display:flex;}
#playercard .pcbox{width:min(380px,92vw);max-height:86vh;overflow:auto;background:var(--glass);border:1px solid var(--cyan);
  border-radius:10px;padding:16px 18px 14px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.pc-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--line-hi);}
.pc-head .pc-dia{width:14px;height:14px;transform:rotate(45deg);flex:0 0 auto;border-radius:2px;}
.pc-head b{font-size:16px;letter-spacing:1.5px;color:#eafffb;flex:1;}
.pc-head .pc-tag{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--cyan-dim);border:1px solid var(--line);padding:2px 6px;border-radius:2px;}
.pc-stats{display:flex;flex-direction:column;gap:3px;margin-bottom:10px;}
.pc-sec{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:4px 0 6px;}
.pc-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-bottom:1px solid rgba(14,59,64,.4);}
.pc-row .pc-k{color:var(--dim);}
.pc-row .pc-v{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;text-align:right;}
.pc-close{margin-top:10px;width:100%;padding:9px;cursor:pointer;border-radius:6px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.1);color:var(--cyan);font:600 12px ui-monospace,monospace;letter-spacing:1px;}

/* settings overlay (hub → «Ещё» → Настройки) — client-only display prefs */
#settings{position:fixed;inset:0;z-index:59;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#settings.show{display:flex;}
#settings .setbox{width:min(380px,92vw);max-height:86vh;overflow:auto;background:var(--glass);border:1px solid var(--cyan);
  border-radius:10px;padding:16px 18px 14px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.set-row{display:flex;flex-direction:column;gap:9px;padding:6px 0 2px;}
.set-lbl{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--ink);}
.set-lbl .set-sub{font-size:10px;color:var(--dim);letter-spacing:.2px;}
.set-ctl{display:flex;align-items:center;gap:10px;}
.set-ctl input[type=range]{flex:1;accent-color:var(--cyan);height:22px;cursor:pointer;}
.set-val{min-width:42px;text-align:right;font-variant-numeric:tabular-nums;color:var(--cyan);font-weight:700;}
.set-switch{position:relative;width:46px;height:24px;flex:0 0 auto;cursor:pointer;margin-right:auto;}
.set-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;}
.set-switch .sw-track{position:absolute;inset:0;border-radius:12px;border:1px solid var(--line-hi);
  background:rgba(6,18,22,.9);transition:border-color .18s,background .18s,box-shadow .18s;pointer-events:none;}
.set-switch .sw-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;
  background:var(--dim);transition:left .18s,background .18s,box-shadow .18s;pointer-events:none;}
.set-switch input:checked ~ .sw-track{border-color:var(--cyan);background:rgba(53,214,230,.16);
  box-shadow:inset 0 0 10px rgba(53,214,230,.25);}
.set-switch input:checked ~ .sw-knob{left:25px;background:var(--cyan);box-shadow:0 0 8px rgba(53,214,230,.6);}
.set-switch input:focus-visible ~ .sw-track{border-color:var(--cyan);box-shadow:0 0 0 2px rgba(53,214,230,.35);}

/* war prompt — confirm before a move declares war on a player you're at peace with */
#warprompt{position:fixed;inset:0;z-index:48;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(20,2,1,.6);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#warprompt.show{display:flex;}
#warprompt .wpbox{width:min(360px,92vw);background:var(--glass);border:1px solid var(--red);
  border-radius:10px;padding:16px 18px 14px;box-shadow:0 0 44px rgba(255,90,77,.22),inset 0 0 0 1px rgba(255,90,77,.06);}
.wp-head{font-size:15px;letter-spacing:2px;color:var(--red);text-shadow:0 0 10px rgba(255,90,77,.5);
  padding-bottom:9px;margin-bottom:9px;border-bottom:1px solid #5a201a;}
.wp-body{font-size:12.5px;line-height:1.65;color:#e7c6c2;margin-bottom:14px;}
.wp-body b{color:#ffd9d3;}
.wp-actions{display:flex;gap:8px;}
.wp-actions button{flex:1;padding:11px;cursor:pointer;border-radius:6px;font:700 12px ui-monospace,monospace;letter-spacing:1px;}
.wp-no{border:1px solid var(--cyan-dim);background:rgba(53,214,230,.1);color:var(--cyan);}
.wp-yes{border:1px solid #7a221c;background:rgba(255,90,77,.16);color:var(--red);}
.wp-yes:active{background:rgba(255,90,77,.3);}

/* session menu — diplomacy roster + message log (rail: Diplomacy / Dispatches) */
#diplo{position:fixed;inset:0;z-index:49;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.62);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#diplo.show{display:flex;}
#diplo .dpbox{display:flex;flex-direction:column;width:min(460px,96vw);max-height:88vh;background:var(--glass);
  border:1px solid var(--cyan);border-radius:10px;overflow:hidden;
  box-shadow:0 0 44px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.dp-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line-hi);}
.dp-head b{font-size:11px;letter-spacing:2px;color:var(--cyan-dim);margin-right:2px;}
.dp-tab{padding:6px 11px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:700 11px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;}
.dp-tab.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
.dp-close{margin-left:auto;width:28px;height:28px;border-radius:6px;border:1px solid var(--line);
  background:transparent;color:var(--dim);cursor:pointer;font-size:12px;}
.dp-sorts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--line);
  font-size:10px;color:var(--cyan-dim);letter-spacing:.5px;}
.dp-sortb{padding:4px 8px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:600 10px ui-monospace,monospace;cursor:pointer;}
.dp-sortb.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
.dp-filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:0 12px 9px;border-bottom:1px solid var(--line);
  font-size:10px;color:var(--cyan-dim);letter-spacing:.5px;}
.dp-fchip{padding:3px 9px;border-radius:11px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:600 10px ui-monospace,monospace;cursor:pointer;}
.dp-fchip.on{color:var(--sc);border-color:var(--sc);background:rgba(53,214,230,.08);}
.dp-fchip.ty{font-variant-emoji:text;}
.dp-fchip.ty.on{color:var(--cyan);border-color:var(--cyan-dim);}
.dp-fsep{width:1px;height:14px;background:var(--line-hi);margin:0 2px;}
.dp-fclear{margin-left:auto;padding:3px 9px;border-radius:6px;border:1px solid var(--line);background:transparent;
  color:var(--dim);font:600 10px ui-monospace,monospace;cursor:pointer;}
.dp-list{overflow:auto;padding:6px;display:flex;flex-direction:column;gap:4px;}
.dp-row{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:9px 10px;border-radius:7px;border:1px solid var(--line);
  background:rgba(8,28,32,.5);cursor:pointer;}
.dp-row.me{cursor:default;border-color:var(--cyan-dim);background:rgba(53,214,230,.07);}
.dp-row.open{border-color:var(--cyan-dim);}
.dp-ic{font-size:18px;width:20px;text-align:center;font-variant-emoji:text;flex:0 0 auto;}
.dp-name{flex:1;font-size:13px;color:#eafffb;font-weight:700;display:flex;align-items:baseline;gap:6px;min-width:0;}
.dp-name em{font-style:normal;font-size:8px;letter-spacing:1.2px;color:var(--cyan-dim);
  border:1px solid var(--line);border-radius:3px;padding:1px 4px;flex:0 0 auto;}
.dp-w{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;flex:0 0 auto;}
.dp-stance{font-size:9px;letter-spacing:1px;border:1px solid;border-radius:3px;padding:2px 6px;flex:0 0 auto;font-weight:700;}
.dp-tag{font-size:9px;letter-spacing:1px;color:var(--cyan-dim);flex:0 0 auto;}
/* bot favour (approval) meter — a second line on AI rows: cap ☺ + threshold-ticked bar + tier word */
.dp-fav{flex:1 0 100%;display:flex;align-items:center;gap:7px;margin-top:1px;cursor:help;}
.dp-fav-cap{font-size:11px;color:var(--dim);flex:0 0 auto;font-variant-emoji:text;}
.dp-fav-track{position:relative;flex:1;height:6px;border-radius:3px;background:rgba(120,140,150,.16);
  border:1px solid var(--line);overflow:hidden;min-width:60px;}
.dp-fav-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;transition:width .3s;}
.dp-fav-tick{position:absolute;top:-1px;bottom:-1px;width:1px;z-index:2;}
.dp-fav-tick.emb{background:rgba(232,178,74,.85);}
.dp-fav-tick.war{background:rgba(229,72,77,.9);}
.dp-fav.ok .dp-fav-fill{background:linear-gradient(90deg,rgba(53,214,230,.5),var(--cyan));}
.dp-fav.embargo .dp-fav-fill{background:#e8b24a;}
.dp-fav.war .dp-fav-fill{background:#e5484d;}
.dp-fav-lbl{font-size:8px;letter-spacing:.6px;text-transform:uppercase;flex:0 0 auto;color:var(--dim);}
.dp-fav.embargo .dp-fav-lbl{color:#e8b24a;}
.dp-fav.war .dp-fav-lbl{color:#e5484d;}
.dp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:0 10px 9px 39px;}
.dp-act{padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:700 11px ui-monospace,monospace;cursor:pointer;}
.dp-act.on{color:var(--sc);border-color:var(--sc);background:rgba(53,214,230,.08);}
.dp-act.offer{color:var(--sc);border-color:var(--sc);animation:sppulse 1.6s ease-in-out infinite;}
.dp-act.pend{opacity:.55;}
.dp-spy{padding:6px 10px;border-radius:6px;border:1px solid var(--amber-dim,#8a6a2f);background:transparent;
  color:var(--amber);font:700 11px ui-monospace,monospace;cursor:pointer;}
.dp-spy:hover{border-color:var(--amber);background:rgba(255,180,58,.1);}
.dp-intel{padding:2px 10px 9px 39px;font-size:11px;color:var(--cyan);}
.dp-intel b{color:#eafffb;}
/* SPY-UX: вкладка «Шпионаж» — активные окна интела, операции, сессионный журнал */
.in-hint{margin:2px 0 8px;padding:8px 10px;border:1px solid var(--line-hi);border-radius:8px;
  font-size:10px;color:var(--dim);line-height:1.55;}
.in-sec{margin:12px 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);}
.in-row{display:flex;align-items:center;gap:8px;padding:7px 9px;margin-bottom:6px;
  border:1px solid var(--line);border-radius:8px;background:rgba(53,214,230,.04);font-size:12px;color:var(--ink);}
.in-row b{color:#eafffb;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.in-row[data-iw]{cursor:pointer;}
.in-row[data-iw]:active{background:rgba(53,214,230,.12);}
.in-row .in-k{flex:0 0 auto;color:var(--cyan);}
.in-row .in-t{margin-left:auto;flex:0 0 auto;color:var(--amber);font-size:11px;white-space:nowrap;}
.in-row .in-go{flex:0 0 auto;color:var(--cyan-dim);}
.in-row .dp-spy{margin-left:auto;}
.in-row .dp-spy + .dp-spy{margin-left:0;}
.in-empty{padding:6px 2px;font-size:11px;color:var(--dim);}
.in-log{padding:4px 2px;font-size:10.5px;color:var(--dim);line-height:1.45;border-bottom:1px dashed rgba(29,107,112,.25);}
.dp-intel em{font-style:normal;color:var(--dim);font-size:9px;}
.dp-msg{margin-left:auto;padding:6px 11px;border-radius:6px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.1);color:var(--cyan);font-size:13px;cursor:pointer;}
.dp-feed{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:7px;flex:1;min-height:0;}
.dp-empty{margin:auto;text-align:center;color:var(--dim);font-size:12px;line-height:1.8;}
.dp-line{font-size:12px;line-height:1.5;color:#cfe7e3;}
.dp-line b{color:#eafffb;}
.dp-line.sys{color:var(--amber);font-size:11px;}
.dp-when{display:inline-block;min-width:60px;color:var(--cyan-dim);font-size:9px;
  font-variant-numeric:tabular-nums;margin-right:6px;}
.dp-compose{display:flex;gap:6px;padding:9px 10px;border-top:1px solid var(--line-hi);}
.dp-compose input{flex:1;min-width:0;background:#06181c;color:var(--ink);border:1px solid var(--line);
  border-radius:6px;padding:9px 10px;font:400 13px ui-monospace,monospace;}
.dp-compose input:focus{outline:none;border-color:var(--cyan-dim);}
.dp-send{flex:0 0 auto;width:42px;border-radius:6px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.14);color:var(--cyan);font-size:14px;cursor:pointer;}
/* conversations: chat list (left) + open thread (right), coalition pinned on top */
.dp-convo{display:flex;height:min(62vh,440px);}
.dp-cvlist{width:130px;flex:0 0 auto;overflow:auto;border-right:1px solid var(--line-hi);
  padding:6px;display:flex;flex-direction:column;gap:3px;}
.dp-cv{display:flex;align-items:center;gap:7px;width:100%;padding:7px 7px;border-radius:7px;
  border:1px solid transparent;background:transparent;cursor:pointer;text-align:left;}
.dp-cv:hover{background:rgba(53,214,230,.06);}
.dp-cv.on{border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
.dp-cv.coal{border-bottom:1px solid var(--line);border-radius:7px 7px 0 0;}
.dp-cv-ic{font-size:15px;flex:0 0 auto;font-variant-emoji:text;width:17px;text-align:center;}
.dp-cv-nm{display:flex;flex-direction:column;min-width:0;font-size:12px;color:#eafffb;font-weight:700;}
.dp-cv-nm em{font-style:normal;font-weight:400;font-size:9px;color:var(--dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:92px;}
.dp-thread{flex:1;min-width:0;display:flex;flex-direction:column;}
.dp-thhead{padding:9px 12px;border-bottom:1px solid var(--line-hi);font-size:12px;font-weight:700;
  color:var(--cyan);letter-spacing:.5px;font-variant-emoji:text;}
.dp-line.me b{color:var(--cyan);}
.dp-line.ping{cursor:pointer;color:var(--amber);}
.dp-line.ping:hover{text-decoration:underline;}
.dp-jump{font-size:9px;color:var(--cyan-dim);border:1px solid var(--line);border-radius:3px;
  padding:1px 4px;margin-left:5px;white-space:nowrap;}
.dp-ping{flex:0 0 auto;width:40px;border-radius:6px;border:1px solid var(--amber);
  background:rgba(255,180,58,.12);color:var(--amber);font-size:15px;cursor:pointer;font-variant-emoji:text;}
/* ally ping marker popup (tap a pin on the map) */
#pingpop{position:fixed;z-index:45;display:none;transform:translate(-50%,calc(-100% - 14px));
  width:172px;background:var(--glass);border:1px solid var(--amber);border-radius:8px;padding:8px 10px;
  box-shadow:0 0 22px rgba(0,0,0,.6);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#pingpop.show{display:block;}
.pp-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-bottom:5px;}
.pp-top b{font-size:11px;letter-spacing:.5px;font-variant-emoji:text;}
.pp-top span{font-size:9px;color:var(--cyan-dim);font-variant-numeric:tabular-nums;}
.pp-desc{font-size:11px;line-height:1.4;color:#e7d6b8;margin-bottom:7px;word-break:break-word;}
.pp-desc i{color:var(--dim);}
.pp-act{display:flex;gap:5px;}
.pp-act button{flex:1;padding:5px 6px;border-radius:5px;border:1px solid var(--cyan-dim);
  background:rgba(53,214,230,.1);color:var(--cyan);font:700 10px ui-monospace,monospace;cursor:pointer;}
.pp-act .pp-del{border-color:#7a221c;background:rgba(255,90,77,.12);color:var(--red);}
/* province ping composer: pick a destination (coalition chat / a player's DM) for a
   map ping on the selected province. Centered modal, like #splitdlg. */
#pingmenu{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;
  padding:18px;background:rgba(2,8,11,.62);backdrop-filter:blur(2px);}
#pingmenu.show{display:flex;}
#pingmenu .pm-box{width:min(360px,92vw);background:var(--glass);border:1px solid var(--amber);
  border-radius:12px;padding:16px 16px 14px;box-shadow:0 0 30px rgba(0,0,0,.6);}
#pingmenu .pm-head{font-size:13px;letter-spacing:1px;color:var(--amber);font-variant-emoji:text;margin-bottom:3px;}
#pingmenu .pm-head b{color:#eafffb;}
#pingmenu .pm-sub{color:var(--dim);font-size:11px;line-height:1.5;margin-bottom:11px;}
#pingmenu .pm-text{width:100%;box-sizing:border-box;margin-bottom:12px;padding:8px 10px;border-radius:6px;
  border:1px solid var(--cyan-dim);background:rgba(4,14,18,.7);color:#eafffb;font:inherit;font-size:12px;}
#pingmenu .pm-lbl{color:var(--cyan-dim);font-size:10px;letter-spacing:1px;text-transform:uppercase;margin:2px 0 6px;}
#pingmenu .pm-dst{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;margin-bottom:6px;
  padding:9px 11px;border-radius:7px;border:1px solid var(--line-hi);background:rgba(53,214,230,.06);
  color:var(--ink);font:inherit;font-size:12px;font-weight:700;text-align:left;cursor:pointer;font-variant-emoji:text;}
#pingmenu .pm-dst:hover{background:rgba(53,214,230,.14);border-color:var(--cyan);}
#pingmenu .pm-dst.coal{border-color:var(--amber);background:rgba(255,196,90,.08);}
#pingmenu .pm-dst .pm-ic{flex:0 0 auto;}
#pingmenu .pm-dst em{margin-left:auto;color:var(--dim);font-weight:400;font-style:normal;font-size:10px;}
#pingmenu .pm-cancel{display:block;width:100%;margin-top:8px;padding:9px;border-radius:7px;
  border:1px solid var(--line-hi);background:transparent;color:var(--dim);font:inherit;font-size:12px;cursor:pointer;}
#pingmenu .pm-cancel:hover{color:var(--ink);border-color:var(--cyan-dim);}

/* status strip below the top bar: day/time + victory progress */
#devline{position:fixed;top:46px;left:0;right:0;height:28px;z-index:24;display:flex;align-items:center;gap:14px;
  padding:0 14px;background:rgba(2,8,11,.55);color:var(--cyan-dim);font-size:11px;letter-spacing:.6px;
  white-space:nowrap;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid rgba(14,59,64,.5);}
#devline::-webkit-scrollbar{display:none;}
#devline #clock{color:var(--grn);font-variant-numeric:tabular-nums;flex:0 0 auto;}
#devline .dstat{flex:0 0 auto;}
#devline .dstat.win{color:var(--up);font-weight:700;}

/* left-corner tool rail — collapsed to a single hamburger by default; tapping it expands
   the wired tools UPWARD (primary icon nearest the thumb). The tools live in their own
   panel that sizes to its buttons, so nothing overflows the rail. */
#rail{position:fixed;left:10px;bottom:14px;top:auto;z-index:26;display:flex;flex-direction:column;
  align-items:flex-start;gap:8px;}
#railtools{display:none;flex-direction:column;gap:5px;padding:6px;background:rgba(3,12,16,.82);
  border:1px solid var(--line-hi);border-radius:12px;box-shadow:0 0 16px rgba(0,0,0,.5);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  /* Short viewports (landscape / small phones): the bottom-anchored rail grows UP and
     used to overrun the top bar (z-index 30 > 26), pushing «Дипло» off-screen / under
     the top bar so a tap hit the top bar instead. Cap the tool list to the space above
     the toggle+bottom and below the top bar, and scroll inside it. dvh overrides vh
     where supported (mobile URL-bar aware); no effect on tall screens (list fits). */
  max-height:calc(100vh - 120px);max-height:calc(100dvh - 120px);
  overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;}
#railtools::-webkit-scrollbar{display:none;}
#rail.open #railtools{display:flex;}
#railtools .rlbl{display:none;font:8px ui-monospace,monospace;letter-spacing:.4px;color:var(--cyan-dim);line-height:1;}
#railtools button{position:relative;width:38px;height:38px;background:transparent;border:0;cursor:pointer;
  font-size:18px;color:var(--cyan-dim);border-radius:8px;font-variant-emoji:text;display:grid;place-items:center;}
#railtools button:hover,#railtools button:active{color:var(--cyan);background:rgba(53,214,230,.12);text-shadow:0 0 8px rgba(53,214,230,.6);}
#railtoggle{width:44px;height:44px;display:grid;place-items:center;cursor:pointer;font-size:20px;font-variant-emoji:text;
  color:var(--cyan);background:rgba(3,12,16,.85);border:1px solid var(--line-hi);border-radius:12px;
  box-shadow:0 0 16px rgba(0,0,0,.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}
#railtoggle:hover,#rail.open #railtoggle{background:rgba(53,214,230,.16);text-shadow:0 0 8px rgba(53,214,230,.6);}
#rail .railbadge{position:absolute;top:2px;right:2px;min-width:14px;height:14px;border-radius:7px;
  background:var(--amber,#f0b429);color:#08131a;font:700 9px ui-monospace,monospace;
  display:grid;place-items:center;padding:0 3px;}
.dp-compose.dp-off{align-items:center;gap:8px;}
.dp-compose .dp-offtxt{color:var(--dim);font-size:11px;}
#rail .badge{position:absolute;right:5px;top:4px;min-width:15px;height:15px;border-radius:8px;
  background:var(--red);color:#180605;font:700 9px/15px ui-monospace,monospace;text-align:center;
  box-shadow:0 0 8px rgba(255,90,77,.7);}

#side{position:fixed;left:58px;right:14px;bottom:0;top:auto;width:auto;max-height:34vh;overflow:hidden;z-index:20;
  display:none;align-items:stretch;padding:0;background:rgba(3,14,18,.6);border:1px solid var(--line-hi);
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
  box-shadow:0 0 26px rgba(0,0,0,.6),0 0 0 1px rgba(53,214,230,.08),inset 0 0 30px rgba(53,214,230,.04);
  clip-path:polygon(0 9px,9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%);}
/* scrollable content (left) + a dossier pane glued to the right edge, filling the
   panel's otherwise-empty space. The pane shows the hovered object's description. */
.pscroll{flex:1 1 auto;min-width:0;overflow:auto;padding:13px 15px;touch-action:pan-y;}
/* dossier pane: a FIXED-width reserved column (was fit-content, which reflowed the
   left content every time a longer/shorter dossier was hovered — buttons jumped).
   A stable basis keeps .pscroll's width constant no matter what's hovered; a long
   dossier scrolls inside the pane instead of resizing the whole panel. */
.pdesc{flex:0 0 44%;min-width:200px;overflow-y:auto;overflow-x:hidden;
  padding:14px 16px;border-left:1px solid var(--line-hi);border-radius:0 10px 10px 0;
  background:rgba(53,214,230,.045);}
.pdesc .pd-title{font-size:14px;font-weight:700;letter-spacing:1.5px;color:#eafffb;margin-bottom:9px;
  padding-bottom:7px;border-bottom:1px solid var(--line);}
.pdesc .pd-body{font-size:12px;line-height:1.65;color:#9fc9c4;}
.pdesc .pd-empty{font-size:11px;line-height:1.6;color:var(--dim);font-style:italic;}
.pdesc .hl{font-style:normal;font-weight:700;color:var(--amber);text-shadow:0 0 7px rgba(255,180,58,.35);}
#side .sec{margin:14px 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--grn-dim);
  border-bottom:1px solid var(--line);padding-bottom:4px;}
#side .row{margin:4px 0;}
#side .dim{color:var(--dim);}
#side .qgo{color:var(--cyan);text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer;}
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
/* wrap (don't overflow) so a trailing Select/Upgrade button never laps onto the
   neighbouring column when the panel is laid out in narrow multi-column blocks */
/* thin outline so each menu object reads as one discrete, selectable card; the
   border warms up on hover, echoing the dossier that lights up on the right. */
.asset-row{display:flex;align-items:center;gap:8px;margin:5px 0;min-height:24px;flex-wrap:wrap;
  padding:5px 8px;border:1px solid var(--line);border-radius:2px;background:rgba(53,214,230,.02);
  transition:border-color .12s ease,background .12s ease;}
.asset-row:hover{border-color:var(--cyan-dim);background:rgba(53,214,230,.07);}
.asset-row b{flex:1 1 auto;min-width:96px;font-size:12px;}
.asset-row .b{margin-left:auto;}
.asset-row .prod{color:var(--grn);}
.bicon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:7px;
  border:1px solid var(--line-hi);background:rgba(53,214,230,.07);color:var(--cyan);font-size:12px;}
.asset-row .bicon{margin-right:0;flex:0 0 auto;}
.conveyor{margin:6px 0 8px;padding:8px;border:1px solid var(--line);background:rgba(53,214,230,.04);}
.conveyor .current{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;font-size:11px;}
.conveyor .current span{color:var(--grn);letter-spacing:1.5px;font-size:9px;}
.conveyor .current.idle span{color:var(--dim);}
.conveyor .current em{color:var(--cyan-dim);font-style:normal;}
.conveyor .bar{height:4px;margin:7px 0;background:rgba(53,214,230,.08);overflow:hidden;}
.conveyor .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--grn),var(--cyan));box-shadow:0 0 10px rgba(125,240,208,.6);}
.conveyor .queue{display:flex;gap:6px;flex-wrap:wrap;}
.conveyor .queue span{display:flex;align-items:center;gap:4px;border:1px solid var(--line);background:rgba(2,9,13,.55);padding:3px 6px;font-size:10px;color:var(--ink);}
.conveyor .queue em{font-style:normal;color:var(--grn-dim);margin-right:5px;}
.conveyor .queue.empty{color:var(--dim);font-size:10px;}
.conveyor .current button,.conveyor .queue button,.conveyor .paused button{
  border:1px solid var(--line-hi);background:transparent;color:var(--dim);cursor:pointer;
  font:11px ui-monospace,monospace;padding:2px 6px;border-radius:2px;line-height:1.3;}
.conveyor .current button:hover,.conveyor .queue button:hover,.conveyor .paused button:hover{
  color:var(--cyan);border-color:var(--cyan);}
.conveyor .paused{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}
.conveyor .paused span{display:flex;align-items:center;gap:4px;border:1px solid var(--amber,#f0b429);
  background:rgba(240,180,41,.08);padding:3px 6px;font-size:10px;color:var(--ink);}
.conveyor .paused em{font-style:normal;color:var(--amber,#f0b429);margin-right:2px;}
button.b{background:transparent;color:var(--cyan);border:1px solid var(--cyan-dim);border-radius:2px;
  padding:5px 10px;margin:3px 4px 2px 0;cursor:pointer;font:700 11px ui-monospace,monospace;letter-spacing:.4px;}
button.b:hover:not(:disabled){background:rgba(53,214,230,.14);box-shadow:0 0 10px rgba(53,214,230,.35);}
button.b:disabled{opacity:.32;cursor:not-allowed;color:var(--dim);border-color:var(--line);}

/* desktop: spread the panel's scrollable sections into side-by-side columns,
   divided by faint vertical rules, instead of one tall single-width stack. Each
   .block stays whole (never split across a column). Phones reset this below. */
.pcols{column-width:240px;column-gap:18px;column-rule:1px solid var(--line);}
.pcols .block{break-inside:avoid;-webkit-column-break-inside:avoid;page-break-inside:avoid;margin-bottom:10px;}
.pcols .block:first-child .sec:first-child{margin-top:0;}

/* split-fleet modal */
#splitdlg{position:fixed;inset:0;z-index:45;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#splitdlg .sbox{width:min(440px,94vw);max-height:84vh;overflow:auto;background:var(--glass);
  border:1px solid var(--cyan);border-radius:10px;padding:18px 18px 14px;
  box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#splitdlg .shead{font-size:14px;letter-spacing:2px;color:var(--cyan);}
#splitdlg .shead b{color:#eafffb;}
#splitdlg .ssub{margin:6px 0 12px;color:var(--dim);font-size:11px;line-height:1.5;}
#splitdlg .srow{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;
  padding:7px 0;border-top:1px solid var(--line);}
#splitdlg .sname{display:flex;align-items:center;gap:6px;color:var(--ink);font-weight:700;}
#splitdlg .scur{min-width:26px;text-align:center;color:#eafffb;font-variant-numeric:tabular-nums;}
#splitdlg .snew{min-width:42px;text-align:right;color:var(--grn);font-weight:700;font-variant-numeric:tabular-nums;}
#splitdlg .sbtns{display:flex;gap:4px;}
#splitdlg .sbtns button{min-width:34px;height:30px;padding:0 7px;cursor:pointer;border-radius:2px;
  font:700 11px ui-monospace,monospace;background:transparent;color:var(--cyan);border:1px solid var(--cyan-dim);}
#splitdlg .sbtns button:hover:not(:disabled){background:rgba(53,214,230,.14);}
#splitdlg .sbtns button:disabled{opacity:.3;cursor:not-allowed;color:var(--dim);border-color:var(--line);}
#splitdlg .sfoot{margin:13px 0 2px;color:var(--dim);font-size:12px;text-align:center;}
#splitdlg .sfoot b{color:#eafffb;}
#splitdlg .sactions{display:flex;gap:10px;justify-content:center;margin-top:10px;}
#splitdlg .sactions .cbtn{flex:1;max-width:160px;padding:11px 10px;border-radius:7px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.12);color:var(--cyan);font:600 13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
#splitdlg .sactions .cbtn:disabled{opacity:.35;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
#splitdlg .sactions .cbtn.ghost{border-color:var(--line-hi);background:transparent;color:var(--dim);}

/* event log lives in a tap-to-open window (rail ≡), not a permanent panel */
#logwin{position:fixed;inset:0;z-index:46;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#logwin.show{display:flex;}
#logwin .lwbox{display:flex;flex-direction:column;width:min(440px,94vw);max-height:70vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:10px;
  box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.lw-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line-hi);}
.lw-head b{font-size:12px;letter-spacing:2px;color:var(--cyan);}
.lw-close{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
#logwin .lw-head b{flex:1;} /* push the buttons to the right when the recap button is present */
.lw-recap{width:28px;height:28px;margin-right:6px;border-radius:6px;border:1px solid var(--cyan-dim);background:rgba(53,214,230,.08);color:var(--cyan);cursor:pointer;}
.lw-recap:active{background:rgba(53,214,230,.2);}
#log{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:10px 14px;
  font:11px/1.6 ui-monospace,Menlo,monospace;color:#73b6a2;scrollbar-width:thin;}
#log div::before{content:"> ";color:var(--grn-dim);}

/* technologies + steward + heroes windows (modal, mirror #logwin) */
#tech,#steward,#hero{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#tech.show,#steward.show,#hero.show{display:flex;}
/* division designer (H4) */
#divdesign{position:fixed;inset:0;z-index:44;display:none;align-items:center;justify-content:center;background:rgba(2,8,11,.62);}
#divdesign.show{display:flex;}
#divdesign .dd-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
#divdesign .dd-tabs button{padding:7px 10px;border:1px solid var(--line-hi);border-radius:8px;background:transparent;color:var(--ink);font:700 11px ui-monospace,monospace;cursor:pointer;}
#divdesign .dd-tabs button.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
#divdesign .dd-name{display:flex;gap:8px;margin-bottom:10px;}
#divdesign .dd-name input{flex:1;padding:7px 9px;border:1px solid var(--line-hi);border-radius:8px;background:rgba(2,10,14,.6);color:#eafffb;font:700 12px ui-monospace,monospace;}
#divdesign .dd-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;}
#divdesign .dd-slots button{padding:10px 6px;border:1px dashed var(--line-hi);border-radius:9px;background:rgba(53,214,230,.04);color:#cfeeea;font:700 11px ui-monospace,monospace;cursor:pointer;}
#divdesign .dd-slots button:disabled{cursor:default;opacity:.75;border-style:solid;}
#divdesign .dd-vs{display:flex;flex-direction:column;gap:4px;margin:8px 0;}
#divdesign .dd-vs .vrow{display:flex;align-items:center;gap:8px;font-size:11px;color:#9fc9c4;}
#divdesign .dd-vs .vnm{flex:0 0 130px;}
#divdesign .dd-vs .vtrack{flex:1;height:5px;border-radius:3px;background:rgba(53,214,230,.1);overflow:hidden;}
#divdesign .dd-vs .vbar{height:100%;background:var(--amber);}
#divdesign .dd-lock{color:var(--amber);font-size:11px;margin:6px 0;}
#divdesign .hint2{color:#74b0aa;font-size:11px;line-height:1.5;margin-top:8px;}
#tech .twbox,#steward .twbox,#hero .twbox,#divdesign .twbox{display:flex;flex-direction:column;width:min(460px,94vw);max-height:82vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:10px;
  box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.tw-close{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
#techbody,#stewardbody,#herobody{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:12px 14px;}
/* heroes window: roster cards + abilities / skill tree / fittings */
#herobody .hx-card{border:1px solid var(--line-hi);border-radius:10px;padding:11px 13px;margin-bottom:12px;background:rgba(53,214,230,.04);}
#herobody .hx-card.dead{opacity:.55;border-style:dashed;}
#herobody .hx-name{font-weight:700;color:#eafffb;font-size:13px;}
#herobody .hx-sub{font-size:10.5px;color:var(--dim);margin-top:2px;line-height:1.5;}
#herobody .hx-h{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:10px 0 4px;}
#herobody .hx-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed var(--line);font-size:11.5px;}
#herobody .hx-grow{flex:1;min-width:0;}
#herobody .hx-an{color:var(--cyan);font-weight:600;}
#herobody .hx-note{font-size:10px;color:var(--dim);line-height:1.45;}
#herobody .hx-btn{padding:5px 10px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.10);color:var(--cyan);cursor:pointer;font:inherit;font-size:11px;white-space:nowrap;}
#herobody .hx-btn:disabled{opacity:.4;cursor:not-allowed;}
#herobody .hx-badge{font-size:9px;letter-spacing:1px;text-transform:uppercase;border:1px solid var(--line-hi);border-radius:5px;padding:2px 6px;color:var(--dim);white-space:nowrap;}
#herobody .hx-badge.on{border-color:#7df0d0;color:#9ff0da;}
#herobody .hx-badge.cd{border-color:#e2a15a;color:#e2a15a;}
/* Steward («Хранитель») delegate panel */
#stewardbody .st-status{padding:11px 13px;border:1px solid var(--cyan-dim);border-radius:9px;background:rgba(53,214,230,.08);font-size:12px;color:var(--cyan);line-height:1.55;}
#stewardbody .st-status.locked{border-color:var(--line);background:rgba(255,255,255,.03);color:var(--dim);}
#stewardbody .st-status.on{border-color:#7df0d0;background:rgba(125,240,208,.10);color:#9ff0da;}
#stewardbody .st-h{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:14px 0 8px;}
#stewardbody .st-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
#stewardbody .st-btn{flex:1;min-width:92px;padding:9px 10px;border-radius:8px;border:1px solid var(--cyan);background:rgba(53,214,230,.10);color:var(--cyan);cursor:pointer;font-size:12px;}
#stewardbody .st-btn:disabled{opacity:.4;cursor:not-allowed;}
#stewardbody .st-btn.warn{border-color:#e2a15a;color:#e2a15a;background:rgba(226,161,90,.10);}
#stewardbody .st-btn.sel{background:rgba(53,214,230,.28);font-weight:700;}
#stewardbody .st-log{max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;font-size:12px;}
#stewardbody .st-log-line{padding:4px 6px;border-left:2px solid rgba(53,214,230,.35);background:rgba(53,214,230,.05);border-radius:0 6px 6px 0;}
#stewardbody .st-log-when{opacity:.55;margin-right:4px;}
#stewardbody .st-note{margin-top:12px;font-size:11px;color:var(--dim);line-height:1.55;}
/* TT-3.1: technology tree (mockup v4) — tabs = branches, one shared sticky day
   rail (rows = epoch day-gates), node states, tap → dossier modal. Fixed-basis
   columns: the pane scrolls horizontally inside .tt-scroll, the rail stays pinned. */
#tech .twbox{position:relative;width:min(430px,94vw);}
#techbody{padding:0;overflow:hidden;display:flex;flex-direction:column;}
.tt-top{display:flex;align-items:center;justify-content:space-between;padding:9px 12px 0;flex:none;}
.tt-day{font-size:11px;color:var(--grn);border:1px solid var(--grn-dim);border-radius:12px;padding:3px 10px;background:rgba(95,240,192,.06);}
.tt-slots{font-size:11px;color:var(--cyan);}
.tt-tabs{display:flex;gap:6px;padding:9px 12px 8px;overflow-x:auto;scrollbar-width:none;flex:none;}
.tt-tabs::-webkit-scrollbar{display:none;}
.tt-tab{flex:none;padding:6px 11px;border:1px solid var(--line-hi);border-radius:9px;background:transparent;color:var(--ink);font:600 11px ui-monospace,monospace;cursor:pointer;white-space:nowrap;}
.tt-tab.on{color:#04231c;background:linear-gradient(180deg,var(--grn),#4fe0b0);border-color:var(--grn);}
.tt-lead{padding:0 12px 8px;font-size:10px;color:var(--dim);border-bottom:1px solid var(--line);flex:none;}
.tt-lead b{color:#4fe0b0;}
.tt-lead.closed{color:var(--amber);}
.tt-scroll{flex:1;min-height:0;overflow:auto;touch-action:pan-x pan-y;}
.tt-grid{display:flex;min-width:max-content;}
.tt-rail{position:sticky;left:0;z-index:6;flex:0 0 44px;background:var(--glass);border-right:1px solid var(--line-hi);}
.tt-dhead,.tt-chead{height:34px;display:flex;align-items:center;justify-content:center;position:sticky;top:0;z-index:5;
  background:rgba(3,14,18,.97);border-bottom:1px solid var(--line-hi);
  font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--cyan-dim);text-align:center;}
.tt-drow{height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  border-bottom:1px dashed rgba(29,107,112,.28);color:var(--dim);}
.tt-drow b{font-size:15px;color:var(--ink);}
.tt-drow small{font-size:8px;}
.tt-drow.now{background:linear-gradient(90deg,rgba(95,240,192,.14),rgba(95,240,192,.03));}
.tt-drow.now b{color:var(--grn);}
.tt-drow.future{opacity:.55;}
.tt-col{flex:0 0 112px;border-right:1px solid var(--line);}
.tt-col.w2{flex:0 0 168px;}
.tt-cellwrap{position:relative;}
.tt-cellwrap::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:2px;margin-left:-1px;
  background:linear-gradient(180deg,var(--line-hi),var(--line));opacity:.6;}
.tt-cell{position:relative;height:96px;display:flex;align-items:center;justify-content:center;gap:6px;
  border-bottom:1px dashed rgba(29,107,112,.28);}
.tt-cell.now{background:linear-gradient(90deg,rgba(95,240,192,.05),transparent);}
.tt-node{position:relative;z-index:2;width:88px;cursor:pointer;text-align:center;}
.tt-node:active{transform:scale(.95);}
.tt-box{position:relative;width:52px;height:52px;margin:0 auto;border-radius:12px;border:2px solid var(--line-hi);
  background:linear-gradient(180deg,#0f2b31,#0a1a1f);display:grid;place-items:center;
  font-size:23px;font-variant-emoji:text;color:var(--cyan);}
.tt-lbl{margin:3px auto 0;max-width:100px;font-size:8.5px;line-height:1.25;color:var(--ink);
  background:rgba(4,14,17,.92);border-radius:5px;padding:1px 3px;max-height:23px;overflow:hidden;}
.tt-node.st-done .tt-box{border-color:#4fe0b0;background:linear-gradient(180deg,#0e3b2f,#0a231e);box-shadow:0 0 14px rgba(79,224,176,.25);}
.tt-node.st-avail .tt-box{border-color:var(--cyan);box-shadow:0 0 12px rgba(53,214,230,.22);}
.tt-node.st-res .tt-box{border-color:var(--amber);}
.tt-node.st-gate .tt-box,.tt-node.st-chain .tt-box,.tt-node.st-cond .tt-box{opacity:.55;filter:saturate(.4);}
.tt-tick{position:absolute;right:-6px;bottom:-6px;font-size:10px;color:#04231c;background:#4fe0b0;border-radius:6px;padding:0 3px;}
.tt-lock{position:absolute;right:-6px;top:-6px;font-size:10px;}
.tt-cnd{position:absolute;right:-6px;top:-6px;font-size:10px;color:var(--amber);}
.tt-prog{position:absolute;left:4px;right:4px;bottom:3px;height:4px;border-radius:2px;background:rgba(255,180,58,.22);overflow:hidden;}
.tt-prog i{position:absolute;left:0;top:0;bottom:0;background:var(--amber);}
/* dossier modal over the tree (inside .twbox, so Esc/back close the whole window) */
.tt-modal{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;}
.tt-mback{position:absolute;inset:0;background:rgba(1,6,8,.72);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
.tt-mwin{position:relative;width:min(320px,calc(100% - 28px));background:linear-gradient(180deg,#0c2026,#081418);
  border:1px solid var(--line-hi);border-radius:14px;padding:14px;animation:ttpop .14s ease-out;}
@keyframes ttpop{from{transform:scale(.94);opacity:.4;}to{transform:scale(1);opacity:1;}}
.tt-mx{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
.tt-mhead{display:flex;gap:11px;align-items:center;padding-right:30px;}
.tt-mico{flex:none;width:50px;height:50px;border-radius:11px;border:2px solid var(--line-hi);
  background:linear-gradient(180deg,#0f2b31,#0a1a1f);display:grid;place-items:center;font-size:23px;font-variant-emoji:text;}
.tt-mname{font-size:13.5px;font-weight:800;color:#eafffb;}
.tt-mname .tt-tier{font-size:9px;color:var(--dim);margin-left:6px;letter-spacing:1px;}
.tt-mtags{margin-top:4px;display:flex;flex-wrap:wrap;gap:5px;}
.tt-tag{font-size:8.5px;font-weight:800;letter-spacing:.5px;border-radius:5px;padding:2px 6px;color:#04231c;background:#4fe0b0;}
.tt-tag.dim{background:#0a1a1f;color:var(--dim);border:1px solid var(--line-hi);}
.tt-tag.amb{background:var(--amber);color:#2a1602;}
.tt-mdesc{margin:10px 0 0;padding-left:10px;border-left:2px solid var(--line-hi);font-size:11px;line-height:1.55;color:var(--ink);}
.tt-mstats{margin-top:10px;display:grid;grid-template-columns:1fr;gap:5px;font-size:10.5px;color:var(--dim);}
.tt-mstats b{color:var(--ink);font-weight:600;}
.tt-mbtn{margin-top:12px;width:100%;padding:10px;border-radius:10px;border:1px solid var(--grn);cursor:pointer;
  font:800 11.5px ui-monospace,monospace;letter-spacing:1px;text-transform:uppercase;
  color:#04231c;background:linear-gradient(180deg,var(--grn),#4fe0b0);}
.tt-mbtn.wait{background:#0a1a1f;border-color:var(--line-hi);color:var(--dim);cursor:default;}
.tt-mbtn:disabled{opacity:.75;cursor:not-allowed;}
/* scientist council picker (setup-time, over the start-point screen) */
#scipick{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.74);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}
#scipick.show{display:flex;}
#scipick .twbox{display:flex;flex-direction:column;width:min(560px,96vw);max-height:88vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:12px;box-shadow:0 0 48px rgba(0,0,0,.7),inset 0 0 0 1px rgba(53,214,230,.06);}
#scipick .lw-head{display:flex;align-items:center;justify-content:space-between;}
#scipickbody{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:14px 15px;}
.sp-cancel{background:transparent;border:1px solid var(--line-hi);color:var(--dim);border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;font-size:11px;}
.sp-cancel:hover{border-color:var(--cyan-dim);color:var(--cyan);}
.sp-slots{display:grid;grid-template-columns:1fr 1fr;gap:11px;}
.sp-slot{min-height:96px;border-radius:11px;padding:12px;display:flex;flex-direction:column;gap:5px;position:relative;}
.sp-slot.empty{border:1.5px dashed var(--cyan-dim);background:rgba(53,214,230,.03);align-items:center;justify-content:center;text-align:center;color:var(--cyan-dim);}
.sp-slot.empty .sp-plus{font-size:22px;color:var(--cyan);line-height:1;}
.sp-slot.empty .sp-hint{font-size:10.5px;letter-spacing:1px;}
@media (prefers-reduced-motion:no-preference){.sp-slot.empty{animation:sppulse 1.5s ease-in-out infinite;}}
@keyframes sppulse{0%,100%{border-color:var(--cyan-dim);box-shadow:0 0 0 0 rgba(53,214,230,0);}50%{border-color:var(--cyan);box-shadow:0 0 18px 1px rgba(53,214,230,.30);background:rgba(53,214,230,.08);}}
.sp-slot.filled{border:1px solid var(--cyan);background:linear-gradient(180deg,rgba(53,214,230,.10),rgba(53,214,230,.03));}
/* name reserves the ✕-corner (long names like «Командир крыла» wrapped UNDER the
   remove button and made it look misplaced) */
.sp-slot .sp-sn{font-weight:700;color:#eafffb;font-size:13px;padding-right:24px;}
.sp-slot .sp-inf{font-size:10px;color:var(--dim);line-height:1.4;}
.sp-rm{position:absolute;top:7px;right:7px;width:18px;height:18px;border-radius:5px;border:1px solid var(--line-hi);background:transparent;color:var(--dim);cursor:pointer;font-size:10px;line-height:1;padding:0;display:grid;place-items:center;}
.sp-rm:hover{border-color:var(--red);color:var(--red);}
.sp-warn{margin-top:12px;display:flex;gap:8px;padding:10px 12px;border:1px solid #6a4a17;border-radius:9px;background:rgba(255,180,58,.09);color:#f4d199;font-size:11.5px;line-height:1.5;}
.sp-h{margin:15px 0 8px;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);}
.sp-roster{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.sp-card{text-align:left;cursor:pointer;border:1px solid var(--line-hi);border-radius:9px;padding:9px 10px;background:rgba(53,214,230,.04);color:var(--ink);font:inherit;display:flex;flex-direction:column;gap:3px;}
.sp-card:hover:not(:disabled){border-color:var(--cyan);background:rgba(53,214,230,.11);box-shadow:0 0 12px rgba(53,214,230,.16);}
.sp-card:disabled{opacity:.34;cursor:not-allowed;}
.sp-card.picked{border-color:var(--cyan-dim);}
.sp-card .sp-cn{display:flex;align-items:center;gap:6px;font-weight:700;font-size:12px;color:#eafffb;}
.sp-card .sp-tick{margin-left:auto;color:var(--grn);font-size:11px;}
.sp-card .sp-inf{font-size:9.5px;color:var(--dim);line-height:1.4;}
.sp-go{margin-top:15px;width:100%;padding:12px;border-radius:9px;cursor:pointer;border:1px solid var(--cyan);background:rgba(53,214,230,.12);color:var(--cyan);font:inherit;font-weight:700;font-size:12.5px;letter-spacing:1px;text-transform:uppercase;}
.sp-go:hover:not(:disabled){background:rgba(53,214,230,.2);box-shadow:0 0 16px rgba(53,214,230,.28);}
.sp-go:disabled{opacity:.4;cursor:not-allowed;color:var(--dim);border-color:var(--line);}
/* session market (modal, mirrors #tech; tabs mirror .dp-tab) */
#market{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#market.show{display:flex;}
#market .mkbox{display:flex;flex-direction:column;width:min(460px,94vw);max-height:82vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:10px;
  box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.mk-close{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
.mk-tabs{display:flex;gap:6px;padding:9px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.mk-tab{padding:6px 11px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:700 11px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;}
.mk-tab.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
#marketbody{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:12px 14px;}
.mk-form{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px;
  padding:10px;border:1px solid var(--line-hi);border-radius:9px;background:rgba(255,255,255,.02);}
.mk-seg{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;}
.mk-seg button{padding:6px 10px;border:0;background:transparent;color:var(--dim);font:700 11px ui-monospace,monospace;cursor:pointer;}
.mk-seg button.on{color:var(--cyan);background:rgba(53,214,230,.12);}
.mk-in{width:64px;padding:6px 7px;border:1px solid var(--line-hi);border-radius:6px;background:rgba(0,0,0,.25);
  color:var(--ink);font:12px ui-monospace,monospace;}
.mk-lbl{font-size:10px;color:var(--dim);}
.mk-go{margin-left:auto;padding:7px 12px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.14);
  color:var(--cyan);font:11px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;}
.mk-go:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
.mk-sec{margin:12px 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);}
.mk-sec.buy{color:var(--amber);}
.mk-row{display:flex;align-items:center;gap:9px;padding:8px 10px;margin-bottom:6px;border:1px solid var(--line-hi);
  border-radius:8px;background:rgba(255,255,255,.02);}
.mk-row .mk-qp{font-size:13px;color:var(--ink);}
.mk-row .mk-qp b{color:var(--cyan);}
.mk-row.buy .mk-qp b{color:var(--amber);}
.mk-row .mk-who{flex:1;min-width:0;font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mk-btn{flex:none;padding:6px 11px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.14);
  color:var(--cyan);font:11px ui-monospace,monospace;cursor:pointer;white-space:nowrap;}
.mk-btn.cancel{border-color:var(--line-hi);color:var(--dim);background:transparent;}
.mk-btn:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
.mk-empty{padding:10px 2px;font-size:11px;color:var(--dim);opacity:.8;}

/* === CONSTRUCTOR («Верфь») — unified loadout tab; two-column ship-outfit designer === */
#constructor{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.6);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#constructor.show{display:flex;}
#constructor .cnbox{display:flex;flex-direction:column;width:min(960px,96vw);max-height:90vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:12px;
  box-shadow:0 0 48px rgba(0,0,0,.66),inset 0 0 0 1px rgba(53,214,230,.06);}
#constructor .cn-head{display:flex;align-items:center;gap:10px;padding:12px 15px;border-bottom:1px solid var(--line);}
#constructor .cn-head b{font:800 14px ui-monospace,monospace;letter-spacing:1.5px;color:#eafffb;}
.cn-close{margin-left:auto;width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
.cn-tabs{display:flex;gap:6px;padding:9px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.cn-tab{padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:700 11px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;}
.cn-tab.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
#constructorbody{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:14px 16px;}
#constructorbody #herobody{padding:0;overflow:visible;}/* folded hero pane: no nested pad/scroll */
/* two columns: fitting editor (left) + live preview/cost/build (right); stacks on narrow */
.cn-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;}
@media (max-width:760px){.cn-grid{grid-template-columns:1fr;}}
/* hull picker */
.cn-hulls{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px;}
.cn-hbtn{padding:6px 11px;border-radius:8px;border:1px solid var(--line-hi);background:rgba(53,214,230,.03);color:var(--dim);
  font:700 11px ui-monospace,monospace;cursor:pointer;}
.cn-hbtn.on{color:var(--cyan);border-color:var(--cyan);background:rgba(53,214,230,.12);}
/* hull card */
.cn-hull{display:flex;align-items:center;gap:13px;padding:13px 15px;border:1px solid var(--cyan-dim);border-radius:11px;
  background:linear-gradient(180deg,rgba(53,214,230,.08),rgba(53,214,230,.02));margin-bottom:12px;}
.cn-hull .cn-hic{width:50px;height:50px;border-radius:10px;border:1px solid var(--cyan);display:flex;align-items:center;
  justify-content:center;font-size:26px;color:var(--cyan);background:rgba(53,214,230,.06);}
.cn-hull .cn-hn{font:800 16px ui-monospace,monospace;color:#eafffb;}
.cn-hull .cn-hm{font-size:11px;color:var(--cyan);margin-top:2px;}
/* typed slot bays */
.cn-bay{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line-hi);border-radius:10px;margin-bottom:8px;
  background:rgba(255,255,255,.02);}
.cn-bay.empty{border-style:dashed;color:var(--dim);}
.cn-bay .cn-bic{width:40px;height:40px;border-radius:9px;border:1px solid var(--line-hi);display:flex;align-items:center;
  justify-content:center;font-size:19px;color:var(--cyan);}
.cn-bay.empty .cn-bic{color:var(--cyan-dim);}
.cn-bay .cn-bt{font-size:9.5px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);}
.cn-bay .cn-bn{font:700 13px ui-monospace,monospace;color:var(--ink);margin-top:2px;}
.cn-bay.empty .cn-bn{color:var(--dim);font-weight:400;}
.cn-bay .cn-bd{margin-left:auto;font:700 12px ui-monospace,monospace;color:var(--grn);}
.cn-bay.filled{cursor:pointer;}
.cn-bay.filled:hover{border-color:var(--red);}
/* palette */
.cn-ph{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan);margin:14px 0 8px;}
.cn-ph em{color:var(--dim);font-style:normal;text-transform:none;letter-spacing:0;}
.cn-pal{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.cn-mod{text-align:left;padding:11px 11px;border:1px solid var(--line-hi);border-radius:10px;background:rgba(53,214,230,.04);
  cursor:pointer;color:var(--ink);font:inherit;display:flex;flex-direction:column;gap:3px;}
.cn-mod:hover:not(.locked){border-color:var(--cyan);box-shadow:0 0 12px rgba(53,214,230,.18);}
.cn-mod .cn-mic{font-size:20px;line-height:1;color:var(--cyan);}
.cn-mod .cn-mn{font:700 11.5px ui-monospace,monospace;color:#eafffb;}
.cn-mod .cn-me{font-size:10.5px;color:var(--grn);}
.cn-mod .cn-mc{font-size:10px;color:var(--dim);}
.cn-mod.locked{opacity:.42;cursor:not-allowed;background:rgba(255,255,255,.015);}
.cn-mod.locked .cn-mic,.cn-mod.locked .cn-mn{color:var(--dim);}
.cn-mod.locked .cn-me{color:var(--dim);}
/* LARS-4: origin tag on a bay/palette card ("fresh from a drop/craft/auction") */
.cn-mo,.cn-bay .cn-mo{margin-left:6px;padding:1px 6px;border-radius:8px;border:1px solid var(--amber-dim,var(--line-hi));
  color:var(--amber,var(--cyan));font:600 9px ui-monospace,monospace;letter-spacing:.3px;vertical-align:middle;}
.cn-note{margin-top:11px;font-size:10.5px;color:var(--dim);line-height:1.5;}
.cn-note b{color:var(--cyan);}
/* live stat preview bars (right column) */
.cn-stat{margin-bottom:11px;}
.cn-srow{display:flex;align-items:baseline;gap:8px;margin-bottom:5px;}
.cn-snm{font:700 12px ui-monospace,monospace;color:#eafffb;}
.cn-sval{margin-left:auto;font:12px ui-monospace,monospace;color:var(--dim);}
.cn-sval b{color:#eafffb;}
.cn-up{color:var(--grn);font-weight:700;}
.cn-strack{position:relative;height:7px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;display:flex;}
.cn-sbar{height:100%;background:var(--cyan);opacity:.75;}
.cn-sdelta{height:100%;background:var(--grn);}
/* right column: preview + cost + build */
.cn-side .cn-ph{margin-top:0;}
.cn-cost{margin:14px 0 4px;border-top:1px solid var(--line);padding-top:12px;}
.cn-cost .cn-crow{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dim);margin-bottom:5px;}
.cn-cost .cn-crow .cn-cv{margin-left:auto;color:var(--ink);font:700 12px ui-monospace,monospace;}
.cn-cost .cn-crow.total .cn-cl{color:#eafffb;font-weight:700;}
.cn-cost .cn-crow.total .cn-cv{color:var(--amber);font-size:14px;}
.cn-build{width:100%;margin-top:12px;padding:14px;border-radius:10px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.16);color:var(--cyan);font:800 14px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
.cn-build:hover:not(:disabled){background:rgba(53,214,230,.24);box-shadow:0 0 20px rgba(53,214,230,.25);}
.cn-build:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
.cn-lock{margin-top:12px;display:flex;gap:8px;font-size:11px;color:var(--dim);line-height:1.5;}
.cn-lock b{color:var(--amber);}
/* count + planet steppers */
.cn-row2{display:flex;align-items:center;gap:10px;margin:12px 0 4px;flex-wrap:wrap;}
.cn-step{display:flex;align-items:center;border:1px solid var(--line-hi);border-radius:8px;overflow:hidden;}
.cn-step button{width:32px;height:32px;border:0;background:transparent;color:var(--cyan);font-size:16px;cursor:pointer;}
.cn-step button:disabled{opacity:.35;cursor:not-allowed;}
.cn-step .cn-sv{min-width:34px;text-align:center;font:700 13px ui-monospace,monospace;color:#eafffb;}
.cn-plan{flex:1;min-width:120px;padding:8px 10px;border:1px solid var(--line-hi);border-radius:8px;background:rgba(0,0,0,.25);
  color:var(--ink);font:12px ui-monospace,monospace;}
.cn-soon{padding:26px 14px;text-align:center;color:var(--dim);font-size:12.5px;line-height:1.6;}
.cn-soon .cn-si{font-size:30px;margin-bottom:8px;opacity:.7;}
/* army pane: 6-slot formation grid + synergies */
.cn-fgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:2px;}
.cn-fslot{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 6px;border:1px dashed var(--line-hi);
  border-radius:10px;background:rgba(255,255,255,.02);cursor:pointer;color:var(--dim);font:inherit;}
.cn-fslot.filled{border-style:solid;border-color:var(--cyan-dim);background:rgba(53,214,230,.06);}
.cn-fslot:hover{border-color:var(--cyan);}
.cn-fslot .cn-fic{font-size:22px;line-height:1;}
.cn-fslot .cn-fn{font:700 11px ui-monospace,monospace;color:#eafffb;}
.cn-fslot .cn-fn.dim,.cn-fslot .cn-fic.dim{color:var(--dim);font-weight:400;}
.cn-syn{display:flex;gap:7px;align-items:center;padding:7px 10px;margin-bottom:6px;border:1px solid var(--cyan-dim);
  border-radius:8px;background:rgba(53,214,230,.06);font-size:11.5px;color:var(--cyan);}
/* --- phone: reclaim width, roomier tap targets, and a 2-col module palette so tiles
   stop wrapping their names (the .cn-grid already stacks to one column at 760px) --- */
@media (max-width:560px){
  #constructor{padding:9px;}
  #constructorbody{padding:13px 12px;}
  .cn-tabs{gap:5px;padding:9px 10px;}
  .cn-tab{padding:9px 12px;font-size:11.5px;}
  .cn-close{width:36px;height:36px;}
  .cn-pal{grid-template-columns:repeat(2,1fr);}
  .cn-hbtn{padding:9px 12px;}
  .cn-step button{width:38px;height:38px;}
  .cn-build{padding:15px;}
}

/* === FLOATING CHAT (desktop) — sized/positioned/opacity inline by renderChat() === */
.desk-only{} /* shown by default; the media query below hides it on phones */
@media (max-width:720px), ((hover: none) and (pointer: coarse) and (max-height: 520px)){.desk-only{display:none!important;}}
/* border-color + background alpha are set inline by applyChatGeom() so the
   transparency slider fades the frame too, not just the fill */
#chatwin{position:fixed;z-index:27;display:none;flex-direction:column;overflow:visible;
  background:var(--glass);border:1px solid var(--cyan);border-radius:11px;
  box-shadow:0 0 30px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#chatwin.open{display:flex;}
#chatwin.min{height:auto!important;}
#chatwin.min .cw-tabs,#chatwin.min .cw-feed,#chatwin.min .cw-compose{display:none;}
/* the title bar doubles as the drag handle (Windows-style); locked when pinned */
.cw-head{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 9px;border-bottom:1px solid var(--line-hi);
  cursor:move;flex:0 0 auto;border-radius:11px 11px 0 0;}
#chatwin.pinned .cw-head{cursor:default;}
.cw-title{font:700 10px ui-monospace,monospace;letter-spacing:2px;color:var(--cyan-dim);flex:1;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* head controls reveal only while the pointer is over the window */
.cw-btn{width:24px;height:24px;flex:0 0 auto;border:1px solid var(--line);border-radius:5px;background:transparent;
  color:var(--cyan-dim);font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .12s;}
#chatwin:hover .cw-btn{opacity:1;}
.cw-btn:hover{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
.cw-btn.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.16);}
.cw-tabs{display:flex;gap:3px;padding:6px 6px 0;flex-wrap:wrap;flex:0 0 auto;}
.cw-tab{padding:4px 8px;border:1px solid var(--line);border-bottom:0;border-radius:6px 6px 0 0;background:transparent;
  color:var(--dim);font:11px ui-monospace,monospace;cursor:pointer;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cw-tab.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.1);}
.cw-feed{flex:1;min-height:0;overflow:auto;padding:9px 11px;display:flex;flex-direction:column;gap:6px;
  border-top:1px solid var(--line-hi);scrollbar-width:thin;}
#chatwin .dp-line{font-size:inherit;}
.cw-empty{color:var(--dim);font-size:11px;text-align:center;margin:auto;padding:14px;line-height:1.5;}
.cw-compose{display:flex;gap:6px;padding:7px 8px;border-top:1px solid var(--line-hi);flex:0 0 auto;}
.cw-compose input{flex:1;min-width:0;padding:7px 9px;background:rgba(2,10,14,.9);border:1px solid var(--line-hi);
  border-radius:6px;color:var(--ink);font:12px ui-monospace,monospace;}
.cw-compose input:focus{outline:none;border-color:var(--cyan);}
.cw-send{flex:0 0 auto;width:34px;border:1px solid var(--cyan);border-radius:6px;background:rgba(53,214,230,.14);
  color:var(--cyan);cursor:pointer;font-size:13px;}
/* settings popover — flies out to the right of the window */
.cw-set{position:absolute;left:calc(100% + 8px);top:0;width:230px;padding:12px;background:var(--glass);
  border:1px solid var(--cyan);border-radius:11px;box-shadow:0 0 26px rgba(0,0,0,.6);font:11px ui-monospace,monospace;}
.cw-set,.cw-set *{box-sizing:border-box;}
.cw-set h4{margin:0 0 9px;color:var(--cyan);font-size:11px;letter-spacing:1.5px;}
.cw-srow{display:flex;align-items:center;gap:8px;margin:9px 0;color:var(--ink);}
.cw-srow label{flex:1;min-width:0;color:var(--dim);}
.cw-srow input[type=number]{width:52px;padding:4px 6px;background:rgba(2,10,14,.9);border:1px solid var(--line-hi);
  border-radius:5px;color:var(--ink);font:11px ui-monospace,monospace;}
.cw-srow input[type=range]{flex:1;min-width:0;accent-color:var(--cyan);}
.cw-srow input[type=color]{width:34px;height:22px;padding:0;border:1px solid var(--line-hi);border-radius:5px;background:none;}
.cw-srow input[disabled]{opacity:.4;cursor:not-allowed;}
.cw-sub{flex:0 0 auto;font-size:9px;color:var(--amber);letter-spacing:.5px;white-space:nowrap;}
.cw-opval{flex:0 0 auto;font-size:9px;color:var(--dim);width:30px;text-align:right;}
.cw-shdr{margin:13px 0 4px;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--grn-dim);
  border-top:1px solid var(--line);padding-top:9px;}
/* === /FLOATING CHAT === */

#banner{display:none;position:fixed;inset:0;margin:auto;height:fit-content;width:fit-content;z-index:40;
  padding:18px 34px;font-size:20px;font-weight:700;letter-spacing:3px;text-align:center;text-transform:uppercase;
  background:rgba(2,9,13,.94);border:1px solid var(--cyan);color:var(--cyan);
  box-shadow:0 0 40px rgba(53,214,230,.25),inset 0 0 30px rgba(53,214,230,.06);
  clip-path:polygon(0 12px,12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%);}
#banner .bn-btn{display:inline-block;margin-top:16px;padding:10px 22px;cursor:pointer;border:1px solid var(--cyan);
  border-radius:6px;background:rgba(53,214,230,.14);color:var(--cyan);text-transform:none;letter-spacing:1px;
  font:700 13px ui-monospace,monospace;}
#banner .bn-btn:hover{background:rgba(53,214,230,.26);box-shadow:0 0 12px rgba(53,214,230,.4);}

/* end screen — the match-over overlay: outcome + stats + rematch. z above the banner. */
#endscreen{display:none;position:fixed;inset:0;z-index:56;align-items:center;justify-content:center;
  padding:20px;background:rgba(1,6,9,.78);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}
#endscreen.show{display:flex;}
#endscreen .es-box{width:min(440px,94vw);max-height:92vh;overflow:auto;background:var(--glass);
  border:1px solid var(--cyan);border-radius:12px;padding:22px 22px 18px;text-align:center;
  box-shadow:0 0 50px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#endscreen .es-head{font-size:30px;font-weight:800;letter-spacing:3px;text-transform:uppercase;line-height:1.1;}
#endscreen .es-head.win{color:#4fe0b0;text-shadow:0 0 18px rgba(79,224,176,.45);}
#endscreen .es-head.lose{color:#e5484d;text-shadow:0 0 18px rgba(229,72,77,.4);}
#endscreen .es-head.draw{color:var(--amber);text-shadow:0 0 18px rgba(232,178,74,.4);}
#endscreen .es-why{margin-top:7px;font-size:12px;color:var(--dim);letter-spacing:.4px;}
#endscreen .es-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:18px 0 6px;}
#endscreen .es-cell{border:1px solid var(--line-hi);border-radius:8px;padding:9px 10px;background:rgba(6,18,22,.6);
  display:flex;flex-direction:column;gap:3px;}
#endscreen .es-cell.wide{grid-column:1 / -1;}
#endscreen .es-k{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--cyan-dim);}
#endscreen .es-v{font-size:18px;font-weight:700;color:#eafffb;font-variant-numeric:tabular-nums;}
#endscreen .es-v small{font-size:11px;color:var(--dim);font-weight:400;}
#endscreen .es-xp{margin:8px 0 2px;font-size:13px;color:var(--amber);font-weight:700;}
#endscreen .es-xp .lvl{display:block;margin-top:3px;font-size:11px;color:var(--cyan);font-weight:400;}
#endscreen .es-acts{display:flex;flex-wrap:wrap;gap:9px;margin-top:16px;}
#endscreen .es-btn{flex:1 1 45%;min-width:120px;padding:12px;border-radius:8px;cursor:pointer;
  font:700 13px ui-monospace,monospace;letter-spacing:.5px;border:1px solid var(--line-hi);
  background:transparent;color:var(--ink);}
#endscreen .es-btn.primary{border-color:var(--cyan);background:rgba(53,214,230,.16);color:var(--cyan);}
#endscreen .es-btn.primary:hover{background:rgba(53,214,230,.28);box-shadow:0 0 12px rgba(53,214,230,.35);}
#endscreen .es-btn:hover{border-color:var(--cyan-dim);}
#endscreen .es-btn.ghost{flex-basis:100%;background:transparent;color:var(--dim);border-color:var(--line);}

@media (max-width:720px), ((hover: none) and (pointer: coarse) and (max-height: 520px)){
  #top{height:44px;}
  .who{display:none;}
  /* phones: the left crest is just the player emblem (title hidden) */
  .crest{padding:0 8px;}
  #crestmark{width:30px;height:30px;font-size:16px;}
  #devline{top:44px;}
  /* the chips get the full bar now (donate moved under it) — tighten just a touch */
  /* APK / phones: stack the icon OVER the number so each value gets the full chip width */
  .res{flex-direction:column;gap:1px;padding:0 3px;}
  .res i{width:20px;height:20px;font-size:12px;}
  .res b{font-size:13px;}
  /* the value line sizes to its content on the stacked layout so the flow rate shows */
  .rv{flex:none;gap:2px;overflow:visible;}
  #devline .dl-donate{font-size:11px;padding:2px 8px;}

  /* phones: three tabs + ✕ no longer fit beside the window title — the tabs alone
     identify the window, so the «ДИПЛОМАТИЯ» caption yields its room to them */
  #diplo .dp-head b{display:none;}
  #diplo .dp-tab{padding:6px 9px;}
  #side{right:0;left:0;bottom:0;top:auto;width:auto;max-height:50vh;z-index:28;clip-path:none;
    border-left:0;border-right:0;border-top:1px solid var(--cyan);
    padding-bottom:env(safe-area-inset-bottom,0px);}
  /* bottom-sheet affordance: the little grab-bar phones use to say "this is a sheet" */
  #side::before{content:'';position:absolute;top:6px;left:50%;transform:translateX(-50%);
    width:42px;height:4px;border-radius:2px;background:rgba(53,214,230,.35);pointer-events:none;}
  /* the bottom-sheet (z-index 28) opens OVER the corner rail: the hamburger stays put at
     the bottom-left and the panel covers it, instead of the rail jumping up into the
     command bar and overlapping it. Hidden while a panel is open (reopen by closing it). */
  body.sheet-open #rail{opacity:0;pointer-events:none;}
  /* phones have no hover and no room — drop the dossier pane, content fills width */
  .pdesc{display:none;}
  .pscroll{padding:13px 14px;}
  /* phones: no horizontal columns — a single readable top-to-bottom stack */
  .pcols{column-width:auto;column-count:1;column-rule:none;}
  .pcols .block{margin-bottom:0;}
  /* phones are wide enough for one line — keep asset rows un-wrapped as before */
  .asset-row{flex-wrap:nowrap;}
  .asset-row b{flex:0 1 auto;min-width:120px;}
  .asset-row .b{margin-left:0;}

  /* speed control sits at the bottom-right; it hides under the sheet, and a
     selection opens the sheet, so it never collides with the command bar */
  #speedbar{right:10px;bottom:12px;top:auto;padding:4px 6px;}
  body.sheet-open #speedbar{display:none;}

  #banner{font-size:16px;padding:14px 20px;letter-spacing:2px;}
  /* finger-first targets: everything tappable grows to the 44px rule (hud-inmatch.md) */
  button.b{padding:9px 12px;font-size:12px;min-height:44px;}
  #railtools button{width:46px;height:46px;}
  #railtoggle{width:50px;height:50px;font-size:22px;}
  .spd button{min-width:42px;height:44px;font-size:12px;}
  .spd .spdmini{min-width:38px;}
  .pclose{width:44px;height:44px;font-size:14px;}
  .ptab{min-height:42px;}
  /* market listing form: label+input pairs lock together on a grid, the segment
     switch and the submit span the full width — no orphaned inputs on wrap */
  .mk-form{display:grid;grid-template-columns:auto 1fr auto 1fr;align-items:center;}
  .mk-form .mk-seg{grid-column:1 / -1;justify-self:start;}
  .mk-form .mk-go{grid-column:1 / -1;justify-self:stretch;min-height:44px;}
  /* toasts (goal line etc.) wrap to two lines instead of clipping with an ellipsis
     that hides the rest and offers no way to read it */
  #toasts .toast{white-space:normal;text-overflow:clip;line-height:1.45;}
  /* the status line lies over bright provinces — give it a real backdrop */
  #devline{background:rgba(2,8,11,.9);}
  /* setup: the LAUNCH button must never scroll below the fold — the pane scrolls,
     the CTA (and Back) stay pinned at the bottom of the box */
  #setup .sbox{display:flex;flex-direction:column;overflow:hidden;}
  #setup .spane{flex:1 1 auto;min-height:0;overflow:auto;}
  #setup .sgo,#setup .scancel{flex:0 0 auto;}
  /* rail: icons get tiny labels — seven unlabeled glyphs read as a puzzle */
  #railtools button{width:64px;height:54px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:3px;}
  #railtools .rlbl{display:block;}
  /* window close-✕ buttons reach the 44px thumb rule */
  .dp-close,.mk-close,.lw-head button{min-width:44px;min-height:44px;}
  /* notched phones: controls step inside the safe area instead of under the notch */
  #top{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);
    padding-top:env(safe-area-inset-top,0px);height:calc(46px + env(safe-area-inset-top,0px));}
  #devline{top:calc(44px + env(safe-area-inset-top,0px));}
  #fps{top:calc(78px + env(safe-area-inset-top,0px));}
  #rail{padding-bottom:env(safe-area-inset-bottom);}
  #speedbar{bottom:calc(12px + env(safe-area-inset-bottom));}
  #cmdbar{bottom:calc(10px + env(safe-area-inset-bottom));gap:5px;
    left:8px;right:8px;transform:none;justify-content:center;flex-wrap:wrap;row-gap:5px;}
  #cmdbar button .cl{font-size:10px;}
  #cmdbar .cmdlabel{display:none;}
  #cmdbar button{min-width:56px;height:52px;}
  #cmdbar button .ci{font-size:20px;}
  body.sheet-open #cmdbar{bottom:calc(50vh + 8px);}
}
/* connect overlay — entry screen (single-player vs join a live session) */
#connect{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  padding:20px;background:radial-gradient(120% 100% at 50% 30%,rgba(4,20,28,.92),rgba(1,4,10,.97));
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#connect .cbox{width:min(520px,94vw);background:var(--glass);border:1px solid var(--line-hi);
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
#connect .cwlogin{display:flex;gap:8px;margin-top:10px;}
#connect .cwlogin input{flex:1;min-width:0;padding:11px 12px;background:rgba(2,10,14,.9);border:1px solid var(--line-hi);
  border-radius:7px;color:var(--ink);font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3px;}
#connect .cwlogin input:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 0 2px rgba(53,214,230,.2);}
#connect .cwlogin .cbtn{flex:0 0 auto;min-width:92px;}
#connect .cstat{margin-top:14px;min-height:16px;font-size:12px;color:var(--amber);text-align:center;}
#connect .mtabs{display:flex;gap:6px;margin-top:16px;}
#connect .mtab{flex:1;padding:8px 6px;border-radius:7px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;}
#connect .mtab.active{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.10);}
#connect .mlist{margin-top:10px;max-height:46vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;}
#connect .mempty{padding:18px 8px 8px;text-align:center;color:var(--dim);font-size:12px;}
#connect .msolo{padding:6px 8px 16px;text-align:center;}
#connect .msolo .mbtn{font-size:13px;padding:10px 18px;}
#connect .msolo-sub{margin-top:6px;color:var(--dim);font-size:11px;}
#connect .mrow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line-hi);
  border-radius:8px;background:rgba(255,255,255,.02);}
#connect .minfo{flex:1;min-width:0;}
#connect .mname{font-size:13px;color:var(--txt,#dfeef2);text-transform:capitalize;}
#connect .mname .mid{font-size:10px;color:var(--dim);letter-spacing:.5px;text-transform:none;margin-left:6px;}
#connect .mmeta{margin-top:3px;font-size:11px;color:var(--dim);}
#connect .mmeta .mwin{color:var(--cyan-dim,#6cc);}
#connect .mmeta .mwin.soon{color:var(--amber,#e0a942);}
#connect .mmeta .mwin.shut{color:var(--dim);text-decoration:line-through;}
#connect .mbtns{display:flex;gap:6px;flex:none;}
#connect .mbtn{padding:8px 11px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.12);
  color:var(--cyan);font-size:11px;cursor:pointer;white-space:nowrap;}
#connect .mbtn.ghost{border-color:var(--line-hi);background:transparent;color:var(--dim);}
#connect .mbtn:active{background:rgba(53,214,230,.24);}
/* welcome stage — first-launch identity screen (new commander / sign-in / single-player) */
#connect .cwrap{position:relative;width:min(520px,94vw);}
#connect .clang{position:absolute;top:-46px;right:0;display:flex;align-items:center;gap:7px;
  padding:7px 13px;background:rgba(3,12,16,.72);border:1px solid var(--line-hi);border-radius:7px;
  color:var(--dim);font:11px ui-monospace,monospace;letter-spacing:2px;cursor:pointer;}
#connect .clang:hover{border-color:var(--cyan-dim);color:var(--ink);}
#connect .clang .car{font-size:7px;opacity:.7;}
#connect .ccrest{display:flex;flex-direction:column;align-items:center;gap:9px;margin:4px 0 24px;}
#connect .ccrest .ring{position:relative;width:62px;height:62px;display:grid;place-items:center;}
#connect .ccrest .ring .dia{width:32px;height:32px;transform:rotate(45deg);border:2px solid var(--cyan);
  background:rgba(53,214,230,.12);box-shadow:0 0 22px rgba(53,214,230,.5),inset 0 0 12px rgba(53,214,230,.3);}
#connect .ccrest .ring::before{content:"";position:absolute;inset:-8px;border:1px solid var(--line-hi);
  border-radius:50%;opacity:.55;}
#connect .ccrest .wm{font-size:clamp(20px,6.5vw,26px);letter-spacing:clamp(3px,2vw,8px);color:var(--cyan);
  font-weight:700;text-shadow:0 0 18px rgba(53,214,230,.45);text-align:center;white-space:nowrap;}
#connect .ccrest .wtag{font-size:10px;letter-spacing:clamp(2px,1.4vw,5px);color:var(--cyan-dim);text-transform:uppercase;}
#connect .cnew{width:100%;padding:16px;border-radius:10px;border:1px solid var(--cyan);cursor:pointer;
  background:linear-gradient(180deg,rgba(53,214,230,.30),rgba(53,214,230,.12));color:#eafdff;
  font:700 15px ui-monospace,monospace;letter-spacing:2px;box-shadow:0 0 26px rgba(53,214,230,.26);min-height:54px;}
#connect .cnew:active{background:linear-gradient(180deg,rgba(53,214,230,.44),rgba(53,214,230,.20));}
#connect .cdiv{display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:var(--dim);
  font-size:10px;letter-spacing:2px;text-transform:uppercase;}
#connect .cdiv::before,#connect .cdiv::after{content:"";flex:1;height:1px;background:var(--line-hi);}
#connect .csocial{display:flex;gap:12px;justify-content:center;}
#connect .csoc{width:52px;height:52px;border-radius:50%;border:1px solid var(--line-hi);background:rgba(3,12,16,.72);
  display:grid;place-items:center;cursor:pointer;color:var(--ink);font:700 17px system-ui,sans-serif;}
#connect .csoc:hover{border-color:var(--cyan);box-shadow:0 0 12px rgba(53,214,230,.3);color:var(--cyan);}
#connect .cstack{display:flex;flex-direction:column;gap:10px;margin-top:18px;}
#connect .cback{align-self:flex-start;background:none;border:none;color:var(--dim);
  font:12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;padding:0;margin-bottom:8px;}
#connect .cback:hover{color:var(--cyan);}
#connect .cfoot{position:absolute;left:0;right:0;bottom:-50px;display:flex;flex-wrap:wrap;
  justify-content:center;gap:6px 16px;padding:0 8px;}
#connect .cfoot a{color:var(--cyan-dim);font-size:10px;letter-spacing:.5px;text-decoration:none;cursor:pointer;opacity:.85;}
#connect .cfoot a:hover{color:var(--cyan);opacity:1;}
#setup{position:fixed;inset:0;z-index:58;display:none;align-items:center;justify-content:center;
  background:rgba(2,8,11,.72);}
#setup .sbox{width:min(560px,95vw);max-height:92vh;overflow:auto;background:var(--glass);
  border:1px solid var(--line-hi);border-radius:14px;padding:22px;box-shadow:0 0 40px rgba(0,0,0,.6);}
#setup .stitle{display:flex;align-items:center;gap:10px;font-size:18px;letter-spacing:3px;color:var(--cyan);}
#setup .stitle .dia{width:12px;height:12px;transform:rotate(45deg);background:var(--cyan);box-shadow:0 0 10px var(--cyan);border:none;}
#setup .ssub{margin:8px 0 14px;color:var(--dim);font-size:12px;line-height:1.5;}
#setup .smap{width:100%;height:200px;display:block;border:1px solid var(--line-hi);border-radius:10px;
  background:radial-gradient(circle at 50% 40%,rgba(53,214,230,.06),transparent 70%),#06141a;margin-bottom:6px;}
#setup .smap .cand{cursor:pointer;}
#setup .smaphint{text-align:center;color:var(--dim);font-size:11px;margin:0 0 14px;}
#setup .sslots{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}
/* H3 faction picker: four houses, each a pure passive bonus (economy or units) */
#setup .fph{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:0 0 6px;}
#setup .fpick{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
#setup .fchip{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 11px;border:1px solid var(--line-hi);
  border-radius:9px;background:rgba(255,255,255,.02);color:var(--dim);cursor:pointer;font:inherit;}
#setup .fchip b{font:700 12px ui-monospace,monospace;color:#eafffb;}
#setup .fchip span{font:10.5px ui-monospace,monospace;color:var(--grn);}
#setup .fchip.on{border-color:var(--cyan);background:rgba(53,214,230,.1);}
#setup .fchip.on b{color:var(--cyan);}
#setup .srow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line-hi);
  border-radius:8px;font:13px ui-monospace,monospace;color:var(--ink);}
#setup .srow .dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor;}
#setup .srow .nm{flex:1;}
#setup .srow .you{font-size:10px;color:var(--cyan);letter-spacing:1px;}
#setup .srow.off{opacity:.45;}
#setup .srow .stog{font:11px ui-monospace,monospace;letter-spacing:1px;border:1px solid var(--line-hi);
  border-radius:6px;padding:6px 12px;min-width:64px;cursor:pointer;background:transparent;color:var(--dim);}
#setup .srow .stog.ai{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
#setup .tmrow{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
#setup .tmtog{flex:1;padding:9px 12px;border-radius:8px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font:700 12px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;text-align:left;}
#setup .tmtog.on{border-color:var(--amber);color:var(--amber);background:rgba(232,178,74,.12);}
#setup .tmhint{font-size:10px;color:var(--dim);letter-spacing:.3px;}
#setup .srow .tmchip{width:30px;height:30px;flex:none;border-radius:7px;border:1px solid var(--line-hi);
  background:transparent;font:800 13px ui-monospace,monospace;cursor:pointer;color:var(--dim);}
#setup .srow .tmchip.sA{border-color:#4fe0b0;color:#4fe0b0;background:rgba(79,224,176,.14);}
#setup .srow .tmchip.sB{border-color:#e5884a;color:#e5884a;background:rgba(229,136,74,.14);}
#setup .srow .tmchip.lock{cursor:default;opacity:.85;}
#setup .sspeedlabel{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:0 0 4px;}
#setup .sspeedhint{font-size:11px;color:var(--dim);margin:0 0 8px;line-height:1.45;}
#setup .sspeed{display:flex;gap:8px;margin-bottom:16px;}
#setup .sspeed .spdchip{flex:1;padding:10px 6px;border-radius:8px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font:13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
#setup .sspeed .spdchip.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.14);}
#setup .sgo{width:100%;padding:13px 10px;border-radius:8px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.16);color:var(--cyan);font:600 13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;min-height:46px;}
#setup .sgo:disabled{opacity:.4;cursor:not-allowed;}
#setup .scancel{width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--line-hi);
  background:transparent;color:var(--dim);font:12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
/* setup tabs (Старт / Дивизии) + division designer */
#setup .stabs{display:flex;gap:6px;margin:12px 0 14px;}
#setup .stabs button{flex:1;padding:9px;border:1px solid var(--line-hi);border-radius:8px;background:transparent;
  color:var(--dim);font:600 12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
#setup .stabs button.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
#setup .tpl-tabs{display:flex;gap:6px;margin-bottom:12px;}
#setup .tpl-tabs button{flex:1;padding:8px 6px;border:1px solid var(--line-hi);border-radius:7px;background:transparent;
  color:var(--ink);font:12px ui-monospace,monospace;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#setup .tpl-tabs button.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
#setup .tpl-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;}
#setup .tslot{padding:12px 6px;border:1px dashed var(--line-hi);border-radius:8px;background:rgba(255,255,255,.02);
  text-align:center;cursor:pointer;min-height:64px;display:flex;flex-direction:column;justify-content:center;gap:3px;}
#setup .tslot .ic{font-size:20px;line-height:1;}
#setup .tslot .nm{font:11px ui-monospace,monospace;color:var(--ink);}
#setup .tslot.empty{opacity:.5;}
#setup .tslot.empty .nm{color:var(--dim);}
#setup .tpl-stats{border:1px solid var(--line-hi);border-radius:8px;padding:12px;margin-bottom:6px;font:12px ui-monospace,monospace;}
#setup .tpl-stats .row{display:flex;gap:14px;color:var(--ink);margin-bottom:8px;flex-wrap:wrap;}
#setup .tpl-stats .syn{display:block;color:var(--cyan);font-size:11px;margin-top:4px;line-height:1.5;}
#setup .tpl-stats .syn.none{color:var(--dim);}
#setup .tpl-cost{color:var(--dim);font-size:11px;margin-top:6px;}
/* polished live stat preview — labelled rows with base→derived + a track bar (the
   approved loadout-menu look). Shared by the ship / hero / squadron fitting panes. */
.lstats{border:1px solid var(--line-hi);border-radius:10px;padding:13px 14px;margin-bottom:8px;background:rgba(255,255,255,.02);}
.lstats .lhd{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);font-weight:800;margin-bottom:11px;}
.lstats .lsum{font-size:12px;color:var(--ink);line-height:1.7;}
.lstats .lsum b{color:#eafffb;}
.lstats .lsum .lpl{color:var(--amber);}
.lstat{margin-bottom:11px;}
.lstat:last-child{margin-bottom:0;}
.lstat .lrow{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:4px;}
.lstat .lnm{color:var(--dim);font-weight:700;}
.lstat .lval{font-weight:800;color:#eafffb;}
.lstat .lval .lb{color:var(--dim);font-weight:600;}
.lstat .lval .lup{color:var(--grn);}
.lstat .lval .ldn{color:var(--amber);}
.lstat .ltrack{height:7px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;display:flex;}
.lstat .ltrack .lbar{background:var(--cyan-dim);}
.lstat .ltrack .ldelta{background:var(--grn);}
.synlist{border:1px solid var(--line);border-radius:10px;padding:11px 13px;}
.synlist .syn{display:block;color:var(--cyan);font-size:11px;line-height:1.55;margin-bottom:4px;}
.synlist .syn:last-child{margin-bottom:0;}
.synlist .syn em{color:var(--amber);font-style:normal;}
.synlist .syn.none{color:var(--dim);}
/* hero fitting — Minecraft-inventory style: equip "bays" + a module inventory grid you
   grab from (tap to pick onto the cursor, tap a bay to place; a ghost trails the pointer) */
.fitpane .heroslots{grid-template-columns:repeat(2,1fr);}
.fitpane .tslot.drop{border-style:solid;border-color:var(--amber);box-shadow:0 0 12px rgba(255,180,58,.35);}
.fitpane .hpal-h{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--grn-dim);margin:12px 0 7px;}
.fitpane .mheld{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 4px;padding:9px 11px;
  border:1px dashed var(--line-hi);border-radius:8px;color:var(--dim);font-size:12px;line-height:1.4;min-height:40px;}
.fitpane .mheld.active{border-style:solid;border-color:var(--amber);color:var(--amber);cursor:pointer;background:rgba(255,180,58,.06);}
.fitpane .mheld b{color:#eafffb;}
.fitpane .minv{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.fitpane .mcell{position:relative;padding:11px 4px;border:1px solid var(--line-hi);border-radius:9px;
  background:rgba(255,255,255,.02);text-align:center;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:4px;min-height:64px;}
.fitpane .mcell:active{background:rgba(53,214,230,.08);}
.fitpane .mcell .ic{font-size:21px;line-height:1;color:var(--cyan);}
.fitpane .mcell .nm{font:10px ui-monospace,monospace;color:var(--ink);}
.fitpane .mcell.equip{border-color:var(--cyan);background:rgba(53,214,230,.1);}
.fitpane .mcell.held{border-color:var(--amber);box-shadow:0 0 12px rgba(255,180,58,.45);}
.fitpane .mcell.planned{opacity:.55;}
.fitpane .mcell .badge{position:absolute;top:3px;right:6px;font:700 10px ui-monospace,monospace;color:var(--cyan);}
/* hero grade (rarity) line — colour by tier */
.fitpane .hgradeline{font:600 12px ui-monospace,monospace;letter-spacing:.5px;margin:2px 0 10px;}
.fitpane .hgradeline.g-common{color:#8fa6ad;}
.fitpane .hgradeline.g-rare{color:#5fd0ff;}
.fitpane .hgradeline.g-legendary{color:var(--amber);}
.fitpane .hgradeline.g-main{color:var(--grn);}

/* in-app APK update banner + manual check (APK only; updater.ts toggles visibility).
   GLOBAL fixed banner — floats over ANY screen (welcome / hub / match), z above the
   window overlays (47) and testmode (59): an update prompt is deliberately on top. */
#updbar{display:none;position:fixed;top:calc(10px + env(safe-area-inset-top,0px));left:50%;
  transform:translateX(-50%);z-index:96;width:min(440px,calc(100vw - 20px));
  padding:12px 14px;border:1px solid var(--cyan);border-radius:10px;
  background:rgba(4,20,26,.94);box-shadow:0 6px 28px rgba(0,0,0,.55),0 0 22px rgba(53,214,230,.16);}
#updbar .ub-t{font-size:12px;color:var(--cyan-dim);letter-spacing:.5px;line-height:1.5;}
#updbar .ub-t b{color:var(--ink);}
#updbar .ub-row{display:flex;gap:10px;margin-top:10px;}
#updbar .ub-go{flex:1;text-align:center;padding:11px 10px;border-radius:8px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.18);color:var(--cyan);font-size:13px;letter-spacing:1px;text-decoration:none;cursor:pointer;}
#updbar .ub-go:active{background:rgba(53,214,230,.3);}
#updbar .ub-later{flex:none;padding:11px 16px;border-radius:8px;border:1px solid var(--line-hi);
  background:transparent;color:var(--dim);font-size:12px;cursor:pointer;}
#connect .cupd{flex:none;width:100%;margin-top:10px;padding:9px 10px;border:1px dashed var(--line-hi);border-radius:8px;
  background:transparent;color:var(--cyan-dim);font-size:12px;letter-spacing:.5px;cursor:pointer;}
#connect .cupd:active{background:rgba(53,214,230,.12);}
#connect .cver{margin-top:8px;text-align:center;font-size:10px;letter-spacing:.5px;color:var(--dim);opacity:.8;}
/* === DEV TEST MODE — self-contained; delete this whole block to cut the styles === */
#connect .tm-open{flex:none;width:100%;margin-top:10px;border-style:dashed;border-color:var(--line-hi);color:var(--cyan-dim);}
#connect .tm-open:active{background:rgba(53,214,230,.12);}
#testmode{position:fixed;inset:0;z-index:59;display:none;align-items:center;justify-content:center;padding:18px;
  background:radial-gradient(120% 100% at 50% 30%,rgba(4,20,28,.94),rgba(1,4,10,.98));
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#testmode .tmbox{width:min(620px,96vw);max-height:92vh;overflow:auto;background:var(--glass);border:1px solid var(--cyan);
  border-radius:12px;padding:20px 20px 16px;box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
#testmode .tm-title{display:flex;align-items:center;gap:10px;font-size:17px;letter-spacing:2px;color:var(--cyan);}
#testmode .tm-title .dia{width:12px;height:12px;transform:rotate(45deg);background:var(--cyan);box-shadow:0 0 10px var(--cyan);}
#testmode .tm-dev{margin-left:auto;font-size:9px;letter-spacing:2px;color:#0a0f12;background:var(--amber);padding:2px 7px;border-radius:3px;}
#testmode .tm-sub{margin:8px 0 14px;color:var(--dim);font-size:12px;line-height:1.5;}
#testmode .tm-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--grn-dim);margin:12px 0 7px;}
#testmode .tm-row{display:flex;gap:8px;flex-wrap:wrap;}
#testmode .tm-spd{min-width:54px;padding:9px 10px;border:1px solid var(--line-hi);border-radius:8px;background:transparent;
  color:var(--cyan-dim);font:700 13px ui-monospace,monospace;cursor:pointer;}
#testmode .tm-spd.on{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.14);box-shadow:0 0 10px rgba(53,214,230,.25);}
#testmode .tm-scn{display:block;width:100%;text-align:left;margin:8px 0;padding:13px 14px;border:1px solid var(--line-hi);
  border-radius:9px;background:rgba(53,214,230,.04);color:var(--ink);cursor:pointer;}
#testmode .tm-scn:hover{border-color:var(--cyan);background:rgba(53,214,230,.1);}
#testmode .tm-scn b{display:block;color:#eafffb;font-size:13px;letter-spacing:.5px;margin-bottom:4px;}
#testmode .tm-scn span{color:var(--dim);font-size:11px;line-height:1.45;}
#testmode .tm-back{width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid var(--line-hi);
  background:transparent;color:var(--dim);cursor:pointer;font:12px ui-monospace,monospace;}
#testmode .tm-sides{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
#testmode .tm-side{border:1px solid var(--line-hi);border-radius:9px;padding:11px;}
#testmode .tm-side-h{font:700 11px ui-monospace,monospace;letter-spacing:1px;color:var(--cyan);margin-bottom:9px;text-transform:uppercase;}
#testmode .tm-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
#testmode .tm-slot{padding:9px 4px;border:1px dashed var(--line-hi);border-radius:7px;background:rgba(255,255,255,.02);
  text-align:center;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;}
#testmode .tm-slot:hover{border-color:var(--cyan);}
#testmode .tm-slot .ic{font-size:17px;line-height:1;}
#testmode .tm-slot .nm{font:10px ui-monospace,monospace;color:var(--ink);}
#testmode .tm-slot.empty{opacity:.5;}
#testmode .tm-stats{margin-top:9px;font:11px ui-monospace,monospace;color:var(--ink);}
#testmode .tm-fight{width:100%;padding:13px;border-radius:9px;border:1px solid var(--cyan);background:rgba(53,214,230,.14);
  color:var(--cyan);font:700 14px ui-monospace,monospace;letter-spacing:2px;cursor:pointer;}
#testmode .tm-fight:active{background:rgba(53,214,230,.26);}
#testmode .tm-result{margin-top:12px;padding:12px 13px;border:1px solid var(--line-hi);border-radius:9px;
  background:rgba(2,9,13,.5);font:12px ui-monospace,monospace;line-height:1.6;}
#testmode .tm-result .win{color:var(--grn);}
#testmode .tm-result .draw{color:var(--amber);}
#testmode .tm-result .tm-surv{color:var(--dim);font-size:11px;margin-top:4px;}
#testmode .tm-frow{display:flex;align-items:center;gap:8px;margin:7px 0;}
#testmode .tm-fic{width:18px;text-align:center;color:var(--cyan);font-size:14px;}
#testmode .tm-fnm{flex:1;color:var(--ink);font-size:12px;}
#testmode .tm-step{width:28px;height:28px;flex:none;border:1px solid var(--line-hi);border-radius:6px;background:transparent;
  color:var(--cyan);font:700 15px ui-monospace,monospace;cursor:pointer;}
#testmode .tm-step:hover{border-color:var(--cyan);background:rgba(53,214,230,.12);}
#testmode .tm-fn{min-width:22px;text-align:center;color:#eafffb;font:700 13px ui-monospace,monospace;font-variant-numeric:tabular-nums;}
#testmode .tm-fight:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
@media (max-width:520px){#testmode .tm-sides{grid-template-columns:1fr;}}
/* === /DEV TEST MODE === */
/* --- wide landscape (tablets / large landscape): the build/asset panel docks to the
   RIGHT as a full-height side panel instead of a short bottom sheet, so it uses the
   width and keeps the map tall. Phones in landscape are too narrow/short → they keep
   the bottom sheet. Panel overlays the right of the map the same way the sheet overlays
   the bottom, so no camera reframe is needed. --- */
@media (min-width:900px) and (orientation:landscape){
  /* a floating card on the right whose HEIGHT fits its content (grows as rows are
     added, shrinks for a sparse fleet) instead of a fixed full-height column — only
     caps at the viewport, so ordinary panels never need an inner scrollbar */
  #side{left:auto;right:12px;top:74px;bottom:auto;width:min(380px,40vw);height:auto;
    max-height:calc(100vh - 88px);flex-direction:column;clip-path:none;
    border:1px solid var(--cyan);border-radius:12px;
    box-shadow:-8px 0 30px rgba(0,0,0,.55),inset 0 0 30px rgba(53,214,230,.04);}
  /* content stacks: list on top, hovered-object dossier pinned below. The dossier gets
     a FIXED reserved height (was content-sized, which changed the panel's height every
     time a taller/shorter dossier — or none — was hovered, scrolling & jumping the list
     rows the cursor was aiming for). A stable block keeps the list rock-steady; a long
     dossier scrolls inside its own area instead of resizing the panel. */
  #side .pscroll{flex:1 1 auto;min-height:0;}
  #side .pdesc{flex:0 0 auto;width:auto;max-width:none;height:154px;overflow-y:auto;
    border-left:0;border-radius:0;border-top:1px solid var(--line-hi);}
  /* the panel is on the right now, not the bottom: don't lift the bars by a vh fraction,
     just keep them clear of the panel's width */
  body.sheet-open #cmdbar,body.sheet-open #speedbar{bottom:14px;}
  #cmdbar{left:calc((100% - min(380px,40vw)) / 2);}
  #speedbar,body.sheet-open #speedbar{right:calc(min(380px,40vw) + 14px);}
}
/* --- short viewports (landscape phones, split-screen): overlays scroll instead of
   clipping off-screen; the welcome card compacts and stacks its chip/footer in-flow --- */
@media (max-height:680px){
  #connect,#setup,#codex,#playercard,#settings,#warprompt,#diplo,#splitdlg,#pingmenu,#constructor,#market{
    align-items:flex-start;overflow-y:auto;-webkit-overflow-scrolling:touch;}
  #connect{padding:14px 18px;}
  #connect .cwrap{display:flex;flex-direction:column;margin:auto;}
  #connect .clang{position:static;align-self:flex-end;margin:0 0 10px;top:auto;right:auto;}
  #connect .cfoot{position:static;bottom:auto;margin-top:14px;}
  #connect .ccrest{margin:2px 0 14px;gap:6px;}
  #connect .ccrest .ring{width:48px;height:48px;}
  #connect .ccrest .ring .dia{width:25px;height:25px;}
  #connect .ccrest .wtag{display:none;}
  #connect .cnew{padding:13px;min-height:46px;}
  #connect .cdiv{margin:13px 0 11px;}
  #connect .csoc{width:46px;height:46px;}
  #connect .cstack{margin-top:14px;}
}
/* --- meta-shell hub: post-login home + bottom nav (docs/main-menu.md) --- */
#hub{position:fixed;inset:0;z-index:52;display:none;flex-direction:column;
  background:radial-gradient(130% 80% at 50% 0%,#06161e,#010409);color:var(--ink);}
#hub .hub-banner{position:relative;flex:0 0 auto;height:118px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:8px;border-bottom:1px solid var(--line-hi);overflow:hidden;}
#hub .hub-banner::before{content:"";position:absolute;inset:0;
  background:radial-gradient(62% 130% at 50% -16%,rgba(53,214,230,.18),transparent 70%);}
#hub .hub-crest{position:relative;width:46px;height:46px;display:grid;place-items:center;}
#hub .hub-crest .dia{width:26px;height:26px;transform:rotate(45deg);border:2px solid var(--cyan);
  background:rgba(53,214,230,.12);box-shadow:0 0 18px rgba(53,214,230,.5),inset 0 0 9px rgba(53,214,230,.3);}
#hub .hub-bt{position:relative;font-size:18px;letter-spacing:6px;color:var(--cyan);font-weight:700;
  text-shadow:0 0 14px rgba(53,214,230,.45);}
#hub .hub-id{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);}
#hub .hub-av{width:42px;height:42px;border-radius:50%;border:1px solid var(--line-hi);background:rgba(3,12,16,.8);
  display:grid;place-items:center;color:var(--cyan);font-size:17px;flex:0 0 auto;box-shadow:inset 0 0 10px rgba(53,214,230,.1);
  cursor:pointer;position:relative;font-variant-emoji:text;}
#hub .hub-av:hover{border-color:var(--cyan);box-shadow:inset 0 0 12px rgba(53,214,230,.22),0 0 12px rgba(53,214,230,.2);}
/* a tiny pencil badge hints the avatar is editable (pick your emblem) */
#hub .hub-av::after{content:"✎";position:absolute;right:-3px;bottom:-3px;width:16px;height:16px;border-radius:50%;
  background:var(--cyan);color:#04141c;font-size:9px;display:grid;place-items:center;box-shadow:0 0 8px rgba(53,214,230,.6);}
/* emblem picker — a small console modal opened from the hub avatar */
#emblempick{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  background:rgba(1,5,9,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);padding:20px;}
#emblempick.show{display:flex;}
#emblempick .ep-box{width:min(340px,92vw);background:var(--glass);border:1px solid var(--line-hi);border-radius:14px;
  box-shadow:0 0 30px rgba(0,0,0,.6),inset 0 0 30px rgba(53,214,230,.05);overflow:hidden;}
#emblempick .ep-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;
  border-bottom:1px solid var(--line);color:var(--cyan);letter-spacing:2px;font:700 13px ui-monospace,monospace;}
#emblempick .ep-head button{background:transparent;border:0;color:var(--dim);font-size:16px;cursor:pointer;}
#emblempick .ep-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:16px;}
#emblempick .ep-cell{aspect-ratio:1;display:grid;place-items:center;font-size:24px;cursor:pointer;font-variant-emoji:text;
  color:var(--cyan);background:rgba(3,12,16,.6);border:1px solid var(--line-hi);border-radius:10px;
  text-shadow:0 0 8px rgba(53,214,230,.4);transition:background .12s,border-color .12s;}
#emblempick .ep-cell:hover{background:rgba(53,214,230,.12);}
#emblempick .ep-cell.sel{border-color:var(--cyan);background:rgba(53,214,230,.18);
  box-shadow:inset 0 0 12px rgba(53,214,230,.25),0 0 10px rgba(53,214,230,.3);}
#hub .hub-who{flex:1;min-width:0;}
#hub .hub-name{font-size:15px;color:#eafffb;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#hub .hub-st{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--cyan-dim);margin-top:3px;}
#hub .hub-st::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#3ad17a;
  box-shadow:0 0 6px #3ad17a;margin-right:6px;vertical-align:middle;}
#hub .hub-msg{position:relative;width:42px;height:42px;border-radius:10px;border:1px solid var(--line-hi);
  background:rgba(3,12,16,.7);color:var(--cyan);font-size:16px;cursor:pointer;flex:0 0 auto;}
#hub .hub-msg .badge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;border-radius:9px;padding:0 4px;
  background:var(--red);color:#180605;font:700 10px/18px ui-monospace,monospace;text-align:center;}
#hub .hub-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:18px 16px 14px;}
#hub .hub-panel{display:flex;flex-direction:column;gap:14px;}
#hub .hub-play{width:100%;padding:18px;border-radius:12px;border:1px solid var(--cyan);cursor:pointer;
  background:linear-gradient(180deg,rgba(53,214,230,.30),rgba(53,214,230,.12));color:#eafdff;
  font:700 17px ui-monospace,monospace;letter-spacing:2px;box-shadow:0 0 28px rgba(53,214,230,.26);min-height:58px;}
#hub .hub-play:active{background:linear-gradient(180deg,rgba(53,214,230,.44),rgba(53,214,230,.2));}
#hub .hub-solo{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font:13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
#hub .hub-sec{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin-top:4px;
  padding-bottom:6px;border-bottom:1px solid var(--line);}
#hub .hub-card{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line-hi);border-radius:10px;
  padding:13px 14px;background:rgba(255,255,255,.02);}
#hub .hub-card .hc-ic{width:38px;height:38px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;
  background:rgba(53,214,230,.1);color:var(--cyan);font-size:18px;}
#hub .hub-card .hc-t{font-size:13px;color:#dfeef2;}
#hub .hub-card .hc-s{font-size:11px;color:var(--dim);margin-top:4px;line-height:1.45;}
/* ONB-0 first-run offer card (hub home) */
#hub .ob-nudge{border-color:var(--cyan);background:rgba(53,214,230,.06);}
#hub .ob-nudge .ob-body{flex:1;}
#hub .ob-nudge .ob-btns{display:flex;gap:8px;margin-top:10px;}
#hub .ob-nudge .ob-go{background:var(--cyan);border:none;color:#04121a;font-weight:700;font-size:12px;
  padding:7px 14px;border-radius:7px;cursor:pointer;letter-spacing:.4px;}
#hub .ob-nudge .ob-later{background:none;border:1px solid var(--line-hi);color:var(--dim);font-size:12px;
  padding:7px 12px;border-radius:7px;cursor:pointer;}
#hub .ob-nudge .ob-later:active{border-color:var(--cyan);color:#dfeef2;}
#hub .hub-empty{padding:54px 16px;text-align:center;color:var(--dim);font-size:14px;letter-spacing:1px;line-height:1.9;}
#hub .hub-empty .he-ic{font-size:38px;color:var(--cyan-dim);display:block;margin-bottom:14px;
  text-shadow:0 0 16px rgba(53,214,230,.3);}
#hub .hub-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
#hub .hub-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:20px 10px;
  border-radius:12px;border:1px solid var(--line-hi);background:rgba(3,12,16,.6);color:#dfeef2;
  font:600 12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;min-height:94px;}
#hub .hub-tile .ht-ic{font-size:23px;color:var(--cyan);}
#hub .hub-tile:active{background:rgba(53,214,230,.12);border-color:var(--cyan);}
#hub .hub-tile.wide{grid-column:1 / -1;flex-direction:row;gap:12px;min-height:0;padding:14px;color:var(--dim);}
#hub .hub-tile.wide .ht-ic{font-size:17px;color:var(--dim);}
#hub .hub-note{flex:0 0 auto;min-height:0;text-align:center;color:var(--amber);font-size:12px;
  padding:0 16px;}
#hub .hub-note:not(:empty){padding:8px 16px;}
/* «Прокачка» — meta-progression trees (hub tab) */
#hp-meta{overflow-y:auto;gap:10px;}
.mp-head{display:flex;align-items:baseline;gap:12px;color:#eafffb;}
.mp-head b{font-size:16px;letter-spacing:1px;}
.mp-xp{color:var(--cyan-dim);font-size:11px;}
.mp-pts{margin-left:auto;color:var(--amber);font-weight:700;font-size:12px;}
.mp-track{height:5px;border-radius:3px;background:rgba(53,214,230,.12);overflow:hidden;}
.mp-fill{height:100%;background:var(--cyan);box-shadow:0 0 8px rgba(53,214,230,.5);}
.mp-branch{border:1px solid var(--line-hi);border-radius:10px;padding:10px 12px;}
.mp-bt{font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--grn-dim);margin-bottom:8px;}
.mp-node{padding:7px 0;border-top:1px dashed var(--line);}
.mp-node:first-of-type{border-top:none;}
.mp-nm{color:#eafffb;font-weight:700;font-size:12px;}
.mp-nm em{color:var(--dim);font-style:normal;font-weight:400;}
.mp-ds{color:#74b0aa;font-size:11px;margin:2px 0 5px;}
.mp-node.lock{opacity:.5;}
.mp-node.own .mp-nm{color:var(--grn,#5ff0a8);}
.mp-buy{padding:5px 12px;border:1px solid var(--cyan-dim);border-radius:7px;background:transparent;color:var(--cyan);font:700 11px ui-monospace,monospace;cursor:pointer;}
.mp-buy:disabled{border-color:var(--line);color:var(--dim);cursor:default;}
.mp-note{color:var(--dim);font-size:10px;margin:2px 0 0;}
/* «Арсенал» — the account's persistent collection (hub tab, ARS-5) */
#hp-arsenal{overflow-y:auto;gap:10px;}
.ar-filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-bottom:9px;border-bottom:1px solid var(--line);}
.ar-fchip{padding:3px 9px;border-radius:11px;border:1px solid var(--line);background:transparent;color:var(--dim);
  font:600 10px ui-monospace,monospace;cursor:pointer;}
.ar-fchip.on{color:var(--cyan);border-color:var(--cyan-dim);background:rgba(53,214,230,.08);}
.ar-fsep{width:1px;height:14px;background:var(--line-hi);margin:0 2px;}
.ar-grid .ar-card{min-height:78px;}
.ar-meta{color:var(--dim);font-size:9px;letter-spacing:.3px;}
#hub .hub-nav{flex:0 0 auto;display:flex;border-top:1px solid var(--line-hi);background:rgba(2,9,13,.94);
  padding-bottom:env(safe-area-inset-bottom,0);}
#hub .hub-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 2px 8px;cursor:pointer;
  background:transparent;border:0;color:var(--cyan-dim);font:9px ui-monospace,monospace;letter-spacing:.5px;}
#hub .hub-tab .hn-ic{font-size:18px;line-height:1;}
#hub .hub-tab.active{color:var(--cyan);}
#hub .hub-tab.active .hn-ic{text-shadow:0 0 8px rgba(53,214,230,.6);}

/* corporation cabinet — cross-session alliance management (mock, see docs/corporation-ui.md) */
#corp{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  background:rgba(2,8,11,.72);padding:16px;}
#corp .corpbox{width:min(760px,96vw);max-height:92vh;display:flex;flex-direction:column;
  background:var(--glass);border:1px solid var(--line-hi);border-radius:14px;overflow:hidden;
  box-shadow:0 0 44px rgba(0,0,0,.65),inset 0 0 40px rgba(40,200,210,.05);}
#corp .corphd{padding:16px 18px 12px;border-bottom:1px solid var(--line);}
#corp .chrow{display:flex;align-items:center;gap:12px;}
#corp .cemblem{width:40px;height:40px;display:grid;place-items:center;flex:none;font-size:22px;color:var(--cyan);
  border:1px solid var(--line-hi);border-radius:9px;background:rgba(53,214,230,.08);box-shadow:0 0 12px rgba(53,214,230,.15);}
#corp .cident{flex:1;min-width:0;}
#corp .cident>b{font-size:17px;letter-spacing:1px;color:var(--ink);}
#corp .ctag{color:var(--cyan);font-size:12px;letter-spacing:1px;}
#corp .cmotto{color:var(--dim);font-size:11px;margin-top:2px;font-style:italic;}
#corp .cx{flex:none;width:32px;height:32px;border-radius:8px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font-size:14px;cursor:pointer;}
#corp .cx:active{background:rgba(255,90,77,.15);color:var(--red);}
#corp .cmetrics{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:11px;color:var(--dim);letter-spacing:.5px;}
#corp .cmetrics b{color:var(--cyan);font-size:12px;}
#corp .corptabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid var(--line);overflow-x:auto;}
#corp .ctab{padding:9px 13px;border:none;border-bottom:2px solid transparent;background:transparent;
  color:var(--dim);font:600 12px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;white-space:nowrap;}
#corp .ctab.on{color:var(--cyan);border-bottom-color:var(--cyan);}
#corp .corpbody{padding:16px 18px;overflow-y:auto;}
#corp .ccols{display:flex;gap:14px;flex-wrap:wrap;}
#corp .ccard{flex:1;min-width:230px;border:1px solid var(--line);border-radius:10px;padding:12px 14px;}
#corp .ccard h4{margin:0 0 8px;color:var(--cyan);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;}
#corp .clist{margin:0;padding-left:16px;color:var(--ink);font-size:12px;line-height:1.7;}
#corp .chint{margin:10px 0 0;color:var(--dim);font-size:10px;line-height:1.5;font-style:italic;}
#corp .cwarn{margin:0 0 14px;padding:9px 12px;border:1px solid var(--amber);border-radius:8px;
  background:rgba(255,180,58,.08);color:var(--amber);font-size:12px;}
#corp .cline{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:12px;}
#corp .cline:last-child{border-bottom:none;}
#corp .cline em{font-style:normal;}
#corp .up{color:var(--up);}
#corp .dn{color:var(--dn);}
#corp .cwhen{color:var(--dim);font-weight:400;font-size:10px;}
#corp .ctable{display:flex;flex-direction:column;gap:6px;}
#corp .crow2{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;
  font-size:12px;flex-wrap:wrap;}
#corp .crow2.me{border-color:var(--cyan-dim);background:rgba(53,214,230,.06);}
#corp .cdot{width:9px;height:9px;border-radius:50%;flex:none;background:currentColor;box-shadow:0 0 7px currentColor;}
#corp .cnm{flex:1;min-width:120px;color:var(--ink);}
#corp .cnm i{color:var(--cyan);font-style:normal;font-size:10px;}
#corp .crole{color:var(--dim);width:70px;}
#corp .cinf{color:var(--grn);width:92px;text-align:right;}
#corp .cpres{color:var(--dim);width:64px;}
#corp .cman{display:flex;gap:5px;}
#corp .cbonus{flex:1;min-width:140px;color:var(--grn);}
#corp .cthreat{font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--line-hi);}
#corp .cthreat.t-low{color:var(--grn);}
#corp .cthreat.t-med{color:var(--amber);}
#corp .cthreat.t-high{color:var(--red);border-color:var(--red);}
#corp .cbtn2{padding:7px 11px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.1);
  color:var(--cyan);font:600 11px ui-monospace,monospace;cursor:pointer;}
#corp .cbtn2:active{background:rgba(53,214,230,.24);}
#corp .cbtn2.danger{border-color:var(--red);color:var(--red);background:rgba(255,90,77,.08);}
#corp .cbtn2.wide{width:100%;margin-top:12px;}
#corp .cbig{display:flex;gap:14px;margin-bottom:14px;}
#corp .cbig>div{flex:1;border:1px solid var(--line);border-radius:10px;padding:12px 14px;}
#corp .cbig span{display:block;color:var(--dim);font-size:10px;letter-spacing:1px;text-transform:uppercase;}
#corp .cbig b{color:var(--cyan);font-size:18px;}
#corp .corpbody h4{margin:0 0 8px;color:var(--cyan);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;}
#corp .cledger{margin-bottom:12px;}
#corp .cwars{display:flex;flex-direction:column;gap:10px;}
#corp .cwar{border:1px solid var(--line);border-radius:10px;padding:11px 13px;}
#corp .cwtop{display:flex;justify-content:space-between;align-items:center;}
#corp .cwtop b{color:var(--ink);}
#corp .cst{font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--line-hi);color:var(--dim);}
#corp .cst.st-active{color:var(--red);border-color:var(--red);}
#corp .cst.st-incoming{color:var(--amber);border-color:var(--amber);}
#corp .cwmid{color:var(--dim);font-size:11px;margin:6px 0 9px;}
#corp .cwroster{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px;}
#corp .ctoggle{opacity:.55;}
#corp .ctoggle.on{opacity:1;background:rgba(53,214,230,.24);}
#corp .cchat{display:flex;flex-direction:column;gap:8px;margin-bottom:12px;}
#corp .cmsg{border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12px;}
#corp .cmsg.audit{border-style:dashed;color:var(--dim);}
#corp .cmsg b{color:var(--cyan);}
#corp .cmsg p{margin:4px 0 0;color:var(--ink);}
#corp .cpin{float:right;}
#corp .cinput{display:flex;gap:8px;}
#corp .cinput input{flex:1;padding:9px 11px;border-radius:7px;border:1px solid var(--line-hi);
  background:rgba(2,10,13,.7);color:var(--ink);font:12px ui-monospace,monospace;}
#corp .cinput input:focus{outline:none;border-color:var(--cyan);}

/* === PC (mouse-driven desktop): the whole HUD at 1.5× ==========================
   The UI was sized for phones — on a monitor the 12px console text is unreadably
   small. zoom:1.5 scales every font/control coherently. Two gotchas, both handled
   here: (1) vw/vh units inside a zoomed element are ALSO scaled visually (67vw
   renders as the full screen; calc(100vh - N) overflows it), so every vw/vh used
   inside a zoomed layer is re-declared below at 1/1.5 of its base value — keep
   this list in sync when adding vw/vh rules; (2) layers whose position/size is
   set in px from JS (#map canvas, #chatwin drag geometry, #pingpop / #holdtip /
   the #spotlight ring anchored to getBoundingClientRect) must stay UNZOOMED, or
   the JS px and the visual px disagree by 1.5× — they are deliberately absent
   from the zoom list. Percentages resolve against the (zoomed) parent, so they
   need no compensation — which is why the hub column below uses % and not vw. */
@media (min-width:900px) and (hover:hover) and (pointer:fine){
  #top,#devline,#toasts,#speedbar,#cmdbar,#rail,#side,#logwin,#tech,#steward,#scipick,
  #divdesign,#market,#constructor,#codex,#codexhub,#intro,#recap,#goals,#playercard,
  #settings,#warprompt,#diplo,#splitdlg,#pingmenu,#banner,#endscreen,#connect,#updbar,
  #hub,#emblempick,#corp,#setup,#testmode{zoom:1.5;}
  /* vw/vh compensations (base values ÷ 1.5 — see the note above) */
  #toasts{max-width:min(61vw,520px);}
  /* rail tool list: cap at ~7 items and scroll; the sticky ▲/▾ ticks (not buttons)
     hint that the list scrolls both ways */
  #railtools{max-height:min(330px,calc(66.7vh - 120px));}
  #railtools::before,#railtools::after{display:block;position:sticky;z-index:1;flex:0 0 auto;
    text-align:center;font-size:8px;line-height:1;padding:1px 0;color:var(--cyan-dim);
    pointer-events:none;}
  #railtools::before{content:'▲';top:-6px;background:linear-gradient(180deg,rgba(3,12,16,.95) 55%,transparent);}
  #railtools::after{content:'▼';bottom:-6px;background:linear-gradient(0deg,rgba(3,12,16,.95) 55%,transparent);}
  /* division-designer window: its body pane had no padding of its own — text sat
     flush against the frame */
  #divdesignbody{flex:1;min-height:0;overflow:auto;padding:14px 16px;}
  #goals{max-width:min(230px,40vw);}
  /* content windows widen to ~80% of the screen (53.4vw layout × zoom 1.5) — the
     console windows outgrew their phone-sized boxes (long RU copy overflowed) */
  #codex .cxbox{width:53.4vw;max-height:56vh;}
  #codexhub .chbox{width:53.4vw;max-height:57vh;}
  #intro .inbox{width:min(400px,61vw);max-height:56vh;}
  #recap .rcbox{width:min(440px,62.5vw);max-height:57vh;}
  #playercard .pcbox{width:min(380px,61vw);max-height:57vh;}
  #settings .setbox{width:min(380px,61vw);max-height:57vh;}
  #warprompt .wpbox{width:min(360px,61vw);}
  #diplo .dpbox{width:53.4vw;max-height:58.5vh;}
  .dp-convo{height:min(41vh,440px);}
  #splitdlg .sbox{width:min(440px,62.5vw);max-height:56vh;}
  #logwin .lwbox{width:53.4vw;max-height:46.5vh;}
  #tech .twbox,#steward .twbox,#hero .twbox,#divdesign .twbox{width:53.4vw;max-height:54.5vh;}
  #scipick .twbox{width:53.4vw;max-height:58.5vh;}
  #market .mkbox{width:53.4vw;max-height:54.5vh;}
  #constructor .cnbox{width:53.4vw;max-height:60vh;}
  #endscreen .es-box{width:min(440px,62.5vw);max-height:61vh;}
  #connect .cbox,#connect .cwrap{width:min(520px,62.5vw);}
  #connect .mlist{max-height:30.5vh;}
  #connect .ccrest .wm{font-size:clamp(20px,4.33vw,26px);letter-spacing:clamp(3px,1.33vw,8px);}
  #connect .ccrest .wtag{letter-spacing:clamp(2px,.93vw,5px);}
  /* skirmish setup on PC: two side-by-side card-columns (map+faction | seats+speed)
     instead of one narrow scrolling stack — the box widens to fit both. Each column
     scrolls on its own; the title and the LAUNCH/Back buttons never leave the screen. */
  #setup .sbox{width:min(1080px,62vw);max-height:61vh;display:flex;flex-direction:column;overflow:hidden;}
  #setup .spane{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px;}
  #setup .scol{min-height:0;overflow-y:auto;border:1px solid var(--line-hi);border-radius:12px;
    padding:14px 16px;background:rgba(255,255,255,.015);}
  #setup .scol .ssub{margin-top:0;}
  #setup .scol .fpick,#setup .scol .sspeed{margin-bottom:2px;}
  #setup .sgo{margin-top:14px;}
  #setup .sgo,#setup .scancel{flex:0 0 auto;}
  #updbar{width:min(440px,calc(66.7vw - 20px));}
  #testmode .tmbox{width:min(620px,64vw);max-height:61vh;}
  #emblempick .ep-box{width:min(340px,61vw);}
  #corp .corpbox{width:53.4vw;max-height:61vh;}
  /* base (portrait) bottom-sheet panel + the bars it lifts */
  #side{max-height:22.5vh;}
  body.sheet-open #cmdbar,body.sheet-open #speedbar{bottom:calc(22.5vh + 12px);}
  #fps{top:120px;}
  /* PC: the docked dossier pane is retired — the dossier follows the cursor as a
     translucent tooltip instead (#objtip, filled/positioned by main.ts). The tooltip
     is deliberately NOT in the zoom list (JS places it at pointer coords, and zoom
     would double them) — its type is therefore sized at 1.5× directly. */
  #side .pdesc{display:none;}
  #objtip{position:fixed;left:0;top:0;z-index:29;display:none;pointer-events:none;opacity:.8;
    width:max-content;max-width:min(460px,32vw);padding:12px 15px;
    background:rgba(3,14,18,.95);border:1px solid var(--line-hi);border-radius:9px;
    box-shadow:0 6px 24px rgba(0,0,0,.55),inset 0 0 0 1px rgba(53,214,230,.06);}
  #objtip .pd-title{font-size:18px;font-weight:700;letter-spacing:1.5px;color:#eafffb;
    margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid var(--line);}
  #objtip .pd-title:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none;}
  #objtip .pd-body{font-size:16px;line-height:1.55;color:#9fc9c4;}
  #objtip .hl{font-style:normal;font-weight:700;color:var(--amber);text-shadow:0 0 7px rgba(255,180,58,.35);}
  /* main menu (hub): don't stretch the console across the whole monitor — a
     centred column at 80% of the screen; the hub's backdrop still fills it all */
  #hub .hub-banner,#hub .hub-id,#hub .hub-body,#hub .hub-note,#hub .hub-nav{
    width:80%;margin-left:auto;margin-right:auto;
    border-left:1px solid var(--line-hi);border-right:1px solid var(--line-hi);}
}
/* the right-dock panel layout (the ≥900px landscape query above) re-stated at
   vw/vh ÷ 1.5 for the zoomed PC HUD — those base rules would otherwise scale
   to 60vw-wide panels and off-screen heights */
@media (min-width:900px) and (hover:hover) and (pointer:fine) and (orientation:landscape){
  #side{width:min(380px,26.7vw);max-height:calc(66.7vh - 88px);}
  #cmdbar{left:calc((100% - min(380px,26.7vw)) / 2);}
  /* time controls hug the right edge — clear of the (now shorter) sector panel and
     of the fleet command bar centred over the map */
  #speedbar,body.sheet-open #speedbar{right:14px;}
  body.sheet-open #cmdbar,body.sheet-open #speedbar{bottom:14px;}
}
/* «Компактный режим меню» (settings toggle, PC only): a denser sector panel — the
   same content with the air squeezed out: tighter paddings, smaller chips/rows/tiles,
   the head subtitle inlined after the world's name, a lower bottom dossier strip.
   Pure restyle over body.compact-panel — panel markup and behaviour untouched. */
@media (min-width:900px) and (hover:hover) and (pointer:fine){
  body.compact-panel #side .pscroll{padding:8px 10px;}
  body.compact-panel #side .phead{gap:8px;margin:0 0 6px;padding-bottom:6px;}
  body.compact-panel #side .phead .pflag{width:12px;height:12px;}
  body.compact-panel #side .ptitle{display:flex;align-items:baseline;gap:8px;min-width:0;}
  body.compact-panel #side .ptitle b{display:inline;font-size:13px;letter-spacing:1.5px;flex:0 0 auto;}
  body.compact-panel #side .ptitle span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;font-size:8px;}
  body.compact-panel #side .pclose{width:22px;height:22px;font-size:10px;}
  body.compact-panel #side .pstats{gap:5px;margin:2px 0 3px;}
  body.compact-panel #side .pstats span{padding:2px 7px;font-size:10px;}
  body.compact-panel #side .pstats .pl{display:none;} /* icon+number chips, as mocked */
  body.compact-panel #side .sec{margin:8px 0 4px;font-size:9px;padding-bottom:3px;}
  body.compact-panel #side .row{margin:2px 0;}
  body.compact-panel #side .asset-row{gap:6px;margin:3px 0;min-height:20px;padding:3px 7px;}
  body.compact-panel #side .asset-row b{min-width:80px;font-size:11px;}
  body.compact-panel #side .bicon{width:17px;height:17px;font-size:11px;}
  body.compact-panel #side button.b{padding:3px 8px;font-size:10px;}
  body.compact-panel #side .ptabs{gap:5px;margin:7px 0 3px;}
  body.compact-panel #side .ptab{padding:4px 8px;}
  body.compact-panel #side .ptiles{gap:5px;margin:3px 0 6px;}
  body.compact-panel #side .ptile{min-width:46px;min-height:40px;padding:4px 5px;}
  body.compact-panel #side .ptile .pt-ic{font-size:15px;}
  body.compact-panel #side .conveyor{margin:4px 0 6px;padding:6px;}
  body.compact-panel #side .hint{font-size:10px;margin-top:6px;}
}
`;

const page = (js) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#061318"/><rect x="9" y="9" width="14" height="14" rx="2" transform="rotate(45 16 16)" fill="none" stroke="#35d6e6" stroke-width="2.5"/></svg>')}">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<canvas id="map"></canvas>
<header id="top">
  <div class="crest">
    <button id="crestmark" title="Ваш профиль" type="button">◆</button>
    <div class="who"><b>VOID DOMINION</b><span>SECTOR COMMAND</span></div>
  </div>
  <div id="purse"></div>
</header>
<div id="devline"></div>
<!-- slim left rail: only the wired tools (each opens its window). More icons land here as
     features get wired. -->
<nav id="rail">
  <div id="railtools">
    <button id="rail-diplo" title="Дипломатия" data-i18n-title>⬡<span class="rlbl" data-i18n>Дипло</span></button>
    <button id="rail-msgs" title="Сообщения" data-i18n-title>✉<span class="rlbl" data-i18n>Почта</span><b id="msgbadge" class="railbadge" style="display:none"></b></button>
    <button id="rail-tech" title="Технологии" data-i18n-title>⚛<span class="rlbl" data-i18n>Наука</span></button>
    <button id="rail-constructor" title="Конструктор — оснащение кораблей, эскадрилий, армии и героев" data-i18n-title>⚒<span class="rlbl" data-i18n>Верфь</span></button>
    <button id="rail-steward" title="Хранитель — передать ИИ на сон" data-i18n-title>😴<span class="rlbl" data-i18n>Сон</span></button>
    <button id="rail-market" title="Рынок" data-i18n-title>⇄<span class="rlbl" data-i18n>Рынок</span></button>
    <button id="railcorp" title="Корпорация" data-i18n-title>⬢<span class="rlbl" data-i18n>Корп</span></button>
    <button id="rail-chat" title="Чат" data-i18n-title class="desk-only">🗨<span class="rlbl" data-i18n>Чат</span></button>
    <button id="rail-log" title="Сводки" data-i18n-title>≡<span class="rlbl" data-i18n>Сводки</span><span class="badge" id="alertbadge" style="display:none">0</span></button>
    <button id="rail-help" title="Справочник" data-i18n-title>?<span class="rlbl" data-i18n>Справка</span></button>
    <button id="rail-settings" title="Настройки" data-i18n-title>⚙<span class="rlbl" data-i18n>Настройки</span></button>
    <button id="rail-exit" title="Покинуть сессию" data-i18n-title>⌂<span class="rlbl" data-i18n>Выйти</span></button>
  </div>
  <button id="railtoggle" title="Инструменты" type="button" aria-expanded="false"><span id="railglyph">☰</span><span class="badge" id="railalert" style="display:none">0</span></button>
</nav>
<!-- floating chat window (desktop only) — content rendered by renderChat() in main.ts -->
<div id="chatwin" class="desk-only"></div>
<div id="logwin"><div class="lwbox"><div class="lw-head"><b data-i18n>СВОДКИ</b><button class="lw-recap" id="lw-recap" type="button" title="Сводка возвращения" data-i18n-title>🛰</button><button class="lw-close">✕</button></div><div id="log"></div></div></div>
<!-- technologies window — content rendered by renderTech() in main.ts -->
<div id="tech"><div class="twbox"><div class="lw-head"><b data-i18n>ТЕХНОЛОГИИ</b><button class="tw-close">✕</button></div><div id="techbody"></div></div></div>
<!-- steward («Хранитель») window — content rendered by renderSteward() in main.ts -->
<div id="steward"><div class="twbox"><div class="lw-head"><b data-i18n>ХРАНИТЕЛЬ · ИИ НА СОН</b><button class="tw-close">✕</button></div><div id="stewardbody"></div></div></div>
<!-- heroes: the roster/штаб now lives INSIDE the constructor «Верфь» tab (Герои pane) -->
<!-- scientist council picker (setup-time, before the start-point) — rendered by renderSciPick() -->
<div id="scipick"><div class="twbox"><div class="lw-head"><b data-i18n>СОВЕТ УЧЁНЫХ</b><button class="sp-cancel" type="button" data-i18n>↩ В меню</button></div><div id="scipickbody"></div></div></div>
<!-- division template designer (H4, Stellaris-style) — rendered by renderDivDesign() -->
<div id="divdesign"><div class="twbox"><div class="lw-head"><b data-i18n>КОНСТРУКТОР ДИВИЗИЙ</b><button class="tw-close">✕</button></div><div id="divdesignbody"></div></div></div>
<!-- session market — whole box rendered by renderMarket() in main.ts -->
<div id="market"></div>
<!-- constructor («Верфь») — unified loadout tab; whole box rendered by renderConstructor() -->
<div id="constructor"></div>
<aside id="side"></aside>
<div id="toasts"></div>
<div id="speedbar" class="spd">
  <!--dev-only--><button id="spd-pause" data-speed="0">‖</button><button id="spd-play" data-speed="1" class="on">▶</button><button id="spd-fast" data-speed="3">▶▶</button><span class="spddiv"></span><button class="spdmini" data-mult="1" title="реальное время" data-i18n-title>×1</button><button class="spdmini" data-mult="10">×10</button><button class="spdmini" data-mult="50">×50</button><button class="spdmini" data-mult="100">×100</button>
  <span class="sep" id="restart-sep" style="display:none"></span><button id="restart" title="Перезапуск — к выбору ботов" data-i18n-title style="display:none">⟳</button>
  <span class="sep"></span><!--/dev-only--><button id="tomenu" title="Выход в меню" data-i18n-title>⌂</button>
</div>
<div id="cmdbar"></div>
<div id="codex"></div>
<div id="codexhub"></div>
<div id="intro"></div>
<div id="recap"></div>
<div id="goals"></div>
<div id="playercard"></div>
<div id="settings"></div>
<div id="warprompt"></div>
<div id="diplo"></div>
<div id="pingpop"></div>
<div id="objtip"></div>
<div id="splitdlg"></div>
<div id="pingmenu"></div>
<div id="fps"></div>
<div id="banner"></div>
<div id="endscreen"></div>
<div id="connect">
  <div class="cwrap">
    <button id="clang" class="clang" type="button">РУССКИЙ <span class="car">▼</span></button>
    <div class="cbox">
      <div id="cwelcome">
        <div class="ccrest">
          <div class="ring"><span class="dia"></span></div>
          <div class="wm">VOID DOMINION</div>
          <div class="wtag" data-i18n>Грань пустоты</div>
        </div>
        <button id="cnew" class="cnew" type="button" data-i18n>Новый командир</button>
        <div class="cdiv" data-i18n>войти через</div>
        <div class="csocial">
          <button id="cgoogle" class="csoc" type="button" aria-label="Войти через Google" title="Войти через Google" data-i18n-title data-i18n-aria>G</button>
          <button id="capple" class="csoc" type="button" aria-label="Войти через Apple" title="Войти через Apple" data-i18n-title data-i18n-aria><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.4 12.9c0-2.3 1.9-3.4 2-3.4-1.1-1.6-2.8-1.8-3.4-1.8-1.5-.1-2.8.8-3.5.8s-1.8-.8-3-.8c-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.5-.7 2.9-.7s1.7.7 2.9.7c1.2 0 2-1.1 2.7-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.3-.9-2.3-3zM14.3 6.3c.6-.8 1-1.8.9-2.9-.9 0-2 .6-2.6 1.3-.6.7-1.1 1.7-.9 2.7 1 .1 2-.5 2.6-1.1z"/></svg></button>
        </div>
        <div class="cstack">
          <button id="clogin" class="cbtn ghost" type="button" data-i18n>Вход по позывному</button>
          <!--dev-only--><button id="csolo" class="cbtn ghost" type="button" data-i18n>Одиночная игра</button><!--/dev-only-->
        </div>
        <div id="cwlogin" class="cwlogin" style="display:none">
          <input id="cwnick" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="24" placeholder="позывной" data-i18n-ph>
          <button id="cwgo" class="cbtn" type="button" data-i18n>Войти</button>
        </div>
      </div>
      <div id="cbrowse" style="display:none">
        <button id="cback" class="cback" type="button" data-i18n>‹ назад</button>
        <div class="ctitle"><span class="dia"></span><b data-i18n>МАТЧИ</b></div>
        <p class="csub" data-i18n>Выбери матч из списка и войди, или обнови список.</p>
        <label class="cfield"><span data-i18n>Сервер</span>
          <input id="csrv" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="wss://… or ws://host:8788">
        </label>
        <label class="cfield"><span data-i18n>Позывной</span>
          <input id="cnick" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="24" placeholder="позывной" data-i18n-ph>
        </label>
        <label class="cfield" id="cpassrow" style="display:none"><span data-i18n>Пароль</span>
          <input id="cpass" type="password" autocomplete="current-password" maxlength="128" placeholder="пароль (аккаунт создастся сам)" data-i18n-ph>
        </label>
        <div class="crow">
          <button id="cgo" class="cbtn" type="button" data-i18n>Обновить список</button>
        </div>
        <div class="mtabs">
          <button class="mtab active" data-tab="available" data-i18n>Доступные</button>
          <button class="mtab" data-tab="active" data-i18n>Активные</button>
          <button class="mtab" data-tab="archived" data-i18n>Архив</button>
        </div>
        <div id="mlist" class="mlist"></div>
      </div>
      <div id="cstatus" class="cstat"></div>
    </div>
    <button id="cupd" class="cupd" type="button" style="display:none" data-i18n>Проверить обновления</button>
    <div id="cver" class="cver"></div>
    <!-- DEV TEST MODE — remove this button (and the #testmode block + CSS + main.ts hook) to cut the feature -->
    <!--dev-only--><button id="ctest" class="cbtn ghost tm-open" data-i18n>🧪 Тесты · режим разработчика</button><!--/dev-only-->
    <!-- /DEV TEST MODE -->
    <div class="cfoot">
      <a id="cl-imprint" data-i18n>Выходные данные</a>
      <a id="cl-terms" data-i18n>Условия</a>
      <a id="cl-privacy" data-i18n>Политика конфиденциальности</a>
      <a id="cl-support" data-i18n>Поддержка</a>
    </div>
  </div>
</div>
<!-- in-app APK update (APK only; dormant in the browser — driven by updater.ts).
     A GLOBAL fixed banner so it is seen from ANY screen — welcome, hub, or mid-match:
     the returning-player path lands in the hub and never visits #connect, which is
     where this used to live (and why players never saw their updates). -->
<div id="updbar">
  <div class="ub-t"><span data-i18n>Доступна новая сборка</span> <b id="ub-ver"></b></div>
  <div class="ub-row">
    <a id="ub-go" class="ub-go" href="#" rel="noopener" data-i18n>Обновить</a>
    <button id="ub-later" class="ub-later" type="button" data-i18n>Позже</button>
  </div>
</div>
<div id="hub">
  <div class="hub-banner">
    <div class="hub-crest"><span class="dia"></span></div>
    <div class="hub-bt">VOID DOMINION</div>
  </div>
  <div class="hub-id">
    <div class="hub-av" id="hubav" title="Сменить эмблему">◆</div>
    <div class="hub-who">
      <div class="hub-name" id="hub-name">Командир</div>
      <div class="hub-st" data-i18n>в сети</div>
    </div>
    <button class="hub-msg" id="hub-msg" type="button" aria-label="Сообщения" data-i18n-aria>✉</button>
  </div>
  <div class="hub-body">
    <div class="hub-panel" id="hp-home">
      <button id="hub-play" class="hub-play" type="button" data-i18n>ИГРАТЬ СЕЙЧАС</button>
      <!--dev-only--><button id="hub-solo" class="hub-solo" type="button" data-i18n>Одиночная игра</button><!--/dev-only-->
      <!-- ONB-0 first-run offer: shown only to a not-yet-onboarded commander -->
      <div class="hub-card ob-nudge" id="onboard-nudge" style="display:none">
        <div class="hc-ic">◎</div>
        <div class="ob-body">
          <div class="hc-t" data-i18n>Впервые в Void Dominion?</div>
          <div class="hc-s" data-i18n>Короткое обучение покажет интерфейс и первый ход — пара минут.</div>
          <div class="ob-btns">
            <button id="ob-start" class="ob-go" type="button" data-i18n>Начать обучение</button>
            <button id="ob-skip" class="ob-later" type="button" data-i18n>Пропустить</button>
          </div>
        </div>
      </div>
      <div class="hub-sec" data-i18n>Сводка</div>
      <div class="hub-card">
        <div class="hc-ic">◷</div>
        <div><div class="hc-t" data-i18n>Нет матчей, ждущих приказа</div><div class="hc-s" data-i18n>Войди в матч на вкладке «Игры» — здесь появятся ходы, требующие внимания.</div></div>
      </div>
      <div class="hub-card">
        <div class="hc-ic">✦</div>
        <div><div class="hc-t" data-i18n>Сезон ещё не начат</div><div class="hc-s" data-i18n>Рейтинги и альянсы откроются со стартом мета-слоя.</div></div>
      </div>
    </div>
    <div class="hub-panel" id="hp-meta" style="display:none"></div>
    <div class="hub-panel" id="hp-arsenal" style="display:none"></div>
    <div class="hub-panel" id="hp-rank" style="display:none">
      <div class="hub-empty"><span class="he-ic">▤</span><span data-i18n>Рейтинги — скоро</span><br><span style="font-size:11px;color:var(--cyan-dim)" data-i18n>сезонный рейтинг по местам в матчах</span></div>
    </div>
    <div class="hub-panel" id="hp-ally" style="display:none">
      <div class="hub-empty"><span class="he-ic">⚑</span><span data-i18n>Альянсы</span><br><span style="font-size:11px;color:var(--cyan-dim)" data-i18n>корпорации · общие AvA-битвы · влияние</span></div>
      <button id="ccorp" class="hub-solo" type="button">⬢ <span data-i18n>Кабинет корпорации</span></button>
    </div>
    <div class="hub-panel" id="hp-more" style="display:none">
      <div class="hub-grid">
        <button class="hub-tile" id="hub-tutorial" type="button"><span class="ht-ic">◎</span><span data-i18n>Обучение</span></button>
        <button class="hub-tile" id="hub-help" type="button"><span class="ht-ic">?</span><span data-i18n>Справочник</span></button>
        <button class="hub-tile" id="hub-settings" type="button"><span class="ht-ic">⚙</span><span data-i18n>Настройки</span></button>
        <button class="hub-tile" id="hub-upd" type="button" style="display:none"><span class="ht-ic">⟳</span><span data-i18n>Обновления</span></button>
        <button class="hub-tile" data-more="Аккаунт" type="button"><span class="ht-ic">◉</span><span data-i18n>Аккаунт</span></button>
        <button class="hub-tile" data-more="Сообщество" type="button"><span class="ht-ic">◍</span><span data-i18n>Сообщество</span></button>
        <button class="hub-tile" data-more="Поддержка" type="button"><span class="ht-ic">⚠</span><span data-i18n>Поддержка</span></button>
        <button class="hub-tile" data-more="Уведомления" type="button"><span class="ht-ic">◔</span><span data-i18n>Уведомления</span></button>
        <button class="hub-tile" data-more="Чат" type="button"><span class="ht-ic">▭</span><span data-i18n>Чат</span></button>
        <button class="hub-tile wide" id="hub-logout" type="button"><span class="ht-ic">↩</span><span data-i18n>Сменить командира</span></button>
      </div>
    </div>
  </div>
  <div class="hub-note" id="hub-note"></div>
  <nav class="hub-nav">
    <button class="hub-tab active" data-hub="home" type="button"><span class="hn-ic">⌂</span><span data-i18n>Домой</span></button>
    <button class="hub-tab" data-hub="games" type="button"><span class="hn-ic">▶</span><span data-i18n>Игры</span></button>
    <button class="hub-tab" data-hub="rank" type="button"><span class="hn-ic">▤</span><span data-i18n>Рейтинг</span></button>
    <button class="hub-tab" data-hub="meta" type="button"><span class="hn-ic">★</span><span data-i18n>Прокачка</span></button>
    <button class="hub-tab" data-hub="arsenal" type="button"><span class="hn-ic">⚔</span><span data-i18n>Арсенал</span></button>
    <button class="hub-tab" data-hub="ally" type="button"><span class="hn-ic">⚑</span><span data-i18n>Альянсы</span></button>
    <button class="hub-tab" data-hub="more" type="button"><span class="hn-ic">≡</span><span data-i18n>Ещё</span></button>
  </nav>
</div>
<div id="emblempick">
  <div class="ep-box">
    <div class="ep-head"><b>ВЫБОР ЭМБЛЕМЫ</b><button id="ep-close" type="button" aria-label="Закрыть">✕</button></div>
    <div class="ep-grid" id="ep-grid"></div>
  </div>
</div>
<div id="corp">
  <div class="corpbox">
    <div id="corphd" class="corphd"></div>
    <div id="corptabs" class="corptabs"></div>
    <div id="corpbody" class="corpbody"></div>
  </div>
</div>
<div id="setup">
  <div class="sbox">
    <div class="stitle"><span class="dia"></span><b data-i18n>НАСТРОЙКА СХВАТКИ</b></div>
    <div id="setup-start" class="spane">
      <div class="scol">
        <p class="ssub" data-i18n>Выберите свой домашний мир на карте, задайте число соперников-ботов и запускайте. Пустые места займут боты — выключите место, чтобы командовать меньшим сектором, или выключите все ради мирной одиночной песочницы для знакомства с интерфейсом.</p>
        <svg id="setupmap" class="smap" preserveAspectRatio="xMidYMid meet"></svg>
        <p class="smaphint" id="setuphint" data-i18n>Тапните светящийся мир, чтобы выбрать старт</p>
        <div id="setupfactions"></div>
      </div>
      <div class="scol">
        <div id="setupslots" class="sslots"></div>
        <div class="sspeedlabel" data-i18n>Скорость времени</div>
        <p class="sspeedhint" data-i18n>×1 — реальное время (час пути = час жизни, мир живёт и офлайн). Для быстрой партии выбери ×10–×100.</p>
        <div id="setupspeed" class="sspeed">
          <button class="spdchip" type="button" data-spd="1">×1</button>
          <button class="spdchip" type="button" data-spd="2">×2</button>
          <button class="spdchip" type="button" data-spd="5">×5</button>
          <button class="spdchip" type="button" data-spd="10">×10</button>
          <button class="spdchip" type="button" data-spd="50">×50</button>
          <button class="spdchip" type="button" data-spd="100">×100</button>
        </div>
      </div>
    </div>
    <button id="setupgo" class="sgo" disabled data-i18n>ЗАПУСК</button>
    <button id="setupcancel" class="scancel" data-i18n>Назад</button>
  </div>
</div>
<!-- hero fitting: the module "on the cursor" — follows the pointer (heroes setup tab) -->
<!-- DEV TEST MODE — content rendered by testmode.ts; delete this one line to cut the markup -->
<!--dev-only--><div id="testmode"></div><!--/dev-only-->
<script>${js}</script>
</body></html>`;

// Player artifact: drop every <!--dev-only--> … <!--/dev-only--> fence. The matching
// JS is already compiled out by the define, so no handler is left pointing at a hole.
const stripDevMarkup = (html) => html.replace(/<!--dev-only-->[\s\S]*?<!--\/dev-only-->/g, '');

mkdirSync('prototype/dist', { recursive: true });
const devHtml = page(await bundle(false));
const playerHtml = stripDevMarkup(page(await bundle(true)));
writeFileSync('prototype/dist/void-dominion.html', devHtml);
writeFileSync('prototype/dist/void-dominion-player.html', playerHtml);
console.log('wrote prototype/dist/void-dominion.html (' + (devHtml.length / 1024).toFixed(0) + ' KB)');
console.log('wrote prototype/dist/void-dominion-player.html (' + (playerHtml.length / 1024).toFixed(0) + ' KB)');
