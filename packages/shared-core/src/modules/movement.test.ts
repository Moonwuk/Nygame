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
    expect(errCode(kernel.applyAction(st, move('E', 'B'), ctx(0)))).toBe('E_NO_FLEET'); // foreign fleet denied AND indistinguishable from not-found (A06)
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

describe('movement — stranded fleet (beginLeg failure mid-journey)', () => {
  it('emits fleet.stranded when the next leg cannot start (speed zeroed by hook)', () => {
    // A hook that kills speed for legs entering planet C → beginLeg fails at B.
    const blocker: GameModule = {
      id: 'blocker',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('fleet.speed', (speed, args) => {
          const { to } = args as { to?: string };
          return to === 'C' ? 0 : speed;
        });
      },
    };
    const kernel = createKernel([movementModule, blocker]);
    const st = baseState(chainABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    const ordered = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0)));

    // Advance past the first hop (A→B takes 3h); arrival at B tries to start B→C
    // but the hook zeroes the speed, so the fleet is stranded at B.
    const r = okAdvance(kernel.advanceTo(ordered.state, ctx(6 * HOUR)));
    expect(r.state.fleets.F?.location).toBe('B');
    expect(r.state.fleets.F?.movement).toBe(null);
    expect(r.events.map((e) => e.type)).toContain('fleet.stranded');
    const stranded = r.events.find((e) => e.type === 'fleet.stranded');
    expect((stranded?.payload as { fleetId: string; at: string }).fleetId).toBe('F');
    expect((stranded?.payload as { fleetId: string; at: string }).at).toBe('B');
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

const stop = (fleetId: string, playerId = 'p1'): Action => ({
  id: `s:${playerId}:2`,
  type: 'fleet.stop',
  playerId,
  payload: { fleetId },
  issuedAt: 0,
});
function moveEdge(
  fleetId: string,
  edge: { from: string; to: string; t: number },
  playerId = 'p1',
): Action {
  return {
    id: `s:${playerId}:3`,
    type: 'fleet.move',
    playerId,
    payload: { fleetId, toEdge: edge },
    issuedAt: 0,
  };
}
// A(0,0) — B(30,0) — C(60,0); scout speed 10 → 3h per leg.
const lineABC = (): Planet[] => [
  { ...planet('A', 'p1', 0, 0), links: ['B'] },
  { ...planet('B', null, 30, 0), links: ['A', 'C'] },
  { ...planet('C', null, 60, 0), links: ['B'] },
];

describe('movement — fleet.stop parks the fleet ON the lane (Bytro continuous position)', () => {
  it('parks at the current continuous fraction, not the next node', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(lineABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    const ordered = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0)));
    expect(ordered.state.fleets.F?.movement?.destination).toBe('C'); // headed all the way

    // 1h into the 3h A→B leg → one third of the way down the lane.
    const stopped = okApply(kernel.applyAction(ordered.state, stop('F'), ctx(HOUR)));
    const f = stopped.state.fleets.F;
    expect(f?.location).toBe(null);
    expect(f?.movement).toBe(null);
    expect(f?.edge?.from).toBe('A');
    expect(f?.edge?.to).toBe('B');
    expect(f?.edge?.t).toBeCloseTo(1 / 3, 5);
    expect(stopped.events.map((e) => e.type)).toContain('fleet.parked');

    // It stays put — a parked fleet does not drift to a node on its own.
    const later = okAdvance(kernel.advanceTo(stopped.state, ctx(10 * HOUR)));
    expect(later.state.fleets.F?.edge?.t).toBeCloseTo(1 / 3, 5);
    expect(later.state.fleets.F?.location).toBe(null);
  });

  it('rejects stopping a fleet that is not under way', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState([{ ...planet('A', 'p1', 0, 0), links: [] }], [fleet('F', 'p1', 'A', ['scout'])]);
    const r = kernel.applyAction(st, stop('F'), ctx(0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('E_FLEET_BUSY');
  });
});

describe('movement — march to a point ON a lane (toEdge), and re-route from a parked fleet', () => {
  it('marches to a continuous point on a distant lane and parks there', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(lineABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    // Aim at the midpoint of the B—C lane: route A→B (3h), then half of B→C (1.5h).
    const ordered = okApply(kernel.applyAction(st, moveEdge('F', { from: 'B', to: 'C', t: 0.5 }), ctx(0)));
    expect(ordered.state.fleets.F?.movement?.to).toBe('B'); // first hop is the node B

    const done = okAdvance(kernel.advanceTo(ordered.state, ctx(5 * HOUR)));
    const f = done.state.fleets.F;
    expect(f?.location).toBe(null);
    expect(f?.movement).toBe(null);
    expect(f?.edge).toEqual({ from: 'B', to: 'C', t: 0.5 });
    expect(done.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['fleet.transit', 'fleet.parked']),
    );
  });

  it('lets a parked fleet resume to a node, choosing the cheaper lane end', () => {
    const kernel = createKernel([movementModule]);
    // Park F one third down A→B, then order it onward to C.
    const st = baseState(lineABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    const moving = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0)));
    const parked = okApply(kernel.applyAction(moving.state, stop('F'), ctx(HOUR)));
    expect(parked.state.fleets.F?.edge?.t).toBeCloseTo(1 / 3, 5);

    // Forward to B (20 units) then B→C (30) beats reversing to A. Resumes forward.
    const resumed = okApply(kernel.applyAction(parked.state, move('F', 'C'), ctx(HOUR)));
    expect(resumed.state.fleets.F?.movement?.from).toBe('A');
    expect(resumed.state.fleets.F?.movement?.to).toBe('B');
    expect(resumed.state.fleets.F?.movement?.startT).toBeCloseTo(1 / 3, 5);

    const done = okAdvance(kernel.advanceTo(resumed.state, ctx(10 * HOUR)));
    expect(done.state.fleets.F?.location).toBe('C');
  });

  it('repositions directly along the lane it is already parked on (no detour)', () => {
    const kernel = createKernel([movementModule]);
    const parkedFleet: Fleet = { ...fleet('F', 'p1', null, ['scout']), edge: { from: 'A', to: 'B', t: 0.3 } };
    const st = baseState(lineABC(), [parkedFleet]);
    // Slide forward to 0.7 along the SAME A—B lane: one short leg, 0.4 × 30 / 10 = 1.2h.
    const ordered = okApply(kernel.applyAction(st, moveEdge('F', { from: 'A', to: 'B', t: 0.7 }), ctx(0)));
    expect(ordered.state.fleets.F?.movement?.from).toBe('A');
    expect(ordered.state.fleets.F?.movement?.to).toBe('B');
    expect(ordered.state.fleets.F?.movement?.arrivesAt).toBeCloseTo(1.2 * HOUR, 0);

    const done = okAdvance(kernel.advanceTo(ordered.state, ctx(2 * HOUR)));
    expect(done.state.fleets.F?.edge).toEqual({ from: 'A', to: 'B', t: 0.7 });
  });

  it('ignores a stale arrival after stop + re-route (no premature teleport)', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(lineABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    const moving = okApply(kernel.applyAction(st, move('F', 'C'), ctx(0))); // arrival scheduled at 3h
    const parked = okApply(kernel.applyAction(moving.state, stop('F'), ctx(HOUR)));
    // Re-route back toward A at 1h; its new arrival is later. The OLD 3h arrival
    // is now stale and must NOT fire the new leg.
    const resumed = okApply(kernel.applyAction(parked.state, move('F', 'A'), ctx(HOUR)));
    const atStale = okAdvance(kernel.advanceTo(resumed.state, ctx(3 * HOUR)));
    // The genuine A-arrival is at 1h + (10 units / 10) = 2h, so by 3h it is at A —
    // reached by its OWN leg, not the stale C-bound one.
    expect(atStale.state.fleets.F?.location).toBe('A');
    expect(atStale.state.fleets.F?.movement).toBe(null);
  });

  it('ignores a stale arrival that shares departedAt with the live leg (same-instant stop+reroute)', () => {
    // When a stop+reroute is resolved in the SAME instant, both legs are stamped with
    // the same `departedAt`, so that field alone cannot tell the abandoned leg from the
    // live one — the arrival must also match the live leg's `arrivesAt`.
    const kernel = createKernel([movementModule]);
    const s = baseState(chainABC(), [fleet('F', 'p1', null, ['scout'])]);
    // F is on a LIVE leg A→B→C that departed at t0=0; this first leg is slow (arrives 12h).
    s.fleets.F!.movement = {
      from: 'A',
      to: 'B',
      departedAt: 0,
      arrivesAt: 12 * HOUR,
      path: ['C'],
      destination: 'C',
    };
    // Two arrivals both stamped departedAt=0: the LIVE one at 12h and a STALE leftover from
    // the abandoned leg-1 at 3h. The 3h one must be ignored.
    s.scheduled = [
      {
        id: 'evt:live',
        at: 12 * HOUR,
        type: 'fleet.arrival',
        payload: { fleetId: 'F', departedAt: 0, arrivesAt: 12 * HOUR },
        seq: 1,
      },
      {
        id: 'evt:stale',
        at: 3 * HOUR,
        type: 'fleet.arrival',
        payload: { fleetId: 'F', departedAt: 0, arrivesAt: 3 * HOUR },
        seq: 0,
      },
    ];
    s.scheduleSeq = 2;

    const r = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const f = r.state.fleets.F;
    // The stale 3h arrival is rejected: F is still mid-flight on its real A→B leg, not teleported.
    expect(f?.location).toBeNull();
    expect(f?.movement?.to).toBe('B');
    expect(f?.movement?.arrivesAt).toBe(12 * HOUR);
  });

  it('rejects a point that is not on a real lane', () => {
    const kernel = createKernel([movementModule]);
    const st = baseState(lineABC(), [fleet('F', 'p1', 'A', ['scout'])]);
    // A and C are not directly lane-connected → not a valid lane point.
    expect(errCode(kernel.applyAction(st, moveEdge('F', { from: 'A', to: 'C', t: 0.5 }), ctx(0)))).toBe(
      'E_NOT_A_LANE',
    );
  });
});
