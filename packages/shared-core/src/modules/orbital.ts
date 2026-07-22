import type { GameModule, HandlerContext } from '../kernel/module';
import type { BuildingInstance, Fleet, UnitStack } from '../state/gameState';
import type { GameData } from '../data/schemas';
import { buildingLevel } from '../data/schemas';
import { hoursToMs, timeScaleOf, type Context } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { sumUnitStat } from '../util/stacks';
import { requireOwnedIdleFleet } from '../util/fleet';
import { isActivelyBombarding } from '../state/orbit';
import { BLACKOUT_MULT } from '../state/visibility';
import { applyDamageToSide, isHostile, removeIfWiped } from '../util/combat';

/** Fraction of a bombarding fleet's firepower that rains on the planet below. */
const BOMBARD_FRACTION = 0.5;

/** One game-hour of world time — the AA volley grid (same value the melee module
 *  uses for its round interval). */
const hourIntervalMs = (ctx: Context): number => hoursToMs(ctx, 1);

/** The ORBITAL AA tier: Σ the buildings' `aaDamage` — fixed heavy emplacements.
 *  Fires one full-strength volley per game-HOUR. */
function aaOrbitalAt(planet: { buildings: BuildingInstance[] }, data: GameData): number {
  let total = 0;
  for (const b of planet.buildings) {
    const def = data.buildings[b.type];
    if (def) total += buildingLevel(def, b.level).aaDamage;
  }
  return total;
}
/** The CLOSE (point-defense) AA tier: Σ the garrison units' `aaDamage` — mobile
 *  flak. Fires every QUARTER game-hour at a quarter of the hourly rate, so the
 *  hourly output matches the stat while the dodge window shrinks to 15 minutes. */
function aaCloseAt(planet: { garrison: UnitStack[] }, data: GameData): number {
  return sumUnitStat(planet.garrison, data, 'aaDamage');
}

/** Lowest-id hostile, free fleet sitting on the NEAR orbit of `planetId`.
 *  If a pre-built `localFleets` index is supplied it avoids an O(all-fleets) scan. */
function nearOrbitHostile(
  h: HandlerContext,
  planetId: string,
  owner: string | null,
  localFleets?: readonly Fleet[],
): Fleet | null {
  const candidates =
    localFleets ?? Object.values(h.state.fleets).filter((f) => f.location === planetId);
  let best: Fleet | null = null;
  for (const f of candidates) {
    if (f.orbit !== 'near' || f.battleId) {
      continue;
    }
    if (!f.units.some((s) => s.count > 0) || owner === null || !isHostile(h, owner, f.owner)) {
      continue;
    }
    if (best === null || f.id < best.id) best = f;
  }
  return best;
}

/** Bombardment firepower a fleet rains on the planet = Σ ship attack × fraction. */
function bombardPower(fleet: Fleet, data: GameData): number {
  return sumUnitStat(fleet.units, data, 'attack') * BOMBARD_FRACTION;
}

/** Resolves the orbital layer over one continuous time span: planetary AA fires
 *  at near-orbit attackers (unless a ground assault keeps it busy), and each
 *  bombarding fleet wears the world's structures (and freezes its production —
 *  enforced in economy/construction via `isBombarded`).
 *
 *  Optimized with a fleet-by-location index and a ground-assault set so the
 *  cost is O(planets + fleets + battles) instead of O(planets × fleets). */
function runOrbital(h: HandlerContext, from: number, to: number, hours: number): void {
  const data = h.ctx.data;

  // Pre-index fleets by location — O(fleets).
  const fleetsByLocation = new Map<string, Fleet[]>();
  for (const f of Object.values(h.state.fleets)) {
    if (f.location !== null) {
      const arr = fleetsByLocation.get(f.location);
      if (arr) arr.push(f);
      else fleetsByLocation.set(f.location, [f]);
    }
  }

  // Pre-index planets with an active ground assault — O(battles).
  const groundAssaults = new Set<string>();
  for (const b of Object.values(h.state.battles)) {
    if (b.phase === 'ground') groundAssaults.add(b.location);
  }

  for (const planetId of Object.keys(h.state.planets)) {
    const planet = h.state.planets[planetId];
    if (!planet) {
      continue;
    }
    const localFleets = fleetsByLocation.get(planetId);

    // AA — anti-ship, only when not defending the ground. Two tiers, both firing
    // discrete VOLLEYS on the world-time grid (a fleet slipping in and out of orbit
    // BETWEEN volleys escapes untouched — timing a raid past the flak matters):
    //   - ORBITAL (buildings): one full-strength volley per game-HOUR;
    //   - CLOSE (garrison units): a quarter-strength volley every QUARTER-hour —
    //     same hourly output, but only a 15-minute window to dodge.
    // The quarter grid contains the hour grid, so one walk over quarter boundaries
    // covers both; at a shared boundary the heavy orbital volley lands first.
    if (planet.owner !== null && !groundAssaults.has(planetId)) {
      // ECON-2 «блэкаут»: unpaid energy halves BOTH flak tiers until the bill is
      // covered — same knob as the radar dim (BLACKOUT_MULT, visibility.ts).
      const starved = h.state.players[planet.owner]?.arrears?.includes('energy') === true;
      const aaMult = starved ? BLACKOUT_MULT : 1;
      const aaOrbital = aaOrbitalAt(planet, data) * aaMult;
      const aaClose = aaCloseAt(planet, data) * aaMult;
      if (aaOrbital > 0 || aaClose > 0) {
        const hourMs = hourIntervalMs(h.ctx); // one game-hour of world time
        const quarterMs = hourMs / 4;
        const firstQ = Math.floor(from / quarterMs) + 1;
        const lastQ = Math.floor(to / quarterMs);
        const volley = (damage: number, tier: 'orbital' | 'close'): boolean => {
          // Re-aim every volley: a target destroyed mid-span frees the next strike
          // for the next hostile still hanging in orbit.
          const target = nearOrbitHostile(h, planetId, planet.owner!, localFleets);
          if (!target) return false;
          // Announce BEFORE applying: the client draws the flak burst planet→fleet
          // even when this very volley destroys the target (H2 — visible AA fire).
          h.emit('aa.fired', {
            planetId,
            owner: planet.owner,
            fleetId: target.id,
            by: target.owner,
            damage,
            tier,
          });
          applyDamageToSide(h, { kind: 'fleet', fleetId: target.id }, damage, data, planetId);
          removeIfWiped(h, target.id);
          return true;
        };
        outer: for (let q = firstQ; q <= lastQ; q++) {
          if (aaOrbital > 0 && q % 4 === 0) {
            if (!volley(aaOrbital, 'orbital')) break outer;
          }
          if (aaClose > 0) {
            if (!volley(aaClose / 4, 'close')) break outer;
          }
        }
      }
    }
    // Bombardment — each hostile bombarding fleet shells the structures below.
    // The rule (incl. the pinned-in-melee exception and why it exists) is THE
    // shared predicate `isActivelyBombarding` — the same one the economy /
    // construction freeze reads, so damage and freeze can't disagree. Here it
    // gets combat's capability-aware hostility; resume = re-issue after the
    // battle (finishBattle resets `bombarding` on release).
    if (localFleets) {
      const hostile = (a: string, b: string): boolean => isHostile(h, a, b);
      for (const f of localFleets) {
        if (isActivelyBombarding(h.state, f, hostile)) {
          const power = bombardPower(f, data) * hours;
          if (power > 0) {
            h.emit('planet.bombarded', { planetId, power, owner: planet.owner, by: f.owner });
          }
        }
      }
    }
  }
}

/**
 * Orbital — the near-orbit layer (GDD §7.4), split out of the melee combat
 * module along the bus seams. There is a SINGLE orbit: arriving stations a fleet
 * in it, a stationed fleet can bombard the world below and is exposed to the
 * planet's AA. AA fires discrete two-tier VOLLEYS on the world-time grid (hourly
 * orbital emplacements, quarter-hour close flak); bombardment accrues over
 * continuous time (`time.advanced`), like the economy. Degrades gracefully:
 * without this module fleets still fight (melee `combat`) — no AA, no bombardment.
 */
export const orbitalModule: GameModule = {
  id: 'orbital',
  version: '1.0.0',
  setup(api) {
    // A single orbit (GDD §7.4): arriving = stationed in orbit, not bombarding
    // until ordered. Registered BEFORE the melee module in the manifest, so this
    // runs first on `fleet.arrived` — the same stamp-then-engage sequence the
    // old single handler had (invariant #6: order = module array order).
    api.on('fleet.arrived', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      const fleet = h.state.fleets[fleetId];
      if (fleet && !fleet.battleId) {
        fleet.orbit = 'near';
        fleet.bombarding = false;
      }
    });

    // Bring an idle fleet into the planet's orbit. There is a SINGLE orbit (GDD §7.4) —
    // `'near'` is the only value; arrival enters it automatically, so this is mostly the
    // explicit "enter orbit" path. A fleet in orbit can bombard / land and is exposed to
    // the planet's AA. (The old far/near switch was collapsed to one orbit.)
    api.onAction('fleet.orbit', (action, h) => {
      const { fleetId, orbit } = action.payload as { fleetId?: string; orbit?: string };
      if (typeof fleetId !== 'string' || orbit !== 'near') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, fleetId, action.playerId);
      fleet.orbit = 'near';
      h.emit('fleet.orbit', { fleetId, orbit: 'near', owner: action.playerId });
    });

    // Toggle bombardment of the world below (near orbit, a hostile world, ships
    // aboard). While on, it shells structures and freezes the owner's production
    // each time span — and the fleet eats the planet's AA fire in return.
    api.onAction('fleet.bombard', (action, h) => {
      const { fleetId, on } = action.payload as { fleetId?: string; on?: boolean };
      if (typeof fleetId !== 'string' || typeof on !== 'boolean') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, fleetId, action.playerId);
      if (on) {
        if (fleet.orbit !== 'near') {
          return h.reject('E_WRONG_ORBIT');
        }
        const planet = h.state.planets[fleet.location];
        if (!planet) {
          return h.reject('E_NO_PLANET');
        }
        if (planet.owner === fleet.owner) {
          return h.reject('E_OWN_PLANET');
        }
        if (planet.owner !== null && !isHostile(h, fleet.owner, planet.owner)) {
          return h.reject('E_FORBIDDEN');
        }
        if (!fleet.units.some((s) => s.count > 0)) {
          return h.reject('E_NO_SHIPS');
        }
      }
      fleet.bombarding = on;
      h.emit('fleet.bombard', { fleetId, on, owner: action.playerId });
    });

    // The orbital layer accrues over continuous time, like the economy (AA fires
    // in discrete volleys on the from→to grid; bombardment accrues by hours).
    // Registered before `artillery` in the manifest, preserving the old
    // runOrbital→runArtillery order within each span.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) {
        return;
      }
      runOrbital(h, from, to, (span / MS_PER_HOUR) * timeScaleOf(h.ctx));
    });
  },
};
