import { describe, it, expect } from 'vitest';
import { scanNodeThreats } from './threat';
import { createInitialState, type Fleet, type GameState, type Planet } from './gameState';
import { pairKey } from './diplomacy';
import { parseGameData, type GameData } from '../data/schemas';
import type { Context } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { deepFreeze } from '../util/clone';

// Minimal roster: one mobile hull so fleets have a base speed for ETA math.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    fighter: { faction: 'x', stats: { attack: 10, defense: 0, speed: 10, hp: 20 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
});
const HOUR = MS_PER_HOUR;
const NOW = 100 * HOUR;
const ctx: Context = { now: NOW, data };

// Chain map A—B—C, 100 map-units per lane. p1 owns A, so its identify coverage
// is {A, B} (IDENTIFY_HOPS = 1) — C sits beyond the fog line by construction.
function world(id: string, owner: string | null, x: number, links: string[]): Planet {
  return {
    id,
    owner,
    kind: 'planet',
    position: { x, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
    links,
  };
}
function fleet(id: string, owner: string, patch: Partial<Fleet>): Fleet {
  return {
    id,
    owner,
    location: null,
    movement: null,
    units: [{ unit: 'fighter', count: 2 }],
    traits: [],
    ...patch,
  };
}
function baseState(fleets: Fleet[], diplomacy?: Record<string, 'war' | 'peace'>): GameState {
  const s = createInitialState({ seed: 'thr', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const player = (id: string) => ({ id, name: id, faction: 'x', status: 'active' as const, resources: {} });
  return {
    ...s,
    time: NOW,
    planets: {
      A: world('A', 'p1', 0, ['B']),
      B: world('B', null, 100, ['A', 'C']),
      C: world('C', null, 200, ['B']),
    },
    fleets: f,
    players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
    ...(diplomacy ? { diplomacy } : {}),
  };
}

describe('scanNodeThreats — «враг близко» tripwire (ST-3.1)', () => {
  it('reports a hostile parked at the node as present, effective now', () => {
    const s = baseState([fleet('F1', 'p2', { location: 'A' })]);
    expect(scanNodeThreats(s, 'A', 'p1', ctx)).toEqual([
      { fleetId: 'F1', owner: 'p2', kind: 'present', eta: NOW },
    ]);
  });

  it('reports a final-leg approach as inbound with the EXACT leg arrival', () => {
    const s = baseState([
      fleet('F1', 'p2', {
        movement: { from: 'B', to: 'A', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 3 * HOUR },
      }),
    ]);
    const threats = scanNodeThreats(s, 'A', 'p1', ctx);
    expect(threats).toEqual([{ fleetId: 'F1', owner: 'p2', kind: 'inbound', eta: NOW + 3 * HOUR }]);
  });

  it('estimates a multi-hop journey: current leg exact + remaining hops at base speed ÷ timeScale', () => {
    // On C→B, 75% through (anchored to B — inside p1's fog line), then one more
    // hop B→A: 100 units at speed 10 = 10 game-hours, compressed by timeScale 2.
    const s = baseState([
      fleet('F1', 'p2', {
        movement: {
          from: 'C',
          to: 'B',
          departedAt: NOW - 3 * HOUR,
          arrivesAt: NOW + 1 * HOUR,
          path: ['A'],
          destination: 'A',
        },
      }),
    ]);
    const scaled: Context = { ...ctx, config: { timeScale: 2 } };
    const threats = scanNodeThreats(s, 'A', 'p1', scaled);
    expect(threats).toHaveLength(1);
    expect(threats[0]!.kind).toBe('inbound');
    expect(threats[0]!.eta).toBe(NOW + 1 * HOUR + (10 * HOUR) / 2);
  });

  it('is fog-honest: the same inbound journey is silent while the ship anchors beyond the fog line', () => {
    // Same C→B leg but only 25% through — the ship still anchors to C, which p1
    // does not identify (owned-world coverage reaches only 1 hop: A, B). The
    // Steward must not react to what its player could not see.
    const s = baseState([
      fleet('F1', 'p2', {
        movement: {
          from: 'C',
          to: 'B',
          departedAt: NOW - 1 * HOUR,
          arrivesAt: NOW + 3 * HOUR,
          path: ['A'],
          destination: 'A',
        },
      }),
    ]);
    expect(scanNodeThreats(s, 'A', 'p1', ctx)).toEqual([]);
  });

  it('ignores a hostile merely passing OUT along an incident lane (it bears on its own destination)', () => {
    const s = baseState([
      fleet('F1', 'p2', {
        movement: { from: 'A', to: 'B', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 1 * HOUR },
      }),
    ]);
    expect(scanNodeThreats(s, 'A', 'p1', ctx)).toEqual([]);
  });

  it('reports a mid-lane camper on an incident lane as nearby', () => {
    const s = baseState([fleet('F1', 'p2', { edge: { from: 'A', to: 'B', t: 0.4 } })]);
    expect(scanNodeThreats(s, 'A', 'p1', ctx)).toEqual([
      { fleetId: 'F1', owner: 'p2', kind: 'nearby', eta: NOW },
    ]);
  });

  it('filters by stance: a peace-pair fleet at the node is no threat; own fleets never are', () => {
    const s = baseState(
      [fleet('F1', 'p3', { location: 'A' }), fleet('F2', 'p1', { location: 'A' })],
      { [pairKey('p1', 'p3')]: 'peace' },
    );
    expect(scanNodeThreats(s, 'A', 'p1', ctx)).toEqual([]);
  });

  it('sorts soonest-first, ties broken by fleet id (deterministic)', () => {
    const inbound = (id: string): Fleet =>
      fleet(id, 'p2', {
        movement: { from: 'B', to: 'A', departedAt: NOW - 1 * HOUR, arrivesAt: NOW + 2 * HOUR },
      });
    const s = baseState([inbound('zz'), fleet('mm', 'p2', { location: 'A' }), inbound('aa')]);
    expect(scanNodeThreats(s, 'A', 'p1', ctx).map((t) => t.fleetId)).toEqual(['mm', 'aa', 'zz']);
  });

  it('is pure: a deep-frozen state scans without a throw', () => {
    const s = deepFreeze(baseState([fleet('F1', 'p2', { location: 'A' })]));
    expect(() => scanNodeThreats(s, 'A', 'p1', ctx)).not.toThrow();
  });
});
