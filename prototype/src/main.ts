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

const COLOR: Record<string, string> = { p1: '#38bdf8', p2: '#fb7185', null: '#64748b' };
const SECTOR_RING: Record<string, string> = {
  empty_space: '#1e3a5f',
  asteroid_field: '#5b4636',
  nebula: '#4c2a5a',
};
const SHIP_UNITS = ['scout', 'cruiser', 'siege'];
const BUILDABLE = ['mine', 'refinery', 'barracks', 'fort'];
const BUILD_UNITS = ['marine', 'cruiser', 'scout', 'siege'];
const ME = 'p1';

// --- state -------------------------------------------------------------------

let s: GameState = newGame();
let speed = 2; // game-hours per real second (0 = paused)
let banner: string | null = null;
let selFleet: string | null = null;
let selPlanet: string | null = 'HOME';
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

// --- helpers -----------------------------------------------------------------

const planet = (id: string | null | undefined): Planet | undefined => (id ? s.planets[id] : undefined);
const isShip = (u: string) => !data.units[u]?.traits.includes('ground');
const floor = Math.floor;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

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
  cx.clearRect(0, 0, canvas.width, canvas.height);
  cx.fillStyle = '#0a0f1e';
  cx.fillRect(0, 0, canvas.width, canvas.height);
  // starfield
  cx.fillStyle = 'rgba(255,255,255,0.20)';
  for (let i = 0; i < 90; i++) {
    const x = (i * 137.5) % canvas.width;
    const y = (i * 83.3) % canvas.height;
    cx.fillRect(x, y, 1, 1);
  }
  // lanes
  cx.strokeStyle = 'rgba(120,150,200,0.25)';
  cx.lineWidth = 1.5;
  for (const n of MAP) {
    for (const l of n.links) {
      if (n.id < l) {
        const b = s.planets[l]?.position;
        if (b) {
          cx.beginPath();
          cx.moveTo(n.x, n.y);
          cx.lineTo(b.x, b.y);
          cx.stroke();
        }
      }
    }
  }
  // battles (pulse)
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  for (const b of Object.values(s.battles)) {
    const p = s.planets[b.location]?.position;
    if (!p) continue;
    cx.strokeStyle = `rgba(251,191,36,${0.4 + 0.5 * pulse})`;
    cx.lineWidth = 3;
    cx.beginPath();
    cx.arc(p.x, p.y, 30 + 6 * pulse, 0, Math.PI * 2);
    cx.stroke();
  }
  // planets
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    const owner = p.owner ?? 'null';
    if (selPlanet === n.id) {
      cx.strokeStyle = '#fde68a';
      cx.lineWidth = 3;
      cx.beginPath();
      cx.arc(n.x, n.y, 28, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.fillStyle = SECTOR_RING[p.sectorType ?? ''] ?? '#222';
    cx.beginPath();
    cx.arc(n.x, n.y, 23, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = COLOR[owner];
    cx.beginPath();
    cx.arc(n.x, n.y, 17, 0, Math.PI * 2);
    cx.fill();
    // fort ring
    const fort = p.buildings.find((b) => b.type === 'fort');
    if (fort) {
      cx.strokeStyle = '#e2e8f0';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.arc(n.x, n.y, 20, 0, Math.PI * 2);
      cx.stroke();
      cx.fillStyle = '#0a0f1e';
      cx.font = 'bold 9px monospace';
      cx.textAlign = 'center';
      cx.fillText('L' + fort.level, n.x, n.y - 24);
    }
    // building dots
    const blds = p.buildings.filter((b) => b.type !== 'fort');
    blds.forEach((b, i) => {
      cx.fillStyle = b.type === 'mine' ? '#cbd5e1' : b.type === 'refinery' ? '#fcd34d' : '#94a3b8';
      cx.fillRect(n.x - 8 + i * 8, n.y + 26, 5, 5);
    });
    // garrison strength
    const g = p.garrison.reduce((a, st) => a + st.count, 0);
    cx.fillStyle = '#e2e8f0';
    cx.font = 'bold 11px monospace';
    cx.textAlign = 'center';
    if (g > 0) cx.fillText('⛨' + g, n.x, n.y + 4);
    // label
    cx.fillStyle = '#cbd5e1';
    cx.font = '11px monospace';
    cx.fillText(n.id, n.x, n.y + 40);
  }
  // fleets
  for (const f of Object.values(s.fleets)) {
    const pos = fleetPos(f);
    if (!pos) continue;
    const ships = f.units.reduce((a, st) => a + st.count, 0);
    const troops = (f.landing ?? []).reduce((a, st) => a + st.count, 0);
    cx.save();
    cx.translate(pos.x, pos.y - (f.location ? 30 : 0));
    if (selFleet === f.id) {
      cx.strokeStyle = '#fde68a';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.arc(0, 0, 12, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.fillStyle = COLOR[f.owner];
    cx.beginPath();
    cx.moveTo(0, -8);
    cx.lineTo(7, 7);
    cx.lineTo(-7, 7);
    cx.closePath();
    cx.fill();
    cx.fillStyle = '#e2e8f0';
    cx.font = 'bold 10px monospace';
    cx.textAlign = 'center';
    cx.fillText(`${ships}${troops ? '+' + troops : ''}`, 0, 20);
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
  const mx = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const my = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  // hit a fleet?
  for (const f of Object.values(s.fleets)) {
    const pos = fleetPos(f);
    if (!pos) continue;
    const fy = pos.y - (f.location ? 30 : 0);
    if (Math.hypot(mx - pos.x, my - fy) < 14 && f.owner === ME) {
      selFleet = f.id;
      selPlanet = f.location ?? selPlanet;
      lastPanelHtml = '';
      return;
    }
  }
  // hit a planet?
  for (const n of MAP) {
    if (Math.hypot(mx - n.x, my - n.y) < 24) {
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
  // top bar
  const d = floor(s.time / DAY) + 1;
  const h = floor((s.time % DAY) / HOUR);
  clock.textContent = `Day ${d} · ${String(h).padStart(2, '0')}:00`;
  const r = s.players[ME]?.resources ?? {};
  purse.textContent = `⬡ ${floor(r.metal ?? 0)} metal   ◎ ${floor(r.credits ?? 0)} credits`;
  logEl.innerHTML = logLines.map((l) => `<div>${l}</div>`).join('');
  if (banner) {
    bannerEl.textContent = banner;
    bannerEl.style.display = 'block';
  }
  requestAnimationFrame(frame);
}

note('Welcome, Commander. Take FORGE & RELAY, then crack NEXUS and march on CRIMSON.');
requestAnimationFrame(frame);
