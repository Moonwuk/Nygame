import type { UnitStack } from '../state/gameState';
import type { GameData, UnitDef } from '../data/schemas';
import { effectiveStats } from './loadout';

/** Canonical, order-independent signature of a loadout (one instance per module
 *  id, so it's a set): sorted ids joined. Empty/absent loadout → `''`. Two stacks
 *  merge only when this matches — a fitted stack never silently absorbs a bare one. */
function loadoutKey(modules?: readonly string[]): string {
  if (!modules || modules.length === 0) return '';
  return [...modules].sort().join(',');
}

/** A healthy (non-combat) stack of `unit` with the SAME loadout in `stacks`, if
 *  any — full hull AND full shield (both pools undefined), so a battle-damaged or
 *  differently-fitted stack never silently merges. */
export function findHealthyStack(
  stacks: UnitStack[],
  unit: string,
  modules?: readonly string[],
): UnitStack | undefined {
  const key = loadoutKey(modules);
  return stacks.find(
    (s) =>
      s.unit === unit &&
      s.hp === undefined &&
      s.shieldHp === undefined &&
      loadoutKey(s.modules) === key,
  );
}

/** Adds `count` units to a stack array, merging into an existing healthy stack of
 *  the same type AND loadout when one exists, else appending a fresh stack (which
 *  carries `modules` when a loadout was given). */
export function addUnits(
  stacks: UnitStack[],
  unit: string,
  count: number,
  modules?: readonly string[],
): void {
  const stack = findHealthyStack(stacks, unit, modules);
  if (stack) {
    stack.count += count;
  } else {
    const fresh: UnitStack = { unit, count };
    if (modules && modules.length > 0) fresh.modules = [...modules];
    stacks.push(fresh);
  }
}

/** Sums `count * stat` across unit stacks, reading each stack's EFFECTIVE stat
 *  (base + its installed modules) so fitted ships count for what they carry.
 *  Stacks whose unit is missing from `data` are silently skipped. A stack with no
 *  modules yields exactly its base stat, so unfitted fleets are unchanged. */
export function sumUnitStat(stacks: readonly UnitStack[], data: GameData, stat: string): number {
  let total = 0;
  for (const s of stacks) {
    const def = data.units[s.unit];
    if (def) {
      total += s.count * (effectiveStats(def, s, data)[stat] ?? 0);
    }
  }
  return total;
}

/** Combat line cap (Bytro-style): only this many units per combatant side fire in
 *  a volley — everyone beyond the cap only adds hull/shield to soak damage. Binds
 *  melee attack/defense, bombardment and artillery standoff; NOT AA, cargo or the
 *  receiving hull pools. A balance constant (like BROWNOUT) — data after shakeout. */
export const COMBAT_UNIT_CAP = 10;

/** `sumUnitStat` bounded by the combat line cap: only the `cap` strongest units
 *  (per-unit EFFECTIVE `stat`, strongest first, ties by unit id) contribute.
 *  Stacks the optional `eligible` filter rejects neither fire nor consume budget
 *  (artillery standoff spends the cap on artillery units only). Deterministic:
 *  the sort key is (stat desc, unit id asc); stacks tied on both have identical
 *  per-unit contributions, so their relative order can't change the sum. */
export function cappedUnitStat(
  stacks: readonly UnitStack[],
  data: GameData,
  stat: string,
  eligible?: (def: UnitDef) => boolean,
  cap: number = COMBAT_UNIT_CAP,
): number {
  const rows: Array<{ per: number; unit: string; count: number }> = [];
  for (const s of stacks) {
    if (s.count <= 0) continue;
    const def = data.units[s.unit];
    if (!def || (eligible && !eligible(def))) continue;
    rows.push({ per: effectiveStats(def, s, data)[stat] ?? 0, unit: s.unit, count: s.count });
  }
  rows.sort((a, b) => b.per - a.per || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  let budget = cap;
  let total = 0;
  for (const r of rows) {
    if (budget <= 0) break;
    const n = Math.min(r.count, budget);
    total += n * r.per;
    budget -= n;
  }
  return total;
}
