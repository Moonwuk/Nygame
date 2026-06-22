/**
 * Void Dominion — playable prototype, browser UI.
 *
 * Renders the live map and drives the REAL shared-core kernel in real time:
 * every frame advances the world clock, player clicks become kernel actions, a
 * light Red AI issues its own, and the canvas reflects the resulting state.
 */
import {
  newGame,
  advance,
  order,
  data,
  MAP,
  HOUR,
  DAY,
  hpOfLevel,
  netIncome,
  moveFleet,
  orbitFleet,
  assaultFleet,
  bombardFleet,
  loadArmy,
  unloadArmy,
  launchFleet,
  buildBuilding,
  upgradeBuilding,
  buildUnit,
  type StepOut,
} from './game';
import { buildingMaxLevel } from '../../packages/shared-core/src/index';
import type {
  GameState,
  Fleet,
  Planet,
  Action,
  DomainEvent,
} from '../../packages/shared-core/src/index';

// --- constants ---------------------------------------------------------------

// Tactical-display palette: cyan = friendly, red = hostile, steel = neutral,
// phosphor-green accent = targeting/HUD. Everything reads on near-black.
const COLOR: Record<string, string> = { p1: '#35d6e6', p2: '#ff5a4d', null: '#6f8a93' };
const LANE = 'rgba(73,196,206,0.20)';
const GRID = 'rgba(46,150,160,0.07)';
const LOCK = '#7df0d0'; // selection / targeting reticle accent
const TAU = Math.PI * 2;
const TOP = 50; // top-bar height
const RAIL = 50; // left-rail width
const BUILDABLE = ['mine', 'refinery', 'barracks', 'fort'];
const BUILD_UNITS = ['marine', 'orbital_aa', 'cruiser', 'scout', 'siege'];
const BUILD_ICON: Record<string, string> = { mine: '⬢', refinery: '◇', barracks: '▤', fort: '⬡' };
const ME = 'p1';

/** hex `#rrggbb` → `rgba()` with alpha — for tinted rings, ticks and trails. */
function rgba(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// --- state -------------------------------------------------------------------

let s: GameState = newGame();
let speed = 2; // game-hours per real second (0 = paused)
let banner: string | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = null;
let selFleets = new Set<string>();
const logLines: string[] = [];
let lastAiAt = 0;
let lastPanelHtml = '';

// --- dom ---------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = $('map') as unknown as HTMLCanvasElement;
const cx = canvas.getContext('2d') as CanvasRenderingContext2D;
const side = $('side');
const logEl = $('log');
const clock = $('clock');
const purse = $('purse');
const bannerEl = $('banner');
const dayTimer = $('daytimer');
const alertBadge = $('alertbadge');

// --- viewport, galaxy backdrop & map projection ------------------------------

function viewW(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1280;
}
function viewH(): number {
  return typeof window !== 'undefined' ? window.innerHeight : 720;
}
let VW = 1280; // viewport size in CSS pixels (drives layout + projection)
let VH = 720;
let DPR = 1;
let MOBILE = false;
function resize() {
  VW = viewW();
  VH = viewH();
  DPR = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  MOBILE = VW < 720;
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + 'px';
  canvas.style.height = VH + 'px';
}
if (typeof window !== 'undefined') window.addEventListener('resize', resize);
resize();

// Deterministic faint starfield (normalized 0..1), drawn as dim vector ticks.
const STARS = Array.from({ length: 280 }, (_, i) => {
  const r1 = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  const r2 = (Math.sin(i * 78.233) * 12543.1234) % 1;
  const r3 = (Math.sin(i * 3.71) * 9281.77) % 1;
  return { x: (r1 + 1) % 1, y: (r2 + 1) % 1, b: 0.12 + ((r3 + 1) % 1) * 0.45 };
});

// The map is a radar plotting table: a coordinate grid that pans and scales with
// the camera, plus faint star ticks.
function drawScope() {
  const w = VW;
  const h = VH;
  cx.fillStyle = '#02060c';
  cx.fillRect(0, 0, w, h);

  // panning / zooming coordinate grid
  const gap = Math.max(28, 56 * cam.scale);
  const gx = ((cam.x % gap) + gap) % gap;
  const gy = ((cam.y % gap) + gap) % gap;
  cx.lineWidth = 1;
  cx.strokeStyle = GRID;
  cx.beginPath();
  for (let x = gx; x <= w; x += gap) {
    cx.moveTo(x, 0);
    cx.lineTo(x, h);
  }
  for (let y = gy; y <= h; y += gap) {
    cx.moveTo(0, y);
    cx.lineTo(w, y);
  }
  cx.stroke();

  // star ticks
  for (const st of STARS) {
    cx.fillStyle = rgba('#9fe6e0', st.b);
    cx.fillRect(st.x * w, st.y * h, 1, 1);
  }
}

// Project a map-space point into the on-screen play area (inside the HUD insets).
let MINX = Infinity;
let MAXX = -Infinity;
let MINY = Infinity;
let MAXY = -Infinity;
for (const n of MAP) {
  MINX = Math.min(MINX, n.x);
  MAXX = Math.max(MAXX, n.x);
  MINY = Math.min(MINY, n.y);
  MAXY = Math.max(MAXY, n.y);
}
// Base fit: map-space → screen, fitting the cluster inside the HUD insets.
function projBase(p: { x: number; y: number }): { x: number; y: number } {
  const left = (MOBILE ? 40 : RAIL) + (MOBILE ? 18 : 80);
  const right = VW - (MOBILE ? 24 : 372);
  const top = TOP + (MOBILE ? 54 : 80);
  const bottom = VH - (MOBILE ? 96 : 150);
  const aw = Math.max(60, right - left);
  const ah = Math.max(60, bottom - top);
  const sx = (p.x - MINX) / (MAXX - MINX || 1);
  const sy = (p.y - MINY) / (MAXY - MINY || 1);
  return { x: left + sx * aw, y: top + sy * ah };
}

// Camera: pan offset + zoom over the base fit. Node/label sizes stay constant
// in screen pixels; only positions transform (a node-graph style zoom).
const cam = { scale: 1, x: 0, y: 0 };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function world(p: { x: number; y: number }): { x: number; y: number } {
  const b = projBase(p);
  return { x: b.x * cam.scale + cam.x, y: b.y * cam.scale + cam.y };
}
function zoomAt(fx: number, fy: number, factor: number) {
  const bx = (fx - cam.x) / cam.scale;
  const by = (fy - cam.y) / cam.scale;
  cam.scale = clamp(cam.scale * factor, 0.6, 5);
  cam.x = fx - bx * cam.scale;
  cam.y = fy - by * cam.scale;
}

// --- helpers -----------------------------------------------------------------

const planet = (id: string | null | undefined): Planet | undefined =>
  id ? s.planets[id] : undefined;
const isShip = (u: string) => !data.units[u]?.traits.includes('ground');
const isGround = (u: string) => data.units[u]?.domain === 'ground';
const floor = Math.floor;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
/** Compact number like Iron Order's bar: 15.7k, 728, … */
function kfmt(n: number): string {
  const v = Math.round(n);
  return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(v);
}

function cost(bag: Record<string, number> | undefined): string {
  if (!bag) return 'free';
  const parts = Object.entries(bag).map(([r, n]) => `${n}${r === 'metal' ? 'm' : 'c'}`);
  return parts.length ? parts.join(' ') : 'free';
}
function afford(bag: Record<string, number> | undefined): boolean {
  const res = s.players[ME]?.resources ?? {};
  for (const [r, n] of Object.entries(bag ?? {})) if ((res[r] ?? 0) < n) return false;
  return true;
}
function fleetPos(f: Fleet): { x: number; y: number } | null {
  if (f.location) return s.planets[f.location]?.position ?? null;
  const m = f.movement;
  if (!m) return null;
  const a = s.planets[m.from]?.position;
  const b = s.planets[m.to]?.position;
  if (!a || !b) return null;
  const t = Math.min(1, Math.max(0, (s.time - m.departedAt) / (m.arrivesAt - m.departedAt)));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function note(msg: string) {
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  logLines.push(`D${d} ${String(h).padStart(2, '0')}h · ${msg}`);
  while (logLines.length > 9) logLines.shift();
}
function apply(out: StepOut) {
  s = out.state;
  if (selFleet && !s.fleets[selFleet]) selFleet = null;
  selFleets = new Set([...selFleets].filter((id) => s.fleets[id]?.owner === ME));
  handleEvents(out.events);
}

/** Apply a player-issued order and surface a rejection in the log (so a denied
 *  click — wrong orbit, no capacity, can't afford — isn't silently swallowed). */
function playerOrder(action: Action) {
  const out = order(s, action, s.time);
  apply(out);
  if (out.error) note('✖ ' + out.error.replace(/^E_/, '').toLowerCase().replace(/_/g, ' '));
}

const NAME: Record<string, string> = { p1: 'Azure', p2: 'Crimson' };
function setFleetSelection(ids: string[]) {
  const picked = ids.filter((id) => s.fleets[id]?.owner === ME);
  selFleets = new Set(picked);
  selFleet = picked.length === 1 ? (picked[0] ?? null) : null;
  const first = picked[0] ? s.fleets[picked[0]] : undefined;
  if (first?.location) selPlanet = first.location;
  lastPanelHtml = '';
}
function clearSelection() {
  selFleet = null;
  selPlanet = null;
  selFleets = new Set();
  lastPanelHtml = '';
}
function handleEvents(events: DomainEvent[]) {
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'battle.started':
        note(`⚔️ battle at ${p.location} (${p.phase})`);
        break;
      case 'battle.resolved':
        note(
          `battle at ${p.location} ended — ${p.winner ? NAME[p.winner as string] + ' won' : 'stalemate'}`,
        );
        break;
      case 'planet.captured':
        note(`🚩 ${NAME[p.owner as string]} captured ${p.planetId}`);
        break;
      case 'building.constructed':
        note(`🏗️ ${p.building} built at ${p.planetId}`);
        break;
      case 'building.upgraded':
        note(`⬆️ ${p.building} → L${p.level} at ${p.planetId}`);
        break;
      case 'building.destroyed':
        note(`💥 ${p.building} destroyed at ${p.planetId}`);
        break;
      case 'unit.built':
        note(`🛠️ ${p.count}× ${p.unit} at ${p.planetId}`);
        break;
      case 'fleet.launched':
        note(`🚀 ${NAME[p.owner as string]} launched a fleet from ${p.planetId}`);
        break;
      case 'fleet.destroyed':
        note(`☠️ a ${NAME[p.owner as string]} fleet was destroyed`);
        break;
    }
  }
}

// --- red AI ------------------------------------------------------------------

function runAI() {
  if (s.time - lastAiAt < 2 * HOUR) return;
  lastAiAt = s.time;
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== 'p2' || f.location == null || f.movement || f.battleId) continue;
    const here = s.planets[f.location];
    if (!here) continue;
    let best: Planet | null = null;
    let bestD = Infinity;
    for (const p of Object.values(s.planets)) {
      if (p.owner === 'p2') continue;
      const d = dist(here.position, p.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) apply(order(s, moveFleet('p2', f.id, best.id), s.time));
  }
  const cap = s.planets.CRIMSON;
  const red = s.players.p2;
  if (cap && cap.owner === 'p2' && red) {
    if ((red.resources.metal ?? 0) > 220 && (red.resources.credits ?? 0) > 120) {
      apply(order(s, buildUnit('p2', 'CRIMSON', 'cruiser', 1), s.time));
    } else if ((red.resources.metal ?? 0) > 70) {
      apply(order(s, buildUnit('p2', 'CRIMSON', 'marine', 1), s.time));
    }
    const redFleets = Object.values(s.fleets).filter((f) => f.owner === 'p2').length;
    const capHasShip = cap.garrison.some((st) => isShip(st.unit));
    if (redFleets < 2 && capHasShip) apply(order(s, launchFleet('p2', 'CRIMSON'), s.time));
  }
}

// Enemy (AI) auto-engagement: an idle hostile fleet over a world it doesn't own,
// with the orbit clear, descends and lands automatically — keeps the AI pressing
// the capture loop. The player's own fleets are driven by hand (orbit/bombard/
// assault controls in the fleet panel), so they are skipped here.
function autoEngage() {
  for (const f of Object.values(s.fleets)) {
    if (f.owner === ME || f.location == null || f.movement || f.battleId) continue;
    const here = s.planets[f.location];
    if (!here || here.owner === f.owner) continue;
    const enemyHere = Object.values(s.fleets).some(
      (g) => g.owner !== f.owner && g.location === f.location && g.units.some((u) => u.count > 0),
    );
    if (enemyHere) continue; // let the auto orbital battle settle first
    if (f.orbit !== 'near') apply(order(s, orbitFleet(f.owner, f.id, 'near'), s.time));
    apply(order(s, assaultFleet(f.owner, f.id), s.time));
  }
}

function checkEnd() {
  if (banner) return;
  const mine = Object.values(s.planets).filter((p) => p.owner === ME).length;
  const foe = Object.values(s.planets).filter((p) => p.owner === 'p2').length;
  const myFleets = Object.values(s.fleets).some((f) => f.owner === ME);
  const foeFleets = Object.values(s.fleets).some((f) => f.owner === 'p2');
  if (s.planets.CRIMSON?.owner === ME || (foe === 0 && !foeFleets)) {
    banner = '🏆 VICTORY — the Crimson Hegemony has fallen';
  } else if (s.planets.HOME?.owner !== ME || (mine === 0 && !myFleets)) {
    banner = '💀 DEFEAT — your home world is lost';
  }
}

// --- rendering ---------------------------------------------------------------

/** A regular polygon path centred at (x,y) — fort/station containment marker. */
function poly(x: number, y: number, r: number, sides: number, rot = 0) {
  cx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i) cx.lineTo(px, py);
    else cx.moveTo(px, py);
  }
  cx.closePath();
}

/** Four slowly-rotating corner brackets — the "locked target" selection reticle. */
function targetBrackets(x: number, y: number, r: number, t: number) {
  cx.save();
  cx.translate(x, y);
  cx.rotate(t / 1600);
  cx.strokeStyle = LOCK;
  cx.lineWidth = 1.6;
  cx.shadowColor = LOCK;
  cx.shadowBlur = 8;
  const len = 6;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    cx.beginPath();
    cx.moveTo(sx * r - sx * len, sy * r);
    cx.lineTo(sx * r, sy * r);
    cx.lineTo(sx * r, sy * r - sy * len);
    cx.stroke();
  }
  cx.restore();
}

let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null;

function render() {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0); // draw in CSS pixels, crisp on hi-DPI
  drawScope();

  // jump lanes — thin glowing vectors
  cx.save();
  cx.strokeStyle = LANE;
  cx.lineWidth = 1;
  cx.shadowColor = 'rgba(53,214,230,0.5)';
  cx.shadowBlur = 4;
  for (const n of MAP) {
    for (const l of n.links) {
      if (n.id < l && s.planets[l]) {
        const a = world(n);
        const q = world(s.planets[l]!.position);
        cx.beginPath();
        cx.moveTo(a.x, a.y);
        cx.lineTo(q.x, q.y);
        cx.stroke();
      }
    }
  }
  cx.restore();

  // battles — pulsing red contact ring
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  for (const b of Object.values(s.battles)) {
    const pp = s.planets[b.location];
    if (!pp) continue;
    const c = world(pp.position);
    cx.save();
    cx.strokeStyle = rgba('#ff5a4d', 0.4 + 0.45 * pulse);
    cx.lineWidth = 1.6;
    cx.shadowColor = '#ff5a4d';
    cx.shadowBlur = 10;
    cx.beginPath();
    cx.arc(c.x, c.y, 24 + 7 * pulse, 0, TAU);
    cx.stroke();
    cx.restore();
  }

  // planets — wireframe blips with sensor rings + monospace callouts
  cx.textAlign = 'left';
  const R = 13;
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    const c = world(n);
    const col = COLOR[p.owner ?? 'null'];

    // sensor-range ring (dashed, faint)
    cx.save();
    cx.setLineDash([3, 5]);
    cx.strokeStyle = rgba(col, 0.22);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, R + 14, 0, TAU);
    cx.stroke();
    cx.restore();

    // fort = hex containment ring
    if (p.buildings.some((b) => b.type === 'fort')) {
      cx.strokeStyle = rgba(col, 0.5);
      cx.lineWidth = 1;
      poly(c.x, c.y, R + 6, 6, Math.PI / 6);
      cx.stroke();
    }

    if (p.buildings.length) {
      cx.save();
      cx.font = '11px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      const start = c.x - ((p.buildings.length - 1) * 13) / 2;
      for (let i = 0; i < p.buildings.length; i++) {
        const b = p.buildings[i];
        if (!b) continue;
        const bx = start + i * 13;
        const by = c.y + R + 19;
        cx.fillStyle = 'rgba(2,9,13,.78)';
        cx.strokeStyle = rgba(col, 0.55);
        cx.lineWidth = 1;
        cx.beginPath();
        cx.rect(bx - 5, by - 5, 10, 10);
        cx.fill();
        cx.stroke();
        cx.fillStyle = rgba(col, 0.9);
        cx.fillText(BUILD_ICON[b.type] ?? '▪', bx, by + 0.5);
      }
      cx.restore();
    }

    // wireframe body + glow + bright core
    cx.save();
    cx.shadowColor = col;
    cx.shadowBlur = 12;
    cx.strokeStyle = col;
    cx.lineWidth = 2;
    cx.beginPath();
    cx.arc(c.x, c.y, R, 0, TAU);
    cx.stroke();
    cx.fillStyle = col;
    cx.beginPath();
    cx.arc(c.x, c.y, 2.4, 0, TAU);
    cx.fill();
    cx.restore();

    // N/E/S/W crosshair ticks
    cx.strokeStyle = rgba(col, 0.7);
    cx.lineWidth = 1.2;
    cx.beginPath();
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      cx.moveTo(c.x + dx * (R - 3), c.y + dy * (R - 3));
      cx.lineTo(c.x + dx * (R + 5), c.y + dy * (R + 5));
    }
    cx.stroke();

    if (selPlanet === n.id) targetBrackets(c.x, c.y, R + 10, performance.now());

    // callout: id + garrison/buildings, monospace
    cx.save();
    cx.shadowColor = 'rgba(0,0,0,0.85)';
    cx.shadowBlur = 3;
    cx.fillStyle = p.owner ? col : '#9fc9c4';
    cx.font = '700 12px ui-monospace,Menlo,monospace';
    cx.fillText(n.id, c.x + R + 12, c.y - 1);
    const g = p.garrison.reduce((a, st) => a + st.count, 0);
    cx.fillStyle = 'rgba(150,210,205,0.6)';
    cx.font = '10px ui-monospace,Menlo,monospace';
    const icons = p.buildings.map((b) => BUILD_ICON[b.type] ?? '▪').join('');
    cx.fillText(`G:${g}  B:${icons || '—'}`, c.x + R + 12, c.y + 12);
    cx.restore();
  }

  // fleets — glowing chevrons oriented to heading, with a fading contact trail
  cx.textAlign = 'center';
  for (const f of Object.values(s.fleets)) {
    const mp = fleetPos(f);
    if (!mp) continue;
    const c = world(mp);
    const col = COLOR[f.owner];
    const ships = f.units.reduce((a, st) => a + st.count, 0);
    const troops = (f.landing ?? []).reduce((a, st) => a + st.count, 0);

    // heading from the movement vector (default: pointing up)
    let ang = -Math.PI / 2;
    if (f.movement) {
      const a = s.planets[f.movement.from]?.position;
      const b = s.planets[f.movement.to]?.position;
      if (a && b) {
        const wa = world(a);
        const wb = world(b);
        ang = Math.atan2(wb.y - wa.y, wb.x - wa.x);
      }
    }
    const lift = f.location ? 22 : 0; // lift off the node when stationed in orbit

    // contact trail while moving
    if (f.movement) {
      for (let i = 1; i <= 4; i++) {
        cx.fillStyle = rgba(col, 0.3 - 0.06 * i);
        cx.beginPath();
        cx.arc(c.x - Math.cos(ang) * i * 9, c.y - Math.sin(ang) * i * 9, 2.4 - 0.3 * i, 0, TAU);
        cx.fill();
      }
    }

    cx.save();
    cx.translate(c.x, c.y - lift);
    cx.rotate(ang + Math.PI / 2);
    cx.shadowColor = col;
    cx.shadowBlur = 9;
    cx.strokeStyle = col;
    cx.lineWidth = 1.8;
    cx.beginPath();
    cx.moveTo(0, -8);
    cx.lineTo(6, 7);
    cx.lineTo(0, 3.5);
    cx.lineTo(-6, 7);
    cx.closePath();
    cx.stroke();
    cx.restore();

    if (selFleet === f.id || selFleets.has(f.id))
      targetBrackets(c.x, c.y - lift, 12, performance.now());

    cx.fillStyle = rgba(col, 0.95);
    cx.font = '700 10px ui-monospace,Menlo,monospace';
    cx.fillText(`${ships}${troops ? '+' + troops : ''}`, c.x, c.y - lift + 20);
  }

  if (selectionBox) {
    const x = Math.min(selectionBox.x1, selectionBox.x2);
    const y = Math.min(selectionBox.y1, selectionBox.y2);
    const w = Math.abs(selectionBox.x2 - selectionBox.x1);
    const h = Math.abs(selectionBox.y2 - selectionBox.y1);
    cx.save();
    cx.fillStyle = 'rgba(53,214,230,.08)';
    cx.strokeStyle = LOCK;
    cx.setLineDash([5, 4]);
    cx.lineWidth = 1.2;
    cx.fillRect(x, y, w, h);
    cx.strokeRect(x, y, w, h);
    cx.restore();
  }
}

// --- side panel --------------------------------------------------------------

function btn(act: string, arg: string, label: string, ok: boolean): string {
  return `<button class="b" data-act="${act}" data-arg="${arg}" ${ok ? '' : 'disabled'}>${label}</button>`;
}
function cardHeader(color: string, title: string, sub: string): string {
  return `<div class="phead">
    <span class="pflag" style="background:${color}"></span>
    <div class="ptitle"><b>${title}</b><span>${sub}</span></div>
    <button class="pclose" data-act="close" data-arg="">✕</button>
  </div>`;
}

function panelHtml(): string {
  const group = [...selFleets].map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  if (group.length > 1) {
    const ships = group.reduce((a, f) => a + f.units.reduce((b, u) => b + u.count, 0), 0);
    const troops = group.reduce(
      (a, f) => a + (f.landing ?? []).reduce((b, u) => b + u.count, 0),
      0,
    );
    let h = cardHeader(
      COLOR[ME],
      'TASK GROUP',
      `${group.length} fleets · ${ships} ships · ${troops} troops`,
    );
    h += `<div class="hint">Tap a destination world to move all selected fleets. Shift-drag on the map selects a fleet group.</div>`;
    for (const f of group) {
      const loc = f.location ?? (f.movement ? `${f.movement.from}→${f.movement.to}` : '—');
      const nShips = f.units.reduce((a, u) => a + u.count, 0);
      const nTr = (f.landing ?? []).reduce((a, u) => a + u.count, 0);
      h += `<div class="row" style="color:${COLOR[f.owner]}">▲ ${f.id} <span class="dim">${loc}</span> · ${nShips}${nTr ? '+' + nTr : ''}</div>`;
    }
    h += btn('cancel', '', 'Deselect group', true);
    return h;
  }
  if (selFleet) {
    const f = s.fleets[selFleet];
    if (f) {
      const ships = f.units.map((u) => `${u.count}×${u.unit}`).join(', ') || '—';
      const tr = (f.landing ?? []).map((u) => `${u.count}×${u.unit}`).join(', ') || '—';
      const nShips = f.units.reduce((a, u) => a + u.count, 0);
      const nTr = (f.landing ?? []).reduce((a, u) => a + u.count, 0);
      const orbit = f.orbit ?? '—';
      let h = cardHeader(
        COLOR[f.owner],
        'FLEET',
        `${nShips} ships · ${nTr} troops · orbit ${orbit}${f.bombarding ? ' · ⊗ bombarding' : ''}`,
      );
      h += `<div class="pstats"><span>✦ ${ships}</span></div><div class="row dim">Carrying: ${tr}</div>`;

      const here = planet(f.location);
      const docked = !!here && !f.movement && !f.battleId;
      if (!docked) {
        h += `<div class="hint">${
          f.battleId
            ? 'Engaged — orbital battle in progress.'
            : 'In transit — routing along the lanes. Collisions trigger an orbital battle.'
        }</div>`;
      } else {
        const hostile = here!.owner !== f.owner; // enemy or neutral world
        // orbit toggle
        h += `<div class="sec">Orbit · ${here!.id}</div><div class="row">`;
        h += btn('orbit', 'near', '▼ Descend (near)', orbit !== 'near');
        h += btn('orbit', 'far', '▲ Pull back (far)', orbit !== 'far');
        h += `</div>`;
        if (hostile) {
          h += `<div class="row">`;
          h += btn(
            'bombard',
            f.bombarding ? 'off' : 'on',
            f.bombarding ? '⊗ Stop bombard' : '⊗ Bombard',
            orbit === 'near' && nShips > 0,
          );
          h += btn('assault', '', '⚔ Assault', orbit === 'near');
          h += `</div>`;
          h += `<div class="hint">Near orbit lets you bombard (wears buildings &amp; freezes their output) but the garrison's AA reaches you; far orbit is safe. Assault lands your carried troops against the garrison.</div>`;
        }
        // load / unload ground army at your own world
        if (here!.owner === ME) {
          h += `<div class="sec">Ground army ⇄ garrison</div>`;
          const groundHere = here!.garrison.filter((st) => isGround(st.unit));
          const carried = f.landing ?? [];
          if (groundHere.length) {
            h += `<div class="row">`;
            for (const st of groundHere) h += btn('load', st.unit, `▲ Load ${st.unit}`, true);
            h += `</div>`;
          }
          if (carried.length) {
            h += `<div class="row">`;
            for (const st of carried) h += btn('unload', st.unit, `▼ Unload ${st.unit}`, true);
            h += `</div>`;
          }
          if (!groundHere.length && !carried.length)
            h += `<div class="row dim">no ground army here</div>`;
        }
      }
      h += `<div class="hint">Tap a destination world to move this fleet.</div>`;
      h += btn('cancel', '', 'Deselect', true);
      return h;
    }
  }
  const p = planet(selPlanet);
  if (!p) return '<div class="hint">Tap a world.</div>';
  const owner = p.owner ?? 'null';
  const mine = p.owner === ME;
  const sec = data.sectors[p.sectorType ?? '']?.name ?? p.sectorType ?? '—';
  const pt = p.planetType ? data.planetTypes[p.planetType] : undefined;
  const ptName = pt?.name ?? p.planetType ?? '—';
  const gcount = p.garrison.reduce((a, st) => a + st.count, 0);
  let h =
    cardHeader(COLOR[owner], p.id, `${p.owner ? NAME[p.owner] : 'Neutral'} · ${ptName} · ${sec}`) +
    `<div class="pstats"><span>⚔ ${gcount} garrison</span><span>▣ ${p.buildings.length} built</span></div>`;
  if (pt && (pt.productionBonus !== 0 || pt.defenseBonus !== 0)) {
    const pct = (n: number) => (n >= 0 ? '+' : '') + Math.round(n * 100) + '%';
    const parts: string[] = [];
    if (pt.productionBonus !== 0) parts.push(`prod ${pct(pt.productionBonus)}`);
    if (pt.defenseBonus !== 0) parts.push(`def ${pct(pt.defenseBonus)}`);
    h += `<div class="row dim">${ptName} world — ${parts.join(' · ')}</div>`;
  }

  // buildings
  h += `<div class="sec">Buildings</div>`;
  if (p.buildings.length === 0) h += `<div class="row dim">none</div>`;
  for (const b of p.buildings) {
    const def = data.buildings[b.type];
    const max = def ? buildingMaxLevel(def) : 1;
    h += `<div class="row"><span class="bicon">${BUILD_ICON[b.type] ?? '▪'}</span>${def?.name ?? b.type} <span class="dim">L${b.level}/${max} · hp ${floor(b.hp)}/${hpOfLevel(b.type, b.level)}</span>`;
    if (mine && b.level < max) {
      const c = def?.upgrades[b.level - 1]?.cost;
      h += ' ' + btn('upgrade', b.type, `▲ ${cost(c)}`, afford(c));
    }
    h += `</div>`;
  }
  if (mine) {
    const missing = BUILDABLE.filter((t) => !p.buildings.some((b) => b.type === t));
    if (missing.length) {
      h += `<div class="row" style="margin-top:4px">`;
      for (const t of missing) {
        const c = data.buildings[t]?.cost;
        h += btn(
          'build',
          t,
          `${BUILD_ICON[t] ?? '+'} ${data.buildings[t]?.name ?? t} ${cost(c)}`,
          afford(c),
        );
      }
      h += `</div>`;
    }
  }

  // garrison
  h += `<div class="sec">Garrison</div>`;
  h +=
    p.garrison.length === 0
      ? `<div class="row dim">undefended</div>`
      : `<div class="row">${p.garrison.map((u) => `${u.count}×${u.unit}`).join(', ')}</div>`;
  if (mine && p.garrison.some((st) => isShip(st.unit))) {
    h += `<div class="row">${btn('launch', p.id, '🚀 Launch fleet from garrison', true)}</div>`;
  }

  // fleets here
  const here = Object.values(s.fleets).filter((f) => f.location === p.id);
  if (here.length) {
    h += `<div class="sec">Fleets in orbit</div>`;
    for (const f of here) {
      const ships = f.units.reduce((a, st) => a + st.count, 0);
      const tr = (f.landing ?? []).reduce((a, st) => a + st.count, 0);
      const sel = f.owner === ME ? btn('selfleet', f.id, 'Select →', true) : '';
      h += `<div class="row" style="color:${COLOR[f.owner]}">▲ ${ships} ships${tr ? ' +' + tr + ' troops' : ''} ${sel}</div>`;
    }
  }

  // unit production
  if (mine) {
    h += `<div class="sec">Build units → garrison</div><div class="row">`;
    for (const u of BUILD_UNITS) {
      const c = data.units[u]?.cost;
      h += btn('unit', u, `${u} ${cost(c)}`, afford(c));
    }
    h += `</div><div class="hint">Built units join the garrison; “Launch fleet” turns ships + troops into a mobile fleet.</div>`;
  }
  return h;
}

function renderPanel() {
  const open = selFleet !== null || selPlanet !== null;
  side.style.display = open ? 'block' : 'none';
  document.body.classList.toggle('sheet-open', open); // mobile: hide log/comms under the sheet
  if (!open) {
    lastPanelHtml = '';
    return;
  }
  const html = panelHtml();
  if (html !== lastPanelHtml) {
    side.innerHTML = html;
    lastPanelHtml = html;
  }
}

side.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled) return;
  const act = t.dataset.act;
  const arg = t.dataset.arg ?? '';
  if (act === 'close') {
    clearSelection();
  } else if (act === 'cancel') {
    selFleet = null;
    selFleets = new Set();
  } else if (act === 'selfleet') {
    setFleetSelection([arg]);
  } else if (act === 'build') {
    playerOrder(buildBuilding(ME, selPlanet!, arg));
  } else if (act === 'upgrade') {
    playerOrder(upgradeBuilding(ME, selPlanet!, arg));
  } else if (act === 'unit') {
    playerOrder(buildUnit(ME, selPlanet!, arg, 1));
  } else if (act === 'launch') {
    playerOrder(launchFleet(ME, arg));
  } else if (act === 'orbit') {
    playerOrder(orbitFleet(ME, selFleet!, arg as 'near' | 'far'));
  } else if (act === 'bombard') {
    playerOrder(bombardFleet(ME, selFleet!, arg === 'on'));
  } else if (act === 'assault') {
    playerOrder(assaultFleet(ME, selFleet!));
  } else if (act === 'load') {
    playerOrder(loadArmy(ME, selFleet!, arg, 1));
  } else if (act === 'unload') {
    playerOrder(unloadArmy(ME, selFleet!, arg, 1));
  }
  lastPanelHtml = '';
  renderPanel();
});

// --- canvas input ------------------------------------------------------------

// Tap/click selection at a screen point (drag-aware — see the pointer handlers).
function selectAt(mx: number, my: number) {
  for (const f of Object.values(s.fleets)) {
    const mp = fleetPos(f);
    if (!mp) continue;
    const c = world(mp);
    const fy = c.y - (f.location ? 22 : 0);
    if (Math.hypot(mx - c.x, my - fy) < 16 && f.owner === ME) {
      setFleetSelection([f.id]);
      return;
    }
  }
  for (const n of MAP) {
    const c = world(n);
    if (Math.hypot(mx - c.x, my - c.y) < 24) {
      const moving = selFleets.size ? [...selFleets] : selFleet ? [selFleet] : [];
      if (moving.length) {
        for (const fleetId of moving) {
          const f = s.fleets[fleetId];
          if (f && f.location !== n.id) apply(order(s, moveFleet(ME, fleetId, n.id), s.time));
        }
        selFleet = null;
        selFleets = new Set();
      }
      selPlanet = n.id;
      lastPanelHtml = '';
      return;
    }
  }
  clearSelection(); // empty space → close the dossier
}

// --- camera control: drag-pan, pinch-zoom, wheel-zoom, tap-select ------------

const pointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let pinchDist = 0;
let boxSelecting = false;
const ptXY = (ev: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * VW, y: ((ev.clientY - r.top) / r.height) * VH };
};
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture?.(ev.pointerId);
  const p = ptXY(ev);
  pointers.set(ev.pointerId, p);
  if (pointers.size === 1) {
    dragStart = p;
    boxSelecting = ev.shiftKey;
    selectionBox = boxSelecting ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y } : null;
    dragged = false;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (ev) => {
  const prev = pointers.get(ev.pointerId);
  if (!prev) return;
  const p = ptXY(ev);
  pointers.set(ev.pointerId, p);
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
    dragged = true;
  } else if (boxSelecting && dragStart) {
    selectionBox = { x1: dragStart.x, y1: dragStart.y, x2: p.x, y2: p.y };
    if (Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) dragged = true;
  } else {
    cam.x += p.x - prev.x;
    cam.y += p.y - prev.y;
    if (dragStart && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) dragged = true;
  }
});
function endPointer(ev: PointerEvent) {
  const single = pointers.size === 1;
  const p = pointers.get(ev.pointerId);
  if (single && boxSelecting && selectionBox) {
    const x1 = Math.min(selectionBox.x1, selectionBox.x2);
    const x2 = Math.max(selectionBox.x1, selectionBox.x2);
    const y1 = Math.min(selectionBox.y1, selectionBox.y2);
    const y2 = Math.max(selectionBox.y1, selectionBox.y2);
    const picked: string[] = [];
    for (const f of Object.values(s.fleets)) {
      if (f.owner !== ME) continue;
      const mp = fleetPos(f);
      if (!mp) continue;
      const c = world(mp);
      const fy = c.y - (f.location ? 22 : 0);
      if (c.x >= x1 && c.x <= x2 && fy >= y1 && fy <= y2) picked.push(f.id);
    }
    if (picked.length) setFleetSelection(picked);
    else {
      selFleets = new Set();
      selFleet = null;
      lastPanelHtml = '';
    }
    selectionBox = null;
    boxSelecting = false;
  }
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (single && !dragged && p) selectAt(p.x, p.y);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (ev) => {
  pointers.delete(ev.pointerId);
  pinchDist = 0;
  selectionBox = null;
  boxSelecting = false;
});
canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * VW;
    const y = ((ev.clientY - r.top) / r.height) * VH;
    zoomAt(x, y, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => {
  cam.scale = 1;
  cam.x = 0;
  cam.y = 0;
});

// --- top bar / speed ---------------------------------------------------------

for (const b of Array.from(document.querySelectorAll('[data-speed]'))) {
  b.addEventListener('click', () => {
    speed = Number((b as HTMLElement).dataset.speed);
    for (const x of Array.from(document.querySelectorAll('[data-speed]')))
      x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === speed);
  });
}

// --- loop --------------------------------------------------------------------

let lastReal = performance.now();
function frame(nowReal: number) {
  const dt = nowReal - lastReal;
  lastReal = nowReal;
  if (speed > 0 && !banner) {
    const target = s.time + (dt / 1000) * speed * HOUR;
    apply(advance(s, target));
    autoEngage();
    runAI();
    checkEnd();
  }
  render();
  renderPanel();
  // top bar (Iron Order-style resource readouts with +/h deltas)
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  clock.textContent = `Day ${d} · ${String(h).padStart(2, '0')}:00`;
  dayTimer.textContent = `Day ${d} — next cycle in ${24 - h}h`;
  const r = s.players[ME]?.resources ?? {};
  const inc = netIncome(s, ME);
  const worlds = Object.values(s.planets).filter((p) => p.owner === ME).length;
  const myFleets = Object.values(s.fleets).filter((f) => f.owner === ME).length;
  const chip = (icon: string, val: string, delta?: number) => {
    const dh =
      delta === undefined
        ? ''
        : `<em class="${delta >= 0 ? 'up' : 'dn'}">${delta >= 0 ? '+' : ''}${Math.round(delta)}/h</em>`;
    return `<span class="res"><i>${icon}</i><span class="rv"><b>${val}</b>${dh}</span></span>`;
  };
  purse.innerHTML =
    chip('MTL', kfmt(r.metal ?? 0), inc.metal ?? 0) +
    chip('CRD', kfmt(r.credits ?? 0), inc.credits ?? 0) +
    chip('WLD', String(worlds)) +
    chip('FLT', String(myFleets));
  const battles = Object.keys(s.battles).length;
  alertBadge.style.display = battles > 0 ? 'grid' : 'none';
  alertBadge.textContent = String(battles);
  logEl.innerHTML = logLines.map((l) => `<div>${l}</div>`).join('');
  if (banner) {
    bannerEl.textContent = banner;
    bannerEl.style.display = 'block';
  }
  requestAnimationFrame(frame);
}

note(
  'Welcome, Commander. Secure FORGE/RELAY/ANCHOR, flank through VEIL or HARBOR, then crack CRIMSON.',
);
requestAnimationFrame(frame);
