import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { movementModule } from './movement';
import { captureOnArrivalModule } from './captureOnArrival';
import { createInitialState, type Fleet, type GameState, type Planet } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } } },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: {
    planet: { capturable: true, buildable: true, orbit: true },
    empty: { capturable: false, buildable: false, orbit: false },
  },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function planet(
  id: string,
  owner: string | null,
  x: number,
  opts: { kind?: string; garrison?: string[] } = {},
): Planet {
  const p: Planet = {
    id,
    owner,
    position: { x, y: 0 },
    resources: {},
    buildings: [],
    garrison: (opts.garrison ?? []).map((u) => ({ unit: u, count: 1 })),
    traits: [],
  };
  if (opts.kind) p.kind = opts.kind;
  return p;
}
function fleet(id: string, owner: string, location: string | null, units: string[] = ['scout']): Fleet {
  return { id, owner, location, movement: null, units: units.map((u) => ({ unit: u, count: 1 })), traits: [] };
}
function baseState(planets: Planet[], fleets: Fleet[]): GameState {
  const s = createInitialState({ seed: 'cap', version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, planets: p, fleets: f };
}
const move = (fleetId: string, to: string): Action => ({
  id: `m:${fleetId}:${to}`,
  type: 'fleet.move',
  playerId: 'p1',
  payload: { fleetId, to },
  issuedAt: 0,
});
const okApply = (r: ApplyResult): ApplyResult & { ok: true } => {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
};
const okAdvance = (r: AdvanceResult): AdvanceResult & { ok: true } => {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
};

/** A→B are 30 apart and lane-connected; scout speed 10 → 3h. Move F then advance.
 *  Optional `diplomacy` seeds pairwise stances (default FFA = war). */
function arriveAt(
  b: Planet,
  extraFleets: Fleet[] = [],
  diplomacy?: Record<string, 'war' | 'peace' | 'pact' | 'alliance'>,
): { state: GameState; events: { type: string }[] } {
  const a = planet('A', 'p1', 0, { kind: 'planet' });
  a.links = ['B'];
  b.links = ['A'];
  const kernel = createKernel([movementModule, captureOnArrivalModule]);
  let state = baseState([a, b], [fleet('F', 'p1', 'A'), ...extraFleets]);
  if (diplomacy) state = { ...state, diplomacy };
  const dep = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
  const arr = okAdvance(kernel.advanceTo(dep.state, ctx(3 * HOUR)));
  return { state: arr.state, events: arr.events };
}

describe('captureOnArrival module (map-roadmap.md M2.2)', () => {
  it('captures an undefended, uncontested, capturable neutral on arrival', () => {
    const { state, events } = arriveAt(planet('B', null, 30, { kind: 'planet' }));
    expect(state.planets.B!.owner).toBe('p1');
    expect(events.some((e) => e.type === 'planet.captured')).toBe(true);
  });

  it('does NOT capture an empty sector (kind not capturable)', () => {
    const { state } = arriveAt(planet('B', null, 30, { kind: 'empty' }));
    expect(state.planets.B!.owner).toBeNull();
  });

  it('does NOT capture a defended sector (live garrison → needs a real assault)', () => {
    const { state } = arriveAt(planet('B', null, 30, { kind: 'planet', garrison: ['scout'] }));
    expect(state.planets.B!.owner).toBeNull();
  });

  it('does NOT capture a contested sector (an enemy fleet with units is present)', () => {
    const { state } = arriveAt(planet('B', null, 30, { kind: 'planet' }), [fleet('E', 'p2', 'B')]);
    expect(state.planets.B!.owner).toBeNull();
  });

  it('captures a sector with no kind (graceful default = capturable)', () => {
    const { state } = arriveAt(planet('B', null, 30)); // no kind → permissive default
    expect(state.planets.B!.owner).toBe('p1');
  });

  it('captures an at-WAR enemy undefended world (default FFA stance is war)', () => {
    const { state } = arriveAt(planet('B', 'p2', 30, { kind: 'planet' }));
    expect(state.planets.B!.owner).toBe('p1');
  });

  it('does NOT walk into an allied / at-peace undefended world (needs a declared war)', () => {
    const { state, events } = arriveAt(planet('B', 'p2', 30, { kind: 'planet' }), [], {
      'p1|p2': 'alliance',
    });
    expect(state.planets.B!.owner).toBe('p2'); // stays the ally's
    expect(events.some((e) => e.type === 'planet.captured')).toBe(false);
  });
});
