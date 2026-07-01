import { getStance } from './diplomacy';
import type { GameState, PlanetId } from './gameState';

/**
 * Builds the set of all currently-bombarded planet ids in one O(fleets) pass.
 * Callers that check bombardment for multiple planets (economy, construction)
 * call this once and then use `Set.has` — O(1) per planet instead of the
 * previous O(fleets) per planet.
 *
 * A fleet only bombards a HOSTILE owned world: an at-`war` stance (the same gate
 * combat's `isHostile` / the AA loop use). An owner mismatch alone is not enough
 * — a fleet parked over a neutral or an at-peace/allied world freezes nothing.
 */
export function bombardedPlanets(state: GameState): Set<PlanetId> {
  const set = new Set<PlanetId>();
  for (const fleet of Object.values(state.fleets)) {
    if (
      fleet.bombarding &&
      fleet.location !== null &&
      fleet.orbit === 'near'
    ) {
      const planet = state.planets[fleet.location];
      if (planet && planet.owner !== null && getStance(state, fleet.owner, planet.owner) === 'war') {
        set.add(fleet.location);
      }
    }
  }
  return set;
}

/**
 * Is a planet currently being bombarded? True when a hostile fleet sits on its
 * NEAR orbit with bombardment switched on (GDD §7.4). A pure query on state —
 * shared by economy (production is frozen) and construction (no new orders, and
 * in-flight builds are paused) so the rule lives in one place.
 *
 * For bulk checks (iterating many planets) prefer `bombardedPlanets(state)` to
 * avoid an O(fleets) scan per planet.
 */
export function isBombarded(state: GameState, planetId: PlanetId): boolean {
  return bombardedPlanets(state).has(planetId);
}
