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
  launchFleet,
  buildBuilding,
  upgradeBuilding,
  buildUnit,
  type StepOut,
} from './game';
import { buildingMaxLevel } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, Planet, DomainEvent } from '../../packages/shared-core/src/index';

// --- constants ---------------------------------------------------------------

const COLOR: Record<string, string> = { p1: '#2e86d8', p2: '#e23b3b', null: '#9aa3ad' };
const LANE = 'rgba(214,222,232,0.30)';
const TOP = 50; // top-bar height
const RAIL = 50; // left-rail width
const BUILDABLE = ['mine', 'refinery', 'barracks', 'fort'];
const BUILD_UNITS = ['marine', 'orbital_aa', 'cruiser', 'scout', 'siege'];
const ME = 'p1';

// --- state -------------------------------------------------------------------

let s: GameState = newGame();
let speed = 2; // game-hours per real second (0 = paused)
let banner: string | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = null;
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

// Deterministic starfield + nebula clouds (normalized 0..1), drawn each frame.
const STARS = Array.from({ length: 620 }, (_, i) => {
  const r1 = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  const r2 = (Math.sin(i * 78.233) * 12543.1234) % 1;
  const r3 = (Math.sin(i * 3.71) * 9281.77) % 1;
  return { x: (r1 + 1) % 1, y: (r2 + 1) % 1, b: 0.25 + ((r3 + 1) % 1) * 0.75 };
});
const NEBULA: Array<[number, number, number, string]> = [
  [0.46, 0.46, 0.6, 'rgba(70,90,170,0.16)'],
  [0.6, 0.4, 0.42, 'rgba(150,70,150,0.13)'],
  [0.38, 0.6, 0.5, 'rgba(40,120,150,0.10)'],
  [0.5, 0.48, 0.16, 'rgba(220,210,235,0.16)'], // bright core
];

function drawGalaxy() {
  const w = VW;
  const h = VH;
  cx.fillStyle = '#04060d';
  cx.fillRect(0, 0, w, h);
  for (const [nx, ny, r, col] of NEBULA) {
    const cx0 = nx * w;
    const cy0 = ny * h;
    const rad = r * Math.min(w, h);
    const g = cx.createRadialGradient(cx0, cy0, 0, cx0, cy0, rad);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, h);
  }
  for (const st of STARS) {
    cx.globalAlpha = st.b;
    cx.fillStyle = '#dfe8ff';
    const sz = st.b > 0.9 ? 1.6 : 1;
    cx.fillRect(st.x * w, st.y * h, sz, sz);
  }
  cx.globalAlpha = 1;
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
function proj(p: { x: number; y: number }): { x: number; y: number } {
  // Keep the node cluster clear of the HUD: the left rail, the right dossier
  // (desktop only — on mobile it's a bottom sheet) and the bottom strip.
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

// --- helpers -----------------------------------------------------------------

const planet = (id: string | null | undefined): Planet | undefined => (id ? s.planets[id] : undefined);
const isShip = (u: string) => !data.units[u]?.traits.includes('ground');
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
  handleEvents(out.events);
  if (out.error && out.error !== 'E_FLEET_BUSY') {
    /* swallow AI/ordering errors quietly except surfacing player ones elsewhere */
  }
}

const NAME: Record<string, string> = { p1: 'Azure', p2: 'Crimson' };
function handleEvents(events: DomainEvent[]) {
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'battle.started':
        note(`⚔️ battle at ${p.location} (${p.phase})`);
        break;
      case 'battle.resolved':
        note(`battle at ${p.location} ended — ${p.winner ? NAME[p.winner as string] + ' won' : 'stalemate'}`);
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

// Stopgap until the orbit UI lands: any idle fleet sitting over a hostile world
// with a clear orbit descends and lands automatically (preserves the capture
// loop on the new manual-engagement combat model).
function autoEngage() {
  for (const f of Object.values(s.fleets)) {
    if (f.location == null || f.movement || f.battleId) continue;
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

function render() {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0); // draw in CSS pixels, crisp on hi-DPI
  drawGalaxy();
  // star lanes
  cx.strokeStyle = LANE;
  cx.lineWidth = 1.4;
  for (const n of MAP) {
    for (const l of n.links) {
      if (n.id < l && s.planets[l]) {
        const a = proj(n);
        const q = proj(s.planets[l]!.position);
        cx.beginPath();
        cx.moveTo(a.x, a.y);
        cx.lineTo(q.x, q.y);
        cx.stroke();
      }
    }
  }
  // battles (pulse)
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  for (const b of Object.values(s.battles)) {
    const pp = s.planets[b.location];
    if (!pp) continue;
    const c = proj(pp.position);
    cx.strokeStyle = `rgba(245,185,66,${0.45 + 0.45 * pulse})`;
    cx.lineWidth = 2.5;
    cx.beginPath();
    cx.arc(c.x, c.y, 26 + 5 * pulse, 0, Math.PI * 2);
    cx.stroke();
  }
  // planets (bright node + dark ring + white label to the right)
  cx.textAlign = 'left';
  const R = 16;
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    const c = proj(n);
    const owner = p.owner ?? 'null';
    if (selPlanet === n.id) {
      cx.strokeStyle = '#e8cd84';
      cx.lineWidth = 3;
      cx.beginPath();
      cx.arc(c.x, c.y, R + 7, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.save();
    cx.shadowColor = COLOR[owner];
    cx.shadowBlur = 14;
    cx.fillStyle = COLOR[owner];
    cx.beginPath();
    cx.arc(c.x, c.y, R, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
    cx.strokeStyle = 'rgba(5,10,20,0.85)';
    cx.lineWidth = 3;
    cx.beginPath();
    cx.arc(c.x, c.y, R, 0, Math.PI * 2);
    cx.stroke();
    if (p.buildings.some((b) => b.type === 'fort')) {
      cx.strokeStyle = '#e8cd84';
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.arc(c.x, c.y, R + 3, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.save();
    cx.shadowColor = 'rgba(0,0,0,0.9)';
    cx.shadowBlur = 4;
    cx.fillStyle = '#ffffff';
    cx.font = '700 15px system-ui,sans-serif';
    cx.fillText(n.id, c.x + R + 9, c.y + 5);
    cx.restore();
    const g = p.garrison.reduce((a, st) => a + st.count, 0);
    const meta = [g > 0 ? `⚔ ${g}` : '', p.buildings.length ? `▣ ${p.buildings.length}` : '']
      .filter(Boolean)
      .join('   ');
    if (meta) {
      cx.fillStyle = 'rgba(214,224,236,0.72)';
      cx.font = '11px system-ui';
      cx.fillText(meta, c.x + R + 9, c.y + 21);
    }
  }
  // fleets
  cx.textAlign = 'center';
  for (const f of Object.values(s.fleets)) {
    const mp = fleetPos(f);
    if (!mp) continue;
    const c = proj(mp);
    const ships = f.units.reduce((a, st) => a + st.count, 0);
    const troops = (f.landing ?? []).reduce((a, st) => a + st.count, 0);
    cx.save();
    cx.translate(c.x, c.y - (f.location ? 26 : 0));
    if (selFleet === f.id) {
      cx.strokeStyle = '#e8cd84';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.arc(0, 0, 11, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.fillStyle = COLOR[f.owner];
    cx.strokeStyle = 'rgba(5,10,20,0.8)';
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(0, -8);
    cx.lineTo(7, 7);
    cx.lineTo(-7, 7);
    cx.closePath();
    cx.fill();
    cx.stroke();
    cx.fillStyle = '#fff';
    cx.font = '700 10px system-ui';
    cx.fillText(`${ships}${troops ? '+' + troops : ''}`, 0, 19);
    cx.restore();
  }
}

// --- side panel --------------------------------------------------------------

function btn(act: string, arg: string, label: string, ok: boolean): string {
  return `<button class="b" data-act="${act}" data-arg="${arg}" ${ok ? '' : 'disabled'}>${label}</button>`;
}

function panelHtml(): string {
  if (selFleet) {
    const f = s.fleets[selFleet];
    if (f) {
      const ships = f.units.map((u) => `${u.count}×${u.unit}`).join(', ') || '—';
      const tr = (f.landing ?? []).map((u) => `${u.count}×${u.unit}`).join(', ') || '—';
      return `<h3 style="color:${COLOR[f.owner]}">Fleet selected</h3>
        <div class="row">Ships: ${ships}</div><div class="row">Troops: ${tr}</div>
        <div class="hint">Click a planet to send this fleet (it routes along lanes; collisions trigger battle).</div>
        ${btn('cancel', '', 'Cancel', true)}`;
    }
  }
  const p = planet(selPlanet);
  if (!p) return '<div class="hint">Click a planet.</div>';
  const owner = p.owner ?? 'null';
  const mine = p.owner === ME;
  const sec = data.sectors[p.sectorType ?? '']?.name ?? p.sectorType ?? '—';
  let h = `<h3 style="color:${COLOR[owner]}">${p.id}</h3>
    <div class="row">Owner: <b>${p.owner ? NAME[p.owner] : 'Neutral'}</b> · Sector: ${sec}</div>`;

  // buildings
  h += `<div class="sec">Buildings</div>`;
  if (p.buildings.length === 0) h += `<div class="row dim">none</div>`;
  for (const b of p.buildings) {
    const def = data.buildings[b.type];
    const max = def ? buildingMaxLevel(def) : 1;
    h += `<div class="row">${def?.name ?? b.type} <span class="dim">L${b.level}/${max} · hp ${floor(b.hp)}/${hpOfLevel(b.type, b.level)}</span>`;
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
        h += btn('build', t, `+${data.buildings[t]?.name ?? t} ${cost(c)}`, afford(c));
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
  if (act === 'cancel') {
    selFleet = null;
  } else if (act === 'selfleet') {
    selFleet = arg;
  } else if (act === 'build') {
    apply(order(s, buildBuilding(ME, selPlanet!, arg), s.time));
  } else if (act === 'upgrade') {
    apply(order(s, upgradeBuilding(ME, selPlanet!, arg), s.time));
  } else if (act === 'unit') {
    apply(order(s, buildUnit(ME, selPlanet!, arg, 1), s.time));
  } else if (act === 'launch') {
    apply(order(s, launchFleet(ME, arg), s.time));
  }
  lastPanelHtml = '';
  renderPanel();
});

// --- canvas input ------------------------------------------------------------

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ((ev.clientX - rect.left) / rect.width) * VW;
  const my = ((ev.clientY - rect.top) / rect.height) * VH;
  // hit a fleet?
  for (const f of Object.values(s.fleets)) {
    const mp = fleetPos(f);
    if (!mp) continue;
    const c = proj(mp);
    const fy = c.y - (f.location ? 26 : 0);
    if (Math.hypot(mx - c.x, my - fy) < 14 && f.owner === ME) {
      selFleet = f.id;
      selPlanet = f.location ?? selPlanet;
      lastPanelHtml = '';
      return;
    }
  }
  // hit a planet?
  for (const n of MAP) {
    const c = proj(n);
    if (Math.hypot(mx - c.x, my - c.y) < 22) {
      if (selFleet) {
        const f = s.fleets[selFleet];
        if (f && f.location !== n.id) apply(order(s, moveFleet(ME, selFleet, n.id), s.time));
        selFleet = null;
      }
      selPlanet = n.id;
      lastPanelHtml = '';
      return;
    }
  }
  selFleet = null;
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
    chip('🔩', kfmt(r.metal ?? 0), inc.metal ?? 0) +
    chip('🪙', kfmt(r.credits ?? 0), inc.credits ?? 0) +
    chip('🪐', String(worlds)) +
    chip('🚀', String(myFleets));
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

note('Welcome, Commander. Take FORGE & RELAY, then crack NEXUS and march on CRIMSON.');
requestAnimationFrame(frame);
