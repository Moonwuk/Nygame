/**
 * Generic trait reads (EFX-1). Traits are plain data strings on defs
 * (docs/architecture.md §2.2) — every engine check goes through this one
 * vocabulary instead of scattering `def.traits.includes(...)` point-reads.
 * Unknown ids resolve to `false` (fail-secure: absent data grants nothing).
 */
import type { GameData } from './schemas';
import type { UnitStack } from '../state/gameState';

/** Does a def (anything carrying a `traits` list) have `trait`? Undefined def → false. */
export function defHasTrait(
  def: { traits: readonly string[] } | undefined,
  trait: string,
): boolean {
  return def?.traits.includes(trait) ?? false;
}

/** Does the unit def registered under `unitId` carry `trait`? Unknown unit → false. */
export function unitHasTrait(data: GameData, unitId: string, trait: string): boolean {
  return defHasTrait(data.units[unitId], trait);
}

/** Does any LIVE stack (count > 0) in `stacks` carry `trait` on its unit def? */
export function stacksHaveTrait(
  data: GameData,
  stacks: readonly UnitStack[],
  trait: string,
): boolean {
  return stacks.some((s) => s.count > 0 && unitHasTrait(data, s.unit, trait));
}
