import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type {
  ApplyResult,
  Context,
  Fleet,
  GameState,
  Planet,
  Player,
} from '../../packages/shared-core/src/index';
import {
  econScrewsModule,
  repairFleet,
  dockRepairCost,
  fleetAtOwnDock,
  REPAIR_HP_PER_METAL,
  data,
} from './game';

// ECON-3: экспресс-ремонт корпуса за METAL у своего дока (shipRepair>0) —
// сток металла в духе Bytro; отказы fail-secure.

const kernel = createKernel([econScrewsModule]);
const ctx = (now = 0): Context => ({ now, data });

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id,
    owner: 'green',
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: 2, hp: 70 }],
    landing: [],
    traits: [],
    battleId: null,
    ...over,
  } as unknown as Fleet;
}
function planet(id: string, over: Partial<Planet> = {}): Planet {
  return {
    id,
    owner: 'green',
    position: { x: 0, y: 0 },
    links: [],
    garrison: [],
    buildings: [{ type: 'spaceport', level: 1, hp: 25 }],
    ...over,
  } as unknown as Planet;
}
function stateWith(fleets: Fleet[], planets: Planet[], res: Record<string, number>): GameState {
  const s = createInitialState({ seed: 'e3', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  return {
    ...s,
    fleets: f,
    planets: p,
    players: { green: { id: 'green', name: 'Green', resources: res } as unknown as Player },
  };
}
function ok(r: ApplyResult): GameState {
  if (!r.ok) throw new Error('apply failed: ' + r.code);
  return r.state;
}
function rej(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const cruiserHp = data.units.cruiser!.stats.hp!;

describe('fleet.repair — ECON-3а: экспресс-ремонт за metal у своего дока', () => {
  it('чинит весь флот по цене ceil(missing / 2) metal', () => {
    const missing = cruiserHp * 2 - 70;
    const f = fleet('f1');
    expect(dockRepairCost(f, data)).toBe(Math.ceil(missing / REPAIR_HP_PER_METAL));
    const s0 = stateWith([f], [planet('A')], { metal: 100, credits: 0 });
    expect(fleetAtOwnDock(f, s0, data)).toBe(true);
    const s1 = ok(kernel.applyAction(s0, repairFleet('green', 'f1'), ctx()));
    expect(s1.fleets.f1!.units[0]!.hp).toBeUndefined();
    expect(s1.players.green!.resources.metal).toBe(100 - dockRepairCost(f, data));
    expect(s0.fleets.f1!.units[0]!.hp).toBe(70); // purity
  });

  it('E_NO_DOCK: чужой мир / без верфи / разбитая верфь / в пути', () => {
    const cases: Array<[Fleet, Planet]> = [
      [fleet('f1'), planet('A', { owner: 'red' })],
      [fleet('f1'), planet('A', { buildings: [] })],
      [fleet('f1'), planet('A', { buildings: [{ type: 'spaceport', level: 1, hp: 0 }] })],
      [
        fleet('f1', {
          movement: { from: 'A', to: 'B', departedAt: 0, arrivesAt: 10 },
        } as unknown as Partial<Fleet>),
        planet('A'),
      ],
    ];
    for (const [f, p] of cases) {
      const s0 = stateWith([f], [p], { metal: 999 });
      expect(rej(kernel.applyAction(s0, repairFleet('green', 'f1'), ctx()))).toBe('E_NO_DOCK');
    }
  });

  it('прочие отказы: цел / нет денег (state не меняется) / чужой флот', () => {
    const whole = fleet('f1', { units: [{ unit: 'cruiser', count: 2 }] });
    expect(
      rej(
        kernel.applyAction(
          stateWith([whole], [planet('A')], { metal: 9 }),
          repairFleet('green', 'f1'),
          ctx(),
        ),
      ),
    ).toBe('E_NOTHING_TO_REPAIR');
    const poor = stateWith([fleet('f1')], [planet('A')], { metal: 3 });
    expect(rej(kernel.applyAction(poor, repairFleet('green', 'f1'), ctx()))).toBe('E_NO_FUNDS');
    expect(poor.fleets.f1!.units[0]!.hp).toBe(70);
    expect(poor.players.green!.resources.metal).toBe(3);
    const foreign = fleet('f1', { owner: 'red' });
    expect(
      rej(
        kernel.applyAction(
          stateWith([foreign], [planet('A')], { metal: 99 }),
          repairFleet('green', 'f1'),
          ctx(),
        ),
      ),
    ).toBe('E_NO_FLEET');
  });
});
