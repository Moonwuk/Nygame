import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type {
  ApplyResult,
  Context,
  Fleet,
  GameState,
  Player,
} from '../../packages/shared-core/src/index';
import {
  instantRepairModule,
  instantRepairFleet,
  instantRepairCost,
  INSTANT_REPAIR_CREDITS_PER_HP,
  data,
} from './game';

// Платный мгновенный ремонт: топ-ап корпуса всех стеков (корабли + десант) за
// кредиты по единой формуле ceil(missingHull × RATE), где угодно кроме боя. Щит
// не трогается (регенит бесплатно), отказы fail-secure с опаковыми кодами.

const kernel = createKernel([instantRepairModule]);
const ctx = (now = 0): Context => ({ now, data });

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id,
    owner: 'green',
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: 2 }],
    landing: [],
    traits: [],
    battleId: null,
    ...over,
  } as unknown as Fleet;
}
function stateWith(fleets: Fleet[], credits = 1000): GameState {
  const s = createInitialState({ seed: 'ir', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return {
    ...s,
    fleets: f,
    players: {
      green: { id: 'green', name: 'Green', resources: { credits } } as unknown as Player,
    },
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
const militiaHp = data.units.militia!.stats.hp!;

describe('fleet.instantRepair — платный мгновенный ремонт', () => {
  it('чинит корабли и десант разом, списывая ceil(missing × RATE) кредитов', () => {
    const missing = cruiserHp * 2 - 70 + (militiaHp * 2 - 10);
    const f = fleet('f1', {
      units: [{ unit: 'cruiser', count: 2, hp: 70 }],
      landing: [{ unit: 'militia', count: 2, hp: 10 }],
    });
    expect(instantRepairCost(f, data)).toBe(Math.ceil(missing * INSTANT_REPAIR_CREDITS_PER_HP));
    const s0 = stateWith([f], 1000);
    const s1 = ok(kernel.applyAction(s0, instantRepairFleet('green', 'f1'), ctx()));
    expect(s1.fleets.f1!.units[0]!.hp).toBeUndefined();
    expect(s1.fleets.f1!.landing![0]!.hp).toBeUndefined();
    expect(s1.players.green!.resources.credits).toBe(1000 - instantRepairCost(f, data));
    // purity: the input state is untouched
    expect(s0.fleets.f1!.units[0]!.hp).toBe(70);
    expect(s0.players.green!.resources.credits).toBe(1000);
  });

  it('щит не трогает — только корпус', () => {
    const f = fleet('f1', { units: [{ unit: 'cruiser', count: 1, hp: 30, shieldHp: 3 }] });
    const s1 = ok(kernel.applyAction(stateWith([f]), instantRepairFleet('green', 'f1'), ctx()));
    expect(s1.fleets.f1!.units[0]!.hp).toBeUndefined();
    expect(s1.fleets.f1!.units[0]!.shieldHp).toBe(3);
  });

  it('фитинги учтены: +hp модуль поднимает полный пул и цену', () => {
    const per = cruiserHp + 12; // ablative_plating +12 hp
    const f = fleet('f1', {
      units: [{ unit: 'cruiser', count: 2, hp: 100, modules: ['ablative_plating'] }],
    });
    expect(instantRepairCost(f, data)).toBe(
      Math.ceil((per * 2 - 100) * INSTANT_REPAIR_CREDITS_PER_HP),
    );
  });

  it('отказы: цел / в бою / чужой / нет денег — и state не меняется', () => {
    const whole = fleet('f1');
    expect(
      rej(kernel.applyAction(stateWith([whole]), instantRepairFleet('green', 'f1'), ctx())),
    ).toBe('E_NOTHING_TO_REPAIR');
    const inBattle = fleet('f1', { units: [{ unit: 'cruiser', count: 1, hp: 5 }], battleId: 'b1' });
    expect(
      rej(kernel.applyAction(stateWith([inBattle]), instantRepairFleet('green', 'f1'), ctx())),
    ).toBe('E_IN_BATTLE');
    const foreign = fleet('f1', { owner: 'red', units: [{ unit: 'cruiser', count: 1, hp: 5 }] });
    expect(
      rej(kernel.applyAction(stateWith([foreign]), instantRepairFleet('green', 'f1'), ctx())),
    ).toBe('E_NO_FLEET');
    expect(
      rej(kernel.applyAction(stateWith([]), instantRepairFleet('green', 'ghost'), ctx())),
    ).toBe('E_NO_FLEET');
    const poor = stateWith([fleet('f1', { units: [{ unit: 'cruiser', count: 2, hp: 10 }] })], 3);
    const r = kernel.applyAction(poor, instantRepairFleet('green', 'f1'), ctx());
    expect(rej(r)).toBe('E_NO_FUNDS');
    expect(poor.fleets.f1!.units[0]!.hp).toBe(10);
    expect(poor.players.green!.resources.credits).toBe(3);
  });
});
