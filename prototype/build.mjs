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
#purse{display:flex;align-items:center;flex:1 1 auto;min-width:0;overflow-x:auto;height:100%;margin:0 4px;
  border-left:1px solid var(--line);border-right:1px solid var(--line);scrollbar-width:none;}
#purse::-webkit-scrollbar{display:none;}
/* uniform chips so the currencies line up evenly: fixed-width centred icon box +
   tabular value, equal min-width per chip */
.res{display:flex;align-items:center;gap:6px;padding:0 10px;height:100%;flex:0 0 auto;min-width:58px;}
.res i{display:inline-block;width:16px;text-align:center;font-style:normal;font-size:14px;line-height:1;
  color:var(--cyan);font-variant-emoji:text;text-shadow:0 0 6px rgba(53,214,230,.4);}
.res b{color:#eafffb;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;}
/* donate/premium currency (Суверены): pinned to the far-right corner, gold accent */
.res.donate{margin-left:auto;border-left:1px solid var(--line);}
.res.donate i{color:#ffd45e;text-shadow:0 0 7px rgba(255,212,94,.5);}
.res.donate b{color:#ffe6a3;}
#speedbar{position:fixed;right:14px;bottom:14px;z-index:24;display:flex;align-items:center;gap:4px;
  padding:5px 7px;background:rgba(3,12,16,.78);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 16px rgba(40,200,210,.10);transition:bottom .2s ease;}
body.sheet-open #speedbar{bottom:calc(34vh + 12px);}
#fps{position:fixed;top:70px;right:10px;z-index:25;pointer-events:none;
  font:700 10px ui-monospace,Menlo,monospace;color:var(--grn);opacity:.72;letter-spacing:.5px;
  text-shadow:0 0 6px rgba(0,0,0,.85);}
@media (max-width:720px){#fps{top:68px;}}
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
.dp-row{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:7px;border:1px solid var(--line);
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

/* status strip below the top bar: day/time + victory progress */
#devline{position:fixed;top:46px;left:0;right:0;height:20px;z-index:24;display:flex;align-items:center;gap:14px;
  padding:0 14px;background:rgba(2,8,11,.55);color:var(--cyan-dim);font-size:11px;letter-spacing:.6px;
  white-space:nowrap;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid rgba(14,59,64,.5);}
#devline::-webkit-scrollbar{display:none;}
#devline #clock{color:var(--grn);font-variant-numeric:tabular-nums;flex:0 0 auto;}
#devline .dstat{flex:0 0 auto;}
#devline .dstat.win{color:var(--up);font-weight:700;}

#rail{position:fixed;left:0;top:66px;bottom:0;width:44px;z-index:24;display:flex;flex-direction:column;
  align-items:center;gap:2px;padding-top:6px;background:rgba(2,9,13,.6);border-right:1px solid var(--line);}
#rail button{position:relative;width:44px;height:40px;background:transparent;border:0;cursor:pointer;
  font-size:16px;color:var(--cyan-dim);}
#rail button:hover{color:var(--cyan);background:rgba(53,214,230,.08);text-shadow:0 0 8px rgba(53,214,230,.6);}
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
.pdesc{flex:0 0 236px;overflow:auto;padding:14px 15px;border-left:1px solid var(--line-hi);
  background:rgba(53,214,230,.035);}
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

#botleft{position:fixed;left:6px;bottom:8px;z-index:24;display:flex;align-items:center;gap:8px;}
.chat{width:40px;height:40px;cursor:pointer;font-size:16px;border-radius:2px;
  background:rgba(2,9,13,.7);border:1px solid var(--line-hi);color:var(--cyan-dim);}
#hovercard{position:fixed;top:70px;right:14px;width:220px;z-index:22;pointer-events:none;
  padding:12px 14px;background:rgba(3,12,16,.88);border:1px solid var(--line-hi);border-radius:3px;
  box-shadow:0 0 18px rgba(40,200,210,.12);font-size:11px;line-height:1.55;display:none;}
#hovercard.show{display:block;}
#hovercard .hc-title{color:var(--cyan);font-size:12px;font-weight:700;letter-spacing:1.5px;margin-bottom:7px;border-bottom:1px solid var(--line);padding-bottom:5px;}
#hovercard .hc-row{display:flex;justify-content:space-between;gap:8px;margin:2px 0;}
#hovercard .hc-key{color:var(--dim);letter-spacing:.5px;}
#hovercard .hc-val{color:var(--ink);font-weight:700;text-align:right;}
#hovercard .hc-sub{color:var(--cyan-dim);font-size:10px;margin-top:5px;}
@media (max-width:720px){#hovercard{display:none!important;}}
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
  .res{padding:0 6px;gap:4px;min-width:52px;}
  #devline{top:44px;}

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
#lobby .lwait{text-align:center;color:var(--dim);font-size:12px;}
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
#setup .sgo{width:100%;padding:13px 10px;border-radius:8px;border:1px solid var(--cyan);
  background:rgba(53,214,230,.16);color:var(--cyan);font:600 13px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;min-height:46px;}
#setup .sgo:disabled{opacity:.4;cursor:not-allowed;}
#setup .scancel{width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--line-hi);
  background:transparent;color:var(--dim);font:12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;}
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
  <div id="purse"></div>
</header>
<div id="devline"></div>
<div id="scrim"></div>
<div id="drawer">
  <nav id="rail">
    <button id="rail-msgs" title="Dispatches">≡<span class="rlabel">Dispatches</span></button>
    <button id="rail-diplo" title="Diplomacy">⬡<span class="rlabel">Diplomacy</span></button>
    <button title="Economy">¤<span class="rlabel">Economy</span></button>
    <button title="Military">△<span class="rlabel">Military</span></button>
    <button title="Army">▤<span class="rlabel">Army</span></button>
    <button title="Espionage (soon)">◎<span class="rlabel">Espionage</span></button>
    <button title="Markers">⚑<span class="rlabel">Markers</span></button>
    <button title="Research (soon)">✛<span class="rlabel">Research</span></button>
    <button title="Alerts">⚠<span class="rlabel">Alerts</span><span class="badge" id="alertbadge" style="display:none">0</span></button>
  </nav>
  <div id="log"></div>
  <footer id="botleft"><button class="chat" title="Comms">◈</button></footer>
</div>
<aside id="side"></aside>
<div id="speedbar" class="spd">
  <button data-speed="0">‖</button><button data-speed="2" class="on">▶</button><button data-speed="6">▶▶</button>
</div>
<div id="hovercard"></div>
<div id="cmdbar"></div>
<div id="codex"></div>
<div id="playercard"></div>
<div id="warprompt"></div>
<div id="diplo"></div>
<div id="pingpop"></div>
<div id="splitdlg"></div>
<div id="fps"></div>
<div id="banner"></div>
<div id="connect">
  <div class="cbox">
    <div class="ctitle"><span class="dia"></span><b>VOID DOMINION</b></div>
    <p class="csub">Выбери матч из списка и войди, или запусти одиночную игру.</p>
    <label class="cfield">Сервер
      <input id="csrv" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="wss://… or ws://host:8788">
    </label>
    <label class="cfield">Имя
      <input id="cnick" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="24" placeholder="commander name">
    </label>
    <div class="crow">
      <button id="cgo" class="cbtn">Обновить список</button>
      <button id="csolo" class="cbtn ghost">Одиночная игра</button>
    </div>
    <div class="mtabs">
      <button class="mtab active" data-tab="available">Доступные</button>
      <button class="mtab" data-tab="active">Активные</button>
      <button class="mtab" data-tab="archived">Архив</button>
    </div>
    <div id="mlist" class="mlist"></div>
    <div id="cstatus" class="cstat"></div>
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
    <p class="ssub">Pick your homeworld on the map, choose how many rivals join, then launch. Empty
      slots are taken by the AI — switch a slot OFF to command a smaller sector.</p>
    <svg id="setupmap" class="smap" preserveAspectRatio="xMidYMid meet"></svg>
    <p class="smaphint" id="setuphint">Tap a glowing world to choose your start</p>
    <div id="setupslots" class="sslots"></div>
    <button id="setupgo" class="sgo" disabled>LAUNCH</button>
    <button id="setupcancel" class="scancel">Back</button>
  </div>
</div>
<script>${js}</script>
</body></html>`;

mkdirSync('prototype/dist', { recursive: true });
writeFileSync('prototype/dist/void-dominion.html', html);
console.log('wrote prototype/dist/void-dominion.html (' + (html.length / 1024).toFixed(0) + ' KB)');
