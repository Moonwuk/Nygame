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
function orbit(fleetId: string, o: 'near' | 'far', playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:2`,
    type: 'fleet.orbit',
    playerId,
    payload: { fleetId, orbit: o },
    issuedAt: 0,
  };
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

    // Auto orbital battle on arrival; the victor then holds the far orbit and
    // the world is NOT taken just by arriving.
    expect(arrived.state.fleets.A?.location).toBe('P');
    expect(arrived.state.fleets.A?.orbit).toBe('far');
    expect(arrived.state.fleets.D).toBeUndefined();
    expect(arrived.state.planets.P?.owner).toBe('p2');
    expect(types(arrived.events)).toEqual(
      expect.arrayContaining(['fleet.arrived', 'battle.started', 'battle.resolved']),
    );

    // Descend and land: the world is undefended now → occupied.
    const near = okApply(kernel.applyAction(arrived.state, orbit('A', 'near'), ctx(3 * HOUR)));
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

    const near = okApply(kernel.applyAction(arrived.state, orbit('A', 'near'), ctx(0)));
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
    const near = okApply(kernel.applyAction(arrived.state, orbit('A', 'near'), ctx(0)));
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
    const near = okApply(kernel.applyAction(arrived.state, orbit('A', 'near'), ctx(0)));
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

    const near = okApply(kernel.applyAction(afterOrbital.state, orbit('A', 'near'), ctx(3 * HOUR)));
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

  it('arrives into the far orbit; assault needs the near orbit and an idle, owned fleet', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    const st = baseState([fleet('A', 'p1', 'P', [['fighter', 1]])], [planet('P', 'p2')]);
    const arrived = okApply(kernel.applyAction(st, arrive('A'), ctx(0)));
    expect(arrived.state.fleets.A?.orbit).toBe('far');
    expect(rej(kernel.applyAction(arrived.state, assault('A'), ctx(0)))).toBe('E_WRONG_ORBIT');

    const moving = fleet('B', 'p1', null, [['fighter', 1]]);
    moving.movement = { from: 'Q', to: 'P', departedAt: 0, arrivesAt: 10 * HOUR };
    const st2 = baseState([moving], [planet('P', 'p2')]);
    expect(rej(kernel.applyAction(st2, orbit('B', 'near'), ctx(0)))).toBe('E_FLEET_BUSY');
    expect(rej(kernel.applyAction(arrived.state, orbit('A', 'near', 'p2'), ctx(0)))).toBe(
      'E_FORBIDDEN',
    );
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
