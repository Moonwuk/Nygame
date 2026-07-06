import type { UnitStack } from '../state/gameState';
import type { GameData } from '../data/schemas';
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
