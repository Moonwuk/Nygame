import { hoursToMs } from '../action/types';
import type { GameModule, HandlerContext } from '../kernel/module';
import type { Fleet, GameState, Hero, PlanetId, PlayerId, TempLane } from '../state/gameState';
import { distance } from '../state/route';
import { isCapturable } from '../state/sectorKind';

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

function heroOf(state: GameState, playerId: PlayerId): Hero | undefined {
  // Instance-keyed roster: find the player's hero by owner. (One per player today;
  // the find is order-stable on insertion order, deterministic.)
  return Object.values(state.heroes ?? {}).find((hero) => hero.owner === playerId);
}

/** Does this fleet currently carry a living hero unit? (drives the fleet aura). */
function fleetHasHero(h: HandlerContext, fleetId: string): boolean {
  const fleet = h.state.fleets[fleetId];
  if (!fleet) return false;
  return fleet.units.some(
    (s) => s.count > 0 && (h.ctx.data.units[s.unit]?.traits.includes(HERO_TRAIT) ?? false),
  );
}

/** ms from now after `hours`, compressed by the match timeScale like every duration. */
function after(h: HandlerContext, hours: number): number {
  return h.ctx.now + hoursToMs(h.ctx, hours);
}

function onCooldown(hero: Hero, ability: string, now: number): boolean {
  return ((hero.cooldowns ?? {})[ability] ?? 0) > now;
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

export const heroModule: GameModule = {
  id: 'hero',
  version: '1.0.0',
  setup(api) {
    api.onAction('hero.move', (action, h) => {
      const { to } = action.payload as { to?: string };
      if (typeof to !== 'string') return h.reject('E_BAD_PAYLOAD');
      const hero = heroOf(h.state, action.playerId);
      if (!hero) return h.reject('E_NO_HERO');
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
      const from = hero.location;
      if (to === from) return h.reject('E_SAME_LOCATION');
      const a = h.state.planets[from];
      const b = h.state.planets[to];
      if (!a || !b) return h.reject('E_NO_PLANET');
      if (distance(a.position, b.position) > PATH_RANGE) return h.reject('E_OUT_OF_RANGE');
      if (onCooldown(hero, 'path', h.ctx.now)) return h.reject('E_COOLDOWN');

      const addedLink = addLink(h.state, from, to);
      addLink(h.state, to, from);
      h.state.topology = (h.state.topology ?? 0) + 1; // invalidate the route cache
      const seq = (h.state.heroSeq ?? 0) + 1;
      h.state.heroSeq = seq;
      const expiresAt = after(h, PATH_DURATION_HOURS);
      const lane: TempLane = {
        id: `lane:${seq}`,
        owner: action.playerId,
        from,
        to,
        speedBonus: PATH_SPEED_BONUS,
        expiresAt,
        addedLink,
      };
      (h.state.tempLanes ??= []).push(lane);
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.path = after(h, PATH_COOLDOWN_HOURS);
      h.schedule(expiresAt, 'hero.path.expire', { laneId: lane.id });
      h.emit('hero.path.created', { owner: action.playerId, from, to, laneId: lane.id });
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
      const planet = h.state.planets[planetId];
      if (!planet) return h.reject('E_NO_PLANET');
      // Destructible = a real, ownable world that isn't already a dead world. Empty
      // space (uncapturable) and a previously-annihilated dead world are both rejected.
      if (!isCapturable(h.ctx.data, planet) || planet.kind === DEAD_KIND) {
        return h.reject('E_NOT_DESTRUCTIBLE');
      }
      const origin = h.state.planets[hero.location];
      if (!origin) return h.reject('E_NO_PLANET');
      if (distance(origin.position, planet.position) > ANNIHILATE_RANGE) {
        return h.reject('E_OUT_OF_RANGE');
      }
      if (onCooldown(hero, 'annihilate', h.ctx.now)) return h.reject('E_COOLDOWN');

      const previousOwner = planet.owner;
      planet.owner = null; // neutral again — a depleted world anyone can re-claim
      planet.buildings = [];
      planet.garrison = [];
      planet.kind = DEAD_KIND; // capturable + buildable, but worth only the flat 10
      planet.planetType = DEAD_PLANET_TYPE; // no defense edge, but rich in metal (+30%)
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.annihilate = after(h, ANNIHILATE_COOLDOWN_HOURS);
      h.emit('planet.destroyed', { planetId, by: action.playerId, from: previousOwner });
    });

    // Speed bonus on a leg that runs along one of the fleet owner's active temp lanes.
    api.hook<number>('fleet.speed', (speed, args, h) => {
      const { fleetId, from, to } = (args ?? {}) as { fleetId?: string; from?: string; to?: string };
      if (typeof fleetId !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        return speed;
      }
      const owner = h.state.fleets[fleetId]?.owner;
      if (owner === undefined || !h.state.tempLanes) return speed;
      const lane = h.state.tempLanes.find(
        (l) =>
          l.owner === owner &&
          l.expiresAt > h.ctx.now &&
          ((l.from === from && l.to === to) || (l.from === to && l.to === from)),
      );
      return lane ? speed * (1 + lane.speedBonus) : speed;
    });

    // --- projection hero: fleet combat aura + death/respawn --------------------

    // +5% to a fleet that carries the hero. combat.damage fires once per side per
    // round; `args.attacker` is the owner DEALING this hit, so buffing that side's
    // fleet covers both its attack (vs the foe) and its return-fire defense.
    api.hook<number>('combat.damage', (base, args, h) => {
      const { battleId, attacker } = (args ?? {}) as { battleId?: string; attacker?: string };
      if (typeof battleId !== 'string' || typeof attacker !== 'string') return base;
      const battle = h.state.battles[battleId];
      if (!battle) return base;
      const side = battle.attacker.owner === attacker ? battle.attacker : battle.defender;
      if (side.ref.kind !== 'fleet') return base; // the aura is a fleet bonus only
      return fleetHasHero(h, side.ref.fleetId) ? base * (1 + HERO_COMBAT_BONUS) : base;
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
        (typeof fleetId === 'string'
          ? Object.values(h.state.heroes ?? {}).find((x) => x.fleetId === fleetId)
          : undefined) ?? (typeof owner === 'string' ? heroOf(h.state, owner) : undefined);
      if (!hero || hero.alive === false) return; // no hero entity, or already respawning
      hero.alive = false;
      delete hero.fleetId; // its ship is gone
      const respawnAt = after(h, HERO_RESPAWN_HOURS);
      hero.cooldowns = hero.cooldowns ?? {};
      hero.cooldowns.respawn = respawnAt;
      h.schedule(respawnAt, 'hero.respawn', { heroId: hero.id });
      h.emit('hero.died', { owner: hero.owner, heroId: hero.id, at: h.ctx.now });
    });

    // Respawn: the hero re-forms as a fresh one-ship fleet at its capital (`home`) if
    // still held, else its last node, else any world the player holds. Homeless ⇒ stays
    // dead (likely being eliminated).
    api.on('hero.respawn', (event, h) => {
      const { heroId } = (event.payload ?? {}) as { heroId?: string };
      if (typeof heroId !== 'string') return;
      const hero = h.state.heroes?.[heroId];
      if (!hero || hero.alive) return;
      const owner = hero.owner;
      const owned = (id: PlanetId | undefined): id is PlanetId =>
        id !== undefined && h.state.planets[id]?.owner === owner;
      const at =
        [hero.home, hero.location].find(owned) ??
        Object.keys(h.state.planets)
          .sort()
          .find((id) => h.state.planets[id]?.owner === owner);
      if (at === undefined) return;
      const seq = (h.state.heroSeq ?? 0) + 1;
      h.state.heroSeq = seq;
      const fleetId = `hero:${owner}:${seq}`;
      const newFleet: Fleet = {
        id: fleetId,
        owner,
        location: at,
        movement: null,
        units: [{ unit: HERO_UNIT, count: 1 }],
        traits: [],
        orbit: 'near',
      };
      h.state.fleets[fleetId] = newFleet;
      hero.alive = true;
      hero.location = at;
      hero.fleetId = fleetId;
      h.emit('hero.respawned', { owner, heroId, fleetId, at });
    });
  },
};
