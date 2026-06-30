import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createKernel } from '../kernel/kernel';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, Context, DomainEvent } from '../action/types';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';

/**
 * Playable skirmish demo — wires the real base modules over the map and prints a
 * narrated timeline; under VD_DEMO it also renders the run as an SVG. Run it with:
 *
 *   VD_DEMO=1 pnpm exec vitest run skirmish
 *
 * Scenario: the Blue fleet crosses neutral space toward the Red homeworld; the
 * Red fleet sorties to intercept. They clash on a lane node (collision → battle),
 * Blue wins and takes the node, then pushes on and storms the Red bastion
 * (orbital → ground capture). Everything runs on real-time `advanceTo`.
 */

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 20, defense: 12, speed: 5, hp: 40 },
      line: 'front',
      upkeep: { credits: 10 },
    },
    marine: {
      faction: 'x',
      stats: { attack: 20, defense: 10, speed: 5, hp: 40 },
      line: 'front',
      upkeep: { credits: 5 },
    },
    militia: {
      faction: 'x',
      stats: { attack: 5, defense: 8, speed: 1, hp: 15 },
      line: 'front',
      upkeep: { credits: 3 },
    },
  },
  factions: {},
  buildings: { mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 } },
  events: {},
  sectors: {
    empty_space: { name: 'Empty Space', speedBonus: 0.15 },
    asteroid_field: { name: 'Asteroid Field', speedBonus: -0.25, hpBonus: 0.1 },
    nebula: { name: 'Nebula', speedBonus: -0.1, hpBonus: 0.05 },
  },
});

const ctx = (now: number): Context => ({ now, data });

interface Node {
  id: string;
  owner: string | null;
  x: number;
  y: number;
  links: string[];
  terrain?: string;
  garrison?: Array<[string, number]>;
  buildings?: string[];
}

// The map: nodes (planets) joined by star lanes, each with a sector terrain.
const MAP: Node[] = [
  {
    id: 'HOME',
    owner: 'p1',
    x: 15,
    y: 35,
    links: ['FORGE', 'RELAY'],
    terrain: 'empty_space',
    buildings: ['mine'],
  },
  {
    id: 'FORGE',
    owner: null,
    x: 40,
    y: 18,
    links: ['HOME', 'NEXUS'],
    terrain: 'asteroid_field',
  },
  { id: 'RELAY', owner: null, x: 40, y: 52, links: ['HOME', 'NEXUS'], terrain: 'empty_space' },
  {
    id: 'NEXUS',
    owner: null,
    x: 65,
    y: 35,
    links: ['FORGE', 'RELAY', 'BASTION', 'OUTPOST'],
    terrain: 'nebula',
  },
  {
    id: 'OUTPOST',
    owner: 'p2',
    x: 95,
    y: 18,
    links: ['NEXUS', 'BASTION'],
    terrain: 'asteroid_field',
  },
  {
    id: 'BASTION',
    owner: 'p2',
    x: 100,
    y: 52,
    links: ['NEXUS', 'OUTPOST'],
    garrison: [['militia', 3]],
    buildings: ['mine'],
  },
];

function planet(n: Node): Planet {
  return {
    id: n.id,
    owner: n.owner,
    position: { x: n.x, y: n.y },
    links: n.links,
    terrain: n.terrain,
    resources: {},
    buildings: (n.buildings ?? []).map((type) => ({ type, level: 1, hp: 0 })),
    garrison: (n.garrison ?? []).map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function fleet(
  id: string,
  owner: string,
  location: string,
  units: Array<[string, number]>,
  landing?: Array<[string, number]>,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    landing: landing?.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}

function buildState(): GameState {
  const s = createInitialState({ seed: 'skirmish', version: { data: '0.1.0', manifest: '1' } });
  const planets: Record<string, Planet> = {};
  for (const n of MAP) planets[n.id] = planet(n);
  const fleets: Record<string, Fleet> = {
    BLUE: fleet('BLUE', 'p1', 'HOME', [['cruiser', 3]], [['marine', 2]]),
    RED: fleet('RED', 'p2', 'BASTION', [['cruiser', 2]]),
  };
  const players: Record<string, Player> = {
    p1: {
      id: 'p1',
      name: 'Blue',
      faction: 'vanguard',
      status: 'active',
      resources: { credits: 500 },
    },
    p2: {
      id: 'p2',
      name: 'Red',
      faction: 'vanguard',
      status: 'active',
      resources: { credits: 500 },
    },
  };
  return { ...s, players, planets, fleets };
}

const move = (fleetId: string, to: string, playerId: string): Action => ({
  id: `s:${playerId}:1`,
  type: 'fleet.move',
  playerId,
  payload: { fleetId, to },
  issuedAt: 0,
});
const assault = (fleetId: string, playerId: string): Action => ({
  id: `s:${playerId}:3`,
  type: 'fleet.assault',
  playerId,
  payload: { fleetId },
  issuedAt: 0,
});

// Events worth narrating, with a one-line formatter.
const NARRATED = new Set([
  'fleet.departed',
  'fleet.arrived',
  'battle.started',
  'battle.resolved',
  'planet.captured',
  'fleet.destroyed',
]);
function describeEvent(e: DomainEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'fleet.departed':
      return `${p.fleetId} sets out for ${p.to}`;
    case 'fleet.arrived':
      return `${p.fleetId} arrives at ${p.at}`;
    case 'battle.started':
      return `battle at ${p.location} (${p.phase})`;
    case 'battle.resolved':
      return `battle at ${p.location} won by ${p.winner ?? 'nobody'} after ${p.rounds} round(s)`;
    case 'planet.captured':
      return `${p.owner} captures ${p.planetId}`;
    case 'fleet.destroyed':
      return `${p.fleetId} (${p.owner}) destroyed`;
    default:
      return null;
  }
}

interface Frame {
  hour: number;
  state: GameState;
}

function runSkirmish(): { timeline: string[]; frames: Frame[]; final: GameState } {
  const kernel = createKernel([economyModule, movementModule, combatModule, sectorModule]);
  let state = buildState();
  const timeline: string[] = [];
  const frames: Frame[] = [];

  const record = (events: DomainEvent[], hour: number) => {
    for (const e of events) {
      if (!NARRATED.has(e.type)) continue;
      const text = describeEvent(e);
      if (text) timeline.push(`t=${String(hour).padStart(2)}h  ${text}`);
    }
  };
  const apply = (action: Action, hour: number) => {
    const r = kernel.applyAction(state, action, ctx(hour * HOUR));
    if (!r.ok) throw new Error(`order rejected: ${r.code}`);
    state = r.state;
    record(r.events, hour);
  };
  // Non-throwing variant for the reactive "player" (timing-dependent orders).
  const tryOrder = (action: Action, hour: number): boolean => {
    const r = kernel.applyAction(state, action, ctx(hour * HOUR));
    if (!r.ok) return false;
    state = r.state;
    record(r.events, hour);
    return true;
  };

  // t=0: both sides move on NEXUS, the central junction.
  apply(move('BLUE', 'NEXUS', 'p1'), 0);
  apply(move('RED', 'NEXUS', 'p2'), 0);
  frames.push({ hour: 0, state });

  const END = 40;
  let pushedOn = false;
  // Reactive "player" for Blue: storm whatever hostile world it sits over
  // (descend to the near orbit, then land), and once NEXUS is ours, march on.
  const blueOrder = (hour: number) => {
    const blue = state.fleets.BLUE;
    if (!blue || blue.location == null || blue.movement || blue.battleId) return;
    const here = state.planets[blue.location];
    if (!here) return;
    const enemyHere = Object.values(state.fleets).some(
      (f) => f.owner !== 'p1' && f.location === blue.location && f.units.some((s) => s.count > 0),
    );
    if (enemyHere) return; // let the auto orbital battle settle first
    if (here.owner !== 'p1') {
      tryOrder(assault('BLUE', 'p1'), hour);
      return;
    }
    if (blue.location === 'NEXUS' && !pushedOn) {
      if (tryOrder(move('BLUE', 'BASTION', 'p1'), hour)) {
        timeline.push(`t=${String(hour).padStart(2)}h  Blue presses on toward BASTION`);
        pushedOn = true;
      }
    }
  };

  for (let hour = 1; hour <= END; hour++) {
    const r = kernel.advanceTo(state, ctx(hour * HOUR));
    if (!r.ok) throw new Error(`advance failed: ${r.code}`);
    state = r.state;
    record(r.events, hour);

    blueOrder(hour);

    if ([8, 12, 16, 22, 32].includes(hour)) frames.push({ hour, state });
  }

  // Final economy snapshot — production accrued and upkeep paid over the run.
  for (const pid of ['p1', 'p2']) {
    const res = state.players[pid]?.resources ?? {};
    const parts = Object.entries(res).map(([k, v]) => `${k} ${Math.round(v)}`);
    timeline.push(`--  ${pid} treasury: ${parts.join(', ')}`);
  }

  return { timeline, frames, final: state };
}

// --- SVG rendering (opt-in) --------------------------------------------------

const COLORS: Record<string, string> = { p1: '#3b82f6', p2: '#ef4444' };
const ownerColor = (owner: string | null): string =>
  owner ? (COLORS[owner] ?? '#9ca3af') : '#6b7280';
const sx = (x: number): number => (x - 5) * 3.4 + 14;
const sy = (y: number): number => (y - 10) * 3.4 + 30;

function fleetPos(state: GameState, f: Fleet, tMs: number): { x: number; y: number } | null {
  if (f.movement) {
    const a = state.planets[f.movement.from]?.position;
    const b = state.planets[f.movement.to]?.position;
    if (!a || !b) return null;
    const span = f.movement.arrivesAt - f.movement.departedAt;
    const k = span > 0 ? Math.min(1, Math.max(0, (tMs - f.movement.departedAt) / span)) : 0;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
  return f.location ? (state.planets[f.location]?.position ?? null) : null;
}
const unitCount = (f: Fleet): number => f.units.reduce((n, s) => n + s.count, 0);

function renderFrame(frame: Frame, dx: number, dy: number): string {
  const { state } = frame;
  const parts: string[] = [`<g transform="translate(${dx},${dy})">`];
  parts.push(`<rect width="392" height="208" rx="8" fill="#0b1020" stroke="#26304d"/>`);
  parts.push(
    `<text x="12" y="22" fill="#cbd5e1" font-size="14" font-family="monospace">t = ${frame.hour}h</text>`,
  );

  const seen = new Set<string>();
  for (const p of Object.values(state.planets)) {
    for (const l of p.links ?? []) {
      const key = [p.id, l].sort().join('-');
      const q = state.planets[l];
      if (seen.has(key) || !q) continue;
      seen.add(key);
      parts.push(
        `<line x1="${sx(p.position.x)}" y1="${sy(p.position.y)}" x2="${sx(q.position.x)}" y2="${sy(q.position.y)}" stroke="#26304d" stroke-width="2"/>`,
      );
    }
  }
  for (const b of Object.values(state.battles)) {
    const p = state.planets[b.location]?.position;
    if (p)
      parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="16" fill="#f59e0b" opacity="0.35"/>`);
  }
  for (const p of Object.values(state.planets)) {
    parts.push(
      `<circle cx="${sx(p.position.x)}" cy="${sy(p.position.y)}" r="9" fill="${ownerColor(p.owner)}" stroke="#0b1020" stroke-width="2"/>`,
    );
    parts.push(
      `<text x="${sx(p.position.x)}" y="${sy(p.position.y) - 13}" fill="#94a3b8" font-size="10" font-family="monospace" text-anchor="middle">${p.id}</text>`,
    );
    if (p.terrain) {
      const label = p.terrain.replace('_field', '').replace('_space', '');
      parts.push(
        `<text x="${sx(p.position.x)}" y="${sy(p.position.y) + 20}" fill="#64748b" font-size="9" font-family="monospace" text-anchor="middle">${label}</text>`,
      );
    }
  }
  for (const f of Object.values(state.fleets)) {
    const pos = fleetPos(state, f, frame.hour * HOUR);
    if (!pos) continue;
    parts.push(
      `<rect x="${sx(pos.x) - 6}" y="${sy(pos.y) - 6}" width="12" height="12" rx="2" fill="${ownerColor(f.owner)}" stroke="#e2e8f0" stroke-width="1.5"/>`,
    );
    parts.push(
      `<text x="${sx(pos.x) + 10}" y="${sy(pos.y) + 4}" fill="#e2e8f0" font-size="10" font-family="monospace">${f.id}·${unitCount(f)}</text>`,
    );
  }
  parts.push('</g>');
  return parts.join('\n');
}

function renderSvg(frames: Frame[]): string {
  const cols = 2;
  const fw = 392 + 16;
  const fh = 208 + 16;
  const rows = Math.ceil(frames.length / cols);
  const w = cols * fw + 8;
  const h = rows * fh + 40;
  const body = frames
    .map((f, i) => renderFrame(f, 12 + (i % cols) * fw, 44 + Math.floor(i / cols) * fh))
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#060912"/>`,
    `<text x="16" y="28" fill="#e2e8f0" font-size="18" font-family="monospace">Void Dominion — skirmish (blue p1 vs red p2)</text>`,
    body,
    `</svg>`,
  ].join('\n');
}

// --- the run -----------------------------------------------------------------

describe('demo skirmish — map, paths, movement and collisions (GDD §1, §7)', () => {
  it('Blue routes across the map, clashes with Red, and captures two worlds', () => {
    const { timeline, frames, final } = runSkirmish();

    if (process.env.VD_DEMO) {
      console.log(['', '=== Skirmish timeline ===', ...timeline, ''].join('\n'));
      const here = path.dirname(fileURLToPath(import.meta.url));
      const outDir = path.resolve(here, '../../../../examples');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'skirmish.svg'), renderSvg(frames), 'utf8');
    }

    // Verify the whole pipeline played out.
    expect(final.planets.NEXUS?.owner).toBe('p1'); // won the interception, took the junction
    expect(final.planets.BASTION?.owner).toBe('p1'); // stormed the Red bastion
    expect(final.fleets.RED).toBeUndefined(); // Red fleet destroyed in the clash
    expect(timeline.some((l) => l.includes('battle at NEXUS'))).toBe(true);
  });
});
