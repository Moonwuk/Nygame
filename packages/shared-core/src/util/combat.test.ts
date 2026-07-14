import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import type { Fleet, UnitStack } from '../state/gameState';
import { damageUnits, laneOccupancy, posAt } from './combat';

// Front line takes hits first (tier order), then the rear. cruiser: 40 hp,
// shielded frigate: 20 hp + 10 shield/ship, healer sits in the rear line.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 10, defense: 8, speed: 6, hp: 40 }, line: 'front' },
    frigate: {
      faction: 'x',
      stats: { attack: 5, defense: 5, speed: 8, hp: 20, shield: 10 },
      line: 'front',
    },
    healer: { faction: 'x', stats: { attack: 0, defense: 2, speed: 5, hp: 10 }, line: 'rear' },
    ghost: { faction: 'x', stats: { attack: 1, defense: 1, speed: 1, hp: 0 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
});

const stack = (unit: string, count: number, extra: Partial<UnitStack> = {}): UnitStack => ({
  unit,
  count,
  ...extra,
});

describe('damageUnits — the pure damage model', () => {
  it('kills whole ships as the pool drops and keeps the last damaged ship alive', () => {
    // 3 cruisers = 120 hp pool; 95 damage leaves 25 → ceil(25/40) = 1 ship at 25 hp.
    const { survivors, deaths } = damageUnits([stack('cruiser', 3)], 95, data);
    expect(survivors).toEqual([{ unit: 'cruiser', count: 1, hp: 25 }]);
    expect(deaths).toEqual([{ unit: 'cruiser', count: 2 }]);
  });

  it('partial damage persists in the pool without killing anyone', () => {
    const { survivors, deaths } = damageUnits([stack('cruiser', 2)], 30, data);
    expect(survivors).toEqual([{ unit: 'cruiser', count: 2, hp: 50 }]);
    expect(deaths).toEqual([]);
  });

  it('a wiped stack disappears from the survivors', () => {
    const { survivors, deaths } = damageUnits([stack('cruiser', 2)], 80, data);
    expect(survivors).toEqual([]);
    expect(deaths).toEqual([{ unit: 'cruiser', count: 2 }]);
  });

  it('fills the FRONT line before the rear (tier order), sorted by unit id inside a tier', () => {
    const units = [stack('healer', 2), stack('cruiser', 1)];
    // 40 damage exactly kills the cruiser; the rear healers are untouched.
    const { survivors, deaths } = damageUnits(units, 40, data);
    expect(deaths).toEqual([{ unit: 'cruiser', count: 1 }]);
    expect(survivors).toEqual([{ unit: 'healer', count: 2 }]);
    // Overflow spills into the rear next.
    const spill = damageUnits([stack('healer', 2), stack('cruiser', 1)], 50, data);
    expect(spill.deaths).toEqual([
      { unit: 'cruiser', count: 1 },
      { unit: 'healer', count: 1 },
    ]);
  });

  it('shields absorb first and never kill; dead ships take their shields along', () => {
    // 2 frigates: 20 shield + 40 hull. 25 damage: shield soaks 20, hull takes 5.
    const soaked = damageUnits([stack('frigate', 2)], 25, data);
    expect(soaked.survivors).toEqual([{ unit: 'frigate', count: 2, hp: 35, shieldHp: 0 }]);
    expect(soaked.deaths).toEqual([]);
    // 45 damage: 20 shield + 25 hull → one frigate dies; the shield pool is capped
    // at the survivor's capacity (here it is already 0).
    const killed = damageUnits([stack('frigate', 2)], 45, data);
    expect(killed.survivors).toEqual([{ unit: 'frigate', count: 1, hp: 15, shieldHp: 0 }]);
    expect(killed.deaths).toEqual([{ unit: 'frigate', count: 1 }]);
  });

  it('an hp=0 unit def falls back to a 1-hp ship instead of dividing by zero', () => {
    const { survivors, deaths } = damageUnits([stack('ghost', 3)], 2, data);
    expect(deaths).toEqual([{ unit: 'ghost', count: 2 }]);
    expect(survivors).toEqual([{ unit: 'ghost', count: 1, hp: 1 }]);
  });

  it('a stack whose unit is missing from the data is skipped untouched', () => {
    const { survivors, deaths } = damageUnits([stack('unknown', 5)], 100, data);
    expect(survivors).toEqual([{ unit: 'unknown', count: 5 }]);
    expect(deaths).toEqual([]);
  });
});

describe('laneOccupancy / posAt — the lane geometry', () => {
  const moving = (from: string, to: string, extra: Partial<NonNullable<Fleet['movement']>> = {}): Fleet => ({
    id: 'F',
    owner: 'p1',
    location: null,
    movement: { from, to, departedAt: 0, arrivesAt: 100, ...extra },
    units: [stack('cruiser', 1)],
    traits: [],
  });

  it('normalizes an opposite-direction leg onto the canonical lo→hi axis', () => {
    // B→A travels the same lane as A→B, mirrored: s runs 1→0.
    const occ = laneOccupancy(moving('B', 'A'))!;
    expect(occ).toMatchObject({ lo: 'A', hi: 'B', s0: 1, s1: 0, t0: 0, t1: 100, moving: true });
    expect(posAt(occ, 0)).toBe(1);
    expect(posAt(occ, 50)).toBe(0.5);
    expect(posAt(occ, 100)).toBe(0);
  });

  it('honors a leg confined to a [startT, endT] sub-segment', () => {
    const occ = laneOccupancy(moving('A', 'B', { startT: 0.25, endT: 0.75 }))!;
    expect(posAt(occ, 0)).toBe(0.25);
    expect(posAt(occ, 100)).toBe(0.75);
  });

  it('a degenerate zero-length leg yields no segment', () => {
    expect(laneOccupancy(moving('A', 'B', { arrivesAt: 0 }))).toBeNull();
  });

  it('a parked fleet occupies one constant point over an unbounded window', () => {
    const parked: Fleet = {
      id: 'F',
      owner: 'p1',
      location: null,
      movement: null,
      edge: { from: 'B', to: 'A', t: 0.3 }, // reversed → canonical s = 0.7
      units: [stack('cruiser', 1)],
      traits: [],
    };
    const occ = laneOccupancy(parked)!;
    expect(occ).toMatchObject({ lo: 'A', hi: 'B', s0: 0.7, s1: 0.7, moving: false });
    expect(posAt(occ, -1e9)).toBe(0.7);
    expect(posAt(occ, 1e9)).toBe(0.7);
  });

  it('a fleet at a node (or gone) is not on any lane', () => {
    const atNode: Fleet = {
      id: 'F',
      owner: 'p1',
      location: 'A',
      movement: null,
      units: [],
      traits: [],
    };
    expect(laneOccupancy(atNode)).toBeNull();
  });
});
