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
): Fleet {
  return { id, owner, location, movement: null, units: stacks(list), traits: [] };
}
function planet(id: string, owner: string | null, x = 0, y = 0): Planet {
  return { id, owner, position: { x, y }, resources: {}, buildings: [], garrison: [], traits: [] };
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
      h.emit('fleet.arrived', { fleetId: (a.payload as { fleetId: string }).fleetId });
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

function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
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
    expect((resolved?.payload as { winner: string | null }).winner).toBe('A');
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
          return a?.attacker === 'A' ? cur * 2 : cur;
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
  it('a fleet flies to a hostile planet and fights on arrival', () => {
    const kernel = createKernel([movementModule, combatModule]);
    const st = baseState(
      [fleet('A', 'p1', 'Q', [['fighter', 3]]), fleet('D', 'p2', 'P', [['fighter', 1]])],
      [planet('Q', 'p1', 0, 0), planet('P', 'p2', 10, 0)], // 10 apart, fighter speed 10 → 1h
    );
    const ordered = okApply(kernel.applyAction(st, move('A', 'P'), ctx(0)));
    const r = okAdvance(kernel.advanceTo(ordered.state, ctx(3 * HOUR)));

    expect(r.state.fleets.A?.location).toBe('P');
    expect(r.state.fleets.A?.battleId).toBe(null);
    expect(r.state.fleets.D).toBeUndefined();
    expect(types(r.events)).toEqual(
      expect.arrayContaining(['fleet.arrived', 'battle.started', 'battle.resolved']),
    );
  });
});
