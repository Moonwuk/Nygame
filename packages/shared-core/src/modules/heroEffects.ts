/**
 * heroEffects — capability providers for the data-driven hero abilities whose
 * effect is NOT a `heroModule` built-in (`temp_lane`/`annihilate`). The exotic-effect
 * seam is defined by HERO-4: the `hero.ability` dispatcher looks up
 * `capability('hero.effect.<type>')` and hands it the validated cast; a missing
 * provider is `E_NO_EFFECT`. This module holds the providers — new ability effects
 * arrive by adding one here (or in any module), never by touching the kernel/dispatcher.
 *
 * Contract (see `HeroEffect`): the effect runs AFTER the generic gates
 * (ownership / liveness / equipment / cooldown / range / cost) have passed. A plain
 * return commits cost + the `fx:<type>` cooldown; any `h.reject(code)` throws and the
 * kernel discards the whole draft (fail-secure, cost included).
 */
import type { GameModule, HandlerContext } from '../kernel/module';
import type { Hero, GameState, PlanetId } from '../state/gameState';
import { distance } from '../state/route';
import { MS_PER_HOUR } from '../util/time';
import type { HeroEffect } from './hero';

/** The node a hero acts from: its ship's node while deployed, else its last node.
 *  Inlined (not imported from heroModule) to keep this provider self-contained. */
function heroNode(hero: Hero, state: GameState): PlanetId {
  if (hero.fleetId !== undefined) {
    const loc = state.fleets[hero.fleetId]?.location;
    if (typeof loc === 'string') return loc;
  }
  return hero.location;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

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

/**
 * `aura` — a TIME-BOXED combat aura (rally / bulwark). Casting stores a `{bonus, radius,
 * until}` buff on the hero; while live it feeds the `combat.damage` hook below for the
 * owner's fleets within `radius` of the hero's node — the temporary twin of the HERO-5
 * `rally_beacon` passive (which is the same contribution, always-on). Untargeted
 * (range-0), centred on the hero and following it. `params`: `combatBonus` OR
 * `defenseBonus` (both feed the single `combat.damage` hook the combat model exposes),
 * `radius`, `durationHours`.
 */
const aura: HeroEffect = ({ heroId, hero, ability, owner }, h) => {
  const p = ability.params;
  const bonus = num(p.combatBonus) || num(p.defenseBonus);
  const radius = num(p.radius);
  const durationHours = num(p.durationHours);
  // Malformed / no-op aura → reject so the player isn't charged the cooldown for nothing.
  if (bonus <= 0 || durationHours <= 0) return h.reject('E_BAD_EFFECT');
  const until = h.ctx.now + durationHours * MS_PER_HOUR;
  // Prune expired auras on cast (cooldown > duration ⇒ the list stays tiny), then add.
  const live = (hero.activeAuras ?? []).filter((a) => a.until > h.ctx.now);
  live.push({ bonus, radius, until });
  hero.activeAuras = live;
  h.emit('hero.aura', { owner, heroId, bonus, radius, until });
};

/** Σ of `owner`'s living heroes' ACTIVE auras covering a fleet fighting at `at`. Mirrors
 *  HERO-5 `passiveBonus` but for the time-boxed `hero.effect.aura` buffs (`until > now`,
 *  hero within the aura's `radius` of the battle node). Deterministic (insertion order,
 *  addition); expired auras and hero-less matches contribute nothing. */
function auraBonus(h: HandlerContext, owner: string, at: PlanetId): number {
  const heroes = h.state.heroes;
  if (heroes === undefined) return 0;
  const here = h.state.planets[at]?.position;
  if (here === undefined) return 0;
  const now = h.ctx.now;
  let total = 0;
  for (const hero of Object.values(heroes)) {
    if (hero.owner !== owner || hero.alive === false) continue;
    const auras = hero.activeAuras;
    if (auras === undefined || auras.length === 0) continue;
    const node = h.state.planets[heroNode(hero, h.state)]?.position;
    if (node === undefined) continue;
    const d = distance(node, here);
    for (const a of auras) if (a.until > now && d <= a.radius) total += a.bonus;
  }
  return total;
}

export const heroEffectsModule: GameModule = {
  id: 'heroEffects',
  version: '1.0.0',
  setup(api) {
    api.provideCapability<HeroEffect>('hero.effect.recall', recall);
    api.provideCapability<HeroEffect>('hero.effect.aura', aura);

    // Time-boxed combat aura → `combat.damage`, composing with the base default and the
    // heroModule contributions (multiple registrants chain; ×-factors commute, so the
    // module order is immaterial). Same side/attacker read as the HERO-5 aura: the buff
    // rides the side DEALING the hit (covers its attack and its return-fire defense).
    api.hook<number>('combat.damage', (base, args, h) => {
      const { battleId, attacker } = (args ?? {}) as { battleId?: string; attacker?: string };
      if (typeof battleId !== 'string' || typeof attacker !== 'string') return base;
      const battle = h.state.battles[battleId];
      if (!battle) return base;
      const side = battle.attacker.owner === attacker ? battle.attacker : battle.defender;
      if (side.ref.kind !== 'fleet') return base; // the aura is a fleet bonus only
      const bonus = auraBonus(h, attacker, battle.location);
      return bonus !== 0 ? base * (1 + bonus) : base;
    });
  },
};
