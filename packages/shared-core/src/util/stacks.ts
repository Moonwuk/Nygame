import type { UnitStack } from '../state/gameState';
import type { GameData } from '../data/schemas';

/** A healthy (non-combat) stack of `unit` in `stacks`, if any. */
export function findHealthyStack(stacks: UnitStack[], unit: string): UnitStack | undefined {
  return stacks.find((s) => s.unit === unit && s.hp === undefined);
}

/** Adds `count` units to a stack array, merging into an existing healthy stack
 *  of the same type when one exists, else appending a fresh stack. */
export function addUnits(stacks: UnitStack[], unit: string, count: number): void {
  const stack = findHealthyStack(stacks, unit);
  if (stack) {
    stack.count += count;
  } else {
    stacks.push({ unit, count });
  }
}

/** Sums `count * stat` across unit stacks, looking up each unit's definition.
 *  Stacks whose unit is missing from `data` are silently skipped. */
export function sumUnitStat(stacks: readonly UnitStack[], data: GameData, stat: string): number {
  let total = 0;
  for (const s of stacks) {
    const def = data.units[s.unit];
    if (def) {
      total += s.count * (def.stats[stat] ?? 0);
    }
  }
  return total;
}
