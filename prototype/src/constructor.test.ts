import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  buildShip,
  data,
  START_CANDIDATES,
  templatesOf,
  formationStats,
  setDivisionTemplate,
  FORMATION_SLOTS,
} from './game';
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

// The «Эскадрильи» pane is the SAME loadout editor over the squadron/carrier hulls —
// so the only new prototype wiring to pin is that those hulls carry typed slots and
// space-domain modules fit them (squadrons default to domain='space').
describe('constructor — «Эскадрильи» pane over the squadron hulls', () => {
  it('squadron hulls carry typed slots and the loadout editor fits space modules', () => {
    // the schema normalises `slots` to all three categories (absent ⇒ 0).
    expect(data.units.fighter_squadron?.slots).toEqual({ weapon: 1, defense: 0, utility: 0 });
    expect(data.units.strike_carrier?.slots).toEqual({ weapon: 0, defense: 1, utility: 2 });
    const ed = createLoadoutEditor('strike_carrier', data, { metal: 999, credits: 999 });
    expect(ed.ok).toBe(true);
    if (!ed.ok) return;
    expect(ed.slots.map((s) => s.type)).toEqual(['defense', 'utility', 'utility']);
    // a single weapon gun mount on the strike wing → a weapon module installs, a 2nd is blocked.
    const wing = createLoadoutEditor('fighter_squadron', data, { metal: 999, credits: 999 });
    if (!wing.ok) throw new Error('editor');
    const r = applyLoadoutAction({ kind: 'equip', moduleId: 'targeting_array' }, wing, data, {
      metal: 999,
      credits: 999,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.find((s) => s.type === 'weapon')?.moduleId).toBe('targeting_array');
  });
});

// The «Армия» pane edits a division template's 6 slots (division.template) and previews
// the live formation aggregate — both are shared-core; here we pin the prototype wiring.
describe('constructor — «Армия» pane edits a division template', () => {
  it('a fresh game seeds templates whose slots the pane cycles through the kernel', () => {
    const s = newGame();
    const tpls = templatesOf(s, 'p1');
    expect(tpls.length).toBeGreaterThan(0);
    expect(tpls[0]!.slots.length).toBe(FORMATION_SLOTS);
    // the pane emits division.template when a slot is tapped; clearing a filled slot to
    // null (the last step of the null→infantry→tank→null cycle) shrinks the aggregate.
    const before = formationStats(tpls[0]!);
    const filled = tpls[0]!.slots.findIndex((u) => u !== null);
    expect(filled).toBeGreaterThanOrEqual(0);
    const r = order(s, setDivisionTemplate('p1', 0, filled, null), s.time);
    expect(r.error).toBeUndefined();
    const after = formationStats(templatesOf(r.state, 'p1')[0]!);
    expect(after.count).toBe(before.count - 1);
  });
});

// ARS-5: the «Корабли» pane narrows CON_HULLS/the module palette to `Player.arsenal`
// (the ARS-3 match snapshot) exactly the way `conLoadoutPane` in main.ts does — this
// pins that the prototype's own hull ids (CON_HULLS) and module ids line up with a
// real `PlayerArsenal` shape, not just the editor's own filter mechanics (already
// covered in @void/client's loadoutEditor.test.ts).
describe('constructor («Верфь») — narrowed by the arsenal snapshot (ARS-5)', () => {
  const CON_HULLS = ['cruiser', 'siege', 'scout', 'dropship'];

  it('no snapshot ⇒ every hull + the full palette (graceful degradation)', () => {
    const snap: { hulls: string[]; modules: string[] } | undefined = undefined;
    const ownedHulls = snap ? CON_HULLS.filter((h) => snap.hulls.includes(h)) : CON_HULLS;
    expect(ownedHulls).toEqual(CON_HULLS);
    const ed = createLoadoutEditor('cruiser', data, { metal: 999 }, {
      ownedModules: snap ? new Set(snap.modules) : undefined,
    });
    expect(ed.ok && ed.palette.length).toBe(Object.keys(data.modules).length);
  });

  it('a snapshot narrows both the hull list and the palette to owned defIds', () => {
    const snap = { hulls: ['cruiser'], modules: ['targeting_array', 'cargo_bay'] };
    const ownedHulls = CON_HULLS.filter((h) => snap.hulls.includes(h));
    expect(ownedHulls).toEqual(['cruiser']);
    const ed = createLoadoutEditor('cruiser', data, { metal: 999 }, { ownedModules: new Set(snap.modules) });
    if (!ed.ok) throw new Error('editor');
    expect(ed.palette.map((o) => o.id).sort()).toEqual(['cargo_bay', 'targeting_array']);
  });
});
