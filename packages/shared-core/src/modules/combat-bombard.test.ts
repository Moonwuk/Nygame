import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { combatModule } from './combat';
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
    fighter: { faction: 'x', stats: { attack: 10, defense: 5, speed: 10, hp: 20 }, line: 'front' },
    aa_gun: {
      faction: 'x',
      stats: { attack: 1, defense: 1, speed: 1, hp: 10, aaDamage: 30 },
      line: 'front',
    },
    drone: { faction: 'x', stats: { attack: 2, defense: 1, speed: 5, hp: 5 }, line: 'front' },
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
  opts: { orbit?: 'near' | 'far'; bombarding?: boolean } = {},
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: stacks(list),
    traits: [],
    orbit: opts.orbit,
    bombarding: opts.bombarding,
  };
}
function planet(
  id: string,
  owner: string | null,
  garrison?: Array<[string, number]>,
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: garrison ? stacks(garrison) : [],
    traits: [],
  };
}
function baseState(fleets: Fleet[], planets: Planet[]): GameState {
  const s = createInitialState({ seed: 'bom', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  return { ...s, fleets: f, planets: p };
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
function bombard(fleetId: string, on: boolean, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'fleet.bombard',
    playerId,
    payload: { fleetId, on },
    issuedAt: 0,
  };
}
function orbitAction(fleetId: string, o: 'near' | 'far', playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:2`,
    type: 'fleet.orbit',
    playerId,
    payload: { fleetId, orbit: o },
    issuedAt: 0,
  };
}

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

describe('combat — fleet.bombard action', () => {
  it('enables bombardment from the near orbit over a hostile world', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near' })],
      [planet('P', 'p2')],
    );
    const r = okApply(kernel.applyAction(st, bombard('F', true), ctx(0)));
    expect(r.state.fleets.F?.bombarding).toBe(true);
    expect(r.events.some((e) => e.type === 'fleet.bombard')).toBe(true);
  });

  it('disables bombardment (turns it off)', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near', bombarding: true });
    const st = baseState([f], [planet('P', 'p2')]);
    const r = okApply(kernel.applyAction(st, bombard('F', false), ctx(0)));
    expect(r.state.fleets.F?.bombarding).toBe(false);
  });

  it('rejects bombardment from the far orbit', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'far' })],
      [planet('P', 'p2')],
    );
    expect(rej(kernel.applyAction(st, bombard('F', true), ctx(0)))).toBe('E_WRONG_ORBIT');
  });

  it('rejects bombardment of your own planet', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near' })],
      [planet('P', 'p1')],
    );
    expect(rej(kernel.applyAction(st, bombard('F', true), ctx(0)))).toBe('E_OWN_PLANET');
  });

  it('rejects bombardment with no ships', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [], { orbit: 'near' })],
      [planet('P', 'p2')],
    );
    expect(rej(kernel.applyAction(st, bombard('F', true), ctx(0)))).toBe('E_NO_SHIPS');
  });

  it('rejects bombardment for a non-existent fleet', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState([], [planet('P', 'p2')]);
    expect(rej(kernel.applyAction(st, bombard('ZZZ', true), ctx(0)))).toBe('E_NO_FLEET');
  });

  it('rejects bombardment for a fleet you do not own', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p2', 'P', [['fighter', 2]], { orbit: 'near' })],
      [planet('P', 'p1')],
    );
    expect(rej(kernel.applyAction(st, bombard('F', true, 'p1'), ctx(0)))).toBe('E_FORBIDDEN');
  });

  it('rejects bombardment for a fleet that is in transit', () => {
    const kernel = createKernel([combatModule]);
    const f: Fleet = {
      id: 'F',
      owner: 'p1',
      location: null,
      movement: { from: 'A', to: 'P', departedAt: 0, arrivesAt: HOUR },
      units: stacks([['fighter', 2]]),
      traits: [],
      orbit: 'near',
    };
    const st = baseState([f], [planet('P', 'p2')]);
    expect(rej(kernel.applyAction(st, bombard('F', true), ctx(0)))).toBe('E_FLEET_BUSY');
  });

  it('rejects with E_BAD_PAYLOAD for invalid payload', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near' })],
      [planet('P', 'p2')],
    );
    const bad: Action = { id: 's:p1:1', type: 'fleet.bombard', playerId: 'p1', payload: {}, issuedAt: 0 };
    expect(rej(kernel.applyAction(st, bad, ctx(0)))).toBe('E_BAD_PAYLOAD');
  });

  it('moving to far orbit auto-disables bombardment', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near', bombarding: true });
    const st = baseState([f], [planet('P', 'p2')]);
    const r = okApply(kernel.applyAction(st, orbitAction('F', 'far'), ctx(0)));
    expect(r.state.fleets.F?.bombarding).toBe(false);
    expect(r.state.fleets.F?.orbit).toBe('far');
  });
});

describe('combat — orbital AA (time.advanced)', () => {
  it('deals garrison AA damage to a hostile fleet on the near orbit', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 1]], { orbit: 'near' });
    const st = baseState([f], [planet('P', 'p2', [['aa_gun', 1]])]);
    // aa_gun has aaDamage: 30 per hour; fighter has 20 hp → killed in 1h.
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    expect(r.state.fleets.F).toBeUndefined(); // destroyed by AA
    expect(r.events.some((e) => e.type === 'fleet.destroyed')).toBe(true);
  });

  it('does not fire AA if the planet has no owner', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 1]], { orbit: 'near' });
    const st = baseState([f], [planet('P', null, [['aa_gun', 1]])]);
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    expect(r.state.fleets.F).toBeDefined(); // no damage taken
    expect(r.state.fleets.F?.units[0]?.count).toBe(1);
  });

  it('emits planet.bombarded when a fleet shells the structures below', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near', bombarding: true });
    const st = baseState([f], [planet('P', 'p2')]);
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    const ev = r.events.find((e) => e.type === 'planet.bombarded');
    expect(ev).toBeDefined();
    // bombard power = 2 fighters × attack 10 × 0.5 fraction × 1h = 10
    expect((ev?.payload as { power: number }).power).toBe(10);
  });

  it('AA scales with time span', () => {
    const kernel = createKernel([combatModule]);
    const f = fleet('F', 'p1', 'P', [['fighter', 2]], { orbit: 'near' });
    // 2 fighters have 40 total hp; aa_gun does 30/h → after 0.5h = 15 damage.
    const st = baseState([f], [planet('P', 'p2', [['aa_gun', 1]])]);
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR / 2)));
    // Fleet survives, 1 fighter with reduced hp
    expect(r.state.fleets.F).toBeDefined();
    expect(r.state.fleets.F?.units.some((s) => s.count > 0)).toBe(true);
  });
});

describe('combat — stalemate safety valve', () => {
  it('ends a battle as a draw after MAX_COMBAT_ROUNDS (240)', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    // Both sides deal 0 damage (shields only) → infinite rounds without the cap.
    const shieldData: GameData = parseGameData({
      version: '0.1.0',
      resources: ['metal'],
      units: {
        shield: {
          faction: 'x',
          stats: { attack: 0, defense: 0, speed: 5, hp: 100 },
          line: 'front',
        },
      },
      factions: {},
      buildings: {},
      events: {},
    });
    const shieldCtx = (now: number): Context => ({ now, data: shieldData });
    const st = baseState(
      [fleet('A', 'p1', 'P', [['shield', 1]]), fleet('D', 'p2', 'P', [['shield', 1]])],
      [planet('P', null)],
    );
    const started = okApply(kernel.applyAction(st, arrive('A'), shieldCtx(0)));
    // Advance far enough for 241 rounds → 241 hours.
    const r = okAdvance(kernel.advanceTo(started.state, shieldCtx(242 * HOUR)));
    const resolved = r.events.find((e) => e.type === 'battle.resolved');
    expect(resolved).toBeDefined();
    // Winner is null (stalemate).
    expect((resolved?.payload as { winner: string | null }).winner).toBeNull();
    // After the stalemate resolves, the attacker re-engages (both survived) so a
    // new battle starts — we only assert the stalemate resolution event fired.
  });
});

describe('combat — fleet.orbit action validations', () => {
  it('rejects with E_BAD_PAYLOAD for invalid orbit value', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('F', 'p1', 'P', [['fighter', 1]], { orbit: 'far' })],
      [planet('P', 'p2')],
    );
    const bad: Action = {
      id: 's:p1:1',
      type: 'fleet.orbit',
      playerId: 'p1',
      payload: { fleetId: 'F', orbit: 'low' },
      issuedAt: 0,
    };
    expect(rej(kernel.applyAction(st, bad, ctx(0)))).toBe('E_BAD_PAYLOAD');
  });

  it('rejects with E_NO_FLEET for a non-existent fleet', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState([], [planet('P', 'p2')]);
    expect(rej(kernel.applyAction(st, orbitAction('ZZZ', 'near'), ctx(0)))).toBe('E_NO_FLEET');
  });
});

describe('combat — fleet.assault extra validations', () => {
  it('rejects assault when orbit is contested by an enemy fleet', () => {
    const kernel = createKernel([combatModule, arrivalModule]);
    // p1 wants to assault but p2's fleet is still alive at P.
    const st = baseState(
      [
        fleet('A', 'p1', 'P', [['fighter', 1]], { orbit: 'near' }),
        fleet('D', 'p2', 'P', [['fighter', 1]]),
      ],
      [planet('P', 'p2', [['drone', 1]])],
    );
    // Manually set landing troops
    st.fleets.A!.landing = stacks([['drone', 1]]);
    const assaultAction: Action = {
      id: 's:p1:3',
      type: 'fleet.assault',
      playerId: 'p1',
      payload: { fleetId: 'A' },
      issuedAt: 0,
    };
    expect(rej(kernel.applyAction(st, assaultAction, ctx(0)))).toBe('E_ORBIT_CONTESTED');
  });

  it('rejects assault on own planet', () => {
    const kernel = createKernel([combatModule]);
    const st = baseState(
      [fleet('A', 'p1', 'P', [['fighter', 1]], { orbit: 'near' })],
      [planet('P', 'p1')],
    );
    const assaultAction: Action = {
      id: 's:p1:3',
      type: 'fleet.assault',
      playerId: 'p1',
      payload: { fleetId: 'A' },
      issuedAt: 0,
    };
    expect(rej(kernel.applyAction(st, assaultAction, ctx(0)))).toBe('E_OWN_PLANET');
  });
});
