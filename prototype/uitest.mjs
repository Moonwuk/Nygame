// Headless smoke test for the browser UI: bundle main.ts for node, run it
// against a fake DOM/canvas, drive several animation frames + a click, and
// assert nothing throws. Not a substitute for a real browser, but it exercises
// init, the real-time loop, rendering calls, the side panel and input.
import { build } from 'esbuild';

const listeners = new Map(); // el -> {type: [fn]}
function mkEl(id) {
  const el = {
    id,
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    _children: [],
    set innerHTML(v) {
      this._html = v;
    },
    get innerHTML() {
      return this._html ?? '';
    },
    textContent: '',
    addEventListener(type, fn) {
      const m = listeners.get(this) ?? {};
      (m[type] ??= []).push(fn);
      listeners.set(this, m);
    },
    appendChild(child) {
      this._children.push(child);
      return child;
    },
    removeChild(child) {
      this._children = this._children.filter((c) => c !== child);
      return child;
    },
    remove() {},
    get children() {
      return this._children;
    },
    get firstElementChild() {
      return this._children[0] ?? null;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 900, height: 600 };
    },
    querySelectorAll() {
      return [];
    },
    getContext() {
      return ctxProxy;
    },
    width: 900,
    height: 600,
  };
  return el;
}
// Chainable stub: every method returns the proxy, so e.g.
// createRadialGradient(...).addColorStop(...) works.
const ctxProxy = new Proxy(
  {},
  {
    get: () => () => ctxProxy,
    set: () => true,
  },
);

const els = new Map();
const getEl = (id) => {
  if (!els.has(id)) els.set(id, mkEl(id));
  return els.get(id);
};

globalThis.document = {
  getElementById: getEl,
  querySelector: () => mkEl('q'), // tab/overlay wiring uses it; a stub element is enough
  querySelectorAll: () => [],
  // The prototype bakes offscreen canvases (glow sprites, the static map layer) via
  // document.createElement('canvas') at module load — give the stub a real element
  // (its getContext returns the chainable ctx proxy) so the render path runs.
  createElement: () => mkEl('canvas'),
  body: mkEl('body'),
};
let t = 0;
globalThis.performance = { now: () => (t += 16) };
// Net-mode reads localStorage for the saved server URL; stub it (no persistence).
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// resize() probes coarse-pointer media to spot phones; the fake DOM is a desktop.
globalThis.matchMedia = () => ({ matches: false });
// The APK Back integration wires popstate/history straight on window at module
// load — give the fake DOM a minimal window + history so init runs headless.
globalThis.window = {
  innerWidth: 900,
  innerHeight: 600,
  devicePixelRatio: 1,
  addEventListener() {},
  matchMedia: globalThis.matchMedia,
  setTimeout,
  clearTimeout,
};
globalThis.history = { pushState() {}, back() {} };
globalThis.location = { protocol: 'file:', host: '', hostname: '', href: 'file:///', search: '' };
const rafCbs = [];
globalThis.requestAnimationFrame = (cb) => {
  rafCbs.push(cb);
  return rafCbs.length;
};

const res = await build({
  entryPoints: ['prototype/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  write: false,
});

const mod = { exports: {} };
const fn = new Function('module', 'exports', 'require', res.outputFiles[0].text);
fn(mod, mod.exports, () => ({}));

// drive ~40 frames (~0.6s real → with speed 2 ≈ many game hours)
let frames = 0;
for (let i = 0; i < 40 && rafCbs.length; i++) {
  const cb = rafCbs.shift();
  cb(performance.now());
  frames++;
}

// simulate a click on the canvas (HOME ≈ 130,330) and a side-panel build click
const canvas = getEl('map');
const canvasClicks = (listeners.get(canvas) ?? {}).click ?? [];
for (const fn2 of canvasClicks) fn2({ clientX: 130, clientY: 330 });
const sideEl = getEl('side');
const sideClicks = (listeners.get(sideEl) ?? {}).click ?? [];
for (const fn2 of sideClicks)
  fn2({ target: { closest: () => ({ disabled: false, dataset: { act: 'build', arg: 'refinery' } }) } });

// a few more frames after interaction
for (let i = 0; i < 20 && rafCbs.length; i++) {
  rafCbs.shift()(performance.now());
  frames++;
}

console.log(`UI OK — ran ${frames} frames + clicks with no throw. clock="${getEl('clock').textContent}"`);
console.log(`purse="${getEl('purse').textContent}"`);
console.log(`log has ${(getEl('log').innerHTML.match(/<div>/g) || []).length} lines`);
