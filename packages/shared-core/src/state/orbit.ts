import { getStance } from './diplomacy';
import type { Fleet, GameState, PlanetId, PlayerId } from './gameState';

/**
 * THE one predicate for "this fleet is actively shelling the world below"
 * (GDD §7.4) — shared by the orbital module (damage) and the economy /
 * construction freeze (via {@link bombardedPlanets}), so the rule can't fork.
 *
 * A fleet shells only when ALL hold:
 *  - bombardment is switched on and the fleet sits on the NEAR orbit of a world;
 *  - it is NOT pinned in a melee (`battleId`): a pinned fleet is busy fighting —
 *    it neither shells nor freezes the planet (bug-hunt MAJOR: a relief fleet
 *    must lift the siege it engages, not shield the bombarder);
 *  - the world is OWNED and `hostile(fleet.owner, planet.owner)` — an owner
 *    mismatch alone is not enough; a fleet over a neutral or allied world
 *    freezes nothing.
 *
 * `hostile` is injected because the projection differs by layer: a module passes
 * combat's capability-aware `isHostile(h, …)`; pure state readers fall back to
 * the D1 stance read (`war`) — the capability's base mapping is the same, so the
 * two agree whenever no module overrides the projection.
 */
export function isActivelyBombarding(
  state: GameState,
  fleet: Fleet,
  hostile: (a: PlayerId, b: PlayerId) => boolean,
): boolean {
  if (!fleet.bombarding || fleet.battleId || fleet.orbit !== 'near' || fleet.location === null) {
    return false;
  }
  const planet = state.planets[fleet.location];
  return planet !== undefined && planet.owner !== null && hostile(fleet.owner, planet.owner);
}

/** The D1 fallback hostility read: only an explicit `war` stance is hostile —
 *  the same base mapping the `diplomacy` capability projects. */
function stanceHostile(state: GameState): (a: PlayerId, b: PlayerId) => boolean {
  return (a, b) => getStance(state, a, b) === 'war';
}

/**
 * Builds the set of all currently-bombarded planet ids in one O(fleets) pass.
 * Callers that check bombardment for multiple planets (economy, construction)
 * call this once and then use `Set.has` — O(1) per planet instead of the
 * previous O(fleets) per planet. Per-fleet rule: {@link isActivelyBombarding}.
 */
export function bombardedPlanets(state: GameState): Set<PlanetId> {
  const set = new Set<PlanetId>();
  const hostile = stanceHostile(state);
  for (const fleet of Object.values(state.fleets)) {
    if (isActivelyBombarding(state, fleet, hostile)) {
      set.add(fleet.location as PlanetId);
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
