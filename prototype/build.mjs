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
/* the six currencies always fit the bar — no scroll. Chips share the width and shrink
   together (flex:1 1 0; min-width:0) so the row scales down instead of overflowing. */
#purse{display:flex;align-items:center;flex:1 1 auto;min-width:0;overflow:hidden;height:100%;margin:0 4px;
  border-left:1px solid var(--line);border-right:1px solid var(--line);}
.res{display:flex;align-items:center;justify-content:center;gap:4px;padding:0 4px;height:100%;flex:1 1 0;min-width:0;}
.res i{flex:0 0 auto;text-align:center;font-style:normal;font-size:13px;line-height:1;
  color:var(--cyan);font-variant-emoji:text;text-shadow:0 0 6px rgba(53,214,230,.4);}
.res b{color:#eafffb;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* donate/premium currency (Суверены): gold accent — moved out of the resource bar onto
   the status line right under it (#devline .dl-donate), pushed to the right end. Rendered
   as an enlarged, glowing gold pill with a slow pulse so it actually draws the eye. */
#devline .dl-donate{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:6px;
  padding:3px 11px;border-radius:13px;color:#fff2cf;font-weight:800;font-size:16px;line-height:1;
  letter-spacing:.4px;font-variant-numeric:tabular-nums;
  background:linear-gradient(180deg,rgba(255,206,92,.22),rgba(240,170,40,.12));
  border:1px solid rgba(255,208,96,.6);
  box-shadow:0 0 14px rgba(255,198,72,.4),inset 0 0 7px rgba(255,214,120,.18);
  animation:donatePulse 2.6s ease-in-out infinite;}
#devline .dl-donate i{color:#ffd45e;text-shadow:0 0 10px rgba(255,212,94,.85);font-style:normal;font-size:20px;}
@keyframes donatePulse{
  0%,100%{box-shadow:0 0 10px rgba(255,198,72,.30),inset 0 0 7px rgba(255,214,120,.16);}
  50%{box-shadow:0 0 22px rgba(255,205,90,.7),inset 0 0 9px rgba(255,220,130,.30);}}
#speedbar{position:fixed;right:14px;bottom:14px;z-index:24;display:flex;align-items:center;gap:4px;
  padding:5px 7px;background:rgba(3,12,16,.78);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 16px rgba(40,200,210,.10);transition:bottom .2s ease;}
body.sheet-open #speedbar{bottom:calc(34vh + 12px);}
#fps{position:fixed;top:82px;right:10px;z-index:25;pointer-events:none;
  font:700 10px ui-monospace,Menlo,monospace;color:var(--grn);opacity:.72;letter-spacing:.5px;
  text-shadow:0 0 6px rgba(0,0,0,.85);}
@media (max-width:720px){#fps{top:78px;}}
.spd button{min-width:30px;height:26px;padding:0 5px;border-radius:2px;cursor:pointer;font:11px ui-monospace,monospace;
  background:transparent;color:var(--cyan-dim);border:1px solid var(--line-hi);}
.spd button.on{background:rgba(53,214,230,.16);color:var(--cyan);border-color:var(--cyan);box-shadow:0 0 10px rgba(53,214,230,.4);}
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

/* slim icon rail in the bottom-left corner (just the wired tools); each icon opens a
   window. column-reverse + bottom anchor → it grows UPWARD as more tools get wired,
   with the primary icon nearest the thumb. Short, so the map around it stays tappable. */
#rail{position:fixed;left:8px;bottom:14px;top:auto;width:42px;z-index:26;display:flex;flex-direction:column-reverse;gap:4px;
  padding:4px;background:rgba(3,12,16,.72);border:1px solid var(--line-hi);border-radius:9px;
  box-shadow:0 0 16px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#rail button{position:relative;width:34px;height:34px;background:transparent;border:0;cursor:pointer;
  font-size:17px;color:var(--cyan-dim);border-radius:6px;font-variant-emoji:text;}
#rail button:hover,#rail button:active{color:var(--cyan);background:rgba(53,214,230,.12);text-shadow:0 0 8px rgba(53,214,230,.6);}
#rail .badge{position:absolute;right:5px;top:4px;min-width:15px;height:15px;border-radius:8px;
  background:var(--red);color:#180605;font:700 9px/15px ui-monospace,monospace;text-align:center;
  box-shadow:0 0 8px rgba(255,90,77,.7);}

#side{position:fixed;left:58px;right:14px;bottom:0;top:auto;width:auto;max-height:34vh;overflow:hidden;z-index:20;
  display:none;align-items:stretch;padding:0;background:var(--glass);border:1px solid var(--line-hi);
  box-shadow:0 0 26px rgba(0,0,0,.6),0 0 0 1px rgba(53,214,230,.08),inset 0 0 30px rgba(53,214,230,.04);
  clip-path:polygon(0 9px,9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%);}
/* scrollable content (left) + a dossier pane glued to the right edge, filling the
   panel's otherwise-empty space. The pane shows the hovered object's description. */
.pscroll{flex:1 1 auto;min-width:0;overflow:auto;padding:13px 15px;touch-action:pan-y;}
/* dossier pane: width fits its content (grows as rows are added) instead of a
   fixed column, and it never scrolls internally — the colleague's no-scroll rule */
.pdesc{flex:0 1 auto;width:fit-content;min-width:188px;max-width:48%;overflow:visible;
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
#log{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:10px 14px;
  font:11px/1.6 ui-monospace,Menlo,monospace;color:#73b6a2;scrollbar-width:thin;}
#log div::before{content:"> ";color:var(--grn-dim);}

/* technologies window (modal, mirrors #logwin) */
#tech{position:fixed;inset:0;z-index:47;display:none;align-items:center;justify-content:center;padding:16px;
  background:rgba(1,5,9,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
#tech.show{display:flex;}
#tech .twbox{display:flex;flex-direction:column;width:min(460px,94vw);max-height:82vh;overflow:hidden;
  background:var(--glass);border:1px solid var(--cyan);border-radius:10px;
  box-shadow:0 0 40px rgba(0,0,0,.6),inset 0 0 0 1px rgba(53,214,230,.06);}
.tw-close{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;}
#techbody{flex:1;min-height:0;overflow:auto;touch-action:pan-y;padding:12px 14px;}
.tw-active{margin:0 0 14px;padding:10px 12px;border:1px solid var(--cyan-dim);border-radius:9px;background:rgba(53,214,230,.08);}
.tw-active .tw-an{font-size:12px;color:var(--cyan);letter-spacing:.5px;}
.tw-active .tw-bar{margin-top:8px;height:6px;border-radius:4px;background:rgba(53,214,230,.14);overflow:hidden;}
.tw-active .tw-fill{height:100%;background:var(--cyan);box-shadow:0 0 8px var(--cyan);transition:width .3s;}
.tw-active .tw-eta{margin-top:5px;font-size:10px;color:var(--dim);}
.tw-branch{margin:16px 0 8px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);}
.tw-branch:first-child{margin-top:0;}
.tw-card{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;border:1px solid var(--line-hi);
  border-radius:9px;background:rgba(255,255,255,.02);}
.tw-card.done{border-color:var(--up,#57e0a0);opacity:.75;}
.tw-card.locked{opacity:.55;}
.tw-info{flex:1;min-width:0;}
.tw-name{font-size:13px;color:var(--ink);}
.tw-name .tier{font-size:9px;color:var(--dim);margin-left:6px;letter-spacing:1px;}
.tw-meta{margin-top:3px;font-size:10px;color:var(--dim);line-height:1.4;}
.tw-cost{color:var(--cyan-dim);}
.tw-go{flex:none;padding:8px 12px;border-radius:7px;border:1px solid var(--cyan);background:rgba(53,214,230,.14);
  color:var(--cyan);font:11px ui-monospace,monospace;letter-spacing:.5px;cursor:pointer;white-space:nowrap;}
.tw-go:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line);color:var(--dim);background:transparent;}
.tw-badge{flex:none;font-size:11px;letter-spacing:1px;color:var(--up,#57e0a0);}
.tw-badge.wait{color:var(--amber);}

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

/* === FLOATING CHAT (desktop) — sized/positioned/opacity inline by renderChat() === */
.desk-only{} /* shown by default; the media query below hides it on phones */
@media (max-width:720px){.desk-only{display:none!important;}}
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

@media (max-width:720px){
  #top{height:44px;}
  .who{display:none;}
  .crest{padding:0 10px;}
  #devline{top:44px;}

  #side{right:0;left:0;bottom:0;top:auto;width:auto;max-height:50vh;z-index:28;clip-path:none;
    border-left:0;border-right:0;border-top:1px solid var(--cyan);}
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
#connect .cstat{margin-top:14px;min-height:16px;font-size:12px;color:var(--amber);text-align:center;}
#connect .mtabs{display:flex;gap:6px;margin-top:16px;}
#connect .mtab{flex:1;padding:8px 6px;border-radius:7px;border:1px solid var(--line-hi);background:transparent;
  color:var(--dim);font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;}
#connect .mtab.active{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.10);}
#connect .mlist{margin-top:10px;max-height:46vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;}
#connect .mempty{padding:18px 8px;text-align:center;color:var(--dim);font-size:12px;}
#connect .mrow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line-hi);
  border-radius:8px;background:rgba(255,255,255,.02);}
#connect .minfo{flex:1;min-width:0;}
#connect .mname{font-size:13px;color:var(--txt,#dfeef2);text-transform:capitalize;}
#connect .mname .mid{font-size:10px;color:var(--dim);letter-spacing:.5px;text-transform:none;margin-left:6px;}
#connect .mmeta{margin-top:3px;font-size:11px;color:var(--dim);}
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
#lobby{position:fixed;inset:0;z-index:55;display:none;align-items:center;justify-content:center;
  background:rgba(2,8,11,.66);}
#lobby .lbox{width:min(420px,94vw);background:var(--glass);border:1px solid var(--line-hi);
  border-radius:14px;padding:22px;box-shadow:0 0 40px rgba(0,0,0,.6);}
#lobby .ltitle{display:flex;align-items:center;gap:10px;font-size:18px;letter-spacing:3px;color:var(--cyan);}
#lobby .ltitle .dia{width:12px;height:12px;transform:rotate(45deg);background:var(--cyan);box-shadow:0 0 10px var(--cyan);border:none;}
#lobby .lsub{margin:8px 0 16px;color:var(--dim);font-size:12px;line-height:1.5;}
#lobby .lroster{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}
#lobby .lrow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line-hi);
  border-radius:8px;font:13px ui-monospace,monospace;color:var(--ink);}
#lobby .lrow .dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor;}
#lobby .lrow .nm{flex:1;}
#lobby .lrow .me{font-size:10px;color:var(--cyan);letter-spacing:1px;}
#lobby .lrow .host{font-size:9px;letter-spacing:.5px;border:1px solid var(--line-hi);border-radius:3px;
  padding:2px 5px;color:var(--amber);}
#lobby .lrow.off{opacity:.5;}
#lobby .lbtn{width:100%;padding:13px 10px;border-radius:8px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.14);color:var(--cyan);font:13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
#lobby .lbtn:disabled{opacity:.4;cursor:not-allowed;}
#lobby .lbtn.ghost{margin-top:8px;border-color:var(--line-hi);background:transparent;color:var(--dim);}
#lobby .lwait{text-align:center;color:var(--dim);font-size:12px;margin-bottom:8px;}
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
#setup .srow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line-hi);
  border-radius:8px;font:13px ui-monospace,monospace;color:var(--ink);}
#setup .srow .dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor;}
#setup .srow .nm{flex:1;}
#setup .srow .you{font-size:10px;color:var(--cyan);letter-spacing:1px;}
#setup .srow.off{opacity:.45;}
#setup .srow .stog{font:11px ui-monospace,monospace;letter-spacing:1px;border:1px solid var(--line-hi);
  border-radius:6px;padding:6px 12px;min-width:64px;cursor:pointer;background:transparent;color:var(--dim);}
#setup .srow .stog.ai{border-color:var(--cyan);color:var(--cyan);background:rgba(53,214,230,.12);}
#setup .sspeedlabel{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan-dim);margin:0 0 8px;}
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
#heldghost{position:fixed;z-index:80;pointer-events:none;display:none;transform:translate(-50%,-50%);
  font-size:26px;filter:drop-shadow(0 0 7px rgba(53,214,230,.9));}
/* hero grade (rarity) line — colour by tier */
.fitpane .hgradeline{font:600 12px ui-monospace,monospace;letter-spacing:.5px;margin:2px 0 10px;}
.fitpane .hgradeline.g-common{color:#8fa6ad;}
.fitpane .hgradeline.g-rare{color:#5fd0ff;}
.fitpane .hgradeline.g-legendary{color:var(--amber);}
.fitpane .hgradeline.g-main{color:var(--grn);}

/* in-app APK update banner + manual check (APK only; updater.ts toggles visibility) */
#connect #updbar{display:none;margin:14px 0 0;padding:12px 14px;border:1px solid var(--cyan);border-radius:10px;
  background:rgba(53,214,230,.10);box-shadow:0 0 22px rgba(53,214,230,.12);}
#connect #updbar .ub-t{font-size:12px;color:var(--cyan-dim);letter-spacing:.5px;line-height:1.5;}
#connect #updbar .ub-t b{color:var(--ink);}
#connect #updbar .ub-row{display:flex;gap:10px;margin-top:10px;}
#connect #updbar .ub-go{flex:1;text-align:center;padding:11px 10px;border-radius:8px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.18);color:var(--cyan);font-size:13px;letter-spacing:1px;text-decoration:none;cursor:pointer;}
#connect #updbar .ub-go:active{background:rgba(53,214,230,.3);}
#connect #updbar .ub-later{flex:none;padding:11px 16px;border-radius:8px;border:1px solid var(--line-hi);
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
  /* content stacks: list on top, hovered-object dossier pinned below. While the card
     fits its content it just grows; once it hits the viewport cap the list (not the
     whole card) scrolls — so the dossier stays put and nothing is ever clipped away */
  #side .pscroll{flex:1 1 auto;min-height:0;}
  #side .pdesc{flex:0 0 auto;width:auto;max-width:none;max-height:none;
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
  #connect,#setup,#codex,#playercard,#warprompt,#diplo,#splitdlg,#pingmenu{
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
  display:grid;place-items:center;color:var(--cyan);font-size:17px;flex:0 0 auto;box-shadow:inset 0 0 10px rgba(53,214,230,.1);}
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
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Void Dominion — Sector Command</title><style>${css}</style></head>
<body>
<canvas id="map"></canvas>
<header id="top">
  <div class="crest">
    <div class="who"><b>VOID DOMINION</b><span>SECTOR COMMAND</span></div>
  </div>
  <div id="purse"></div>
</header>
<div id="devline"></div>
<!-- slim left rail: only the wired tools (each opens its window). More icons land here as
     features get wired. -->
<nav id="rail">
  <button id="rail-diplo" title="Дипломатия">⬡</button>
  <button id="rail-msgs" title="Сообщения">✉</button>
  <button id="rail-tech" title="Технологии">⚛</button>
  <button id="rail-market" title="Рынок">⇄</button>
  <button id="railcorp" title="Корпорация">⬢</button>
  <button id="rail-chat" title="Чат" class="desk-only">🗨</button>
  <button id="rail-log" title="Сводки">≡<span class="badge" id="alertbadge" style="display:none">0</span></button>
</nav>
<!-- floating chat window (desktop only) — content rendered by renderChat() in main.ts -->
<div id="chatwin" class="desk-only"></div>
<div id="logwin"><div class="lwbox"><div class="lw-head"><b>СВОДКИ</b><button class="lw-close">✕</button></div><div id="log"></div></div></div>
<!-- technologies window — content rendered by renderTech() in main.ts -->
<div id="tech"><div class="twbox"><div class="lw-head"><b>ТЕХНОЛОГИИ</b><button class="tw-close">✕</button></div><div id="techbody"></div></div></div>
<!-- session market — whole box rendered by renderMarket() in main.ts -->
<div id="market"></div>
<aside id="side"></aside>
<div id="speedbar" class="spd">
  <button id="spd-pause" data-speed="0">‖</button><button id="spd-play" data-speed="1" class="on">▶</button><button id="spd-fast" data-speed="3">▶▶</button>
  <span class="sep" id="restart-sep" style="display:none"></span><button id="restart" title="Перезапуск — к выбору ботов" style="display:none">⟳</button>
  <span class="sep"></span><button id="tomenu" title="Выход в меню">⌂</button>
</div>
<div id="cmdbar"></div>
<div id="codex"></div>
<div id="playercard"></div>
<div id="warprompt"></div>
<div id="diplo"></div>
<div id="pingpop"></div>
<div id="splitdlg"></div>
<div id="pingmenu"></div>
<div id="fps"></div>
<div id="banner"></div>
<div id="connect">
  <div class="cwrap">
    <button id="clang" class="clang" type="button">РУССКИЙ <span class="car">▼</span></button>
    <div class="cbox">
      <div id="cwelcome">
        <div class="ccrest">
          <div class="ring"><span class="dia"></span></div>
          <div class="wm">VOID DOMINION</div>
          <div class="wtag">Грань пустоты</div>
        </div>
        <button id="cnew" class="cnew" type="button">Новый командир</button>
        <div class="cdiv">войти через</div>
        <div class="csocial">
          <button id="cgoogle" class="csoc" type="button" aria-label="Войти через Google" title="Войти через Google">G</button>
          <button id="capple" class="csoc" type="button" aria-label="Войти через Apple" title="Войти через Apple"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.4 12.9c0-2.3 1.9-3.4 2-3.4-1.1-1.6-2.8-1.8-3.4-1.8-1.5-.1-2.8.8-3.5.8s-1.8-.8-3-.8c-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.5-.7 2.9-.7s1.7.7 2.9.7c1.2 0 2-1.1 2.7-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.3-.9-2.3-3zM14.3 6.3c.6-.8 1-1.8.9-2.9-.9 0-2 .6-2.6 1.3-.6.7-1.1 1.7-.9 2.7 1 .1 2-.5 2.6-1.1z"/></svg></button>
        </div>
        <div class="cstack">
          <button id="clogin" class="cbtn ghost" type="button">Вход по позывному</button>
          <button id="csolo" class="cbtn ghost" type="button">Одиночная игра</button>
        </div>
      </div>
      <div id="cbrowse" style="display:none">
        <button id="cback" class="cback" type="button">‹ назад</button>
        <div class="ctitle"><span class="dia"></span><b>МАТЧИ</b></div>
        <p class="csub">Выбери матч из списка и войди, или обнови список.</p>
        <label class="cfield">Сервер
          <input id="csrv" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="wss://… or ws://host:8788">
        </label>
        <label class="cfield">Позывной
          <input id="cnick" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="24" placeholder="позывной">
        </label>
        <div class="crow">
          <button id="cgo" class="cbtn" type="button">Обновить список</button>
        </div>
        <div class="mtabs">
          <button class="mtab active" data-tab="available">Доступные</button>
          <button class="mtab" data-tab="active">Активные</button>
          <button class="mtab" data-tab="archived">Архив</button>
        </div>
        <div id="mlist" class="mlist"></div>
      </div>
      <div id="cstatus" class="cstat"></div>
    </div>
    <!-- in-app APK update (APK only; dormant in the browser — driven by updater.ts) -->
    <div id="updbar">
      <div class="ub-t">Доступна новая сборка <b id="ub-ver"></b></div>
      <div class="ub-row">
        <a id="ub-go" class="ub-go" href="#" rel="noopener">Обновить</a>
        <button id="ub-later" class="ub-later" type="button">Позже</button>
      </div>
    </div>
    <button id="cupd" class="cupd" type="button" style="display:none">Проверить обновления</button>
    <div id="cver" class="cver"></div>
    <!-- DEV TEST MODE — remove this button (and the #testmode block + CSS + main.ts hook) to cut the feature -->
    <button id="ctest" class="cbtn ghost tm-open">🧪 Тесты · режим разработчика</button>
    <!-- /DEV TEST MODE -->
    <div class="cfoot">
      <a id="cl-imprint">Выходные данные</a>
      <a id="cl-terms">Условия</a>
      <a id="cl-privacy">Политика конфиденциальности</a>
      <a id="cl-support">Поддержка</a>
    </div>
  </div>
</div>
<div id="hub">
  <div class="hub-banner">
    <div class="hub-crest"><span class="dia"></span></div>
    <div class="hub-bt">VOID DOMINION</div>
  </div>
  <div class="hub-id">
    <div class="hub-av">◆</div>
    <div class="hub-who">
      <div class="hub-name" id="hub-name">Командир</div>
      <div class="hub-st">в сети</div>
    </div>
    <button class="hub-msg" id="hub-msg" type="button" aria-label="Сообщения">✉</button>
  </div>
  <div class="hub-body">
    <div class="hub-panel" id="hp-home">
      <button id="hub-play" class="hub-play" type="button">ИГРАТЬ СЕЙЧАС</button>
      <button id="hub-solo" class="hub-solo" type="button">Одиночная игра</button>
      <div class="hub-sec">Сводка</div>
      <div class="hub-card">
        <div class="hc-ic">◷</div>
        <div><div class="hc-t">Нет матчей, ждущих приказа</div><div class="hc-s">Войди в матч на вкладке «Игры» — здесь появятся ходы, требующие внимания.</div></div>
      </div>
      <div class="hub-card">
        <div class="hc-ic">✦</div>
        <div><div class="hc-t">Сезон ещё не начат</div><div class="hc-s">Рейтинги и альянсы откроются со стартом мета-слоя.</div></div>
      </div>
    </div>
    <div class="hub-panel" id="hp-rank" style="display:none">
      <div class="hub-empty"><span class="he-ic">▤</span>Рейтинги — скоро<br><span style="font-size:11px;color:var(--cyan-dim)">сезонный рейтинг по местам в матчах</span></div>
    </div>
    <div class="hub-panel" id="hp-ally" style="display:none">
      <div class="hub-empty"><span class="he-ic">⚑</span>Альянсы — скоро<br><span style="font-size:11px;color:var(--cyan-dim)">корпорации · общие AvA-битвы · влияние</span></div>
      <button id="ccorp" class="hub-solo" type="button">⬢ Кабинет корпорации (макет)</button>
    </div>
    <div class="hub-panel" id="hp-more" style="display:none">
      <div class="hub-grid">
        <button class="hub-tile" data-more="Аккаунт" type="button"><span class="ht-ic">◉</span>Аккаунт</button>
        <button class="hub-tile" data-more="Сообщество" type="button"><span class="ht-ic">◍</span>Сообщество</button>
        <button class="hub-tile" data-more="Поддержка" type="button"><span class="ht-ic">⚠</span>Поддержка</button>
        <button class="hub-tile" data-more="Уведомления" type="button"><span class="ht-ic">◔</span>Уведомления</button>
        <button class="hub-tile" data-more="Чат" type="button"><span class="ht-ic">▭</span>Чат</button>
        <button class="hub-tile wide" id="hub-logout" type="button"><span class="ht-ic">↩</span>Сменить командира</button>
      </div>
    </div>
  </div>
  <div class="hub-note" id="hub-note"></div>
  <nav class="hub-nav">
    <button class="hub-tab active" data-hub="home" type="button"><span class="hn-ic">⌂</span>Домой</button>
    <button class="hub-tab" data-hub="games" type="button"><span class="hn-ic">▶</span>Игры</button>
    <button class="hub-tab" data-hub="rank" type="button"><span class="hn-ic">▤</span>Рейтинг</button>
    <button class="hub-tab" data-hub="ally" type="button"><span class="hn-ic">⚑</span>Альянсы</button>
    <button class="hub-tab" data-hub="more" type="button"><span class="hn-ic">≡</span>Ещё</button>
  </nav>
</div>
<div id="corp">
  <div class="corpbox">
    <div id="corphd" class="corphd"></div>
    <div id="corptabs" class="corptabs"></div>
    <div id="corpbody" class="corpbody"></div>
  </div>
</div>
<div id="lobby">
  <div class="lbox">
    <div class="ltitle"><span class="dia"></span><b>LOBBY</b></div>
    <p class="lsub">Waiting in the staging sector. The host starts the match when ready.</p>
    <div id="lroster" class="lroster"></div>
    <div id="lactions"></div>
  </div>
</div>
<div id="setup">
  <div class="sbox">
    <div class="stitle"><span class="dia"></span><b>SKIRMISH SETUP</b></div>
    <div class="stabs"><button data-stab="start" class="on">Старт</button><button data-stab="div">Дивизии</button><button data-stab="hero">Герои</button><button data-stab="ship">Верфь</button></div>
    <div id="setup-start" class="spane">
      <p class="ssub">Pick your homeworld on the map, choose how many rivals join, then launch. Empty
        slots are taken by the AI — switch a slot OFF to command a smaller sector, or switch
        them all OFF for a peaceful solo sandbox to explore the interface.</p>
      <svg id="setupmap" class="smap" preserveAspectRatio="xMidYMid meet"></svg>
      <p class="smaphint" id="setuphint">Tap a glowing world to choose your start</p>
      <div id="setupslots" class="sslots"></div>
      <div class="sspeedlabel">Скорость времени</div>
      <div id="setupspeed" class="sspeed">
        <button class="spdchip on" type="button" data-spd="1">×1</button>
        <button class="spdchip" type="button" data-spd="2">×2</button>
        <button class="spdchip" type="button" data-spd="5">×5</button>
        <button class="spdchip" type="button" data-spd="10">×10</button>
        <button class="spdchip" type="button" data-spd="50">×50</button>
      </div>
    </div>
    <div id="setup-div" class="spane" style="display:none"></div>
    <div id="setup-hero" class="spane fitpane" style="display:none"></div>
    <div id="setup-ship" class="spane fitpane" style="display:none"></div>
    <button id="setupgo" class="sgo" disabled>LAUNCH</button>
    <button id="setupcancel" class="scancel">Back</button>
  </div>
</div>
<!-- hero fitting: the module "on the cursor" — follows the pointer (heroes setup tab) -->
<div id="heldghost"></div>
<!-- DEV TEST MODE — content rendered by testmode.ts; delete this one line to cut the markup -->
<div id="testmode"></div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
