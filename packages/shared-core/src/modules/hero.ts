import { hoursToMs } from '../action/types';
import type { HeroAbilityDef, HeroPassiveDef } from '../data/schemas';
import type { GameModule, HandlerContext } from '../kernel/module';
import type {
  Fleet,
  GameState,
  Hero,
  PlanetId,
  PlayerId,
  ResourceBag,
  TempLane,
} from '../state/gameState';
import { stacksHaveTrait } from '../data/traits';
import { getStance, stanceToRelation } from '../state/diplomacy';
import { fleetSideDealingHit, heroNode } from '../state/heroes';
import { distance } from '../state/route';
import { isCapturable } from '../state/sectorKind';
import { canInstall } from '../util/fitting';
import { addUnits } from '../util/stacks';
import { canAfford, payCost } from '../util/treasury';

/**
 * Hero — a per-player entity (one hero each) with a position on the map and ability
 * cooldowns (GDD hero concept). It acts from its current node and registers two
 * abilities through the bus, plus the `fleet.speed` bonus for its temp lanes:
 *
 *   - `hero.move {to}` — redeploy the hero to a node the player owns.
 *   - `hero.path.create {to}` — open a TEMPORARY PUBLIC LANE from the hero's node to
 *     a nearby node: a real, routable graph edge (added to `Planet.links`) for a
 *     limited time, that the owner's fleets traverse with a speed bonus. Expiry is a
 *     scheduled `hero.path.expire`; the route cache invalidates via `state.topology`.
 *   - `planet.annihilate {planetId}` — destroy a planet in range: it stays a node
 *     (you can still fly through) but its `kind`/`planetType` flip to an uncapturable
 *     `dead_world`, garrison + buildings are gone, ownership drops. Victory recomputes
 *     automatically (lost score + one fewer ownable world).
 *
 * HERO-2 (docs/heroes.md) — the hero's position IS its ship: while deployed
 * (`Hero.fleetId`) every ability acts from the SHIP's current node (`heroNode`), the
 * hero's `location` trails the ship on `fleet.transit`/`fleet.arrived` (ability origin
 * mid-flight + respawn anchor), `hero.move` is rejected (`E_HERO_DEPLOYED` — move the
 * fleet instead), and `fleet.destroyed` is a death signal alongside `unit.died`.
 *
 * HERO-3 (docs/heroes.md) — manual deploy: `hero.spawn {heroId, at}` raises the hero's
 * ship at an OWNED world (unit from the archetype's `ship.unit`, default `hero`),
 * gated by liveness (`E_HERO_ALIVE`), the respawn cooldown (`E_RESPAWN_COOLDOWN`),
 * spawn legality (`E_BAD_SPAWN`) and the per-player active cap of 3 (`E_HERO_CAP`);
 * the scheduled auto-respawn honors the same cap and shares the same deploy body.
 * HERO-8: CARRYING an ability of type `spawn_allied` / `spawn_fleet` widens the legal
 * targets to allied worlds (diplomacy `alliance`) / the player's own fleets (the hero
 * boards the host, which then carries the hero aura).
 *
 * HERO-7 (docs/heroes.md) — the skill tree: `hero.skill.unlock {heroId, node}` unlocks
 * a `data.heroSkillTrees` node for a living, owned hero, gated by the node's `branch`
 * (vs the archetype's branch), its `requires` parents and its treasury `cost`; the
 * node's grants land on the instance (`abilities` / `passives`) so the existing
 * HERO-4/HERO-5 engines pick them up with no extra wiring.
 *
 * HERO-6 (docs/heroes.md) — ship fittings: `hero.fit {heroId, fitting}` installs a
 * `data.heroFittings` component into one of the archetype's `slots` (for good — the
 * ship-modules "no refit" owner rule). The fitting's `grants` land on the instance
 * loadout (live via HERO-4/5); its `statMods` ride as data until the effective-stats
 * seam (SHIP-3/4) makes them live.
 *
 * HERO-4 (docs/heroes.md) adds the generic, data-driven dispatcher on top:
 *
 *   - `hero.ability {heroId, abilityId, target?}` — cast an ability the hero carries
 *     (`Hero.abilities`) out of the `data.heroAbilities` catalog. The module validates
 *     ownership / liveness / equipment / cooldown / range / cost generically from the
 *     `HeroAbilityDef`, then dispatches on its `type`: the built-in `temp_lane` /
 *     `annihilate` effects (the two legacy actions above run the SAME effect bodies),
 *     or the capability `hero.effect.<type>` for exotic types plugged in by another
 *     module. Unknown type with no capability → `E_NO_EFFECT` (fail-secure: data may
 *     promise only what some engine piece implements).
 *
 * HERO-5 (docs/heroes.md) — data-driven passives: a living hero contributes its
 * `Hero.passives` (→ `data.heroPassives`, `{hook, scope, params{bonus, radius}}`) into
 * the `fleet.speed` / `combat.damage` pipelines. Scopes: `heroFleet` (the hero's own
 * ship's fleet) and `ownFleetsNear` (owner fleets within `radius` of the hero's node).
 * Applied as ×(1 + Σ bonuses) on top of the lane bonus / base +5% aura; a dead hero
 * or an unknown passive id contributes nothing (graceful degradation).
 *
 * State lives in `GameState.heroes` / `tempLanes` (JSON, deterministic); durations go
 * through `schedule`; the speed bonus through the `fleet.speed` hook. No kernel change.
 */

const PATH_SPEED_BONUS = 0.5; // +50% for the owner's fleets along the lane
const PATH_DURATION_HOURS = 6;
const PATH_RANGE = 600; // max Euclidean span the hero can bridge
const PATH_COOLDOWN_HOURS = 12;
const ANNIHILATE_RANGE = 500;
const ANNIHILATE_COOLDOWN_HOURS = 48;
const DEAD_KIND = 'dead_world';
const DEAD_PLANET_TYPE = 'dead_world';
// Projection hero — the player's first hero: a ship that rides in a fleet, granting
// it a flat combat aura, and returns to its home world a while after dying.
const HERO_TRAIT = 'hero';
const HERO_UNIT = 'hero';
/** Flat combat bonus the hero grants its whole fleet (both attack and defense). */
const HERO_COMBAT_BONUS = 0.05;
/** Game-hours before a slain projection hero respawns at its home world. */
const HERO_RESPAWN_HOURS = 24;
/** Max heroes a player may have DEPLOYED (commanding a live ship) at once —
 *  docs/heroes.md: «игрок может выставить до трёх одновременно». */
const HERO_ACTIVE_CAP = 3;
/** Ability TYPES that passively relax the `hero.spawn` target gate (HERO-8): a hero
 *  CARRYING an ability of the type may form its ship aboard one of the player's own
 *  fleets / at an allied world. Markers read by `hero.spawn`, not castable effects
 *  (casting one still fail-secures to `E_NO_EFFECT`). */
const SPAWN_FLEET_TYPE = 'spawn_fleet';
const SPAWN_ALLIED_TYPE = 'spawn_allied';

function heroOf(state: GameState, playerId: PlayerId): Hero | undefined {
  // Instance-keyed roster: the player's FIRST hero by SORTED instance id (BF-13).
  // Insertion order is not durable — a JSONB round-trip (hibernation) re-orders
  // object keys, and with several heroes per player an insertion-order find would
  // pick a DIFFERENT hero after a restart than in the replay.
  const heroes = state.heroes ?? {};
  for (const id of Object.keys(heroes).sort()) {
    if (heroes[id]!.owner === playerId) return heroes[id];
  }
  return undefined;
}

/** The hero commanding this fleet (its ship), if any. Insertion-order stable. The
 *  undefined guard keeps the hero-less common case allocation-free — this runs on
 *  every fleet.transit/arrived and both death signals. */
function heroByFleet(state: GameState, fleetId: string): Hero | undefined {
  if (state.heroes === undefined) return undefined;
  return Object.values(state.heroes).find((hero) => hero.fleetId === fleetId);
}

/** Does this fleet currently carry a living hero unit? (drives the fleet aura). */
function fleetHasHero(h: HandlerContext, fleetId: string): boolean {
  const fleet = h.state.fleets[fleetId];
  if (!fleet) return false;
  return stacksHaveTrait(h.ctx.data, fleet.units, HERO_TRAIT);
}

/** ms from now after `hours`, compressed by the match timeScale like every duration. */
function after(h: HandlerContext, hours: number): number {
  return h.ctx.now + hoursToMs(h.ctx, hours);
}

function onCooldown(hero: Hero, ability: string, now: number): boolean {
  return ((hero.cooldowns ?? {})[ability] ?? 0) > now;
}

/** Live/deployed gates shared by every hero CAST (the legacy actions and the
 *  generic `hero.ability` dispatcher): a dead hero can't act, and a reserve hero
 *  (never deployed, `alive` undefined) must not cast from the bench — it would
 *  be an invulnerable caster outside HERO_ACTIVE_CAP (bughunt BF-24). */
function gateLiveDeployed(h: HandlerContext, hero: Hero): void {
  if (hero.alive === false) h.reject('E_HERO_DEAD');
  if (hero.alive !== true) h.reject('E_HERO_NOT_DEPLOYED');
}

/** The legacy casters' shared gate tail (`hero.path.create`, `planet.annihilate`):
 *  the same origin/target/range/cooldown sequence `hero.ability` derives from a
 *  `HeroAbilityDef`, hand-rolled ONCE — per-action copies drifted before and
 *  opened a bypass. Origin is the hero's node; every failed gate rejects. */
function gateRangedCast(
  h: HandlerContext,
  hero: Hero,
  targetId: string,
  range: number,
  cooldown: string,
): void {
  const origin = h.state.planets[heroNode(h.state, hero)];
  const dest = h.state.planets[targetId];
  if (!origin || !dest) h.reject('E_NO_PLANET');
  if (distance(origin.position, dest.position) > range) h.reject('E_OUT_OF_RANGE');
  if (onCooldown(hero, cooldown, h.ctx.now)) h.reject('E_COOLDOWN');
}

/** Adds an undirected `links` edge a→b; returns true if it was newly added. */
function addLink(state: GameState, a: PlanetId, b: PlanetId): boolean {
  const pa = state.planets[a];
  if (!pa) return false;
  const links = pa.links ?? (pa.links = []);
  if (links.includes(b)) return false;
  links.push(b);
  links.sort(); // keep JSON-stable
  return true;
}

function removeLink(state: GameState, a: PlanetId, b: PlanetId): void {
  const pa = state.planets[a];
  if (pa?.links) pa.links = pa.links.filter((x) => x !== b);
}

/** Arguments handed to a custom ability effect (capability `hero.effect.<type>`). */
export interface HeroEffectArgs {
  heroId: string;
  hero: Hero;
  abilityId: string;
  ability: HeroAbilityDef;
  owner: PlayerId;
  target?: string;
}
/** A custom ability effect plugged in by another module as `hero.effect.<type>`.
 *  Runs after the generic gates (ownership/liveness/equipment/cooldown/range/cost)
 *  have passed; it must `h.reject(code)` on any failure of its own (fail-secure —
 *  a plain return means success and commits cost + cooldown). */
export type HeroEffect = (args: HeroEffectArgs, h: HandlerContext) => void;

/** Does `passive` apply to this fleet/node for a hero? Pure scope evaluation. */
function passiveApplies(
  state: GameState,
  hero: Hero,
  passive: HeroPassiveDef,
  args: { fleetId?: string; node?: PlanetId },
): boolean {
  if (passive.scope === 'heroFleet') {
    return args.fleetId !== undefined && hero.fleetId === args.fleetId;
  }
  // ownFleetsNear: the affected fleet's node within `radius` of the hero's node.
  if (args.node === undefined) return false;
  const heroPlanet = state.planets[heroNode(state, hero)];
  const nodePlanet = state.planets[args.node];
  if (!heroPlanet || !nodePlanet) return false;
  return distance(heroPlanet.position, nodePlanet.position) <= passive.params.radius;
}

/** Σ of `owner`'s living heroes' passive bonuses feeding `hook`, for a fleet at a node
 *  (HERO-5). Deterministic: heroes in insertion order, passives in list order; unknown
 *  ids and dead heroes contribute nothing. */
function passiveBonus(
  h: HandlerContext,
  hook: HeroPassiveDef['hook'],
  owner: PlayerId,
  args: { fleetId?: string; node?: PlanetId },
): number {
  if (h.state.heroes === undefined) return 0; // hero-less match: keep the hot hooks free
  let total = 0;
  // Sorted (BF-13): float summation order must not follow JSONB key order.
  for (const id of Object.keys(h.state.heroes).sort()) {
    const hero = h.state.heroes[id]!;
    // DEPLOYED heroes only — a reserve hero (alive undefined) must not radiate
    // passives from the bench (bughunt BF-24).
    if (hero.owner !== owner || hero.alive !== true) continue;
    for (const id of hero.passives ?? []) {
      const def = h.ctx.data.heroPassives[id];
      if (!def || def.hook !== hook) continue;
      if (passiveApplies(h.state, hero, def, args)) total += def.params.bonus;
    }
  }
  return total;
}

/** How many of `owner`'s heroes currently command a live ship (the HERO_ACTIVE_CAP
 *  ledger). A stale `fleetId` (ship already gone) does not count. */
function activeHeroCount(state: GameState, owner: PlayerId): number {
  return Object.values(state.heroes ?? {}).filter(
    (x) =>
      x.owner === owner &&
      x.alive !== false &&
      x.fleetId !== undefined &&
      state.fleets[x.fleetId] !== undefined,
  ).length;
}

/** The hull the hero's ship is made of: the archetype's `ship.unit`, else the default
 *  projection `hero` unit (graceful when the archetype/data is absent). */
function heroShipUnit(h: HandlerContext, hero: Hero): string {
  return (
    (hero.archetype !== undefined ? h.ctx.data.heroes[hero.archetype]?.ship.unit : undefined) ??
    HERO_UNIT
  );
}

/** Does the hero CARRY an ability of the given effect `type`? (HERO-8 marker check —
 *  the ability relaxes a gate by being equipped, not by being cast.) */
function carriesAbilityType(h: HandlerContext, hero: Hero, type: string): boolean {
  return (hero.abilities ?? []).some(
    (id) => typeof id === 'string' && h.ctx.data.heroAbilities[id]?.type === type,
  );
}

/** Form the hero's ship at `at` — the single deploy path shared by the scheduled
 *  respawn and the manual `hero.spawn`: mint a one-ship fleet (unit resolved from the
 *  archetype's `ship.unit`, defaulting to the `hero` unit), link it, mark alive. */
function formHeroShip(h: HandlerContext, hero: Hero, at: PlanetId): string {
  const seq = (h.state.heroSeq ?? 0) + 1;
  h.state.heroSeq = seq;
  const fleetId = `hero:${hero.owner}:${seq}`;
  const newFleet: Fleet = {
    id: fleetId,
    owner: hero.owner,
    location: at,
    movement: null,
    units: [{ unit: heroShipUnit(h, hero), count: 1 }],
    traits: [],
    orbit: 'near',
  };
  h.state.fleets[fleetId] = newFleet;
  hero.alive = true;
  hero.location = at;
  hero.fleetId = fleetId;
  return fleetId;
}

/** Board the hero onto an existing fleet (HERO-8 `spawn_fleet`): its ship joins the
 *  host's stack (the whole fleet then enjoys the hero aura), the hero commands the
 *  host. Mid-flight hosts keep the hero's node memory unchanged. */
function boardHeroShip(h: HandlerContext, hero: Hero, host: Fleet): void {
  addUnits(host.units, heroShipUnit(h, hero), 1);
  hero.alive = true;
  if (typeof host.location === 'string') hero.location = host.location;
  hero.fleetId = host.id;
}

/** Charge `cost` to the player's treasury or reject — the shared terminal gate of every
 *  priced hero action (`hero.ability` / `hero.skill.unlock` / `hero.fit`). Charges the
 *  DRAFT, so a later reject in the same handler still discards the payment. */
function chargeOrReject(h: HandlerContext, playerId: PlayerId, cost: ResourceBag): void {
  const player = h.state.players[playerId];
  if (!player) return h.reject('E_NO_PLAYER');
  if (!canAfford(player.resources, cost)) return h.reject('E_INSUFFICIENT');
  payCost(player.resources, cost);
}

/** Extend the hero's instance loadout with a grant (shared by skill nodes, HERO-7, and
 *  fittings, HERO-6). Deduped — a grant the hero already carries changes nothing, so
 *  no source can stack the same passive/ability twice. */
function applyGrants(hero: Hero, grants: { ability?: string; passive?: string }): void {
  if (grants.ability !== undefined && !(hero.abilities ?? []).includes(grants.ability)) {
    (hero.abilities ??= []).push(grants.ability);
  }
  if (grants.passive !== undefined && !(hero.passives ?? []).includes(grants.passive)) {
    (hero.passives ??= []).push(grants.passive);
  }
}

/** Put a living hero into the dead/respawning state — the single death path shared by
 *  both death signals (`unit.died` for the hero stack, `fleet.destroyed` for the whole
 *  ship). Caller has checked the hero is alive. */
function killHero(h: HandlerContext, hero: Hero): void {
  hero.alive = false;
  delete hero.fleetId; // its ship is gone
  const respawnAt = after(h, HERO_RESPAWN_HOURS);
  hero.cooldowns = hero.cooldowns ?? {};
  hero.cooldowns.respawn = respawnAt;
  h.schedule(respawnAt, 'hero.respawn', { heroId: hero.id });
  h.emit('hero.died', { owner: hero.owner, heroId: hero.id, at: h.ctx.now });
}

/** A numeric knob out of an ability's free-form `params`, with an engine fallback. */
function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Cooldown-ledger key for an ability. Built-in types share the legacy actions' keys
 *  (`path` / `annihilate`) so the generic and legacy routes can never be combined to
 *  double-fire the same effect; a custom type cools down per effect TYPE for the same
 *  reason (two catalog abilities dispatching to one `hero.effect.<x>` share a cooldown).
 *  The `fx:` prefix keeps custom keys clear of the reserved `path`/`annihilate`/`respawn`
 *  ledger slots. */
function cooldownKey(type: string): string {
  if (type === 'temp_lane') return 'path';
  if (type === 'annihilate') return 'annihilate';
  return `fx:${type}`;
}

/** Targeting reach of an ability. The built-in effect types are inherently targeted, so
 *  an omitted/zero `range` falls back to the engine constant the legacy action enforces
 *  (fail-secure: a catalog omission must never mean "unlimited reach"); for custom types
 *  0 keeps the schema meaning "self / untargeted". */
function abilityRange(def: HeroAbilityDef): number {
  if (def.range > 0) return def.range;
  if (def.type === 'temp_lane') return PATH_RANGE;
  if (def.type === 'annihilate') return ANNIHILATE_RANGE;
  return 0;
}

/** The temp-lane effect body (shared by `hero.path.create` and `hero.ability`):
 *  link both ways, record the lane, schedule expiry, emit. Rejects on a
 *  same-location or unknown-node target; range/cooldown gates belong to callers. */
function castTempLane(
  h: HandlerContext,
  playerId: PlayerId,
  hero: Hero,
  to: PlanetId,
  opts: { durationHours: number; speedBonus: number },
): void {
  const from = heroNode(h.state, hero);
  if (to === from) return h.reject('E_SAME_LOCATION');
  if (!h.state.planets[from] || !h.state.planets[to]) return h.reject('E_NO_PLANET');
  const addedLink = addLink(h.state, from, to);
  addLink(h.state, to, from);
  h.state.topology = (h.state.topology ?? 0) + 1; // invalidate the route cache
  const seq = (h.state.heroSeq ?? 0) + 1;
  h.state.heroSeq = seq;
  const expiresAt = after(h, opts.durationHours);
  const lane: TempLane = {
    id: `lane:${seq}`,
    owner: playerId,
    from,
    to,
    speedBonus: opts.speedBonus,
    expiresAt,
    addedLink,
  };
  (h.state.tempLanes ??= []).push(lane);
  h.schedule(expiresAt, 'hero.path.expire', { laneId: lane.id });
  h.emit('hero.path.created', { owner: playerId, from, to, laneId: lane.id });
}

/** The annihilation TARGET gate: a real, ownable world that isn't already a dead
 *  world. Empty space (uncapturable) and a previously-annihilated dead world are
 *  both rejected. Shared by the legacy `planet.annihilate` pre-gate (which checks
 *  the target before range/cooldown — pinned by tests) and the cast body. */
function requireDestructible(h: HandlerContext, planetId: PlanetId): NonNullable<
  GameState['planets'][string]
> {
  const planet = h.state.planets[planetId];
  if (!planet) h.reject('E_NO_PLANET');
  if (!isCapturable(h.ctx.data, planet) || planet.kind === DEAD_KIND) {
    h.reject('E_NOT_DESTRUCTIBLE');
  }
  return planet;
}

/** The annihilation effect body (shared by `planet.annihilate` and `hero.ability`):
 *  flip the world to a neutral dead world and emit. Rejects unknown / undestructible
 *  targets; range/cooldown gates belong to callers. */
function castAnnihilate(h: HandlerContext, playerId: PlayerId, planetId: PlanetId): void {
  const planet = requireDestructible(h, planetId);
  const previousOwner = planet.owner;
  planet.owner = null; // neutral again — a depleted world anyone can re-claim
  planet.buildings = [];
  planet.garrison = [];
  planet.kind = DEAD_KIND; // capturable + buildable, but worth only the flat 10
  planet.planetType = DEAD_PLANET_TYPE; // no defense edge, but rich in metal (+30%)
  h.emit('planet.destroyed', { planetId, by: playerId, from: previousOwner });
}

export const heroModule: GameModule = {
  id: 'hero',
  version: '1.0.0',
  setup(api) {
    api.onAction('hero.move', (action, h) => {
      const { to } = action.payload as { to?: string };
      if (typeof to !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      if (hero.alive === false) return h.reject('E_HERO_DEAD'); // a dead hero can't act
      // HERO-2: a deployed hero rides its SHIP — redeploy it with `fleet.move`. The
      // teleport-style redeploy remains only for a shipless hero (legacy model).
      if (hero.fleetId && h.state.fleets[hero.fleetId]) return h.reject('E_HERO_DEPLOYED');
      const planet = h.state.planets[to];
      if (!planet) return h.reject('E_NO_PLANET');
      if (planet.owner !== action.playerId) return h.reject('E_FORBIDDEN'); // redeploy to your own world
      hero.location = to;
      h.emit('hero.moved', { owner: action.playerId, to });
    });

    api.onAction('hero.path.create', (action, h) => {
      const { to } = action.payload as { to?: string };
      if (typeof to !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      gateLiveDeployed(h, hero);
      // The hero acts from its ship's node when deployed.
      if (to === heroNode(h.state, hero)) return h.reject('E_SAME_LOCATION');
      gateRangedCast(h, hero, to, PATH_RANGE, 'path');

      castTempLane(h, action.playerId, hero, to, {
        durationHours: PATH_DURATION_HOURS,
        speedBonus: PATH_SPEED_BONUS,
      });
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.path = after(h, PATH_COOLDOWN_HOURS);
    });

    api.on('hero.path.expire', (event, h) => {
      const { laneId } = event.payload as { laneId?: string };
      if (typeof laneId !== 'string' || !h.state.tempLanes) return;
      const idx = h.state.tempLanes.findIndex((l) => l.id === laneId);
      if (idx < 0) return;
      const lane = h.state.tempLanes[idx]!;
      h.state.tempLanes.splice(idx, 1);
      // Remove the link only if THIS lane added it and no other live lane needs the pair.
      const stillUsed = h.state.tempLanes.some(
        (l) =>
          (l.from === lane.from && l.to === lane.to) || (l.from === lane.to && l.to === lane.from),
      );
      if (lane.addedLink && !stillUsed) {
        removeLink(h.state, lane.from, lane.to);
        removeLink(h.state, lane.to, lane.from);
      }
      h.state.topology = (h.state.topology ?? 0) + 1;
      h.emit('hero.path.expired', { laneId, from: lane.from, to: lane.to });
    });

    api.onAction('planet.annihilate', (action, h) => {
      const { planetId } = action.payload as { planetId?: string };
      if (typeof planetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
      gateLiveDeployed(h, hero);
      requireDestructible(h, planetId); // target gate first — pinned gate order
      gateRangedCast(h, hero, planetId, ANNIHILATE_RANGE, 'annihilate');

      castAnnihilate(h, action.playerId, planetId);
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.annihilate = after(h, ANNIHILATE_COOLDOWN_HOURS);
    });

    // HERO-4 — the generic, data-driven ability dispatcher. Every gate is derived
    // from the `HeroAbilityDef`; the effect is picked by its `type` (built-in or a
    // `hero.effect.<type>` capability). Cost + cooldown commit only on success —
    // an effect rejection throws, and the kernel discards the whole draft.
    api.onAction('hero.ability', (action, h) => {
      const { heroId, abilityId, target } = action.payload as {
        heroId?: string;
        abilityId?: string;
        target?: string;
      };
      if (typeof heroId !== 'string' || typeof abilityId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (target !== undefined && typeof target !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = h.state.heroes?.[heroId];
      if (!hero) return h.reject('E_NO_HERO');
      if (hero.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      gateLiveDeployed(h, hero);
      const def = h.ctx.data.heroAbilities[abilityId];
      if (!def) return h.reject('E_NO_ABILITY');
      // The hero must actually carry the ability in a slot (its data-driven loadout).
      if (!(hero.abilities ?? []).includes(abilityId)) return h.reject('E_NOT_EQUIPPED');
      const key = cooldownKey(def.type);
      if (onCooldown(hero, key, h.ctx.now)) return h.reject('E_COOLDOWN');
      const range = abilityRange(def);
      if (range > 0) {
        if (typeof target !== 'string') return h.reject('E_BAD_PAYLOAD'); // ranged ⇒ targeted
        const origin = h.state.planets[heroNode(h.state, hero)];
        const dest = h.state.planets[target];
        if (!origin || !dest) return h.reject('E_NO_PLANET');
        if (distance(origin.position, dest.position) > range) {
          return h.reject('E_OUT_OF_RANGE');
        }
      }
      chargeOrReject(h, action.playerId, def.cost); // draft — a later reject discards everything

      if (def.type === 'temp_lane') {
        if (typeof target !== 'string') return h.reject('E_BAD_PAYLOAD');
        castTempLane(h, action.playerId, hero, target, {
          durationHours: numParam(def.params, 'durationHours', PATH_DURATION_HOURS),
          speedBonus: numParam(def.params, 'speedBonus', PATH_SPEED_BONUS),
        });
      } else if (def.type === 'annihilate') {
        if (typeof target !== 'string') return h.reject('E_BAD_PAYLOAD');
        castAnnihilate(h, action.playerId, target);
      } else {
        const impl = h.capability<HeroEffect>(`hero.effect.${def.type}`);
        if (!impl) return h.reject('E_NO_EFFECT'); // typed in data, absent in the engine
        impl({ heroId, hero, abilityId, ability: def, owner: action.playerId, target }, h);
      }

      if (def.cooldownHours > 0) {
        hero.cooldowns = hero.cooldowns ?? {};
        hero.cooldowns[key] = after(h, def.cooldownHours);
      }
      h.emit('hero.ability.used', {
        heroId,
        owner: action.playerId,
        abilityId,
        type: def.type,
        ...(target !== undefined ? { target } : {}),
      });
    });

    // Speed bonus on a leg that runs along one of the fleet owner's active temp lanes,
    // then the owner's hero passives (HERO-5): ×(1 + Σ applicable `fleet.speed` bonuses).
    api.hook<number>('fleet.speed', (speed, args, h) => {
      const { fleetId, from, to } = (args ?? {}) as { fleetId?: string; from?: string; to?: string };
      if (typeof fleetId !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        return speed;
      }
      const owner = h.state.fleets[fleetId]?.owner;
      if (owner === undefined) return speed;
      let out = speed;
      const lane = h.state.tempLanes?.find(
        (l) =>
          l.owner === owner &&
          l.expiresAt > h.ctx.now &&
          ((l.from === from && l.to === to) || (l.from === to && l.to === from)),
      );
      if (lane) out *= 1 + lane.speedBonus;
      const passives = passiveBonus(h, 'fleet.speed', owner, { fleetId, node: from });
      return passives !== 0 ? out * (1 + passives) : out;
    });

    // --- projection hero: fleet combat aura + death/respawn --------------------

    // +5% to a fleet that carries the hero, then the owner's hero passives (HERO-5)
    // for the battle's node. combat.damage fires once per side per round;
    // `args.attacker` is the owner DEALING this hit, so buffing that side's fleet
    // covers both its attack (vs the foe) and its return-fire defense.
    api.hook<number>('combat.damage', (base, args, h) => {
      const { battleId, attacker } = (args ?? {}) as { battleId?: string; attacker?: string };
      const hit = fleetSideDealingHit(h.state, battleId, attacker);
      if (!hit || typeof attacker !== 'string') return base;
      let out = base;
      if (fleetHasHero(h, hit.side.ref.fleetId)) out *= 1 + HERO_COMBAT_BONUS;
      const passives = passiveBonus(h, 'combat.damage', attacker, {
        fleetId: hit.side.ref.fleetId,
        node: hit.battle.location,
      });
      return passives !== 0 ? out * (1 + passives) : out;
    });

    // The hero went down (its ship was destroyed) → start the respawn timer once.
    // `unit.died` carries the dead stack's `fleetId` and `owner` (the fleet may already
    // be gone by drain time). Attribute the death to the hero commanding THAT ship, so
    // it's right when several heroes share an owner; fall back to the owner's hero when
    // the ship link isn't recorded (older saves / a hero set up without a fleetId).
    api.on('unit.died', (event, h) => {
      const { unit, fleetId, owner } = (event.payload ?? {}) as {
        unit?: string;
        fleetId?: string;
        owner?: string;
      };
      if (unit !== HERO_UNIT) return;
      const hero =
        (typeof fleetId === 'string' ? heroByFleet(h.state, fleetId) : undefined) ??
        (typeof owner === 'string' ? heroOf(h.state, owner) : undefined);
      if (!hero || hero.alive === false) return; // no hero entity, or already respawning
      killHero(h, hero);
    });

    // HERO-2: the whole ship went down with its fleet. `fleet.destroyed` covers the
    // removal paths that never drain a hero stack individually; the alive guard makes
    // the two death signals idempotent (whichever fires first wins).
    api.on('fleet.destroyed', (event, h) => {
      const { fleetId } = (event.payload ?? {}) as { fleetId?: string };
      if (typeof fleetId !== 'string') return;
      const hero = heroByFleet(h.state, fleetId);
      if (!hero || hero.alive === false) return;
      killHero(h, hero);
    });

    // HERO-2: the hero's node memory follows its ship — every node the ship confirms
    // (an intermediate transit or the final arrival) becomes `Hero.location`, which is
    // the ability origin mid-flight and the respawn fallback anchor after `home`.
    const followShip = (event: { payload?: unknown }, h: HandlerContext): void => {
      const { fleetId, at } = (event.payload ?? {}) as { fleetId?: string; at?: string };
      if (typeof fleetId !== 'string' || typeof at !== 'string') return;
      const hero = heroByFleet(h.state, fleetId);
      if (!hero || hero.alive === false) return;
      if (h.state.planets[at]) hero.location = at;
    };
    api.on('fleet.transit', followShip);
    api.on('fleet.arrived', followShip);

    // Respawn: the hero re-forms as a fresh one-ship fleet at its capital (`home`) if
    // still held, else its last node, else any world the player holds. Homeless — or
    // held back by the active cap (HERO-3) — ⇒ stays dead; the manual `hero.spawn`
    // below is the player's retry path once a world / cap slot frees up.
    api.on('hero.respawn', (event, h) => {
      const { heroId } = (event.payload ?? {}) as { heroId?: string };
      if (typeof heroId !== 'string') return;
      const hero = h.state.heroes?.[heroId];
      if (!hero || hero.alive) return;
      const owner = hero.owner;
      if (activeHeroCount(h.state, owner) >= HERO_ACTIVE_CAP) return;
      const owned = (id: PlanetId | undefined): id is PlanetId =>
        id !== undefined && h.state.planets[id]?.owner === owner;
      const at =
        [hero.home, hero.location].find(owned) ??
        Object.keys(h.state.planets)
          .sort()
          .find((id) => h.state.planets[id]?.owner === owner);
      if (at === undefined) return;
      const fleetId = formHeroShip(h, hero, at);
      h.emit('hero.respawned', { owner, heroId, fleetId, at });
    });

    // HERO-3 — manual deploy: raise the hero's ship at an owned world. Complements the
    // scheduled auto-respawn: it deploys roster heroes that never had a ship, and it is
    // the recovery path when the auto-respawn found the player homeless or capped.
    api.onAction('hero.spawn', (action, h) => {
      const { heroId, at } = action.payload as { heroId?: string; at?: string };
      if (typeof heroId !== 'string' || typeof at !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = h.state.heroes?.[heroId];
      if (!hero) return h.reject('E_NO_HERO');
      if (hero.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      // Already commanding a live ship. `alive` is stamped by deploy and cleared ONLY
      // by death (unit.died / fleet.destroyed) — check the flag, not just a live
      // fleetId: a host may delete/rename the carrier without a death (fleet.merge),
      // and a stale fleetId must not re-mint a second free flagship (BF-3 dupe).
      if (hero.alive === true) return h.reject('E_HERO_ALIVE');
      if (hero.fleetId !== undefined && h.state.fleets[hero.fleetId] !== undefined) {
        return h.reject('E_HERO_ALIVE');
      }
      if (onCooldown(hero, 'respawn', h.ctx.now)) return h.reject('E_RESPAWN_COOLDOWN');
      // Target resolution: a world (own; allied with the `spawn_allied` marker) or —
      // with the `spawn_fleet` marker (HERO-8) — one of the player's own fleets.
      const planet = h.state.planets[at];
      const host = planet === undefined ? h.state.fleets[at] : undefined;
      if (!planet && !host) return h.reject('E_NO_PLANET');
      if (planet) {
        const own = planet.owner === action.playerId;
        const allied =
          !own &&
          planet.owner !== null &&
          carriesAbilityType(h, hero, SPAWN_ALLIED_TYPE) &&
          stanceToRelation(getStance(h.state, action.playerId, planet.owner)) === 'ally';
        if (!own && !allied) return h.reject('E_BAD_SPAWN');
      } else if (host) {
        if (host.owner !== action.playerId || !carriesAbilityType(h, hero, SPAWN_FLEET_TYPE)) {
          return h.reject('E_BAD_SPAWN');
        }
      }
      if (activeHeroCount(h.state, action.playerId) >= HERO_ACTIVE_CAP) {
        return h.reject('E_HERO_CAP');
      }
      if (planet) {
        const fleetId = formHeroShip(h, hero, at);
        h.emit('hero.spawned', { owner: action.playerId, heroId, fleetId, at });
      } else if (host) {
        boardHeroShip(h, hero, host);
        h.emit('hero.spawned', {
          owner: action.playerId,
          heroId,
          fleetId: host.id,
          at: hero.location,
          aboard: true,
        });
      }
    });

    // HERO-7 — unlock a skill-tree node. The tree is pure data: branch/requires/cost
    // gate the order, and the grants simply extend the hero's own ability/passive
    // loadout — the HERO-4 dispatcher and HERO-5 passives then apply them as usual.
    api.onAction('hero.skill.unlock', (action, h) => {
      const { heroId, node } = action.payload as { heroId?: string; node?: string };
      if (typeof heroId !== 'string' || typeof node !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = h.state.heroes?.[heroId];
      if (!hero) return h.reject('E_NO_HERO');
      if (hero.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      if (hero.alive === false) return h.reject('E_HERO_DEAD');
      const def = h.ctx.data.heroSkillTrees[node];
      if (!def) return h.reject('E_NO_NODE');
      const skills = hero.skills ?? [];
      if (skills.includes(node)) return h.reject('E_ALREADY_UNLOCKED');
      // A branch node is exclusive to heroes of that branch (via the archetype); a
      // branchless "common" node is open to everyone, incl. archetype-less heroes.
      if (def.branch !== undefined) {
        const branch =
          hero.archetype !== undefined ? h.ctx.data.heroes[hero.archetype]?.branch : undefined;
        if (branch !== def.branch) return h.reject('E_WRONG_BRANCH');
      }
      if (!def.requires.every((parent) => skills.includes(parent))) {
        return h.reject('E_REQUIRES');
      }
      chargeOrReject(h, action.playerId, def.cost);

      hero.skills = [...skills, node];
      applyGrants(hero, def.grants);
      h.emit('hero.skill.unlocked', { owner: action.playerId, heroId, node, grants: def.grants });
    });

    // HERO-6 — install a ship fitting into one of the archetype's slots. Locked in
    // for good (no refit); grants are live (HERO-4/5), statMods await SHIP-3.
    // The install gate is the generic slots+items mechanism (`util/fitting.ts`,
    // SHIP-4) — the same one ship modules run through — expressed as a
    // single-category budget (the archetype's `slots`; archetype-less ⇒ 0).
    api.onAction('hero.fit', (action, h) => {
      const { heroId, fitting } = action.payload as { heroId?: string; fitting?: string };
      if (typeof heroId !== 'string' || typeof fitting !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const hero = h.state.heroes?.[heroId];
      if (!hero) return h.reject('E_NO_HERO');
      if (hero.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      if (hero.alive === false) return h.reject('E_HERO_DEAD');
      // ARS-3 ownership gate: a seat with an arsenal snapshot installs only the
      // fittings it owns; no snapshot ⇒ unrestricted (regular matches unchanged).
      const arsenal = h.state.players[action.playerId]?.arsenal;
      if (arsenal && !arsenal.fittings.includes(fitting)) {
        return h.reject('E_NOT_OWNED');
      }
      const fitted = hero.fittings ?? [];
      const slots =
        hero.archetype !== undefined ? (h.ctx.data.heroes[hero.archetype]?.slots ?? 0) : 0;
      const gate = canInstall(
        {
          item: (id) => h.ctx.data.heroFittings[id],
          category: () => 'fitting',
          capacity: () => slots,
        },
        fitted,
        fitting,
      );
      if (!gate.ok) {
        // `not_allowed` is unreachable (no predicate) → the fail-secure default.
        const code = { unknown: 'E_NO_FITTING', duplicate: 'E_ALREADY_FITTED', no_slot: 'E_NO_SLOTS' }[
          gate.reason as 'unknown' | 'duplicate' | 'no_slot'
        ];
        return h.reject(code ?? 'E_INTERNAL');
      }
      const def = h.ctx.data.heroFittings[fitting]!; // gate passed ⇒ the fitting exists
      chargeOrReject(h, action.playerId, def.cost);

      hero.fittings = [...fitted, fitting];
      applyGrants(hero, def.grants);
      h.emit('hero.fitted', { owner: action.playerId, heroId, fitting, grants: def.grants });
    });
  },
};
