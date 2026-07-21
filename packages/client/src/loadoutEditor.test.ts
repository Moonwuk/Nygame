import { describe, it, expect } from 'vitest';
import { parseGameData, type GameData, type ResourceBag } from '@void/shared-core';
import {
  createLoadoutEditor,
  applyLoadoutAction,
  resolveLoadoutBuild,
  type LoadoutModel,
} from './loadoutEditor';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 10, defense: 8, speed: 6, hp: 40, shield: 15, cargoCapacity: 2 },
      cost: { metal: 220 },
      slots: { weapon: 1, defense: 1, utility: 1 },
    },
  },
  factions: {},
  buildings: {},
  events: {},
  modules: {
    targeting: { name: 'Наведение', slot: 'weapon', tag: 'vertical', effects: { stats: { attack: 4 } }, cost: { metal: 60 } },
    targeting2: { name: 'Наведение II', slot: 'weapon', tag: 'vertical', effects: { stats: { attack: 6 } }, cost: { metal: 90 } },
    shield: { name: 'Щит', slot: 'defense', tag: 'vertical', effects: { stats: { shield: 15 } }, cost: { metal: 80 } },
    cargo: { name: 'Отсек', slot: 'utility', tag: 'horizontal', effects: { stats: { cargoCapacity: 6 } }, cost: { metal: 45 } },
  },
});
const rich: ResourceBag = { metal: 10_000 };

function ok(r: ReturnType<typeof createLoadoutEditor>): LoadoutModel {
  if (!r.ok) throw new Error(`editor failed: ${r.code}`);
  return r;
}
function err(r: { ok: boolean; code?: string }): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code!;
}

describe('loadout editor — model', () => {
  it('opens a hull with its typed empty slots and a full palette', () => {
    const m = ok(createLoadoutEditor('cruiser', data, rich));
    expect(m.hasSlots).toBe(true);
    expect(m.slots.map((s) => s.type)).toEqual(['weapon', 'defense', 'utility']);
    expect(m.slots.every((s) => s.moduleId === undefined)).toBe(true);
    expect(m.modules).toEqual([]);
    expect(m.palette).toHaveLength(4);
    expect(m.palette.every((p) => p.installable)).toBe(true); // all fit an empty hull
    expect(m.totalCost).toEqual({ metal: 220 }); // hull only
  });

  it('previews base stats with no modules', () => {
    const m = ok(createLoadoutEditor('cruiser', data, rich));
    const attack = m.preview.find((p) => p.stat === 'attack');
    expect(attack).toEqual({ stat: 'attack', label: 'Урон в атаке', base: 10, effective: 10, delta: 0 });
    // both combat numbers show: damage when ATTACKING and when DEFENDING.
    expect(m.preview.find((p) => p.stat === 'defense')).toEqual({
      stat: 'defense',
      label: 'Урон в защите',
      base: 8,
      effective: 8,
      delta: 0,
    });
  });

  it('rejects an unknown hull, fail-secure', () => {
    expect(err(createLoadoutEditor('ghost', data, rich))).toBe('E_UNKNOWN_UNIT');
  });
});

describe('loadout editor — equip / unequip', () => {
  it('equips a module into its slot and reflects it in stats and cost', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting' }, m0, data, rich));
    expect(m1.modules).toEqual(['targeting']);
    expect(m1.slots.find((s) => s.type === 'weapon')?.moduleId).toBe('targeting');
    expect(m1.preview.find((p) => p.stat === 'attack')).toEqual({
      stat: 'attack',
      label: 'Урон в атаке',
      base: 10,
      effective: 14,
      delta: 4,
    });
    expect(m1.modulesCost).toEqual({ metal: 60 });
    expect(m1.totalCost).toEqual({ metal: 280 }); // 220 hull + 60 module
    // the palette now marks a second weapon module as un-installable (slot full).
    expect(m1.palette.find((p) => p.id === 'targeting2')).toMatchObject({
      installable: false,
      code: 'E_NO_SLOT',
    });
  });

  it('rejects a second module in a full typed slot', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting' }, m0, data, rich));
    expect(err(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting2' }, m1, data, rich))).toBe(
      'E_NO_SLOT',
    );
  });

  it('unequips an installed module and refuses one that is not installed', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'shield' }, m0, data, rich));
    const m2 = ok(applyLoadoutAction({ kind: 'unequip', moduleId: 'shield' }, m1, data, rich));
    expect(m2.modules).toEqual([]);
    expect(err(applyLoadoutAction({ kind: 'unequip', moduleId: 'shield' }, m2, data, rich))).toBe(
      'E_NOT_INSTALLED',
    );
  });

  it('scales cost by the order count', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting' }, m0, data, rich));
    const m2 = ok(applyLoadoutAction({ kind: 'setCount', count: 3 }, m1, data, rich));
    expect(m2.count).toBe(3);
    expect(m2.totalCost).toEqual({ metal: 840 }); // (220 + 60) × 3
    expect(err(applyLoadoutAction({ kind: 'setCount', count: 0 }, m1, data, rich))).toBe(
      'E_BAD_COUNT',
    );
  });
});

describe('loadout editor — build resolution', () => {
  it('emits a unit.build intent carrying the loadout', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting' }, m0, data, rich));
    const r = resolveLoadoutBuild(m1, 'planetA');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toEqual({
        type: 'unit.build',
        payload: { planetId: 'planetA', unit: 'cruiser', count: 1, modules: ['targeting'] },
      });
    }
  });

  it('refuses with no planet or when the player cannot pay', () => {
    const m = ok(createLoadoutEditor('cruiser', data, rich));
    expect(err(resolveLoadoutBuild(m, '   '))).toBe('E_NO_PLANET');
    const poor = ok(createLoadoutEditor('cruiser', data, { metal: 100 }));
    expect(poor.affordable).toBe(false);
    expect(err(resolveLoadoutBuild(poor, 'planetA'))).toBe('E_INSUFFICIENT');
  });
});

describe('loadout editor — arsenal ownership filter (ARS-5)', () => {
  it('no filter passed ⇒ unrestricted palette (graceful degradation, no snapshot)', () => {
    const m = ok(createLoadoutEditor('cruiser', data, rich));
    expect(m.palette).toHaveLength(4);
    expect(m.ownedModules).toBeUndefined();
  });

  it('narrows the palette to owned defIds — unowned modules are absent, not just disabled', () => {
    const m = ok(createLoadoutEditor('cruiser', data, rich, { ownedModules: new Set(['targeting', 'cargo']) }));
    expect(m.palette.map((p) => p.id).sort()).toEqual(['cargo', 'targeting']);
  });

  it('the filter survives the reducer round-trip', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich, { ownedModules: new Set(['targeting', 'shield']) }));
    const m1 = ok(applyLoadoutAction({ kind: 'equip', moduleId: 'targeting' }, m0, data, rich));
    expect(m1.palette.map((p) => p.id).sort()).toEqual(['shield', 'targeting']);
  });

  it('equipping an unowned module is rejected even off-palette (defense in depth; the server gate is authoritative)', () => {
    const m0 = ok(createLoadoutEditor('cruiser', data, rich, { ownedModules: new Set(['targeting']) }));
    expect(err(applyLoadoutAction({ kind: 'equip', moduleId: 'shield' }, m0, data, rich))).toBe('E_NOT_OWNED');
  });
});
