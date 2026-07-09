/**
 * heroEffects — capability providers for the data-driven hero abilities whose
 * effect is NOT a `heroModule` built-in (`temp_lane`/`annihilate`). The exotic-effect
 * seam is defined by HERO-4: the `hero.ability` dispatcher looks up
 * `capability('hero.effect.<type>')` and hands it the validated cast; a missing
 * provider is `E_NO_EFFECT`. This module is the FIRST such provider — it proves the
 * seam end-to-end, so new ability effects arrive by adding a provider here (or in any
 * module), never by touching the kernel or the dispatcher.
 *
 * Contract (see `HeroEffect`): the effect runs AFTER the generic gates
 * (ownership / liveness / equipment / cooldown / range / cost) have passed. A plain
 * return commits cost + the `fx:<type>` cooldown; any `h.reject(code)` throws and the
 * kernel discards the whole draft (fail-secure, cost included).
 */
import type { GameModule } from '../kernel/module';
import type { HeroEffect } from './hero';

/**
 * `recall` — instantly bring the hero's ship home to its capital (`Hero.home`, the
 * respawn anchor). A teleport by design: it bypasses travel (like spawn/respawn, which
 * also set a fleet's node directly). Range-0 / untargeted; the 24h cooldown is the cost.
 */
const recall: HeroEffect = ({ heroId, hero, owner }, h) => {
  const fleetId = hero.fleetId;
  const fleet = fleetId !== undefined ? h.state.fleets[fleetId] : undefined;
  if (!fleet) return h.reject('E_HERO_NOT_DEPLOYED'); // nothing to recall (a reserve hero)
  // Can't warp a ship out of an active fight — that would need combat-side surgery.
  if (fleet.battleId != null && h.state.battles[fleet.battleId]) {
    return h.reject('E_FLEET_BUSY');
  }
  const home = hero.home;
  if (home === undefined || !h.state.planets[home]) return h.reject('E_NO_CAPITAL');
  // Already parked idle at the capital → no-op; reject so the cooldown isn't wasted.
  if (fleet.location === home && fleet.movement == null && fleet.edge == null) {
    return h.reject('E_SAME_LOCATION');
  }
  fleet.location = home;
  fleet.movement = null;
  fleet.edge = null; // clear any parked-on-lane state (edge is only valid while unlocated)
  hero.location = home; // the hero's node memory follows its ship (HERO-2)
  h.emit('hero.recalled', { owner, heroId, fleetId, to: home });
};

export const heroEffectsModule: GameModule = {
  id: 'heroEffects',
  version: '1.0.0',
  setup(api) {
    api.provideCapability<HeroEffect>('hero.effect.recall', recall);
  },
};
