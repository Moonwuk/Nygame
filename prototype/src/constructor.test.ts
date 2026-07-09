import { describe, it, expect } from 'vitest';
import { newGame, order, buildShip, data, START_CANDIDATES } from './game';
import { createLoadoutEditor, applyLoadoutAction } from '../../packages/client/src/loadoutEditor';

// The «Верфь» constructor renders the @void/client loadout view-model over the prototype's
// inline data and confirms into `unit.build{modules}`. The view-model itself is unit-tested
// in @void/client; here we pin the PROTOTYPE wiring: its data feeds the editor, and the
// build order the tab emits is accepted by the kernel with the modules stamped on.

const HOME = START_CANDIDATES[0]!;

describe('constructor («Верфь») — loadout editor over the prototype data', () => {
  it('the prototype data carries the module catalog + typed hull slots', () => {
    expect(Object.keys(data.modules).length).toBeGreaterThanOrEqual(6);
    expect(data.units.cruiser?.slots).toEqual({ weapon: 1, defense: 1, utility: 1 });
    expect(data.modules.cargo_bay?.slot).toBe('utility');
  });

  it('createLoadoutEditor renders a cruiser: 3 typed bays + a priced palette', () => {
    const ed = createLoadoutEditor('cruiser', data, { metal: 999, credits: 999 });
    expect(ed.ok).toBe(true);
    if (!ed.ok) return;
    expect(ed.slots.map((s) => s.type)).toEqual(['weapon', 'defense', 'utility']);
    expect(ed.palette.length).toBe(Object.keys(data.modules).length);
    // an empty cruiser: every module individually fits its empty bay ⇒ all installable.
    expect(ed.palette.every((o) => o.installable)).toBe(true);
    // once the utility bay is filled, only the weapon + two defense modules remain (3).
    const filled = applyLoadoutAction({ kind: 'equip', moduleId: 'cargo_bay' }, ed, data, { metal: 999, credits: 999 });
    if (!filled.ok) throw new Error('equip');
    expect(filled.palette.filter((o) => o.installable).length).toBe(3);
  });

  it('equipping through the reducer fills a bay, prices it, and blocks a duplicate type', () => {
    const res = { metal: 999, credits: 999 };
    const ed = createLoadoutEditor('cruiser', data, res);
    if (!ed.ok) throw new Error('editor');
    const r = applyLoadoutAction({ kind: 'equip', moduleId: 'cargo_bay' }, ed, data, res);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modules).toEqual(['cargo_bay']);
    expect(r.slots.find((s) => s.type === 'utility')?.moduleId).toBe('cargo_bay');
    expect(r.totalCost.metal).toBe((data.units.cruiser!.cost!.metal ?? 0) + 45); // hull + module
    // utility is now full → a second utility module can't go on.
    const r2 = applyLoadoutAction({ kind: 'equip', moduleId: 'radar_module' }, r, data, res);
    expect(r2.ok).toBe(false);
  });

  it('buildShip emits unit.build{modules}, accepted + validated by the kernel', () => {
    const s = newGame();
    const before = { ...(s.players.p1?.resources ?? {}) } as Record<string, number>;
    const r = order(s, buildShip('p1', HOME, 'cruiser', 1, ['targeting_array']), s.time);
    expect(r.error).toBeUndefined(); // the loadout cleared validateLoadout + was charged
    const after = r.state.players.p1?.resources ?? {};
    // hull (60m) + targeting_array (60m) = 150 metal spent.
    expect((before.metal ?? 0) - (after.metal ?? 0)).toBe(60 + 60);
  });

  it('rejects an illegal loadout at the kernel gate (module in the wrong slot)', () => {
    const s = newGame();
    // two weapon modules but the cruiser has only one weapon bay → validateLoadout fails.
    const r = order(s, buildShip('p1', HOME, 'cruiser', 1, ['targeting_array', 'targeting_array']), s.time);
    expect(r.error).toBeTruthy();
  });
});
