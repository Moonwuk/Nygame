// M2 headless perf harness (docs/metrics-roadmap.md): bundle the prototype like
// uitest.mjs, run its REAL render loop against the fake DOM/canvas, and measure
// the CPU cost of a frame (avg/p95/max) in three scenarios — idle, pan, zoom.
// Draw calls hit a no-op canvas proxy, so this measures the main-thread work
// (sim + scene math + render-path logic) — the regression source a code change
// can introduce — not GPU compositing. Budgets follow the doc's category C
// target (frame time p95 < 20 ms).
//
//   pnpm run perf              # report, always exit 0 (non-blocking, CI-friendly)
//   PERF_STRICT=1 pnpm run perf  # exit 1 when a budget is exceeded (local gate)
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
    setPointerCapture() {},
    releasePointerCapture() {},
    width: 900,
    height: 600,
  };
  return el;
}
// Chainable stub: every method returns the proxy, so gradient chains etc. work.
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
  querySelector: () => mkEl('q'),
  querySelectorAll: () => [],
  createElement: () => mkEl('canvas'),
  body: mkEl('body'),
};
// The game clock the render loop reads — advances a fixed 16 ms per call so every
// run walks the same simulated timeline (measurement uses hrtime, below).
let t = 0;
globalThis.performance = { now: () => (t += 16) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
// The pan path (clampCam → panelSlack) probes panel visibility via computed style.
globalThis.getComputedStyle = () => ({ display: 'block' });
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

const canvas = getEl('map');
const fire = (type, ev) => {
  for (const h of (listeners.get(canvas) ?? {})[type] ?? []) h(ev);
};
const pointer = (type, x, y) =>
  fire(type, {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
  });
const wheel = (deltaY) =>
  fire('wheel', { clientX: 450, clientY: 300, deltaY, preventDefault() {} });

/** Run one frame callback and return its CPU cost in ms (hrtime — the stubbed
 *  performance.now is the game's clock, not the measurement's). */
function runFrame() {
  const cb = rafCbs.shift();
  if (!cb) return null;
  const start = process.hrtime.bigint();
  cb(performance.now());
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Drive `frames` frames, calling `input(i)` before each, and collect costs. */
function scenario(frames, input) {
  const costs = [];
  for (let i = 0; i < frames; i++) {
    input?.(i);
    const ms = runFrame();
    if (ms === null) break;
    costs.push(ms);
  }
  return costs;
}

function stat(costs) {
  const sorted = [...costs].sort((a, b) => a - b);
  const avg = costs.reduce((s, v) => s + v, 0) / (costs.length || 1);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const max = sorted.at(-1) ?? 0;
  return { frames: costs.length, avg, p95, max };
}

// Warm-up: JIT + the lazily-baked sprites/map layers settle before we measure.
scenario(30);

const FRAMES = 120;
const results = {
  idle: stat(scenario(FRAMES)),
  pan: stat(
    scenario(FRAMES, (i) => {
      // one long drag across the map: down once, then a moving pointer every frame
      if (i === 0) pointer('pointerdown', 450, 300);
      else pointer('pointermove', 450 + Math.sin(i / 10) * 200, 300 + Math.cos(i / 10) * 120);
      if (i === FRAMES - 1) pointer('pointerup', 450, 300);
    }),
  ),
  zoom: stat(
    scenario(FRAMES, (i) => {
      wheel(i % 20 < 10 ? -100 : 100); // breathe in and out around the map centre
    }),
  ),
};

// Budgets: the doc's C-category target is frame-time p95 < 20 ms. Interaction
// scenarios get a little headroom (they add input handling + camera math).
const BUDGET_P95_MS = { idle: 20, pan: 25, zoom: 25 };

let failed = false;
const lines = ['── perf report (CPU frame cost, headless — no GPU) ──'];
for (const [name, s] of Object.entries(results)) {
  const budget = BUDGET_P95_MS[name];
  const over = s.p95 > budget;
  failed ||= over;
  lines.push(
    `  ${name.padEnd(5)}: avg ${s.avg.toFixed(2)}ms · p95 ${s.p95.toFixed(2)}ms · max ${s.max.toFixed(2)}ms` +
      `  (${s.frames} frames, budget p95 ≤ ${budget}ms${over ? ' — EXCEEDED' : ''})`,
  );
}
lines.push('──────────────────────────────────────────────────────');
console.log(lines.join('\n'));
// Machine-readable line for trend tracking (a future M3 collector can grep it).
console.log('PERF_JSON ' + JSON.stringify(results));

if (failed && process.env.PERF_STRICT === '1') {
  console.error('perf budget exceeded (PERF_STRICT=1) — failing');
  process.exit(1);
}
