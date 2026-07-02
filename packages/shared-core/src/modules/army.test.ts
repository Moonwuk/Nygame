import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { armyModule } from './army';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      domain: 'space',
      stats: { attack: 5, defense: 5, speed: 6, hp: 40, cargoCapacity: 2 },
    },
    dropship: {
      faction: 'x',
      domain: 'space',
      stats: { attack: 1, defense: 2, speed: 6, hp: 50, cargoCapacity: 12 },
    },
    militia: {
      faction: 'x',
      domain: 'ground',
      stats: { attack: 4, defense: 8, speed: 0, hp: 20, cargoSize: 1 },
    },
    tank: {
      faction: 'x',
      domain: 'ground',
      stats: { attack: 20, defense: 16, speed: 0, hp: 50, cargoSize: 3 },
    },
    orbital_aa: {
      faction: 'x',
      domain: 'ground',
      traits: ['immobile'],
      stats: { attack: 4, defense: 14, speed: 0, hp: 30, aaDamage: 12, cargoSize: 2 },
    },
  },
  factions: {},
  buildings: {},
  events: {},
});
const ctx: Context = { now: 0, data };

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function planet(id: string, owner: string | null, garrison: Array<[string, number]> = []): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: garrison.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function fleet(
  id: string,
  owner: string,
  location: string | null,
  units: Array<[string, number]> = [],
  landing: Array<[string, number]> = [],
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    landing: landing.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function stateWith(opts: { players?: Player[]; planets?: Planet[]; fleets?: Fleet[] }): GameState {
  const s = createInitialState({ seed: 'army', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  return { ...s, players, planets, fleets };
}
const load = (fleetId: string, unit: string, count?: number, playerId = 'p1'): Action => ({
  id: `a:${playerId}:1`,
  type: 'army.load',
  playerId,
  payload: { fleetId, unit, count },
  issuedAt: 0,
});
const unload = (fleetId: string, unit: string, count?: number, playerId = 'p1'): Action => ({
  id: `a:${playerId}:2`,
  type: 'army.unload',
  playerId,
  payload: { fleetId, unit, count },
  issuedAt: 0,
});
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

const base = () =>
  stateWith({
    players: [player('p1')],
    planets: [
      planet('A', 'p1', [
        ['militia', 4],
        ['tank', 2],
      ]),
    ],
    fleets: [fleet('F', 'p1', 'A', [['cruiser', 2]])], // capacity 2×2 = 4
  });

describe('army module — loading ground army onto fleets', () => {
  it('loads ground army from the garrison into the fleet (within capacity)', () => {
    const kernel = createKernel([armyModule]);
    const r = okApply(kernel.applyAction(base(), load('F', 'militia', 3), ctx));
    expect(r.state.fleets.F?.landing).toEqual([{ unit: 'militia', count: 3 }]);
    expect(r.state.planets.A?.garrison).toEqual([
      { unit: 'militia', count: 1 },
      { unit: 'tank', count: 2 },
    ]);
    expect(r.events.map((e) => e.type)).toContain('army.loaded');
  });

  it('rejects loading beyond the fleet transport capacity', () => {
    const kernel = createKernel([armyModule]);
    // cruiser×2 → capacity 4; a single tank costs 3, two tanks cost 6 > 4.
    expect(errCode(kernel.applyAction(base(), load('F', 'tank', 2), ctx))).toBe('E_NO_CAPACITY');
    // one tank (3) fits; nothing is lost on the failed order.
    const st = base();
    okApply(kernel.applyAction(st, load('F', 'tank', 1), ctx));
    expect(errCode(kernel.applyAction(st, load('F', 'tank', 2), ctx))).toBe('E_NO_CAPACITY');
  });

  it('a dropship lifts a whole invasion force', () => {
    const kernel = createKernel([armyModule]);
    const st = stateWith({
      players: [player('p1')],
      planets: [planet('A', 'p1', [['tank', 5]])],
      fleets: [fleet('F', 'p1', 'A', [['dropship', 1]])], // capacity 12
    });
    const r = okApply(kernel.applyAction(st, load('F', 'tank', 4), ctx)); // 4 × 3 = 12, exactly full
    expect(r.state.fleets.F?.landing).toEqual([{ unit: 'tank', count: 4 }]);
    expect(errCode(kernel.applyAction(r.state, load('F', 'tank', 1), ctx))).toBe('E_NO_CAPACITY');
  });

  it('rejects a space unit as cargo (only the ground army is carried)', () => {
    const kernel = createKernel([armyModule]);
    expect(errCode(kernel.applyAction(base(), load('F', 'cruiser', 1), ctx))).toBe('E_NOT_GROUND');
  });

  it('rejects loading more army than the garrison holds', () => {
    const kernel = createKernel([armyModule]);
    expect(errCode(kernel.applyAction(base(), load('F', 'militia', 9), ctx))).toBe('E_NO_ARMY');
  });

  it('rejects loading a fixed emplacement (immobile orbital AA)', () => {
    const kernel = createKernel([armyModule]);
    const st = stateWith({
      players: [player('p1')],
      planets: [planet('A', 'p1', [['orbital_aa', 2]])],
      fleets: [fleet('F', 'p1', 'A', [['dropship', 1]])], // ample capacity
    });
    expect(errCode(kernel.applyAction(st, load('F', 'orbital_aa', 1), ctx))).toBe('E_IMMOBILE');
    expect(st.planets.A?.garrison).toEqual([{ unit: 'orbital_aa', count: 2 }]); // nothing moved
  });
});

describe('army module — unloading and validation', () => {
  it('unloads carried army back onto an owned world', () => {
    const kernel = createKernel([armyModule]);
    const st = stateWith({
      players: [player('p1')],
      planets: [planet('A', 'p1', [['militia', 1]])],
      fleets: [fleet('F', 'p1', 'A', [['cruiser', 2]], [['militia', 2]])],
    });
    const r = okApply(kernel.applyAction(st, unload('F', 'militia', 2), ctx));
    expect(r.state.fleets.F?.landing).toEqual([]);
    expect(r.state.planets.A?.garrison).toEqual([{ unit: 'militia', count: 3 }]); // 1 + 2 merged
    expect(r.events.map((e) => e.type)).toContain('army.unloaded');
  });

  it('rejects unauthorized, busy, or wrong-planet transfers', () => {
    const kernel = createKernel([armyModule]);
    // not your fleet — opaque code, indistinguishable from a non-existent id (A06)
    expect(errCode(kernel.applyAction(base(), load('F', 'militia', 1, 'p2'), ctx))).toBe(
      'E_NO_FLEET',
    );
    // fleet in transit
    const moving = base();
    moving.fleets.F!.location = null;
    moving.fleets.F!.movement = { from: 'A', to: 'B', departedAt: 0, arrivesAt: 10 };
    expect(errCode(kernel.applyAction(moving, load('F', 'militia', 1), ctx))).toBe('E_FLEET_BUSY');
    // docked at a world you do not own
    const abroad = stateWith({
      players: [player('p1')],
      planets: [planet('A', 'p2', [['militia', 2]])],
      fleets: [fleet('F', 'p1', 'A', [['cruiser', 2]])],
    });
    expect(errCode(kernel.applyAction(abroad, load('F', 'militia', 1), ctx))).toBe('E_FORBIDDEN');
  });

  it('rejects malformed payloads', () => {
    const kernel = createKernel([armyModule]);
    expect(errCode(kernel.applyAction(base(), { ...load('F', 'militia'), payload: {} }, ctx))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(base(), load('F', 'militia', 0), ctx))).toBe('E_BAD_PAYLOAD');
    expect(errCode(kernel.applyAction(base(), load('ghost', 'militia', 1), ctx))).toBe(
      'E_NO_FLEET',
    );
  });

  it('does not mutate the input state', () => {
    const kernel = createKernel([armyModule]);
    const st = deepFreeze(base());
    okApply(kernel.applyAction(st, load('F', 'militia', 2), ctx));
    expect(st.planets.A?.garrison[0]).toEqual({ unit: 'militia', count: 4 }); // input untouched
    expect(st.fleets.F?.landing).toEqual([]);
  });
});
