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

/** The one mutation both directions share: add `sign × bag` to the treasury in
 *  place, skipping zero lines so an empty line never materializes a `0` entry. */
function addToTreasury(treasury: ResourceBag, bag: ResourceBag, sign: 1 | -1): void {
  for (const res of Object.keys(bag)) {
    const amount = bag[res] ?? 0;
    if (amount !== 0) {
      treasury[res] = (treasury[res] ?? 0) + sign * amount;
    }
  }
}

/** Deducts `cost` from the treasury in place (caller has checked affordability). */
export function payCost(treasury: ResourceBag, cost: ResourceBag): void {
  addToTreasury(treasury, cost, -1);
}

/** Adds `amount` to the treasury in place — the symmetric inverse of `payCost`,
 *  for refunding a cancelled/paused construction. */
export function refundCost(treasury: ResourceBag, amount: ResourceBag): void {
  addToTreasury(treasury, amount, 1);
}
