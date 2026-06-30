import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { economyModule } from './economy';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 1, defense: 1, speed: 1 }, upkeep: { credits: 8 } },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 },
  },
  events: {},
});
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ctx(now: number, timeScale?: number): Context {
  return timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };
}
function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function planet(
  id: string,
  owner: string | null,
  buildings: string[] = [],
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: buildings.map((type) => ({ type, level: 1, hp: 0 })),
    garrison: [],
    traits: [],
  };
}
function fleet(
  id: string,
  owner: string,
  location: string,
  units: Array<[string, number]>,
  opts: { orbit?: 'near'; bombarding?: boolean } = {},
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    traits: [],
    orbit: opts.orbit,
    bombarding: opts.bombarding,
  };
}
function stateWith(opts: {
  players?: Player[];
  planets?: Planet[];
  fleets?: Fleet[];
}): GameState {
  const s = createInitialState({ seed: 'eco2', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  return { ...s, players, planets, fleets };
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('economy module — timeScale affects production and upkeep', () => {
  it('doubles production and upkeep with timeScale ×2', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      planets: [planet('A', 'p1', ['mine'])],
      fleets: [fleet('f', 'p1', 'X', [['cruiser', 1]])],
    });
    // 1 real hour at ×2 = 2 game hours of production (20 metal) and 2/24 days of upkeep
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR, 2)));
    expect(r.state.players.p1?.resources.metal).toBe(20); // 10/h × 2h
    // Upkeep: 8/day × (2/24) = 8 × (1/12) ≈ 0.6667
    expect(r.state.players.p1?.resources.credits).toBeCloseTo(100 - 8 * (2 / 24));
  });
});

describe('economy module — bombardment freezes production', () => {
  it('halts production while a planet is bombarded', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1')],
      planets: [planet('A', 'p1', ['mine'])],
      fleets: [fleet('enemy', 'p2', 'A', [['cruiser', 1]], { orbit: 'near', bombarding: true })],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR)));
    // Planet A is bombarded → no production
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
  });

  it('still drains upkeep even while a planet is bombarded', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      planets: [planet('A', 'p1', ['mine'])],
      fleets: [
        fleet('enemy', 'p2', 'A', [['cruiser', 1]], { orbit: 'near', bombarding: true }),
        fleet('own', 'p1', 'X', [['cruiser', 1]]),
      ],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY)));
    // No production (bombarded), but upkeep still drains: 100 − 8
    expect(r.state.players.p1?.resources.credits).toBe(92);
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
  });
});

describe('economy module — zero/negative span is a no-op', () => {
  it('does not accrue production or drain upkeep for zero elapsed time', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 50 })],
      planets: [planet('A', 'p1', ['mine'])],
      fleets: [fleet('f', 'p1', 'X', [['cruiser', 1]])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(0)));
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
    expect(r.state.players.p1?.resources.credits).toBe(50);
  });
});

describe('economy module — fleet landing troops count as upkeep', () => {
  it('counts units in the fleet.landing array toward upkeep', () => {
    const kernel = createKernel([economyModule]);
    const f: Fleet = {
      id: 'f',
      owner: 'p1',
      location: 'X',
      movement: null,
      units: [{ unit: 'cruiser', count: 1 }],
      landing: [{ unit: 'cruiser', count: 1 }],
      traits: [],
    };
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      fleets: [f],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY)));
    // 2 cruisers total (1 in units + 1 in landing) × 8/day = 16
    expect(r.state.players.p1?.resources.credits).toBe(84);
  });
});

describe('economy module — unknown unit in upkeep is gracefully skipped', () => {
  it('ignores stacks with no matching unit definition', () => {
    const kernel = createKernel([economyModule]);
    const f: Fleet = {
      id: 'f',
      owner: 'p1',
      location: 'X',
      movement: null,
      units: [{ unit: 'nonexistent_ship', count: 5 }],
      traits: [],
    };
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      fleets: [f],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY)));
    // No crash, no upkeep charged (unit not in data)
    expect(r.state.players.p1?.resources.credits).toBe(100);
  });
});
