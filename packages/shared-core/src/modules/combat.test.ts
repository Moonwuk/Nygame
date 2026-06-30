import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { combatModule } from './combat';
import { movementModule } from './movement';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type UnitStack,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import { setStance } from '../state/diplomacy';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    fighter: { faction: 'x', stats: { attack: 10, defense: 0, speed: 10, hp: 20 }, line: 'front' },
    shield: { faction: 'x', stats: { attack: 0, defense: 0, speed: 5, hp: 50 }, line: 'front' },
    backliner: { faction: 'x', stats: { attack: 5, defense: 0, speed: 5, hp: 10 }, line: 'rear' },
    artil: {
      faction: 'x',
      stats: { attack: 15, defense: 0, speed: 5, hp: 8 },
      line: 'rear',
      traits: ['artillery'],
    },
    // Artillery WITH a firing radius — drives the standoff-fire tests.
    siege: {
      faction: 'x',
      stats: { attack: 12, defense: 0, speed: 5, hp: 20, range: 250 },
      line: 'rear',
      traits: ['artillery'],
    },
    marine: { faction: 'x', stats: { attack: 10, defense: 0, speed: 1, hp: 20 }, line: 'front' },
    militia: { faction: 'x', stats: { attack: 3, defense: 0, speed: 1, hp: 10 }, line: 'front' },
    aggressor: {
      faction: 'x',
      stats: { attack: 30, defense: 5, speed: 5, hp: 100 },
      line: 'front',
    },
    guardian: { faction: 'x', stats: { attack: 7, defense: 20, speed: 5, hp: 100 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
});
const HOUR = 3_600_000;

function ctx(now: number, timeScale?: number): Context {
  return timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };
}
function stacks(list: Array<[string, number]>): UnitStack[] {
  return list.map(([unit, count]) => ({ unit, count }));
}
function fleet(
  id: string,
  owner: string,
  location: string | null,
  list: Array<[string, number]>,
  landing?: Array<[string, number]>,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: stacks(list),
    landing: landing ? stacks(landing) : undefined,
    traits: [],
  };
}
function planet(
  id: string,
  owner: string | null,
  x = 0,
  y = 0,
  garrison?: Array<[string, number]>,
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    resources: {},
    buildings: [],
    garrison: garrison ? stacks(garrison) : [],
    traits: [],
  };
}
function baseState(fleets: Fleet[], planets: Planet[] = []): GameState {
  const s = createInitialState({ seed: 'cmb', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  return { ...s, fleets: f, planets: p };
}

// Test fixture: emit `fleet.arrived` for a fleet without going through movement.
const arrivalModule: GameModule = {
  id: 'test-arrival',
  version: '1.0.0',
  setup(api) {
    api.onAction('arrive', (a, h) => {
      const fleetId = (a.payload as { fleetId: string }).fleetId;
      h.emit('fleet.arrived', { fleetId, at: h.state.fleets[fleetId]?.location });
    });
  },
};
function arrive(fleetId: string, playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type: 'arrive', playerId, payload: { fleetId }, issuedAt: 0 };
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
function stop(fleetId: string, playerId = 'p1'): Action {
  return { id: `s:${playerId}:9`, type: 'fleet.stop', playerId, payload: { fleetId }, issuedAt: 0 };
}
function assault(fleetId: string, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:3`,
    type: 'fleet.assault',
    playerId,
    payload: { fleetId },
    issuedAt: 0,
  };
}
function barrage(fleetId: string, targetId: string | null, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:4`,
    type: 'fleet.barrage',
    playerId,
    payload: { fleetId, targetId },
    issuedAt: 0,
  };
}
function barrageMode(fleetId: string, mode: string, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:5`,
    type: 'fleet.barrageMode',
    playerId,
    payload: { fleetId, mode },
    issuedAt: 0,
  };
}

function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function rej(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function stackOf(f: Fleet | undefined, unit: string): UnitStack | undefined {
  return f?.units.find((s) => s.unit === unit);
}
const types = (events: { type: string }[]): string[] => events.map((e) => e.type);

describe('combat — engagement (GDD §7)', () => {
  it('starts a battle when a fleet arrives where a hostile fleet sits', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 2]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    const r = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));

    expect(Object.keys(r.state.battles)).toHaveLength(1);
    expect(r.state.fleets.A?.battleId).toBeTruthy();
    expect(r.state.fleets.D?.battleId).toBeTruthy();
    expect(r.state.scheduled.some((e) => e.type === 'combat.tick')).toBe(true);
    expect(types(r.events)).toContain('battle.started');
  });

  it('does not start a battle when only friendly fleets are present', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 2]]), fleet('B', 'p1', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    const r = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(Object.keys(r.state.battles)).toHaveLength(0);
    expect(types(r.events)).not.toContain('battle.started');
  });

  it('does not start a battle when the two owners are at peace (diplomacy)', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 2]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    setStance(st, 'p1', 'p2', 'peace'); // hold fire until war is declared
    const r = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(Object.keys(r.state.battles)).toHaveLength(0);
    expect(r.state.fleets.A?.battleId).toBeFalsy();
    expect(types(r.events)).not.toContain('battle.started');
  });

  it('starts the battle once that peace turns to war', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 2]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    setStance(st, 'p1', 'p2', 'peace');
    setStance(st, 'p1', 'p2', 'war'); // declaration overrides the peace
    const r = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(Object.keys(r.state.battles)).toHaveLength(1);
    expect(types(r.events)).toContain('battle.started');
  });
});

describe('combat — resolution over real hours', () => {
  it('resolves in hourly rounds; the stronger side wins and the loser is destroyed', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 3]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(2 * HOUR)));

    const resolved = r.events.find((e) => e.type === 'battle.resolved');
    expect((resolved?.payload as { winner: string | null }).winner).toBe('p1'); // attacker's owner
    expect(types(r.events)).toContain('unit.died');
    expect(r.state.fleets.D).toBeUndefined(); // destroyed & removed
    expect(r.state.fleets.A?.battleId).toBe(null); // survivor released
    expect(Object.keys(r.state.battles)).toHaveLength(0);
  });

  it('timeScale compresses the round interval', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 3]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0, 2)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR, 2)));
    // First round fires at 0.5h instead of 1h.
    expect(r.events.some((e) => e.type === 'battle.resolved')).toBe(true);
    expect(r.state.time).toBe(HOUR);
  });
});

describe('combat — damage lines (GDD §7.2)', () => {
  it('the front line absorbs damage before the rear', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [
        fleet('A', 'p1', 'P', [['fighter', 1]]), // deals 10/round
        fleet('D', 'p2', 'P', [
          ['shield', 1], // front, hp 50
          ['backliner', 1], // rear, hp 10
        ]),
      ],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR))); // one round

    const d = r.state.fleets.D;
    expect(stackOf(d, 'shield')?.hp).toBe(40); // front took the 10 damage
    expect(stackOf(d, 'backliner')?.count).toBe(1);
    expect(stackOf(d, 'backliner')?.hp).toBeUndefined(); // rear untouched
  });

  it('artillery is only hit once the front line is gone', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [
        fleet('A', 'p1', 'P', [['fighter', 1]]), // deals 10/round
        fleet('D', 'p2', 'P', [
          ['fighter', 1], // front, hp 20
          ['artil', 1], // artillery, hp 8
        ]),
      ],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR))); // one round

    const d = r.state.fleets.D;
    expect(stackOf(d, 'fighter')?.hp).toBe(10); // front fighter took the hit
    expect(stackOf(d, 'artil')?.count).toBe(1); // artillery shielded
    expect(stackOf(d, 'artil')?.hp).toBeUndefined();
  });
});

describe('combat — hooks & graceful degradation', () => {
  it('lets an admiral scale damage through the combat.damage hook', () => {
    const admiral: GameModule = {
      id: 'admiral',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('combat.damage', (cur, args) => {
          const a = args as { attacker?: string } | null;
          return a?.attacker === 'p1' ? cur * 2 : cur; // boost the p1 admiral's fleet
        });
      },
    };
    const kernel = createKernel([combatModule, admiral, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 1]]), fleet('D', 'p2', 'P', [['fighter', 3]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR)));

    const round = r.events.find((e) => e.type === 'combat.round');
    expect((round?.payload as { dmgToDefender: number }).dmgToDefender).toBe(20); // 10 × 2
  });

  it('publishes unit.died that a necromancer-style module can react to', () => {
    const necromancer: GameModule = {
      id: 'necromancer',
      version: '1.0.0',
      setup(api) {
        api.on('unit.died', (event, h) => {
          const { count } = event.payload as { count: number };
          h.state.planets.P?.garrison.push({ unit: 'reanimated_drone', count });
        });
      },
    };
    const kernel = createKernel([combatModule, necromancer, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 3]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('P', 'p2')],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(2 * HOUR)));

    // Combat ran to completion AND the dead unit was reanimated onto the planet.
    expect(r.events.some((e) => e.type === 'battle.resolved')).toBe(true);
    const reanimated = (r.state.planets.P?.garrison ?? []).find(
      (s) => s.unit === 'reanimated_drone',
    );
    expect(reanimated?.count).toBe(1);
  });
});

describe('combat — integration with movement', () => {
  it('flies to a hostile planet, beats its fleet, then lands from the near orbit', () => {
    const kernel = createKernel([movementModule, combatModule]);
    const q = planet('Q', 'p1', 0, 0);
    const p = planet('P', 'p2', 10, 0); // 10 apart, fighter speed 10 → 1h
    q.links = ['P'];
    p.links = ['Q'];
    const st = baseState(
      [fleet('A', 'p1', 'Q', [['fighter', 3]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [q, p],
    );
    const ordered = okApply(kernel.applyAction(st, move('A', 'P'), ctx(0)));
    const arrived = okAdvance(kernel.advanceTo(ordered.state, ctx(3 * HOUR)));

    // Auto orbital battle on arrival; the victor then holds the (single) orbit and
    // the world is NOT taken just by arriving.
    expect(arrived.state.fleets.A?.location).toBe('P');
    expect(arrived.state.fleets.A?.orbit).toBe('near');
    expect(arrived.state.fleets.D).toBeUndefined();
    expect(arrived.state.planets.P?.owner).toBe('p2');
    expect(types(arrived.events)).toEqual(
      expect.arrayContaining(['fleet.arrived', 'battle.started', 'battle.resolved']),
    );

    // Land: the world is undefended now → occupied. Arrival already parked the
    // fleet in the single orbit, so no orbit step is needed.
    const near = arrived;
    const taken = okApply(kernel.applyAction(near.state, assault('A'), ctx(3 * HOUR)));
    expect(taken.state.planets.P?.owner).toBe('p1');
    expect(types(taken.events)).toContain('planet.captured');
  });
});

describe('combat — two-phase planet capture (GDD §7.4)', () => {
  it('occupies an undefended hostile world from the near orbit, without a fight', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState([fleet('A', 'p1', 'P', [['fighter', 1]])], [planet('P', 'p2')]);
    const arrived = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(arrived.state.planets.P?.owner).toBe('p2'); // arriving alone does not capture

    const near = arrived; // arrival already parks the fleet in the single orbit
    const r = okApply(kernel.applyAction(near.state, assault('A'), ctx(0)));
    expect(r.state.planets.P?.owner).toBe('p1');
    expect(types(r.events)).toContain('planet.captured');
    expect(types(r.events)).not.toContain('battle.started');
    expect(Object.keys(r.state.battles)).toHaveLength(0);
  });

  it('storms a garrison from the near orbit and captures the planet', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 1]], [['marine', 2]])], // 2 marines as landing
      [planet('P', 'p2', 0, 0, [['militia', 1]])], // 1 militia garrison
    );
    const arrived = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const near = arrived; // arrival already parks the fleet in the single orbit
    const started = okApply(kernel.applyAction(near.state, assault('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(2 * HOUR)));

    expect(r.state.planets.P?.owner).toBe('p1');
    expect(types([...started.events, ...r.events])).toContain('planet.captured');
    // Surviving marines become the new garrison; the fleet keeps its ships.
    const garrisonMarine = (r.state.planets.P?.garrison ?? []).find((s) => s.unit === 'marine');
    expect(garrisonMarine?.count).toBe(2);
    expect(r.state.fleets.A?.battleId).toBe(null);
    expect(r.state.fleets.A?.units[0]?.unit).toBe('fighter');
  });

  it('cannot storm a defended world without a landing force', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 1]])], // no landing troops
      [planet('P', 'p2', 0, 0, [['militia', 1]])],
    );
    const arrived = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const near = arrived; // arrival already parks the fleet in the single orbit
    expect(rej(kernel.applyAction(near.state, assault('A'), ctx(0)))).toBe('E_NO_TROOPS');
    expect(near.state.planets.P?.owner).toBe('p2'); // holds
  });

  it('runs both phases: auto orbital on arrival, then a deliberate landing', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [
        fleet('A', 'p1', 'P', [['fighter', 3]], [['marine', 2]]),
        fleet('D', 'p2', 'P', [['fighter', 1]]),
      ],
      [planet('P', 'p2', 0, 0, [['militia', 1]])],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0))); // orbital battle starts
    const afterOrbital = okAdvance(kernel.advanceTo(started.state, ctx(3 * HOUR)));
    expect(afterOrbital.state.fleets.D).toBeUndefined(); // orbital phase cleared the defender
    expect(afterOrbital.state.planets.P?.owner).toBe('p2'); // not captured yet

    const near = afterOrbital; // the victor already holds the single orbit
    const land = okApply(kernel.applyAction(near.state, assault('A'), ctx(3 * HOUR))); // ground battle
    const final = okAdvance(kernel.advanceTo(land.state, ctx(8 * HOUR)));

    expect(final.state.planets.P?.owner).toBe('p1'); // ground phase captured the world
    const allEvents = [...started.events, ...afterOrbital.events, ...land.events, ...final.events];
    const phases = allEvents
      .filter((e) => e.type === 'battle.started')
      .map((e) => (e.payload as { phase: string }).phase);
    expect(phases).toEqual(['orbital', 'ground']);
    expect(types(allEvents)).toContain('planet.captured');
  });

  it('arrives into the single orbit; a fleet not in orbit cannot assault', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState([fleet('A', 'p1', 'P', [['fighter', 1]])], [planet('P', 'p2')]);
    const arrived = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(arrived.state.fleets.A?.orbit).toBe('near'); // the single orbit, set on arrival

    // an idle fleet that never entered orbit (orbit undefined) can't assault
    const grounded = fleet('C', 'p1', 'P', [['fighter', 1]]); // orbit undefined
    const st3 = baseState([grounded], [planet('P', 'p2')]);
    expect(rej(kernel.applyAction(st3, assault('C'), ctx(0)))).toBe('E_WRONG_ORBIT');
  });
});

describe('combat — shipless fleet capture (bug fix)', () => {
  it('a fleet with no ships but surviving landing troops still captures the planet', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    // Fleet A has zero ships but carries marines; planet has a weak garrison.
    const shipless = fleet('A', 'p1', 'P', [], [['marine', 2]]);
    shipless.orbit = 'near';
    const st = baseState([shipless], [planet('P', 'p2', 0, 0, [['militia', 1]])]);
    const started = okApply(kernel.applyAction(st, assault('A'), ctx(0)));
    expect(Object.keys(started.state.battles)).toHaveLength(1);

    const r = okAdvance(kernel.advanceTo(started.state, ctx(2 * HOUR)));
    // The landing force should have captured the planet even though the fleet
    // had no ships (previously releaseOrDestroyFleet deleted the fleet first).
    expect(r.state.planets.P?.owner).toBe('p1');
    expect(types(r.events)).toContain('planet.captured');
    // Marines deposited as garrison.
    const marines = (r.state.planets.P?.garrison ?? []).find((s) => s.unit === 'marine');
    expect(marines?.count).toBe(2);
    // Fleet itself is destroyed (no ships left).
    expect(r.state.fleets.A).toBeUndefined();
  });
});

describe('combat — attack vs defense stats (return-fire mechanic)', () => {
  it('the aggressor uses attack; the standing defender answers with defense only', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['aggressor', 1]]), fleet('D', 'p2', 'P', [['guardian', 1]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR))); // one round
    const round = r.events.find((e) => e.type === 'combat.round');
    const p = round?.payload as { dmgToDefender: number; dmgToAttacker: number };

    expect(p.dmgToDefender).toBe(30); // A (aggressor) strikes with its attack stat
    expect(p.dmgToAttacker).toBe(20); // D (standing) returns defense, not its attack (7)
  });
});

describe('combat — lane intercept (crossing ON a lane, GDD §7.4)', () => {
  // A(0,0) — B(60,0), a single lane; fighter speed 10 ⇒ 6h end-to-end.
  function lane(): Planet[] {
    const a = planet('A', null, 0, 0);
    const b = planet('B', null, 60, 0);
    a.links = ['B'];
    b.links = ['A'];
    return [a, b];
  }

  it('intercepts two hostile fleets crossing head-on, mid-lane', () => {
    const kernel = createKernel([combatModule, movementModule]);
    const st = baseState(
      [fleet('F1', 'p1', 'A', [['fighter', 2]]), fleet('F2', 'p2', 'B', [['fighter', 2]])],
      lane(),
    );
    const m1 = okApply(kernel.applyAction(st, move('F1', 'B', 'p1'), ctx(0)));
    const m2 = okApply(kernel.applyAction(m1.state, move('F2', 'A', 'p2'), ctx(0)));
    // Not met yet — a crossing is scheduled for the lane midpoint (3h in), no battle.
    expect(Object.keys(m2.state.battles)).toHaveLength(0);
    expect(m2.state.scheduled.some((e) => e.type === 'fleet.intercept')).toBe(true);

    const r = okAdvance(kernel.advanceTo(m2.state, ctx(4 * HOUR)));
    expect(types(r.events)).toContain('battle.started');
    // Both pinned to the SAME mid-lane point — neither at a node, both off-transit.
    const f1 = r.state.fleets.F1;
    const f2 = r.state.fleets.F2;
    expect(f1?.location).toBeNull();
    expect(f1?.movement).toBeNull();
    expect(f1?.edge).toEqual({ from: 'A', to: 'B', t: 0.5 });
    expect(f2?.edge).toEqual({ from: 'A', to: 'B', t: 0.5 });
    // The battle is live and its hourly round clock (the combat timer) is exposed.
    const battle = Object.values(r.state.battles)[0];
    expect(battle).toBeDefined();
    expect(battle?.nextRoundAt).toBe(5 * HOUR); // 3h start → 4h round 1 → next at 5h
  });

  it('a parked fleet is caught by a hostile fleet running down its lane', () => {
    const kernel = createKernel([combatModule, movementModule]);
    const parked: Fleet = {
      id: 'P',
      owner: 'p1',
      location: null,
      movement: null,
      edge: { from: 'A', to: 'B', t: 0.5 },
      units: stacks([['fighter', 2]]),
      traits: [],
    };
    const st = baseState([parked, fleet('E', 'p2', 'A', [['fighter', 2]])], lane());
    const m = okApply(kernel.applyAction(st, move('E', 'B', 'p2'), ctx(0)));
    expect(m.state.scheduled.some((e) => e.type === 'fleet.intercept')).toBe(true);

    const r = okAdvance(kernel.advanceTo(m.state, ctx(4 * HOUR)));
    expect(types(r.events)).toContain('battle.started');
    expect(Object.keys(r.state.battles)).toHaveLength(1);
    // The runner was pinned to the parked fleet's point — not carried on to node B.
    expect(r.state.fleets.E?.edge).toEqual({ from: 'A', to: 'B', t: 0.5 });
    expect(r.state.fleets.E?.location).toBeNull();
  });

  it('a re-route off the lane before contact makes the crossing a stale no-op', () => {
    const kernel = createKernel([combatModule, movementModule]);
    // A — B — C colinear; F2 can break off down B–C instead of meeting F1 on A–B.
    const a = planet('A', null, 0, 0);
    const b = planet('B', null, 60, 0);
    const c = planet('C', null, 120, 0);
    a.links = ['B'];
    b.links = ['A', 'C'];
    c.links = ['B'];
    const st = baseState(
      [fleet('F1', 'p1', 'A', [['fighter', 2]]), fleet('F2', 'p2', 'B', [['fighter', 2]])],
      [a, b, c],
    );
    const m1 = okApply(kernel.applyAction(st, move('F1', 'B', 'p1'), ctx(0)));
    const m2 = okApply(kernel.applyAction(m1.state, move('F2', 'A', 'p2'), ctx(0)));
    // Up to just before the 3h crossing — still no battle.
    const at2 = okAdvance(kernel.advanceTo(m2.state, ctx(2 * HOUR)));
    expect(Object.keys(at2.state.battles)).toHaveLength(0);
    // F2 breaks off: stop, then run the other way to C, leaving the A–B lane.
    const s = okApply(kernel.applyAction(at2.state, stop('F2', 'p2'), ctx(2 * HOUR)));
    const m3 = okApply(kernel.applyAction(s.state, move('F2', 'C', 'p2'), ctx(2 * HOUR)));
    // Past the original crossing and on to journey's end: they never meet.
    const r = okAdvance(kernel.advanceTo(m3.state, ctx(8 * HOUR)));
    expect(types(r.events)).not.toContain('battle.started');
    expect(Object.keys(r.state.battles)).toHaveLength(0);
    expect(r.state.fleets.F1).toBeDefined();
    expect(r.state.fleets.F2).toBeDefined();
  });
});

describe('combat — ships keep hull damage; ground rests at full (persistent hull)', () => {
  it('leaves a surviving fleet at its battle-end hull, so damage carries forward', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    // A (aggressor, attack 30) beats D (guardian) but takes return-fire (guardian defense 20).
    const st = baseState(
      [fleet('A', 'p1', 'P', [['aggressor', 1]]), fleet('D', 'p2', 'P', [['guardian', 1]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    // Mid-battle the survivor carries a partial HP pool...
    const mid = okAdvance(kernel.advanceTo(started.state, ctx(HOUR)));
    expect(stackOf(mid.state.fleets.A, 'aggressor')?.hp).toBe(80);
    // ...and once the battle resolves the SHIP keeps its reduced hull — no auto-heal,
    // so a battered fleet limps off and only mends at a repair base (construction.ts).
    const r = okAdvance(kernel.advanceTo(started.state, ctx(6 * HOUR)));
    expect(r.state.fleets.A?.battleId).toBe(null);
    expect(r.state.fleets.D).toBeUndefined(); // loser destroyed
    expect(stackOf(r.state.fleets.A, 'aggressor')?.count).toBe(1);
    const hp = stackOf(r.state.fleets.A, 'aggressor')?.hp;
    expect(hp).toBeDefined();
    expect(hp!).toBeLessThan(100); // hull damage persists out of combat (was reset to full before)
  });

  it('deposits a won ground assault as a full-health garrison (clears the landing battle HP)', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    // Shipless lander carries aggressors; the world is defended by a guardian (defense 20),
    // so the landing takes return-fire, wins, and is deposited as the new garrison.
    const lander = fleet('A', 'p1', 'P', [], [['aggressor', 2]]);
    lander.orbit = 'near';
    const st = baseState([lander], [planet('P', 'p2', 0, 0, [['guardian', 1]])]);
    const started = okApply(kernel.applyAction(st, assault('A'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(6 * HOUR)));

    expect(r.state.planets.P?.owner).toBe('p1');
    const g = (r.state.planets.P?.garrison ?? []).find((s) => s.unit === 'aggressor');
    expect(g?.count).toBe(2);
    // The resting garrison must be at full health — not the partial battle pool it ended with.
    expect(g?.hp).toBeUndefined();
  });
});

describe('combat — defender-win re-engages a leftover hostile fleet (bug fix)', () => {
  it('the surviving DEFENDER auto-engages a fleet that was idling at the node', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState(
      [
        fleet('D', 'p2', 'P', [['aggressor', 2]]), // strong defender — wins both fights
        fleet('A1', 'p1', 'P', [['fighter', 1]]), // arrives first, loses to D
        fleet('A2', 'p1', 'P', [['fighter', 1]]), // can't engage while D is busy → idles
      ],
      [planet('P', null)],
    );
    const s1 = okApply(kernel.applyAction(st, arrive('A1'), ctx(0))); // A1 vs D starts
    expect(s1.state.fleets.A1?.battleId).toBeTruthy();
    expect(s1.state.fleets.D?.battleId).toBeTruthy();
    const s2 = okApply(kernel.applyAction(s1.state, arrive('A2'), ctx(0)));
    expect(s2.state.fleets.A2?.battleId).toBeFalsy(); // no free enemy → A2 idles at P

    const r = okAdvance(kernel.advanceTo(s2.state, ctx(12 * HOUR)));
    expect(r.state.fleets.A1).toBeUndefined(); // first loser gone
    // A2 was beaten too — which can ONLY happen if the defender re-scanned the node after winning.
    expect(r.state.fleets.A2).toBeUndefined();
    expect(r.state.fleets.D?.battleId).toBe(null); // D won both, now free
  });
});

describe('combat — artillery standoff fire (GDD §7.2)', () => {
  it('shells a hostile fleet within range over a span, with no return fire or battle', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 200, 0)], // 200 apart ≤ range 250
    );
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR))); // one hour of fire

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBe(28); // 40 pool − 12 (attack×1h)
    expect(stackOf(r.state.fleets.ART, 'siege')?.hp).toBeUndefined(); // pure standoff — unscathed
    expect(Object.keys(r.state.battles)).toHaveLength(0); // never enters a battle
    expect(types(r.events)).toContain('artillery.fired');
  });

  it('does not fire at a target beyond its radius', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 300, 0)], // 300 > range 250
    );
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined(); // untouched
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('holds fire on a non-hostile fleet in range (peace)', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    setStance(st, 'p1', 'p2', 'peace');
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined();
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('auto-targets the NEAREST hostile fleet in range', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [
        fleet('ART', 'p1', 'PA', [['siege', 1]]),
        fleet('E1', 'p2', 'P1', [['fighter', 2]]), // 100 out — nearer
        fleet('E2', 'p3', 'P2', [['fighter', 2]]), // 200 out — farther
      ],
      [planet('PA', null, 0, 0), planet('P1', null, 100, 0), planet('P2', null, 200, 0)],
    );
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E1, 'fighter')?.hp).toBe(28); // nearest took the shot
    expect(stackOf(r.state.fleets.E2, 'fighter')?.hp).toBeUndefined(); // farther one spared
  });

  it('fleet.barrage focuses fire on a chosen target, and clearing reverts to auto', () => {
    const kernel = createKernel([combatModule]);
    const make = (): GameState =>
      baseState(
        [
          fleet('ART', 'p1', 'PA', [['siege', 1]]),
          fleet('E1', 'p2', 'P1', [['fighter', 2]]),
          fleet('E2', 'p3', 'P2', [['fighter', 2]]),
        ],
        [planet('PA', null, 0, 0), planet('P1', null, 100, 0), planet('P2', null, 200, 0)],
      );

    // Focus the farther E2 — it should be shelled instead of the nearer E1.
    const aimed = okApply(kernel.applyAction(make(), barrage('ART', 'E2'), ctx(0)));
    expect(aimed.state.fleets.ART?.barrageTarget).toBe('E2');
    const fired = okAdvance(kernel.advanceTo(aimed.state, ctx(HOUR)));
    expect(stackOf(fired.state.fleets.E2, 'fighter')?.hp).toBe(28);
    expect(stackOf(fired.state.fleets.E1, 'fighter')?.hp).toBeUndefined();

    // Clearing the target falls back to auto-targeting the nearest (E1).
    const cleared = okApply(kernel.applyAction(aimed.state, barrage('ART', null), ctx(0)));
    expect(cleared.state.fleets.ART?.barrageTarget).toBe(null);
    const reverted = okAdvance(kernel.advanceTo(cleared.state, ctx(HOUR)));
    expect(stackOf(reverted.state.fleets.E1, 'fighter')?.hp).toBe(28);
    expect(stackOf(reverted.state.fleets.E2, 'fighter')?.hp).toBeUndefined();
  });

  it('drops a stale chosen target (gone / out of range) and auto-targets instead', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [
        fleet('ART', 'p1', 'PA', [['siege', 1]]),
        fleet('E1', 'p2', 'P1', [['fighter', 2]]), // in range, nearest
        fleet('E2', 'p3', 'P2', [['fighter', 2]]), // chosen, but out of range
      ],
      [planet('PA', null, 0, 0), planet('P1', null, 100, 0), planet('P2', null, 400, 0)],
    );
    const aimed = okApply(kernel.applyAction(st, barrage('ART', 'E2'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(aimed.state, ctx(HOUR)));

    expect(r.state.fleets.ART?.barrageTarget).toBe(null); // stale target cleared
    expect(stackOf(r.state.fleets.E1, 'fighter')?.hp).toBe(28); // auto fell back to nearest
  });

  it('a fleet pinned in a melee battle does not also fire at range', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    st.fleets.ART!.battleId = 'battle:busy'; // engaged elsewhere — guns occupied
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined(); // no standoff shot
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('destroys a target it wipes out from range', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 1]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    const r = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR))); // 24 dmg ≥ 20 hp

    expect(r.state.fleets.E).toBeUndefined(); // gone
    expect(types(r.events)).toContain('fleet.destroyed');
  });

  it('rejects bad barrage orders (fail-secure)', () => {
    const kernel = createKernel([combatModule]);
    const base = (): GameState =>
      baseState(
        [
          fleet('ART', 'p1', 'PA', [['siege', 1]]),
          fleet('PLAIN', 'p1', 'PA', [['fighter', 1]]), // no artillery aboard
          fleet('E', 'p2', 'PB', [['fighter', 1]]),
        ],
        [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
      );
    expect(rej(kernel.applyAction(base(), barrage('ZZ', 'E'), ctx(0)))).toBe('E_NO_FLEET');
    expect(rej(kernel.applyAction(base(), barrage('ART', 'E', 'p2'), ctx(0)))).toBe('E_FORBIDDEN');
    expect(rej(kernel.applyAction(base(), barrage('PLAIN', 'E'), ctx(0)))).toBe('E_NO_ARTILLERY');
    expect(rej(kernel.applyAction(base(), barrage('ART', 'ART'), ctx(0)))).toBe('E_BAD_PAYLOAD');
    expect(rej(kernel.applyAction(base(), barrage('ART', 'GONE'), ctx(0)))).toBe('E_NO_TARGET');
    // prototype-chain ids must not resolve to Object.prototype (own-key lookup)
    expect(rej(kernel.applyAction(base(), barrage('ART', '__proto__'), ctx(0)))).toBe('E_NO_TARGET');
    expect(rej(kernel.applyAction(base(), barrage('ART', 'constructor'), ctx(0)))).toBe('E_NO_TARGET');
    expect(rej(kernel.applyAction(base(), barrage('__proto__', 'E'), ctx(0)))).toBe('E_NO_FLEET');
    const peaceful = base();
    setStance(peaceful, 'p1', 'p2', 'peace');
    expect(rej(kernel.applyAction(peaceful, barrage('ART', 'E'), ctx(0)))).toBe('E_NOT_HOSTILE');
  });

  it('self-heals a poisoned barrageTarget instead of crashing the span (DoS guard)', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    st.fleets.ART!.barrageTarget = '__proto__'; // a value that resolves to Object.prototype
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR))); // must NOT throw / discard the span

    expect(r.state.fleets.ART?.barrageTarget).toBe(null); // poisoned target cleared
    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBe(28); // span ran: auto-targeted the enemy
  });

  it('does not shell a target already pinned in a melee battle', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    st.fleets.E!.battleId = 'battle:elsewhere'; // engaged — not a standoff target
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined(); // spared
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('a moving shooter holds fire (only stationary artillery shells)', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    st.fleets.ART!.location = null; // in transit — its position drifts across the span
    st.fleets.ART!.movement = { from: 'PA', to: 'PB', departedAt: 0, arrivesAt: 100 * HOUR };
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined(); // not shelled
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('does not shell a moving target (only a stationary fleet can be hit)', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)], // PB in range
    );
    st.fleets.E!.location = null; // in transit through the radius — geometry not constant
    st.fleets.E!.movement = { from: 'PB', to: 'PA', departedAt: 0, arrivesAt: 100 * HOUR };
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));

    expect(stackOf(r.state.fleets.E, 'fighter')?.hp).toBeUndefined(); // moving → spared
    expect(types(r.events)).not.toContain('artillery.fired');
  });

  it('resolves mutual standoff simultaneously — both artillery fleets get their shot off', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      // Each siege (12/h) over 2h deals 24 ≥ the other's 20 hp pool. Sequential
      // (lower id first) would let A2 wipe B2 before B2 fires; the pre-span snapshot
      // makes both shots land, so BOTH die.
      [fleet('A2', 'p1', 'PA', [['siege', 1]]), fleet('B2', 'p2', 'PB', [['siege', 1]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    const r = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR)));

    expect(r.state.fleets.A2).toBeUndefined();
    expect(r.state.fleets.B2).toBeUndefined();
    expect(types(r.events).filter((t) => t === 'fleet.destroyed')).toHaveLength(2);
  });
});

describe('combat — artillery fire modes (rules of engagement)', () => {
  type Mode = 'passive' | 'return' | 'standard' | 'aggressive';
  type Stance = 'war' | 'peace' | 'pact' | 'alliance';
  function pair(mode?: Mode, stance?: Stance): GameState {
    const st = baseState(
      [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('E', 'p2', 'PB', [['fighter', 2]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    if (mode) st.fleets.ART!.barrageMode = mode;
    if (stance) setStance(st, 'p1', 'p2', stance);
    return st;
  }
  const fired = (st: GameState, hours = 1): boolean => {
    const r = okAdvance(createKernel([combatModule]).advanceTo(st, ctx(hours * HOUR)));
    return types(r.events).includes('artillery.fired');
  };

  it('passive holds fire even with a hostile in range', () => {
    expect(fired(pair('passive'))).toBe(false);
  });

  it('standard (default) fires at a WAR target but not a PEACE one', () => {
    expect(fired(pair(undefined))).toBe(true); // war is the default stance
    expect(fired(pair('standard', 'peace'))).toBe(false);
  });

  it('aggressive fires on a PEACE neighbour, but spares pact / alliance', () => {
    expect(fired(pair('aggressive', 'peace'))).toBe(true);
    expect(fired(pair('aggressive', 'pact'))).toBe(false);
    expect(fired(pair('aggressive', 'alliance'))).toBe(false);
  });

  it('return holds fire until the fleet has been provoked by damage', () => {
    expect(fired(pair('return'))).toBe(false); // not yet hit → silent
    const provoked = pair('return');
    provoked.fleets.ART!.barrageProvoked = true;
    expect(fired(provoked)).toBe(true);
  });

  it('taking damage sets barrageProvoked (the return trigger)', () => {
    // B (standard) shells A (return → holds fire this span). A is hit ⇒ provoked.
    const st = baseState(
      [fleet('A', 'p1', 'PA', [['siege', 1]]), fleet('B', 'p2', 'PB', [['siege', 1]])],
      [planet('PA', null, 0, 0), planet('PB', null, 100, 0)],
    );
    st.fleets.A!.barrageMode = 'return';
    const r = okAdvance(createKernel([combatModule]).advanceTo(st, ctx(HOUR)));
    expect(r.state.fleets.A?.barrageProvoked).toBe(true); // B's shot provoked A
    expect(r.state.fleets.B?.barrageProvoked).toBeFalsy(); // A held fire → B unhit
  });

  it('fleet.barrageMode sets the mode and rejects bad input', () => {
    const kernel = createKernel([combatModule]);
    const base = (): GameState =>
      baseState(
        [fleet('ART', 'p1', 'PA', [['siege', 1]]), fleet('PLAIN', 'p1', 'PA', [['fighter', 1]])],
        [planet('PA', null, 0, 0)],
      );
    const set = okApply(kernel.applyAction(base(), barrageMode('ART', 'aggressive'), ctx(0)));
    expect(set.state.fleets.ART?.barrageMode).toBe('aggressive');
    expect(rej(kernel.applyAction(base(), barrageMode('ART', 'berserk'), ctx(0)))).toBe('E_BAD_PAYLOAD');
    expect(rej(kernel.applyAction(base(), barrageMode('ZZ', 'passive'), ctx(0)))).toBe('E_NO_FLEET');
    expect(rej(kernel.applyAction(base(), barrageMode('ART', 'passive', 'p2'), ctx(0)))).toBe('E_FORBIDDEN');
    expect(rej(kernel.applyAction(base(), barrageMode('PLAIN', 'passive'), ctx(0)))).toBe('E_NO_ARTILLERY');
  });
});
