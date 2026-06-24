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
  SECTOR_TYPES,
  HOUR,
  DAY,
  hpOfLevel,
  netIncome,
  moveFleet,
  stopFleet,
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

// Political palette (Bytro/Paradox-style): YOU = green, ally = blue, neutral =
// gray, enemy = red — used for fleets/planets and to tint each owner's province.
// Cyan stays the console-chrome accent (grid, borders, targeting reticle).
const COLOR: Record<string, string> = {
  p1: '#3ad17a', // you — green
  p2: '#ff5a4d', // enemy — red
  ally: '#4a8cff', // ally — blue (latent: no allied player in the skirmish yet)
  null: '#6f8a93', // neutral — gray
};
const VOID_COLOR = '#46606e'; // empty-space provinces — uncapturable void
// Dev-only fog: colour for a node whose contents are outside sensor range.
const FOG_COL = '#3a4852';
const LANE = 'rgba(73,196,206,0.20)';
const GRID = 'rgba(46,150,160,0.07)';
const LOCK = '#7df0d0'; // selection / targeting reticle accent
const TAU = Math.PI * 2;
const TOP = 50; // top-bar height
const RAIL = 50; // left-rail width
const BUILDABLE = ['mine', 'refinery', 'barracks', 'fort'];
const BUILD_UNITS = ['marine', 'orbital_aa', 'cruiser', 'scout', 'siege'];
const BUILD_ICON: Record<string, string> = {
  mine: '⬢',
  refinery: '◇',
  barracks: '▤',
  fort: '⬡',
  starfort: '✦',
};
const UNIT_ICON: Record<string, string> = {
  marine: '◆',
  orbital_aa: '⌁',
  cruiser: '▲',
  scout: '◌',
  siege: '✦',
};
/** Accent colour for a sector type (from the data-driven registry). */
const sectorColor = (type: string): string => SECTOR_TYPES[type]?.color ?? '#35d6e6';
const ME = 'p1';
type PlanetTab = 'ground' | 'ships' | 'buildings';
type BuildLane = 'buildings' | 'units';
type BuildKind = 'building' | 'upgrade' | 'unit';

interface QueuedBuild {
  kind: BuildKind;
  id: string;
  count: number;
}

interface PlanetBuildQueue {
  buildings: QueuedBuild[];
  units: QueuedBuild[];
}

interface ConstructionPayload {
  kind?: 'building' | 'unit' | 'upgrade';
  planetId?: string;
  building?: string;
  unit?: string;
  count?: number;
  level?: number;
}

interface ActiveBuild {
  at: number;
  seq: number;
  payload: ConstructionPayload;
}

/** Escape untrusted strings before inserting into innerHTML (XSS prevention). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** hex `#rrggbb` → `rgba()` with alpha — for tinted rings, ticks and trails. */
function rgba(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Total count across a stack of units (ships, garrison or landing troops). */
const sumUnits = (stacks: ReadonlyArray<{ count: number }>): number =>
  stacks.reduce((a, s) => a + s.count, 0);

// Map-marker geometry / palette, shared so every blip reads the same way.
const CARDINAL: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
const ORBIT_COLOR = { near: '#ffb15f', far: '#7df0d0' } as const; // hot zone / safe ring

// --- state -------------------------------------------------------------------

let s: GameState = newGame();
let speed = 2; // game-hours per real second (0 = paused)
let banner: string | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = null;
let selFleets = new Set<string>();
let aiming = false; // "Move" command armed → next world tap orders the move
let aimPointer: { x: number; y: number } | null = null; // last canvas pointer (for the move preview)
let planetTab: PlanetTab = 'buildings';
const buildQueues: Record<string, PlanetBuildQueue> = {};
const logLines: string[] = [];
let lastAiAt = 0;
let lastPanelHtml = '';
let lastCmdHtml = '';
let lastHudHtml = '';
let lastClockText = '';
let lastDayTimerText = '';
let lastLogHtml = '';
let lastAlertText = '';
// --- fog of war (DEV-ONLY, temporary preview of core "variant A") ------------
// Client-side projection just for the renderer — NOT the real security boundary
// (that is `visibleState` in shared-core, built later). Toggle in the speed bar.
let fogOn = true; // default on so the effect is visible
let fogVisible: Set<string> | null = null; // node ids in sensor range; null = no fog

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
const cmdbar = $('cmdbar');
const burger = $('burger');
const scrim = $('scrim');
const topClock = $('topclock');

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
  return {
    x: (r1 + 1) % 1,
    y: (r2 + 1) % 1,
    b: 0.12 + ((r3 + 1) % 1) * 0.45,
    phase: i * 0.37,
  };
});
const NEBULAE = Array.from({ length: 5 }, (_, i) => {
  const r1 = (Math.sin(i * 21.771) * 36137.13) % 1;
  const r2 = (Math.sin(i * 9.317) * 21891.41) % 1;
  const r3 = (Math.sin(i * 15.913) * 11923.71) % 1;
  return {
    x: (r1 + 1) % 1,
    y: (r2 + 1) % 1,
    r: 160 + ((r3 + 1) % 1) * 180,
    color: i % 2 ? '#8f6dff' : '#35d6e6',
    phase: i * 1.7,
  };
});

// The map is a radar plotting table: a coordinate grid that pans and scales with
// the camera, plus faint star ticks.
function drawScope(now: number) {
  const w = VW;
  const h = VH;
  cx.fillStyle = '#02060c';
  cx.fillRect(0, 0, w, h);

  // slow background clouds, drawn before the tactical grid
  for (const n of NEBULAE) {
    const breathe = 0.75 + 0.25 * Math.sin(now / 2400 + n.phase);
    const r = n.r * breathe * (MOBILE ? 0.7 : 1);
    const g = cx.createRadialGradient(n.x * w, n.y * h, 0, n.x * w, n.y * h, r);
    g.addColorStop(0, rgba(n.color, 0.055));
    g.addColorStop(0.45, rgba(n.color, 0.022));
    g.addColorStop(1, 'rgba(2,6,12,0)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, h);
  }

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
    const twinkle = 0.65 + 0.35 * Math.sin(now / 900 + st.phase);
    cx.fillStyle = rgba('#9fe6e0', st.b * twinkle);
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
  // Mobile no longer reserves the left rail (it folds into the drawer) → the map
  // claims that space; desktop keeps the rail + label gutter.
  const left = MOBILE ? 14 : RAIL + 80;
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
const MAP_LINKS = MAP.flatMap((n) =>
  n.links.filter((l) => n.id < l).map((l) => [n.id, l] as const),
);
// node sector type by id — drives asteroid-junction rendering + capture-by-arrival
const SECTOR_OF: Record<string, string> = Object.fromEntries(MAP.map((n) => [n.id, n.sector]));
function world(p: { x: number; y: number }): { x: number; y: number } {
  const b = projBase(p);
  return { x: b.x * cam.scale + cam.x, y: b.y * cam.scale + cam.y };
}
function visible(c: { x: number; y: number }, pad = 80): boolean {
  return c.x >= -pad && c.x <= VW + pad && c.y >= -pad && c.y <= VH + pad;
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
function unitIcon(unit: string): string {
  return UNIT_ICON[unit] ?? (isGround(unit) ? '◆' : '▲');
}
function displayUnit(unit: string): string {
  return unit.replace(/_/g, ' ');
}
function queueOf(planetId: string): PlanetBuildQueue {
  return (buildQueues[planetId] ??= { buildings: [], units: [] });
}
function laneOf(kind: BuildKind): BuildLane {
  return kind === 'unit' ? 'units' : 'buildings';
}
function buildCost(planetId: string, q: QueuedBuild): Record<string, number> | undefined {
  if (q.kind === 'unit') {
    return data.units[q.id]?.cost;
  }
  if (q.kind === 'building') {
    return data.buildings[q.id]?.cost;
  }
  const pl = s.planets[planetId];
  const inst = pl?.buildings.find((b) => b.type === q.id);
  return inst ? data.buildings[q.id]?.upgrades[inst.level - 1]?.cost : undefined;
}
function canStartQueued(planetId: string, q: QueuedBuild): boolean {
  return afford(buildCost(planetId, q));
}
function constructionPayload(payload: unknown): ConstructionPayload | null {
  const p = payload as ConstructionPayload;
  return typeof p?.planetId === 'string' ? p : null;
}
function activeConstruction(planetId: string, lane: BuildLane): ActiveBuild | null {
  let best: ActiveBuild | null = null;
  for (const event of s.scheduled) {
    if (event.type !== 'construction.complete') {
      continue;
    }
    const payload = constructionPayload(event.payload);
    if (!payload || payload.planetId !== planetId) {
      continue;
    }
    const kind = payload.kind === 'unit' ? 'units' : 'buildings';
    if (kind !== lane) {
      continue;
    }
    if (!best || event.at < best.at || (event.at === best.at && event.seq < best.seq)) {
      best = { at: event.at, seq: event.seq, payload };
    }
  }
  return best;
}
function constructionLabel(p: ConstructionPayload): string {
  if (p.kind === 'unit' && p.unit) {
    return `${p.count ?? 1}× ${unitIcon(p.unit)} ${displayUnit(p.unit)}`;
  }
  if (p.kind === 'upgrade' && p.building) {
    return `${BUILD_ICON[p.building] ?? '▣'} ${data.buildings[p.building]?.name ?? p.building} → L${p.level ?? '?'}`;
  }
  if (p.building) {
    return `${BUILD_ICON[p.building] ?? '▣'} ${data.buildings[p.building]?.name ?? p.building}`;
  }
  return 'unknown order';
}
function buildDurationHours(p: ConstructionPayload): number {
  if (p.kind === 'unit' && p.unit) {
    return data.units[p.unit]?.buildTimeHours ?? 0;
  }
  if (p.kind === 'upgrade' && p.building && typeof p.level === 'number') {
    return data.buildings[p.building]?.upgrades[p.level - 2]?.buildTimeHours ?? 0;
  }
  if (p.building) {
    return data.buildings[p.building]?.buildTimeHours ?? 0;
  }
  return 0;
}
function timeLeft(at: number): string {
  const hours = Math.max(0, (at - s.time) / HOUR);
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.ceil(hours * 60)}m`;
}
function progressPct(active: ActiveBuild): number {
  const duration = buildDurationHours(active.payload) * HOUR;
  if (duration <= 0) {
    return 100;
  }
  return Math.max(0, Math.min(100, 100 - ((active.at - s.time) / duration) * 100));
}
function queuedLabel(q: QueuedBuild): string {
  if (q.kind === 'unit') {
    return `${q.count}× ${unitIcon(q.id)} ${displayUnit(q.id)}`;
  }
  if (q.kind === 'upgrade') {
    return `${BUILD_ICON[q.id] ?? '▣'} ${data.buildings[q.id]?.name ?? q.id} upgrade`;
  }
  return `${BUILD_ICON[q.id] ?? '▣'} ${data.buildings[q.id]?.name ?? q.id}`;
}
function enqueueBuild(planetId: string, order: QueuedBuild): void {
  queueOf(planetId)[laneOf(order.kind)].push(order);
  note(`queued ${queuedLabel(order)} at ${planetId}`);
  pumpBuildQueues();
}
function submitQueued(planetId: string, queued: QueuedBuild): StepOut {
  const action =
    queued.kind === 'unit'
      ? buildUnit(ME, planetId, queued.id, queued.count)
      : queued.kind === 'upgrade'
        ? upgradeBuilding(ME, planetId, queued.id)
        : buildBuilding(ME, planetId, queued.id);
  const out = order(s, action, s.time);
  apply(out);
  return out;
}
function pumpBuildQueues(): void {
  for (const planetId of Object.keys(buildQueues)) {
    const q = buildQueues[planetId];
    const p = s.planets[planetId];
    if (!p || p.owner !== ME) {
      continue;
    }
    for (const lane of ['buildings', 'units'] as const) {
      const next = q[lane][0];
      if (!next || activeConstruction(planetId, lane) || !canStartQueued(planetId, next)) {
        continue;
      }
      q[lane].shift();
      const r = submitQueued(planetId, next);
      if (r.error) {
        note(`${queuedLabel(next)} failed: ${r.error}`);
      }
    }
  }
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
/** The fleets the command bar / move order currently act on (mine only). */
function selectedFleetIds(): string[] {
  if (selFleets.size) return [...selFleets].filter((id) => s.fleets[id]?.owner === ME);
  return selFleet && s.fleets[selFleet]?.owner === ME ? [selFleet] : [];
}

const ORBIT_R: Record<'near' | 'far', number> = { near: 30, far: 50 };

/** Screen anchor (+ heading) for a fleet's chevron: the interpolated lane
 *  position while moving, or a slot on its near/far orbit ring while stationed
 *  (fleets sharing a ring are fanned out so they don't overlap). */
function fleetAnchor(f: Fleet): { x: number; y: number; ang: number } | null {
  if (f.movement || !f.location) {
    const mp = fleetPos(f);
    if (!mp) return null;
    const c = world(mp);
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
    return { x: c.x, y: c.y, ang };
  }
  const pl = s.planets[f.location];
  if (!pl) return null;
  const pc = world(pl.position);
  const orbit = f.orbit ?? 'far';
  const peers = Object.values(s.fleets).filter(
    (g) => g.location === f.location && !g.movement && (g.orbit ?? 'far') === orbit,
  );
  const idx = Math.max(
    0,
    peers.findIndex((g) => g.id === f.id),
  );
  const a0 = -Math.PI / 2 + (idx - (peers.length - 1) / 2) * 0.55;
  const r = ORBIT_R[orbit];
  return { x: pc.x + Math.cos(a0) * r, y: pc.y + Math.sin(a0) * r, ang: a0 };
}
function note(msg: string) {
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  logLines.push(`D${d} ${String(h).padStart(2, '0')}h · ${msg}`);
  while (logLines.length > 9) logLines.shift();
}

/** The map node a fleet occupies / is travelling over (for visibility). */
function fleetNode(f: Fleet): string | null {
  return f.location ?? f.movement?.to ?? f.movement?.from ?? null;
}
/** Variant-A visibility: a node's contents are seen if the viewer owns it, or a
 *  friendly world/fleet sits within one jump (sensor range). Recomputed every
 *  frame — no memory, so things blink out the moment coverage lifts. */
function computeFog(): Set<string> {
  const vis = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (!id) return;
    vis.add(id);
    const pl = s.planets[id];
    if (pl?.links) for (const l of pl.links) vis.add(l);
  };
  for (const p of Object.values(s.planets)) if (p.owner === ME) add(p.id);
  for (const f of Object.values(s.fleets))
    if (f.owner === ME) {
      add(f.location);
      if (f.movement) {
        add(f.movement.from);
        add(f.movement.to);
      }
    }
  return vis;
}
/** True if the viewer may see the contents of node `id` (no fog ⇒ always). */
function known(id: string | null | undefined): boolean {
  return !fogVisible || (id != null && fogVisible.has(id));
}
function apply(out: StepOut) {
  s = out.state;
  if (selFleet && !s.fleets[selFleet]) selFleet = null;
  selFleets = new Set([...selFleets].filter((id) => s.fleets[id]?.owner === ME));
  handleEvents(out.events);
}

// A space fortress comes with a fixed orbital-AA emplacement (prototype scenario
// rule). The garrison unit makes the junction "defended" — it can no longer be
// walked into, only stormed — and its AA now fires on near-orbit attackers.
function installFortressAA(planetId: string) {
  const pl = s.planets[planetId];
  if (!pl) return;
  const aa = pl.garrison.find((u) => u.unit === 'orbital_aa' && u.hp === undefined);
  if (aa) aa.count += 1;
  else pl.garrison.push({ unit: 'orbital_aa', count: 1 });
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
  selPlanet = null; // a fleet selection never co-selects a planet (mutually exclusive)
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
        if (p.building === 'starfort') installFortressAA(p.planetId as string);
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
      case 'fleet.transit':
      case 'fleet.arrived':
        seizeSector(p.at as string, p.fleetId as string);
        break;
    }
  }
}

// A fleet moving through (or stopping at) a capturable sector that is undefended
// and uncontested takes it on the spot — the province recolours. Defended sectors
// (a garrison or fortress) need a real assault; empty space can't be owned at all.
function seizeSector(at: string, fleetId: string) {
  const f = s.fleets[fleetId];
  const pl = s.planets[at];
  if (!f || !pl || pl.owner === f.owner) return;
  if (!SECTOR_TYPES[SECTOR_OF[at]]?.capturable) return;
  if ((pl.garrison ?? []).some((u) => u.count > 0)) return;
  const contested = Object.values(s.fleets).some(
    (g) => g.owner !== f.owner && g.location === at && g.units.some((u) => u.count > 0),
  );
  if (contested) return;
  pl.owner = f.owner;
  note(`🚩 ${NAME[f.owner] ?? f.owner} seized ${at}`);
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
    if (!SECTOR_TYPES[SECTOR_OF[f.location]]?.capturable) continue; // empty space can't be taken
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

// Stable asteroid cluster for an asteroid-field junction — built once and seeded
// by the node position, so the rocks never shimmer or move between frames.
interface Rock {
  dx: number;
  dy: number;
  r: number;
  rot: number;
  sides: number;
}
const asteroidCache = new Map<string, Rock[]>();
function asteroidsFor(id: string, x: number, y: number): Rock[] {
  const hit = asteroidCache.get(id);
  if (hit) return hit;
  let seed = (Math.floor(x * 3457) ^ Math.floor(y * 8761) ^ 0x9e3779b9) >>> 0;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const rocks: Rock[] = [];
  const count = 9 + Math.floor(rnd() * 4);
  for (let i = 0; i < count; i++) {
    const ang = rnd() * TAU;
    const dist = 7 + rnd() * 21;
    rocks.push({
      dx: Math.cos(ang) * dist,
      dy: Math.sin(ang) * dist * 0.72, // slightly flattened → reads as a belt
      r: 1.5 + rnd() * 2.8,
      rot: rnd() * TAU,
      sides: 3 + Math.floor(rnd() * 3),
    });
  }
  asteroidCache.set(id, rocks);
  return rocks;
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

function glowRing(x: number, y: number, r: number, color: string, alpha: number) {
  cx.save();
  cx.shadowColor = color;
  cx.shadowBlur = 14;
  cx.strokeStyle = rgba(color, alpha);
  cx.lineWidth = 1.2;
  cx.beginPath();
  cx.arc(x, y, r, 0, TAU);
  cx.stroke();
  cx.restore();
}

function drawWarpLane(a: { x: number; y: number }, b: { x: number; y: number }) {
  cx.save();
  cx.strokeStyle = LANE;
  cx.lineWidth = 1;
  cx.shadowColor = 'rgba(53,214,230,0.5)';
  cx.shadowBlur = 4;
  cx.beginPath();
  cx.moveTo(a.x, a.y);
  cx.lineTo(b.x, b.y);
  cx.stroke();
  cx.restore();
}

function drawBattlePulse(x: number, y: number, pulse: number) {
  cx.save();
  cx.shadowColor = '#ff5a4d';
  cx.shadowBlur = 12;
  for (let i = 0; i < 3; i++) {
    const k = (pulse + i / 3) % 1;
    cx.strokeStyle = rgba('#ff5a4d', 0.55 * (1 - k));
    cx.lineWidth = 1.2 + i * 0.25;
    cx.beginPath();
    cx.arc(x, y, 18 + k * 24, 0, TAU);
    cx.stroke();
  }
  cx.restore();
}

/** The planned route of every moving fleet of mine — dashed, brighter if selected. */
function drawFleetRoutes() {
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME || !f.movement) continue;
    const start = fleetAnchor(f);
    if (!start) continue;
    const sel = selFleet === f.id || selFleets.has(f.id);
    const pts = [{ x: start.x, y: start.y }];
    for (const id of [f.movement.to, ...(f.movement.path ?? [])]) {
      const pl = s.planets[id];
      if (pl) pts.push(world(pl.position));
    }
    if (pts.length < 2) continue;
    cx.save();
    cx.setLineDash([4, 6]);
    cx.strokeStyle = rgba(LOCK, sel ? 0.85 : 0.32);
    cx.lineWidth = sel ? 1.8 : 1.1;
    cx.shadowColor = LOCK;
    cx.shadowBlur = sel ? 8 : 2;
    cx.beginPath();
    cx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i]!.x, pts[i]!.y);
    cx.stroke();
    const d = pts[pts.length - 1]!;
    cx.setLineDash([]);
    cx.beginPath();
    cx.arc(d.x, d.y, 4, 0, TAU);
    cx.stroke();
    cx.restore();
  }
}

/** While "Move" is armed: a dashed line from each selected fleet to the world
 *  under the pointer (snaps to the nearest blip) — preview before committing. */
function drawAimPreview() {
  if (!aiming || !aimPointer) return;
  const ids = selectedFleetIds();
  if (!ids.length) return;
  let target: { x: number; y: number } | null = null;
  let best = 30;
  for (const n of MAP) {
    const c = world(n);
    const d = Math.hypot(aimPointer.x - c.x, aimPointer.y - c.y);
    if (d < best) {
      best = d;
      target = c;
    }
  }
  const tip = target ?? aimPointer;
  cx.save();
  cx.strokeStyle = rgba(LOCK, 0.6);
  cx.lineWidth = 1.4;
  cx.setLineDash([3, 5]);
  cx.shadowColor = LOCK;
  cx.shadowBlur = 6;
  for (const id of ids) {
    const f = s.fleets[id];
    if (!f) continue;
    const a = fleetAnchor(f);
    if (!a) continue;
    cx.beginPath();
    cx.moveTo(a.x, a.y);
    cx.lineTo(tip.x, tip.y);
    cx.stroke();
  }
  if (target) {
    cx.setLineDash([]);
    cx.beginPath();
    cx.arc(tip.x, tip.y, 16, 0, TAU);
    cx.stroke();
  }
  cx.restore();
}

let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null;

/**
 * Province field — the whole map is a tiling of provinces (Bytro/Paradox-style):
 * every point belongs to the nearest seed (planets = capturable territory tinted
 * in the owner's colour; empty-space voids = uncapturable, neutral). The tiling is
 * computed as vector Voronoi cells (half-plane clipping) in base space and filled
 * under the camera each frame — so it covers the whole map, scales without
 * stretching, and never shimmers. Rebuilt only on viewport / ownership change.
 */
interface ProvCell {
  owner: string;
  col: string;
  poly: Array<[number, number]>;
}
let provCells: ProvCell[] = [];
let provSig = '';

/** Clip a convex polygon to the half-plane a*x + b*y + c <= 0 (Sutherland–Hodgman). */
function clipHalfPlane(
  poly: Array<[number, number]>,
  a: number,
  b: number,
  c: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % poly.length]!;
    const dc = a * cur[0] + b * cur[1] + c;
    const dn = a * nxt[0] + b * nxt[1] + c;
    if (dc <= 0) out.push(cur);
    if ((dc < 0) !== (dn < 0)) {
      const t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

function buildProvinces(): void {
  const owners = MAP.map((n) => s.planets[n.id]?.owner ?? 'null').join(',');
  const sig = `${VW}x${VH}:${MOBILE ? 1 : 0}|${owners}`;
  if (sig === provSig) {
    return;
  }
  provSig = sig;
  // every sector is a cell; empty sectors are an uncapturable neutral wash, the
  // rest take their owner's colour (political map).
  const seeds = MAP.map((n) => {
    const b = projBase(n);
    if (n.sector === 'empty') return { x: b.x, y: b.y, key: 'void', col: VOID_COLOR };
    const o = s.planets[n.id]?.owner ?? 'null';
    return { x: b.x, y: b.y, key: o, col: COLOR[o] };
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sd of seeds) {
    minX = Math.min(minX, sd.x);
    maxX = Math.max(maxX, sd.x);
    minY = Math.min(minY, sd.y);
    maxY = Math.max(maxY, sd.y);
  }
  // A clip rectangle far larger than the seed span, so the cells tile well beyond
  // the screen at any pan/zoom — the territory always fills the whole map.
  const m = 4000;
  const rect: Array<[number, number]> = [
    [minX - m, minY - m],
    [maxX + m, minY - m],
    [maxX + m, maxY + m],
    [minX - m, maxY + m],
  ];
  provCells = [];
  for (let i = 0; i < seeds.length; i++) {
    const si = seeds[i]!;
    let poly: Array<[number, number]> = rect.map((p) => [p[0], p[1]]);
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const sj = seeds[j]!;
      const a = 2 * (sj.x - si.x);
      const b = 2 * (sj.y - si.y);
      const c = si.x * si.x + si.y * si.y - (sj.x * sj.x + sj.y * sj.y);
      poly = clipHalfPlane(poly, a, b, c);
    }
    if (poly.length >= 3) {
      provCells.push({ owner: si.key, col: si.col, poly });
    }
  }
}

function drawProvinces(): void {
  buildProvinces();
  // Draw in base space under the live camera (translate+scale matches world()),
  // so the vector cells pan/zoom locked to the planets — no shimmer, no stretch.
  cx.save();
  cx.translate(cam.x, cam.y);
  cx.scale(cam.scale, cam.scale);
  const trace = (poly: Array<[number, number]>): void => {
    cx.beginPath();
    cx.moveTo(poly[0]![0], poly[0]![1]);
    for (let i = 1; i < poly.length; i++) cx.lineTo(poly[i]![0], poly[i]![1]);
    cx.closePath();
  };
  for (const cell of provCells) {
    trace(cell.poly);
    cx.fillStyle = rgba(cell.col, cell.owner === 'void' ? 0.05 : 0.11);
    cx.fill();
  }
  // faint province borders — vector, so ~1px on screen at any zoom
  cx.lineWidth = 1 / cam.scale;
  cx.strokeStyle = rgba('#7df0d0', 0.16);
  for (const cell of provCells) {
    trace(cell.poly);
    cx.stroke();
  }
  cx.restore();
}

function render(now: number) {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0); // draw in CSS pixels, crisp on hi-DPI
  drawScope(now);
  drawProvinces();

  // jump lanes — cached links with animated energy packets
  for (const [from, to] of MAP_LINKS) {
    const aPlanet = s.planets[from];
    const bPlanet = s.planets[to];
    if (!aPlanet || !bPlanet) continue;
    const a = world(aPlanet.position);
    const b = world(bPlanet.position);
    if (!visible(a, 120) && !visible(b, 120)) continue;
    drawWarpLane(a, b);
  }

  drawFleetRoutes();

  // battles — pulsing red contact ring
  const wave = (now / 900) % 1;
  for (const b of Object.values(s.battles)) {
    if (!known(b.location)) continue;
    const pp = s.planets[b.location];
    if (!pp) continue;
    const c = world(pp.position);
    if (!visible(c, 120)) continue;
    drawBattlePulse(c.x, c.y, wave);
  }

  // planets — wireframe blips with sensor rings + monospace callouts
  cx.textAlign = 'left';
  const R = 13;
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    const c = world(n);
    if (!visible(c, 110)) continue;
    const kn = known(n.id);
    const showOwner = kn ? p.owner : null; // hide ownership of fogged systems
    const col = kn ? COLOR[p.owner ?? 'null'] : FOG_COL;
    const sector = sectorColor(n.sector);
    const ownerPulse = 0.64 + 0.36 * Math.sin(now / 620 + n.x * 0.011 + n.y * 0.017);

    // empty-space sector: just a faint survey marker at its centre (no city, no
    // capture) — it is only a node you travel through.
    if (n.sector === 'empty') {
      cx.save();
      cx.strokeStyle = rgba(VOID_COLOR, 0.5);
      cx.lineWidth = 1;
      cx.beginPath();
      for (const [dx, dy] of CARDINAL) {
        cx.moveTo(c.x + dx * 1.5, c.y + dy * 1.5);
        cx.lineTo(c.x + dx * 3.5, c.y + dy * 3.5);
      }
      cx.stroke();
      cx.fillStyle = rgba(VOID_COLOR, 0.6);
      cx.beginPath();
      cx.arc(c.x, c.y, 1, 0, TAU);
      cx.fill();
      cx.restore();
      continue;
    }

    // asteroid-field sector: a lane junction, not a city — scattered rocks + a
    // fat hub where the lanes meet, no orbits. Captured by simply arriving — unless
    // a space fortress is raised here, which fortifies it (orbit + AA, must storm).
    if (n.sector === 'asteroid') {
      const fort = p.buildings.find((b) => b.type === 'starfort');
      const glow = cx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 30);
      glow.addColorStop(0, rgba(col, p.owner ? 0.14 : 0.05));
      glow.addColorStop(1, 'rgba(2,6,12,0)');
      cx.fillStyle = glow;
      cx.beginPath();
      cx.arc(c.x, c.y, 30, 0, TAU);
      cx.fill();
      cx.save();
      cx.strokeStyle = 'rgba(186,170,140,0.7)';
      cx.fillStyle = 'rgba(42,40,33,0.72)';
      cx.lineWidth = 1;
      for (const rk of asteroidsFor(n.id, n.x, n.y)) {
        cx.save();
        cx.translate(c.x + rk.dx, c.y + rk.dy);
        cx.rotate(rk.rot + now / 9000);
        cx.beginPath();
        for (let k = 0; k < rk.sides; k++) {
          const a = (k / rk.sides) * TAU;
          const rr = rk.r * (0.72 + 0.28 * Math.sin(a * 2 + rk.rot));
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr;
          if (k) cx.lineTo(px, py);
          else cx.moveTo(px, py);
        }
        cx.closePath();
        cx.fill();
        cx.stroke();
        cx.restore();
      }
      cx.restore();
      // fat junction hub (the lanes converge here), owner-coloured
      cx.save();
      cx.shadowColor = col;
      cx.shadowBlur = 8;
      cx.fillStyle = rgba(col, 0.92);
      cx.beginPath();
      cx.arc(c.x, c.y, 4.2, 0, TAU);
      cx.fill();
      cx.strokeStyle = rgba(col, 0.75);
      cx.lineWidth = 1.3;
      cx.beginPath();
      cx.arc(c.x, c.y, 7.5 + 0.6 * ownerPulse, 0, TAU);
      cx.stroke();
      cx.restore();
      // space fortress: a hexagonal bastion ring around the hub (with HP bar)
      if (fort) {
        cx.save();
        cx.strokeStyle = col;
        cx.lineWidth = 1.6;
        cx.shadowColor = col;
        cx.shadowBlur = 8;
        poly(c.x, c.y, 12, 6, Math.PI / 6);
        cx.stroke();
        poly(c.x, c.y, 7, 6, Math.PI / 6);
        cx.stroke();
        cx.restore();
        const frac = Math.max(0, Math.min(1, fort.hp / hpOfLevel('starfort', fort.level)));
        cx.fillStyle = 'rgba(2,9,13,.7)';
        cx.fillRect(c.x - 12, c.y - 22, 24, 3);
        cx.fillStyle = rgba(frac > 0.35 ? col : '#ff5a4d', 0.9);
        cx.fillRect(c.x - 12, c.y - 22, 24 * frac, 3);
      }
      if (selPlanet === n.id) targetBrackets(c.x, c.y, fort ? 18 : 15, now);
      cx.save();
      cx.shadowColor = 'rgba(0,0,0,0.85)';
      cx.shadowBlur = 3;
      cx.fillStyle = p.owner ? col : '#9fc9c4';
      cx.font = '700 11px ui-monospace,Menlo,monospace';
      cx.fillText(n.id, c.x + 16, c.y - 1);
      cx.fillStyle = 'rgba(150,210,205,0.55)';
      cx.font = '9px ui-monospace,Menlo,monospace';
      cx.fillText(fort ? 'void fortress ✦' : 'asteroid field', c.x + 16, c.y + 11);
      cx.restore();
      continue;
    }

    const aura = cx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R + 34);
    aura.addColorStop(0, rgba(col, showOwner ? 0.18 : 0.08));
    aura.addColorStop(0.55, rgba(sector, 0.06 + 0.04 * ownerPulse));
    aura.addColorStop(1, 'rgba(2,6,12,0)');
    cx.fillStyle = aura;
    cx.beginPath();
    cx.arc(c.x, c.y, R + 35, 0, TAU);
    cx.fill();

    // sensor-range ring (dashed, faint)
    cx.save();
    cx.setLineDash([3, 5]);
    cx.lineDashOffset = -now / 180;
    cx.strokeStyle = rgba(col, 0.18 + 0.13 * ownerPulse);
    cx.lineWidth = 1;
    cx.beginPath();
    cx.arc(c.x, c.y, R + 14 + 2 * ownerPulse, 0, TAU);
    cx.stroke();
    cx.restore();

    // fort = hex containment ring
    if (kn && p.buildings.some((b) => b.type === 'fort')) {
      cx.strokeStyle = rgba(col, 0.5);
      cx.lineWidth = 1;
      poly(c.x, c.y, R + 6, 6, Math.PI / 6);
      cx.stroke();
    }

    if (kn && p.buildings.length) {
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
    cx.shadowBlur = 10 + 7 * ownerPulse;
    cx.strokeStyle = col;
    cx.lineWidth = 2;
    cx.beginPath();
    cx.arc(c.x, c.y, R, 0, TAU);
    cx.stroke();
    cx.fillStyle = rgba(col, 0.72 + 0.28 * ownerPulse);
    cx.beginPath();
    cx.arc(c.x, c.y, 2.6 + 1.2 * ownerPulse, 0, TAU);
    cx.fill();
    cx.restore();

    glowRing(c.x, c.y, R + 5 + 3 * ownerPulse, col, showOwner ? 0.16 : 0.08);

    // N/E/S/W crosshair ticks
    cx.strokeStyle = rgba(col, 0.7);
    cx.lineWidth = 1.2;
    cx.beginPath();
    for (const [dx, dy] of CARDINAL) {
      cx.moveTo(c.x + dx * (R - 3), c.y + dy * (R - 3));
      cx.lineTo(c.x + dx * (R + 5), c.y + dy * (R + 5));
    }
    cx.stroke();

    if (selPlanet === n.id) targetBrackets(c.x, c.y, R + 10, now);

    // callout: id + garrison/buildings, monospace (fogged → no telemetry)
    cx.save();
    cx.shadowColor = 'rgba(0,0,0,0.85)';
    cx.shadowBlur = 3;
    cx.fillStyle = kn ? (p.owner ? col : '#9fc9c4') : 'rgba(120,140,150,0.55)';
    cx.font = '700 12px ui-monospace,Menlo,monospace';
    cx.fillText(n.id, c.x + R + 12, c.y - 1);
    cx.font = '10px ui-monospace,Menlo,monospace';
    if (kn) {
      const g = p.garrison.reduce((a, st) => a + st.count, 0);
      cx.fillStyle = 'rgba(150,210,205,0.6)';
      const icons = p.buildings.map((b) => BUILD_ICON[b.type] ?? '▪').join('');
      cx.fillText(`G:${g}  B:${icons || '—'}`, c.x + R + 12, c.y + 12);
    } else {
      cx.fillStyle = 'rgba(110,130,140,0.5)';
      cx.fillText('· no telemetry', c.x + R + 12, c.y + 12);
    }
    cx.restore();
  }

  // orbit rings around any CITY that holds a stationed fleet (near vs far).
  // Asteroid-field junctions have no orbits, so they are skipped.
  const stationed: Record<string, Fleet[]> = {};
  for (const f of Object.values(s.fleets))
    if (f.location && !f.movement) {
      if (f.owner !== ME && !known(f.location)) continue; // hidden enemy orbit
      (stationed[f.location] ??= []).push(f);
    }
  for (const pid of Object.keys(stationed)) {
    const pl = s.planets[pid];
    if (!pl) continue;
    // orbit only on types that have one (cities); a fortress gives a junction one too
    const fortified =
      pl.buildings.some((b) => b.type === 'starfort') || (pl.garrison ?? []).some((u) => u.count > 0);
    if (!SECTOR_TYPES[SECTOR_OF[pid]]?.orbit && !fortified) continue;
    const pc = world(pl.position);
    if (!visible(pc, 80)) continue;
    for (const orb of ['far', 'near'] as const) {
      const warm = orb === 'near'; // near = hot zone (bombard / AA reaches), far = safe
      cx.save();
      cx.setLineDash(warm ? [2, 5] : [7, 6]);
      cx.lineDashOffset = warm ? now / 200 : -now / 280;
      cx.strokeStyle = rgba(ORBIT_COLOR[orb], warm ? 0.42 : 0.22);
      cx.lineWidth = warm ? 1.3 : 1;
      cx.beginPath();
      cx.arc(pc.x, pc.y, ORBIT_R[orb], 0, TAU);
      cx.stroke();
      cx.setLineDash([]);
      cx.fillStyle = rgba(ORBIT_COLOR[orb], 0.7);
      cx.font = '700 7px ui-monospace,Menlo,monospace';
      cx.textAlign = 'center';
      cx.fillText(warm ? 'NEAR' : 'FAR', pc.x, pc.y + ORBIT_R[orb] + 8);
      cx.restore();
    }
  }

  // fleets — glowing chevrons on their orbit ring (stationed) or along the lane
  cx.textAlign = 'center';
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== ME && !known(fleetNode(f))) continue; // enemy out of sensors
    const A = fleetAnchor(f);
    if (!A || !visible(A, 120)) continue;
    const col = COLOR[f.owner];
    const ships = sumUnits(f.units);
    const troops = sumUnits(f.landing ?? []);
    const engine = 0.55 + 0.45 * Math.sin(now / 120 + f.id.length);

    // bombardment beam down to the planet
    if (f.bombarding && f.location) {
      const target = s.planets[f.location];
      if (target) {
        const pc = world(target.position);
        const spark = 0.45 + 0.55 * Math.sin(now / 90);
        cx.save();
        cx.strokeStyle = rgba('#ffb15f', 0.3 + 0.3 * spark);
        cx.lineWidth = 1.2 + spark;
        cx.shadowColor = '#ffb15f';
        cx.shadowBlur = 12;
        cx.beginPath();
        cx.moveTo(A.x, A.y);
        cx.lineTo(pc.x, pc.y);
        cx.stroke();
        cx.restore();
      }
    }

    // contact trail while moving
    if (f.movement) {
      for (let i = 1; i <= 4; i++) {
        cx.fillStyle = rgba(col, 0.33 - 0.055 * i);
        cx.beginPath();
        cx.arc(
          A.x - Math.cos(A.ang) * i * (8 + engine * 2),
          A.y - Math.sin(A.ang) * i * (8 + engine * 2),
          2.8 - 0.35 * i,
          0,
          TAU,
        );
        cx.fill();
      }
    }

    // fleet model = a squadron of 1 / 2 / 3 triangles by ship count
    const squad = Math.min(3, Math.max(1, ships));
    const formation: ReadonlyArray<readonly [number, number]> =
      squad === 1
        ? [[0, 0]]
        : squad === 2
          ? [
              [-4, 1],
              [4, 1],
            ]
          : [
              [0, -3.5],
              [-5, 5],
              [5, 5],
            ];
    cx.save();
    cx.translate(A.x, A.y);
    cx.rotate(A.ang + Math.PI / 2);
    cx.shadowColor = col;
    cx.shadowBlur = 8 + 7 * engine;
    cx.fillStyle = rgba(col, 0.14 + 0.12 * engine);
    cx.strokeStyle = col;
    cx.lineWidth = 1.5;
    for (const [ox, oy] of formation) {
      cx.beginPath();
      cx.moveTo(ox, oy - 5);
      cx.lineTo(ox + 3.6, oy + 4);
      cx.lineTo(ox - 3.6, oy + 4);
      cx.closePath();
      cx.fill();
      cx.stroke();
    }
    const lead = formation[0]!;
    cx.fillStyle = rgba('#ffffff', 0.4 + 0.35 * engine);
    cx.beginPath();
    cx.arc(lead[0], lead[1], 1 + 0.8 * engine, 0, TAU);
    cx.fill();
    cx.restore();

    if (selFleet === f.id || selFleets.has(f.id)) targetBrackets(A.x, A.y, 12, now);

    cx.fillStyle = rgba(col, 0.95);
    cx.font = '700 10px ui-monospace,Menlo,monospace';
    cx.fillText(`${ships}${troops ? '+' + troops : ''}`, A.x, A.y + 20);

    // orbit tag for a stationed fleet (N = near / F = far)
    if (f.location && !f.movement) {
      cx.fillStyle = rgba(ORBIT_COLOR[f.orbit ?? 'far'], 0.9);
      cx.font = '700 8px ui-monospace,Menlo,monospace';
      cx.fillText(f.orbit === 'near' ? 'N' : 'F', A.x, A.y - 12);
    }
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
  drawAimPreview();
}

// --- side panel --------------------------------------------------------------

function btn(act: string, arg: string, label: string, ok: boolean): string {
  return `<button class="b" data-act="${esc(act)}" data-arg="${esc(arg)}" ${ok ? '' : 'disabled'}>${esc(label)}</button>`;
}
function cardHeader(color: string, title: string, sub: string): string {
  return `<div class="phead">
    <span class="pflag" style="background:${color}"></span>
    <div class="ptitle"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
    <button class="pclose" data-act="close" data-arg="">✕</button>
  </div>`;
}
function tabButton(tab: PlanetTab, label: string, count: number): string {
  const on = planetTab === tab ? ' on' : '';
  return `<button class="ptab${on}" data-act="tab" data-arg="${tab}">${label}<b>${count}</b></button>`;
}
function unitRows(stacks: Array<{ unit: string; count: number }>): string {
  if (!stacks.length) {
    return `<div class="row dim">none</div>`;
  }
  return stacks
    .map(
      (st) =>
        `<div class="asset-row"><span class="bicon">${unitIcon(st.unit)}</span><b>${st.count}× ${displayUnit(st.unit)}</b><span class="dim">${isGround(st.unit) ? 'ground' : 'space'}</span></div>`,
    )
    .join('');
}
function conveyorHtml(planetId: string, lane: BuildLane): string {
  const active = activeConstruction(planetId, lane);
  const queued = queueOf(planetId)[lane];
  let html = `<div class="conveyor">`;
  if (active) {
    const pct = progressPct(active);
    html += `<div class="current"><span>NOW</span><b>${constructionLabel(active.payload)}</b><em>${timeLeft(active.at)}</em></div>`;
    html += `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>`;
  } else {
    html += `<div class="current idle"><span>IDLE</span><b>ready for next order</b><em>—</em></div>`;
    html += `<div class="bar"><i style="width:0%"></i></div>`;
  }
  if (queued.length) {
    html += `<div class="queue">${queued
      .map((q, i) => `<span><em>${i + 1}</em>${queuedLabel(q)}</span>`)
      .join('')}</div>`;
  } else {
    html += `<div class="queue empty">queue empty</div>`;
  }
  return html + `</div>`;
}
function buildButtons(planetId: string, ids: string[], kind: 'building' | 'unit'): string {
  let html = `<div class="row">`;
  for (const id of ids) {
    const c = kind === 'unit' ? data.units[id]?.cost : data.buildings[id]?.cost;
    const icon = kind === 'unit' ? unitIcon(id) : (BUILD_ICON[id] ?? '+');
    const label =
      kind === 'unit'
        ? `${icon} ${displayUnit(id)} ${cost(c)}`
        : `${icon} ${data.buildings[id]?.name ?? id} ${cost(c)}`;
    html += btn(kind === 'unit' ? 'unit' : 'build', id, label, s.planets[planetId]?.owner === ME);
  }
  return html + `</div>`;
}

function panelHtml(): string {
  const group = [...selFleets].map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  if (group.length > 1) {
    const ships = group.reduce((a, f) => a + sumUnits(f.units), 0);
    const troops = group.reduce((a, f) => a + sumUnits(f.landing ?? []), 0);
    let h = cardHeader(
      COLOR[ME],
      'TASK GROUP',
      `${group.length} fleets · ${ships} ships · ${troops} troops`,
    );
    h += `<div class="hint">Press <b>Move</b>, then tap a destination to send all selected fleets (they route and stop). Shift-drag on the map selects a fleet group.</div>`;
    for (const f of group) {
      const loc = f.location ?? (f.movement ? `${f.movement.from}→${f.movement.to}` : '—');
      const nShips = sumUnits(f.units);
      const nTr = sumUnits(f.landing ?? []);
      h += `<div class="row" style="color:${COLOR[f.owner]}">▲ ${f.id} <span class="dim">${loc}</span> · ${nShips}${nTr ? '+' + nTr : ''}</div>`;
    }
    h += btn('cancel', '', 'Deselect group', true);
    return h;
  }
  if (selFleet) {
    const f = s.fleets[selFleet];
    if (f) {
      const shipList = f.units.map((u) => `${u.count}×${esc(u.unit)}`).join(', ') || '—';
      const trList = (f.landing ?? []).map((u) => `${u.count}×${esc(u.unit)}`).join(', ') || '—';
      const nShips = sumUnits(f.units);
      const nTr = sumUnits(f.landing ?? []);
      const orbit = f.orbit ?? '—';
      let h = cardHeader(
        COLOR[f.owner],
        'FLEET',
        `${nShips} ships · ${nTr} troops · orbit ${orbit}${f.bombarding ? ' · ⊗ bombarding' : ''}`,
      );
      h += `<div class="pstats"><span>✦ ${shipList}</span></div><div class="row dim">Carrying: ${trList}</div>`;

      const here = planet(f.location);
      const docked = !!here && !f.movement && !f.battleId;
      if (!docked) {
        h += `<div class="hint">${
          f.battleId
            ? 'Engaged — orbital battle in progress.'
            : 'In transit — routing along the lanes. Collisions trigger an orbital battle.'
        }</div>`;
      } else {
        // enemy/neutral world you can act on — empty space is pass-through only
        const hostile = here!.owner !== f.owner && (SECTOR_TYPES[SECTOR_OF[here!.id]]?.capturable ?? false);
        // orbit toggle
        h += `<div class="sec">Orbit · ${esc(here!.id)}</div><div class="row">`;
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
      h += `<div class="hint">Press <b>Move</b> (command bar), then tap a destination — the fleet routes along the lanes there and stops. Tap a world without Move to inspect it.</div>`;
      h += btn('cancel', '', 'Deselect', true);
      return h;
    }
  }
  const p = planet(selPlanet);
  if (!p) return '<div class="hint">Tap a world.</div>';
  if (!known(p.id) && p.owner !== ME) {
    return (
      cardHeader(FOG_COL, p.id, 'NO TELEMETRY') +
      `<div class="row dim">Outside sensor range — ownership, garrison and structures unknown.</div>` +
      `<div class="hint">Hold a neighbouring world or send a fleet within one jump to scan this system.</div>` +
      btn('cancel', '', 'Deselect', true)
    );
  }
  const owner = p.owner ?? 'null';
  const mine = p.owner === ME;
  const sec = data.sectors[p.sectorType ?? '']?.name ?? p.sectorType ?? '—';
  const pt = p.planetType ? data.planetTypes[p.planetType] : undefined;
  const ptName = pt?.name ?? p.planetType ?? '—';
  const ground = p.garrison.filter((st) => isGround(st.unit));
  const ships = p.garrison.filter((st) => isShip(st.unit));
  const gcount = sumUnits(p.garrison);
  const here = Object.values(s.fleets).filter((f) => f.location === p.id);
  let h =
    cardHeader(COLOR[owner], p.id, `${p.owner ? NAME[p.owner] : 'Neutral'} · ${ptName} · ${sec}`) +
    `<div class="pstats"><span>⚔ ${gcount} garrison</span><span>${unitIcon('marine')} ${sumUnits(ground)} ground</span><span>${unitIcon('cruiser')} ${sumUnits(ships)} ships</span><span>▣ ${p.buildings.length} built</span></div>`;
  if (pt && (pt.productionBonus !== 0 || pt.defenseBonus !== 0)) {
    const pct = (n: number) => (n >= 0 ? '+' : '') + Math.round(n * 100) + '%';
    const parts: string[] = [];
    if (pt.productionBonus !== 0) parts.push(`prod ${pct(pt.productionBonus)}`);
    if (pt.defenseBonus !== 0) parts.push(`def ${pct(pt.defenseBonus)}`);
    h += `<div class="row dim">${esc(ptName)} world — ${parts.join(' · ')}</div>`;
  }

  h += `<div class="ptabs">${tabButton('ground', 'Ground', ground.length)}${tabButton(
    'ships',
    'Ships',
    ships.length + here.length,
  )}${tabButton('buildings', 'Buildings', p.buildings.length)}</div>`;

  if (planetTab === 'ground') {
    h += `<div class="sec">Ground units</div>`;
    h += unitRows(ground);
    if (mine) {
      const groundBuilds = BUILD_UNITS.filter((u) => isGround(u));
      h += `<div class="sec">Ground conveyor</div>`;
      h += conveyorHtml(p.id, 'units');
      h += buildButtons(p.id, groundBuilds, 'unit');
    }
    h += `<div class="hint">Ground units defend planets and can be loaded onto fleets from the fleet panel.</div>`;
  } else if (planetTab === 'ships') {
    h += `<div class="sec">Spacecraft in garrison</div>`;
    h += unitRows(ships);
    if (mine && ships.length) {
      h += `<div class="row">${btn('launch', p.id, '🚀 Launch fleet from garrison', true)}</div>`;
    }
    if (here.length) {
      h += `<div class="sec">Fleets in orbit</div>`;
      for (const f of here) {
        const fShips = sumUnits(f.units);
        const tr = sumUnits(f.landing ?? []);
        const sel = f.owner === ME ? btn('selfleet', f.id, 'Select →', true) : '';
        h += `<div class="asset-row" style="color:${COLOR[f.owner]}"><span class="bicon">▲</span><b>${fShips} ships${tr ? ' +' + tr + ' troops' : ''}</b><span class="dim">orbit ${f.orbit ?? 'far'}</span>${sel}</div>`;
      }
    }
    if (mine) {
      const shipBuilds = BUILD_UNITS.filter((u) => isShip(u));
      h += `<div class="sec">Shipyard conveyor</div>`;
      h += conveyorHtml(p.id, 'units');
      h += buildButtons(p.id, shipBuilds, 'unit');
    }
    h += `<div class="hint">Built spacecraft join the garrison first; launch creates a mobile fleet.</div>`;
  } else {
    h += `<div class="sec">Building conveyor</div>`;
    if (mine) {
      h += conveyorHtml(p.id, 'buildings');
    } else {
      h += `<div class="row dim">enemy construction telemetry unavailable</div>`;
    }
    h += `<div class="sec">Buildings</div>`;
    if (p.buildings.length === 0) h += `<div class="row dim">none</div>`;
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      const max = def ? buildingMaxLevel(def) : 1;
      h += `<div class="asset-row"><span class="bicon">${BUILD_ICON[b.type] ?? '▪'}</span><b>${def?.name ?? b.type}</b><span class="dim">L${b.level}/${max} · hp ${floor(b.hp)}/${hpOfLevel(b.type, b.level)}</span>`;
      if (mine && b.level < max) {
        const c = def?.upgrades[b.level - 1]?.cost;
        h += btn('upgrade', b.type, `▲ Upgrade ${cost(c)}`, afford(c));
      }
      h += `</div>`;
    }
    if (mine) {
      // an asteroid junction can only raise a space fortress; a city builds the rest
      const buildable = SECTOR_OF[p.id] === 'asteroid' ? ['starfort'] : BUILDABLE;
      const missing = buildable.filter((t) => !p.buildings.some((b) => b.type === t));
      if (missing.length) {
        h += buildButtons(p.id, missing, 'building');
      }
    }
  }
  return h;
}

function renderPanel() {
  const open = selFleet !== null || selPlanet !== null || selFleets.size > 0;
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

function cmdBtn(cmd: string, label: string, cls: string, disabled: boolean): string {
  return `<button data-cmd="${cmd}" class="${cls}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}

/** Horizontal fleet command bar — Move (arm) / Stop / Attack / orbit change —
 *  acting on the current fleet selection, buttons enabled by context. */
function renderCmdBar() {
  const ids = selectedFleetIds();
  if (ids.length === 0) {
    if (aiming) aiming = false;
    cmdbar.classList.remove('show');
    lastCmdHtml = '';
    return;
  }
  const fleets = ids.map((id) => s.fleets[id]).filter((f): f is Fleet => !!f);
  const anyMoving = fleets.some((f) => f.movement);
  const docked = fleets.filter((f) => f.location && !f.movement && !f.battleId);
  const anyDocked = docked.length > 0;
  const anyFar = docked.some((f) => (f.orbit ?? 'far') === 'far');
  const canAssault = docked.some(
    (f) =>
      f.orbit === 'near' &&
      f.location &&
      s.planets[f.location]?.owner !== f.owner &&
      SECTOR_TYPES[SECTOR_OF[f.location]]?.capturable, // empty space can't be taken
  );
  const descend = anyFar; // at least one far → primary orbit action is descend to near
  const html =
    `<span class="cmdlabel">${ids.length > 1 ? ids.length + ' FLEETS' : 'FLEET'}</span>` +
    cmdBtn('move', '⤳ Move', aiming ? 'on' : '', false) +
    cmdBtn('stop', '■ Stop', 'danger', !anyMoving) +
    cmdBtn('attack', '⚔ Attack', '', !canAssault) +
    cmdBtn(descend ? 'near' : 'far', descend ? '▼ Near' : '▲ Far', '', !anyDocked);
  if (html !== lastCmdHtml) {
    cmdbar.innerHTML = html;
    lastCmdHtml = html;
  }
  cmdbar.classList.add('show');
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
  } else if (act === 'tab') {
    if (arg === 'ground' || arg === 'ships' || arg === 'buildings') {
      planetTab = arg;
    }
  } else if (act === 'build') {
    enqueueBuild(selPlanet!, { kind: 'building', id: arg, count: 1 });
  } else if (act === 'upgrade') {
    enqueueBuild(selPlanet!, { kind: 'upgrade', id: arg, count: 1 });
  } else if (act === 'unit') {
    enqueueBuild(selPlanet!, { kind: 'unit', id: arg, count: 1 });
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

cmdbar.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled) return;
  const cmd = t.dataset.cmd;
  const ids = selectedFleetIds();
  if (cmd === 'move') {
    aiming = !aiming; // arm / disarm the move order
  } else if (cmd === 'stop') {
    for (const id of ids) if (s.fleets[id]?.movement) playerOrder(stopFleet(ME, id));
  } else if (cmd === 'attack') {
    for (const id of ids) if (s.fleets[id]?.orbit === 'near') playerOrder(assaultFleet(ME, id));
    aiming = false;
  } else if (cmd === 'near' || cmd === 'far') {
    for (const id of ids) {
      const f = s.fleets[id];
      if (f?.location && !f.movement) playerOrder(orbitFleet(ME, id, cmd));
    }
    aiming = false;
  }
  lastCmdHtml = '';
  lastPanelHtml = '';
  renderCmdBar();
  renderPanel();
});

// --- canvas input ------------------------------------------------------------

// Tap/click selection at a screen point (drag-aware — see the pointer handlers).
function selectAt(mx: number, my: number) {
  // Plain tap = selection. Movement happens only when "Move" is armed (aiming), so a
  // fleet selection never blocks picking a planet (and vice versa).
  if (!aiming) {
    for (const f of Object.values(s.fleets)) {
      if (f.owner !== ME) continue;
      const a = fleetAnchor(f);
      if (a && Math.hypot(mx - a.x, my - a.y) < 16) {
        setFleetSelection([f.id]); // (clears any selected planet)
        return;
      }
    }
  }
  for (const n of MAP) {
    const c = world(n);
    if (Math.hypot(mx - c.x, my - c.y) < 24) {
      if (aiming) {
        // Move armed → send the selected fleet(s) here; they route along the lanes to
        // this world and stop. Keep them selected for follow-up orders.
        for (const fleetId of selectedFleetIds()) {
          const f = s.fleets[fleetId];
          if (f && f.location !== n.id) playerOrder(moveFleet(ME, fleetId, n.id));
        }
        aiming = false;
        lastPanelHtml = '';
        return;
      }
      // plain tap → select the planet (mutually exclusive with a fleet)
      selPlanet = n.id;
      selFleet = null;
      selFleets = new Set();
      lastPanelHtml = '';
      return;
    }
  }
  // empty space: cancel an armed move, otherwise clear the selection
  if (aiming) {
    aiming = false;
    return;
  }
  clearSelection();
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
      const a = fleetAnchor(f);
      if (a && a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2) picked.push(f.id);
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
// track the pointer for the "Move" preview line (hover on desktop, drag on touch)
canvas.addEventListener('pointermove', (ev) => {
  aimPointer = ptXY(ev);
});

// --- top bar / speed ---------------------------------------------------------

for (const b of Array.from(document.querySelectorAll('[data-speed]'))) {
  b.addEventListener('click', () => {
    speed = Number((b as HTMLElement).dataset.speed);
    for (const x of Array.from(document.querySelectorAll('[data-speed]')))
      x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === speed);
  });
}

// Dev-only fog-of-war toggle (temporary — removed once core visibleState lands).
const fogBtn = Array.from(document.querySelectorAll('[data-fog]'))[0] as HTMLElement | undefined;
if (fogBtn) {
  fogBtn.classList.toggle('on', fogOn);
  fogBtn.addEventListener('click', () => {
    fogOn = !fogOn;
    fogBtn.classList.toggle('on', fogOn);
    lastPanelHtml = ''; // force the side panel to re-evaluate visibility
    note(fogOn ? 'fog of war: ON (variant A — here & now)' : 'fog of war: OFF (omniscient)');
  });
}

// Mobile: hamburger toggles the slide-in drawer (rail + log + comms); the scrim
// behind it closes on tap. No-op on desktop, where the drawer is always shown.
burger.addEventListener('click', () => document.body.classList.toggle('drawer-open'));
scrim.addEventListener('click', () => document.body.classList.remove('drawer-open'));

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
    pumpBuildQueues();
    checkEnd();
  }
  fogVisible = fogOn ? computeFog() : null; // dev fog projection for this frame
  render(nowReal);
  renderPanel();
  renderCmdBar();
  // top bar (Iron Order-style resource readouts with +/h deltas)
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  const clockText = `Day ${d} · ${String(h).padStart(2, '0')}:00`;
  if (clockText !== lastClockText) {
    clock.textContent = clockText;
    topClock.textContent = clockText;
    lastClockText = clockText;
  }
  const dayTimerText = `Day ${d} — next cycle in ${24 - h}h`;
  if (dayTimerText !== lastDayTimerText) {
    dayTimer.textContent = dayTimerText;
    lastDayTimerText = dayTimerText;
  }
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
  const hudHtml =
    chip('MTL', kfmt(r.metal ?? 0), inc.metal ?? 0) +
    chip('CRD', kfmt(r.credits ?? 0), inc.credits ?? 0) +
    chip('WLD', String(worlds)) +
    chip('FLT', String(myFleets));
  if (hudHtml !== lastHudHtml) {
    purse.innerHTML = hudHtml;
    lastHudHtml = hudHtml;
  }
  const battles = Object.keys(s.battles).length;
  const alertText = String(battles);
  if (alertText !== lastAlertText) {
    alertBadge.style.display = battles > 0 ? 'grid' : 'none';
    alertBadge.textContent = alertText;
    lastAlertText = alertText;
  }
  const logHtml = logLines.map((l) => `<div>${esc(l)}</div>`).join('');
  if (logHtml !== lastLogHtml) {
    logEl.innerHTML = logHtml;
    lastLogHtml = logHtml;
  }
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
