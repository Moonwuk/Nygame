import type { ResourceBag } from '../data/schemas';

/**
 * Treasury arithmetic over a `ResourceBag` (a player's purse). Pure helpers shared
 * by the modules that spend resources (construction, technology); a missing line
 * counts as zero so partial bags compare and pay correctly.
 */

/** True if the treasury can cover every line of `cost`. */
export function canAfford(treasury: ResourceBag, cost: ResourceBag): boolean {
  for (const res of Object.keys(cost)) {
    if ((treasury[res] ?? 0) < (cost[res] ?? 0)) {
      return false;
    }
  }
  return true;
}

/** Deducts `cost` from the treasury in place (caller has checked affordability). */
export function payCost(treasury: ResourceBag, cost: ResourceBag): void {
  for (const res of Object.keys(cost)) {
    const amount = cost[res] ?? 0;
    if (amount !== 0) {
      treasury[res] = (treasury[res] ?? 0) - amount;
    }
  }
}
