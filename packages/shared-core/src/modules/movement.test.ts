import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { movementModule } from './movement';
import { economyModule } from './economy';
import { combatModule } from './combat';
import { createInitialState, type Fleet, type GameState, type Planet } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 5, hp: 40 } },
  },
  factions: {},
  buildings: { mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 } },
  events: {},
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function planet(
  id: string,
  owner: string | null,
  x: number,
  y: number,
  buildings: string[] = [],
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    resources: { metal: 0 },
    buildings: buildings.map((type) => ({ type, level: 1, hp: 0 })),
    garrison: [],
    traits: [],
  };
}
function fleet(id: string, owner: string, location: string | null, units: string[]): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map((u) => ({ unit: u, count: 1 })),
    traits: [],
  };
}
function baseState(planets: Planet[], fleets: Fleet[], time = 0): GameState {
  const s = createInitialState({ seed: 'mov', version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, time, planets: p, fleets: f };
}
function move(fleetId: string, to: string, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'fleet.move',
    playerId,
    payload: { fleetId, to },
    issuedAt: 0,
  };
}
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

// A→B is 30 units apart and lane-connected; scout speed 10 → 3h.
const fieldAB = () => {
  const a = planet('A', 'p1', 0, 0, ['mine']);
  const b = planet('B', 'p1', 30, 0);
  a.links = ['B'];
  b.links = ['A'];
  return [a, b];
};

// A(0,0) — B(30,0) — C(60,0), a straight 3-node lane; scout speed 10 → 3h/hop.
function chainABC(): Planet[] {
  const a = planet('A', 'p1', 0, 0);
  const b = planet('B', null, 30, 0);
  const c = planet('C', null, 60, 0);
  a.links = ['B'];
  b.links = ['A', 'C'];
  c.links = ['B'];
  return [a, b, c];
}

describe('movement module — orders & validation (OWASP A01)', () => {
  it('departs a fleet and schedules its arrival', () => {
    const kernel = createKernel([movementModule]);
    const state = baseState(fieldAB(), [fleet('F', 'p1', 'A', ['scout'])]);
    const r = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));

    const f = r.state.fleets.F;
    expect(f?.location).toBe(null);
    expect(f?.movement?.to).toBe('B');
    expect(f?.movement?.arrivesAt).toBe(3 * HOUR);
    expect(r.state.scheduled.some((e) => e.type === 'fleet.arrival')).toBe(true);
    expect(r.events.map((e) => e.type)).toContain('fleet.departed');
  });

  it('uses the slowest unit for fleet speed', () => {
    const kernel = createKernel([movementModule]);
    const state = baseState(fieldAB(), [fleet('F', 'p1', 'A', ['scout', 'cruiser'])]);
    const r = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
    expect(r.state.fleets.F?.movement?.arrivesAt).toBe(6 * HOUR); // cruiser speed 5 → 30/5
  });

  it('lets the fleet.speed hook modify travel time (computeSpeed pipeline)', () => {
    const warp: GameModule = {
      id: 'warp',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('fleet.speed', (cur) => cur * 2);
      },
    };
    const kernel = createKernel([movementModule, warp]);
    const state = baseState(fieldAB(), [fleet('F', 'p1', 'A', ['scout'])]);
    const r = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
    expect(r.state.fleets.F?.movement?.arrivesAt).toBe(1.5 * HOUR); // speed 20 → 30/20
  });

  it('rejects bad and unauthorized orders', () => {
    const kernel = createKernel([movementModule]);
    const planets = fieldAB();
    const fleets = [fleet('F', 'p1', 'A', ['scout']), fleet('E', 'enemy', 'A', ['scout'])];
    const st = baseState(planets, fleets);

    expect(errCode(kernel.applyAction(st, { ...move('F', 'B'), payload: {} }, ctx(0)))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(st, move('ghost', 'B'), ctx(0)))).toBe('E_NO_FLEET');
    expect(errCode(kernel.applyAction(st, move('E', 'B'), ctx(0)))).toBe('E_FORBIDDEN');
    expect(errCode(kernel.applyAction(st, move('F', 'ZZZ'), ctx(0)))).toBe('E_NO_DESTINATION');
    expect(errCode(kernel.applyAction(st, move('F', 'A'), ctx(0)))).toBe('E_SAME_LOCATION');
  });

  it('rejects moving a fleet that is already in transit', () => {
    const kernel = createKernel([movementModule]);
    const moving = fleet('F', 'p1', null, ['scout']);
    moving.movement = { from: 'A', to: 'B', departedAt: 0, arrivesAt: 10 * HOUR };
    const st = baseState(fieldAB(), [moving]);
    expect(errCode(kernel.applyAction(st, move('F', 'B'), ctx(0)))).toBe('E_FLEET_BUSY');
  });

  it('rejects an immobile (empty) fleet', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(fieldAB(), [fleet('F', 'p1', 'A', [])]);
    expect(errCode(kernel.applyAction(st, move('F', 'B'), ctx(0)))).toBe('E_FLEET_IMMOBILE');
  });

  it('does not mutate the input state', () => {
    const kernel = createKernel([movementModule]);
    const state = deepFreeze(baseState(fieldAB(), [fleet('F', 'p1', 'A', ['scout'])]));
    okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
    expect(state.fleets.F?.location).toBe('A'); // input frozen & untouched
  });
});

describe('movement + economy — real-time end to end', () => {
  it('a fleet is in transit for real hours while planets keep producing', () => {
    const kernel = createKernel([economyModule, movementModule]);
    const state: GameState = {
      ...baseState(fieldAB(), [fleet('F', 'p1', 'A', ['scout'])]),
      players: { p1: { id: 'p1', name: 'Blue', faction: 'x', status: 'active', resources: {} } },
    };

    // Server flow: apply the order at t=0 …
    const departed = okApply(kernel.applyAction(state, move('F', 'B'), ctx(0)));
    expect(departed.state.fleets.F?.location).toBe(null);

    // … then the world runs forward to the arrival instant (3h).
    const arrived = kernel.advanceTo(departed.state, ctx(3 * HOUR));
    if (!arrived.ok) throw new Error(arrived.code);

    expect(arrived.state.fleets.F?.location).toBe('B');
    expect(arrived.state.fleets.F?.movement).toBe(null);
    expect(arrived.events.map((e) => e.type)).toContain('fleet.arrived');
    // Planet A produced 10 metal/h for the full 3h the journey took → p1 treasury.
    expect(arrived.state.players.p1?.resources.metal).toBe(30);
  });
});

describe('movement — routing along lanes (the map graph)', () => {
  it('routes hop by hop along the shortest lane path to a distant planet', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(chainABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    const ordered = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0)));
    expect(ordered.state.fleets.F?.movement?.to).toBe('B'); // first hop

    const atB = okAdvance(kernel.advanceTo(ordered.state, ctx(3 * HOUR)));
    expect(atB.state.fleets.F?.movement?.to).toBe('C'); // continued to the next hop
    expect(atB.events.map((e) => e.type)).toContain('fleet.transit');

    const atC = okAdvance(kernel.advanceTo(atB.state, ctx(6 * HOUR)));
    expect(atC.state.fleets.F?.location).toBe('C');
    expect(atC.state.fleets.F?.movement).toBe(null);
  });

  it('rejects a destination with no lane route', () => {
    const kernel = createKernel([movementModule]);
    const a = planet('A', 'p1', 0, 0);
    const island = planet('Z', null, 99, 99); // no links
    a.links = [];
    const st = baseState([a, island], [fleet('F', 'p1', 'A', ['scout'])]);
    expect(errCode(kernel.applyAction(st, move('F', 'Z'), ctx(0)))).toBe('E_NO_ROUTE');
  });
});

describe('movement + combat — collision on a lane triggers battle', () => {
  it('halts mid-journey and fights an enemy fleet blocking the path', () => {
    const kernel = createKernel([combatModule, movementModule]);
    const st = baseState(chainABC(), [
      fleet('F', 'p1', 'A', ['scout', 'scout', 'scout', 'scout', 'scout', 'scout']),
      fleet('E', 'p2', 'B', ['scout']), // lone enemy holding node B
    ]);
    const ordered = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(ordered.state, ctx(12 * HOUR)));

    // F reached B, collided with E, fought — it never continued to C.
    expect(r.state.fleets.F?.location).toBe('B');
    expect(r.state.fleets.E).toBeUndefined(); // destroyed in the clash
    expect(r.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['fleet.transit', 'battle.started', 'battle.resolved']),
    );
  });
});
