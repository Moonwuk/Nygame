import type { Battle, BattleSide, GameState, Hero, PlanetId } from './gameState';

/**
 * Shared pure hero/battle reads for the hero-family modules (`hero`,
 * `heroEffects`). They live in the neutral state layer so a provider module
 * never has to import another module for them (invariant #3) — and so the
 * semantics can't fork across copies (a `heroNode` clone with swapped
 * parameters used to live in heroEffects).
 */

/** The node a hero acts from (HERO-2 — the hero's position IS its ship): the fleet's
 *  current node while deployed; mid-flight (`location: null`) or shipless it falls back
 *  to `Hero.location` — the last confirmed node, synced on transit/arrival and doubling
 *  as the respawn anchor after `home`. */
export function heroNode(state: GameState, hero: Hero): PlanetId {
  if (hero.fleetId) {
    const loc = state.fleets[hero.fleetId]?.location;
    if (typeof loc === 'string') return loc;
  }
  return hero.location;
}

/** The FLEET side dealing this `combat.damage` hit, or null when the hook args
 *  don't resolve to one (malformed args, unknown battle, or a garrison side —
 *  hero auras are fleet bonuses only). `args.attacker` is the owner DEALING the
 *  hit, so buffing that side covers both its attack and its return-fire defense.
 *  The one copy of the preamble both hero-family `combat.damage` hooks share. */
export function fleetSideDealingHit(
  state: GameState,
  battleId: unknown,
  attacker: unknown,
): { battle: Battle; side: BattleSide & { ref: { kind: 'fleet'; fleetId: string } } } | null {
  if (typeof battleId !== 'string' || typeof attacker !== 'string') return null;
  const battle = state.battles[battleId];
  if (!battle) return null;
  const side = battle.attacker.owner === attacker ? battle.attacker : battle.defender;
  if (side.ref.kind !== 'fleet') return null;
  return { battle, side: side as BattleSide & { ref: { kind: 'fleet'; fleetId: string } } };
}
