/**
 * Ship-loadout editor — the framework-agnostic view-model behind the "Оснащение
 * корабля" menu. The player arranges modules into a hull's typed slots BEFORE
 * building; the built ship is locked (no refit). This is the screen's *logic*:
 * a render-ready model + a pure reducer (equip / unequip / count) + a resolver
 * that turns the confirmed loadout into a `unit.build` intent carrying `modules`.
 *
 * Invariants (mirror the core): pure + deterministic (no Date/random), outputs
 * JSON-serialisable, fail-secure — a bad action yields `{ ok: false, code }` with
 * a stable code only, never a throw. All stat maths route through the core's
 * `effectiveStats` so the preview matches what the built ship will actually carry.
 */
import type { GameData, ResourceBag, ShipSlotType, UnitDef } from '@void/shared-core';
import { canEquip, effectiveStats, hullSlotTypes, loadoutCost } from '@void/shared-core';

/** One capacity slot on the hull — its category and the module in it (if any). */
export interface LoadoutSlotView {
  type: ShipSlotType;
  moduleId?: string;
  moduleName?: string;
}

/** A module offered in the palette, with whether it can go on this hull right now. */
export interface LoadoutOption {
  id: string;
  name: string;
  slot: ShipSlotType;
  tag: 'horizontal' | 'vertical';
  /** Flat additive stat deltas the module applies (per ship). */
  effect: Record<string, number>;
  cost: ResourceBag;
  installable: boolean;
  /** Why it can't be installed, when `installable` is false (stable code). */
  code?: string;
}

/** One row of the live stat preview: base hull stat → with-modules value. */
export interface LoadoutStatLine {
  /** Canonical stat key (e.g. `attack`, `defense`). */
  stat: string;
  /** Localised display label (e.g. "Урон в атаке" / "Урон в защите"). */
  label: string;
  base: number;
  effective: number;
  delta: number;
}

/** The render-ready description of the loadout menu for one hull + draft loadout. */
export interface LoadoutModel {
  /** Unit id being fitted (the renderer resolves it to a display name). */
  unit: string;
  /** Whether this hull exposes any slots at all (false ⇒ carries no modules). */
  hasSlots: boolean;
  /** Every capacity slot, filled or empty, grouped by category order. */
  slots: LoadoutSlotView[];
  /** The flat installed loadout — exactly what a `unit.build` carries. */
  modules: string[];
  /** Modules to choose from, each flagged installable for the current draft. */
  palette: LoadoutOption[];
  /** Live per-ship stats: base vs with the current modules. */
  preview: LoadoutStatLine[];
  /** Per-order costs (×count): hull, modules, and their sum. */
  hullCost: ResourceBag;
  modulesCost: ResourceBag;
  totalCost: ResourceBag;
  /** How many ships this order builds (the whole stack shares one loadout). */
  count: number;
  /** Whether the ordering player can pay `totalCost`. */
  affordable: boolean;
}

export type LoadoutEditorResult = ({ ok: true } & LoadoutModel) | { ok: false; code: string };

/** Stats worth previewing for a ship, in display order. A line shows only when the
 *  base is non-zero or a module changes it (keeps the panel free of dead rows) —
 *  except the two combat numbers, which always show. */
const PREVIEW_STATS = [
  'attack',
  'defense',
  'hp',
  'shield',
  'speed',
  'cargoCapacity',
  'radarRange',
] as const;

/** Russian display labels. `attack` and `defense` are the ship's two combat
 *  numbers — its damage when ATTACKING and its return-fire when DEFENDING. */
const STAT_LABELS: Record<string, string> = {
  attack: 'Урон в атаке',
  defense: 'Урон в защите',
  hp: 'Корпус',
  shield: 'Щит',
  speed: 'Скорость',
  cargoCapacity: 'Трюм',
  radarRange: 'Радар',
};

/** Always shown, even at 0 — a ship's attack and defence are its combat identity. */
const ALWAYS_SHOWN = new Set<string>(['attack', 'defense']);

function scaleBag(bag: ResourceBag, n: number): ResourceBag {
  const out: ResourceBag = {};
  for (const [res, amt] of Object.entries(bag)) out[res] = amt * n;
  return out;
}

function addBags(a: ResourceBag, b: ResourceBag): ResourceBag {
  const out: ResourceBag = { ...a };
  for (const [res, amt] of Object.entries(b)) out[res] = (out[res] ?? 0) + amt;
  return out;
}

function affordable(cost: ResourceBag, resources: ResourceBag): boolean {
  return Object.entries(cost).every(([res, amt]) => (resources[res] ?? 0) >= amt);
}

/** Pure builder — the model is a function of (unit, modules, count) + data +
 *  purse. Returns null only when the unit id is unknown (the factory maps that to
 *  a fail-secure code). */
function buildModel(
  unit: string,
  modules: string[],
  count: number,
  data: GameData,
  resources: ResourceBag,
): LoadoutModel | null {
  const def: UnitDef | undefined = data.units[unit];
  if (!def) return null;

  // One slot view per capacity, filled from the installed modules of that type.
  const byType: Record<ShipSlotType, string[]> = { weapon: [], defense: [], utility: [] };
  for (const id of modules) {
    const m = data.modules[id];
    if (m) byType[m.slot].push(id);
  }
  const slots: LoadoutSlotView[] = [];
  for (const type of hullSlotTypes(def)) {
    const filled = byType[type];
    for (let i = 0; i < def.slots[type]; i++) {
      const id = filled[i];
      const m = id ? data.modules[id] : undefined;
      slots.push(id && m ? { type, moduleId: id, moduleName: m.name } : { type });
    }
  }

  const palette: LoadoutOption[] = Object.entries(data.modules).map(([id, m]) => {
    const check = canEquip(unit, def, modules, id, data);
    return {
      id,
      name: m.name,
      slot: m.slot,
      tag: m.tag,
      effect: m.effects.stats,
      cost: m.cost,
      installable: check.ok,
      ...(check.ok ? {} : { code: check.code }),
    };
  });

  const base = effectiveStats(def, {}, data);
  const eff = effectiveStats(def, { modules }, data);
  const preview: LoadoutStatLine[] = [];
  for (const stat of PREVIEW_STATS) {
    const b = base[stat] ?? 0;
    const e = eff[stat] ?? 0;
    if (ALWAYS_SHOWN.has(stat) || b !== 0 || e !== b) {
      preview.push({ stat, label: STAT_LABELS[stat] ?? stat, base: b, effective: e, delta: e - b });
    }
  }

  const hullCost = scaleBag(def.cost, count);
  const modulesCost = scaleBag(loadoutCost(modules, data), count);
  const totalCost = addBags(hullCost, modulesCost);

  return {
    unit,
    hasSlots: slots.length > 0,
    slots,
    modules,
    palette,
    preview,
    hullCost,
    modulesCost,
    totalCost,
    count,
    affordable: affordable(totalCost, resources),
  };
}

/** Open the editor for a hull. `opts.modules` seeds a draft loadout (default
 *  empty), `opts.count` the order size (default 1). Fail-secure on an unknown unit. */
export function createLoadoutEditor(
  unit: string,
  data: GameData,
  resources: ResourceBag,
  opts?: { modules?: string[]; count?: number },
): LoadoutEditorResult {
  const model = buildModel(unit, opts?.modules ?? [], opts?.count ?? 1, data, resources);
  if (!model) return { ok: false, code: 'E_UNKNOWN_UNIT' };
  return { ok: true, ...model };
}

/** What the player did in the editor. */
export type LoadoutEditorAction =
  | { kind: 'equip'; moduleId: string }
  | { kind: 'unequip'; moduleId: string }
  | { kind: 'setCount'; count: number };

/** Pure reducer: apply an editor action, returning a fresh model or a stable
 *  rejection. Equip goes through the core's `canEquip` (slot type, capacity,
 *  `allowed`, no duplicates) so the menu can never assemble an illegal loadout. */
export function applyLoadoutAction(
  action: LoadoutEditorAction,
  model: LoadoutModel,
  data: GameData,
  resources: ResourceBag,
): LoadoutEditorResult {
  const def = data.units[model.unit];
  if (!def) return { ok: false, code: 'E_UNKNOWN_UNIT' };

  let modules = model.modules;
  let count = model.count;
  switch (action.kind) {
    case 'equip': {
      const check = canEquip(model.unit, def, model.modules, action.moduleId, data);
      if (!check.ok) return { ok: false, code: check.code };
      modules = [...model.modules, action.moduleId];
      break;
    }
    case 'unequip': {
      if (!model.modules.includes(action.moduleId)) return { ok: false, code: 'E_NOT_INSTALLED' };
      modules = model.modules.filter((id) => id !== action.moduleId);
      break;
    }
    case 'setCount': {
      if (!Number.isSafeInteger(action.count) || action.count <= 0) {
        return { ok: false, code: 'E_BAD_COUNT' };
      }
      count = action.count;
      break;
    }
  }
  const next = buildModel(model.unit, modules, count, data, resources);
  if (!next) return { ok: false, code: 'E_UNKNOWN_UNIT' };
  return { ok: true, ...next };
}

/** The `unit.build` intent a confirmed loadout emits — the loadout rides in the
 *  payload as `modules`, to be stamped onto the built stack (locked thereafter). */
export interface BuildIntent {
  type: 'unit.build';
  payload: { planetId: string; unit: string; count: number; modules: string[] };
}

/** Resolve the "Построить" action: emit a build intent, or a stable rejection if
 *  no planet is chosen or the player can't pay. Fail-secure. */
export function resolveLoadoutBuild(
  model: LoadoutModel,
  planetId: string,
): { ok: true; action: BuildIntent } | { ok: false; code: string } {
  if (!planetId.trim()) return { ok: false, code: 'E_NO_PLANET' };
  if (!model.affordable) return { ok: false, code: 'E_INSUFFICIENT' };
  return {
    ok: true,
    action: {
      type: 'unit.build',
      payload: { planetId, unit: model.unit, count: model.count, modules: model.modules },
    },
  };
}
