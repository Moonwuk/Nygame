import type { GameModule, HandlerContext } from '../kernel/module';
import type { Battle, CombatantRef, Fleet, GameState, UnitStack } from '../state/gameState';
import type { GameData, UnitDef } from '../data/schemas';
import { timeScaleOf, type Context } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { sumUnitStat } from '../util/stacks';
import { requireOwnedIdleFleet } from '../util/fleet';
/** Hard cap on rounds so a zero-damage stalemate can't run forever (fail-secure). */
const MAX_COMBAT_ROUNDS = 240;
/** Fraction of a bombarding fleet's firepower that rains on the planet below. */
const BOMBARD_FRACTION = 0.5;

type Tier = 'front' | 'mid' | 'rear' | 'artillery';
/** Damage-receiving order (GDD §7.2): artillery is only reachable once the
 *  front, mid and rear lines are gone. */
const TIER_ORDER: readonly Tier[] = ['front', 'mid', 'rear', 'artillery'];

/** Optional diplomacy capability — absent ⇒ different owner = hostile. */
interface Diplomacy {
  getRelation(a: string, b: string): 'hostile' | 'ally' | 'neutral';
}

const roundIntervalMs = (ctx: Context): number => MS_PER_HOUR / timeScaleOf(ctx);

function unitTier(def: UnitDef): Tier {
  return def.traits.includes('artillery') ? 'artillery' : def.line;
}

// --- combatant side access (ships / landing troops / planet garrison) --------

function sideUnits(state: GameState, ref: CombatantRef): UnitStack[] | null {
  switch (ref.kind) {
    case 'fleet':
      return state.fleets[ref.fleetId]?.units ?? null;
    case 'landing': {
      const f = state.fleets[ref.fleetId];
      return f ? (f.landing ?? []) : null;
    }
    case 'garrison':
      return state.planets[ref.planetId]?.garrison ?? null;
  }
}

function setSideUnits(state: GameState, ref: CombatantRef, units: UnitStack[]): void {
  switch (ref.kind) {
    case 'fleet': {
      const f = state.fleets[ref.fleetId];
      if (f) f.units = units;
      return;
    }
    case 'landing': {
      const f = state.fleets[ref.fleetId];
      if (f) f.landing = units;
      return;
    }
    case 'garrison': {
      const p = state.planets[ref.planetId];
      if (p) p.garrison = units;
      return;
    }
  }
}

function sideAlive(state: GameState, ref: CombatantRef): boolean {
  const units = sideUnits(state, ref);
  return !!units && units.some((s) => s.count > 0);
}

/**
 * Damage a side deals in one round = Σ count × stat. The aggressor uses its
 * `attack` stat; a standing fleet that is attacked (the defender) answers with
 * its `defense` stat only — the return-fire mechanic (no separate attack order).
 */
function sideDamage(
  state: GameState,
  ref: CombatantRef,
  data: GameData,
  stat: 'attack' | 'defense',
): number {
  const units = sideUnits(state, ref);
  return units ? sumUnitStat(units, data, stat) : 0;
}

function isHostile(h: HandlerContext, a: string, b: string): boolean {
  if (a === b) {
    return false;
  }
  const diplomacy = h.capability<Diplomacy>('diplomacy');
  return (diplomacy?.getRelation(a, b) ?? 'hostile') === 'hostile';
}

// --- damage ------------------------------------------------------------------

/**
 * Applies `totalDamage` to a unit list, filling the receiving lines in tier
 * order. Tracks each stack's remaining HP pool so partial damage persists
 * across rounds; whole ships/troops are lost as the pool drops, each loss
 * announced via `unit.died` (the bus hook reanimation-style modules listen on).
 * Returns the surviving stacks.
 */
function applyDamage(
  h: HandlerContext,
  units: UnitStack[],
  totalDamage: number,
  data: GameData,
  source: Record<string, string>,
): UnitStack[] {
  let remaining = totalDamage;
  for (const tier of TIER_ORDER) {
    if (remaining <= 0) {
      break;
    }
    const stacks = units
      .filter((s) => {
        const def = data.units[s.unit];
        return def ? unitTier(def) === tier : false;
      })
      .sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));

    for (const stack of stacks) {
      if (remaining <= 0) {
        break;
      }
      const def = data.units[stack.unit];
      if (!def) {
        continue;
      }
      const perShip = def.stats.hp > 0 ? def.stats.hp : 1;
      let pool = stack.hp ?? stack.count * perShip;
      const absorbed = Math.min(remaining, pool);
      pool -= absorbed;
      remaining -= absorbed;

      const newCount = pool <= 0 ? 0 : Math.ceil(pool / perShip);
      const lost = stack.count - newCount;
      if (lost > 0) {
        h.emit('unit.died', { unit: stack.unit, count: lost, ...source });
      }
      stack.count = newCount;
      stack.hp = newCount > 0 ? pool : 0;
    }
  }
  return units.filter((s) => s.count > 0);
}

function applyDamageToSide(
  h: HandlerContext,
  ref: CombatantRef,
  dmg: number,
  data: GameData,
  location: string,
): void {
  const units = sideUnits(h.state, ref);
  if (!units) {
    return;
  }
  const source: Record<string, string> =
    ref.kind === 'garrison'
      ? { at: location, planetId: ref.planetId }
      : { at: location, fleetId: ref.fleetId };
  setSideUnits(h.state, ref, applyDamage(h, units, dmg, data, source));
}

// --- battle lifecycle --------------------------------------------------------

function scheduleTick(h: HandlerContext, battleId: string): void {
  h.schedule(h.ctx.now + roundIntervalMs(h.ctx), 'combat.tick', { battleId });
}

/** Lowest-id hostile, alive, unengaged fleet sitting at node `at`. */
function findEnemyFleetAt(
  h: HandlerContext,
  at: string,
  owner: string,
  excludeId: string,
): Fleet | null {
  let best: Fleet | null = null;
  for (const id of Object.keys(h.state.fleets)) {
    const f = h.state.fleets[id];
    if (!f || f.id === excludeId || f.location !== at || f.battleId) {
      continue;
    }
    if (!f.units.some((s) => s.count > 0) || !isHostile(h, owner, f.owner)) {
      continue;
    }
    if (best === null || f.id < best.id) {
      best = f;
    }
  }
  return best;
}

/** Pulls a fleet out of transit and pins it at a node (it now fights/holds). */
function pinToNode(fleet: Fleet, at: string): void {
  fleet.location = at;
  fleet.movement = null;
}

function startBattle(h: HandlerContext, battle: Battle): void {
  h.state.battles[battle.id] = battle;
  for (const side of [battle.attacker, battle.defender]) {
    if (side.ref.kind !== 'garrison') {
      const f = h.state.fleets[side.ref.fleetId];
      if (f) {
        f.battleId = battle.id;
        f.movement = null; // engaging stops a moving fleet
      }
    }
  }
  h.emit('battle.started', {
    battleId: battle.id,
    location: battle.location,
    phase: battle.phase,
    attacker: battle.attacker.owner,
    defender: battle.defender.owner,
  });
  scheduleTick(h, battle.id);
}

/**
 * Auto-resolves a fleet-vs-fleet collision at node `at`: a hostile enemy fleet
 * sharing the node always triggers an orbital battle (even mid-journey — it pins
 * the fleet and cancels the rest of its move). Taking the planet itself is a
 * separate, deliberate act from the near orbit (`fleet.assault`), so simply
 * arriving never captures — the fleet holds the far orbit (GDD §7.4).
 */
function engageFleets(h: HandlerContext, fleetId: string, at: string): void {
  const fleet = h.state.fleets[fleetId];
  if (!fleet || fleet.battleId) {
    return;
  }
  const enemy = findEnemyFleetAt(h, at, fleet.owner, fleetId);
  if (!enemy) {
    return;
  }
  pinToNode(fleet, at);
  startBattle(h, {
    id: `battle:${h.state.battleSeq++}`,
    location: at,
    phase: 'orbital',
    attacker: { ref: { kind: 'fleet', fleetId: fleet.id }, owner: fleet.owner },
    defender: { ref: { kind: 'fleet', fleetId: enemy.id }, owner: enemy.owner },
    round: 0,
  });
}

/**
 * A ground assault / occupation ordered from the near orbit (`fleet.assault`):
 * storm a defended garrison with the carried landing force, or walk into an
 * undefended hostile/neutral world. Returns a reject code, or null on success
 * (a ground battle was started or the planet was occupied).
 */
function assaultPlanet(h: HandlerContext, fleet: Fleet): string | null {
  const at = fleet.location;
  if (at === null) {
    return 'E_FLEET_BUSY';
  }
  const planet = h.state.planets[at];
  if (!planet) {
    return 'E_NO_PLANET';
  }
  if (planet.owner === fleet.owner) {
    return 'E_OWN_PLANET';
  }
  if (planet.owner !== null && !isHostile(h, fleet.owner, planet.owner)) {
    return 'E_FORBIDDEN'; // an ally's world
  }
  if (findEnemyFleetAt(h, at, fleet.owner, fleet.id)) {
    return 'E_ORBIT_CONTESTED'; // beat the defending fleet first
  }
  const defended = (planet.garrison ?? []).some((s) => s.count > 0);
  if (defended) {
    if (!(fleet.landing ?? []).some((s) => s.count > 0)) {
      return 'E_NO_TROOPS'; // a defended world needs a landing force
    }
    startBattle(h, {
      id: `battle:${h.state.battleSeq++}`,
      location: at,
      phase: 'ground',
      attacker: { ref: { kind: 'landing', fleetId: fleet.id }, owner: fleet.owner },
      defender: { ref: { kind: 'garrison', planetId: at }, owner: planet.owner },
      round: 0,
    });
    return null;
  }
  capturePlanet(h, at, fleet.id, planet.owner, false); // undefended → occupy
  return null;
}

function capturePlanet(
  h: HandlerContext,
  location: string,
  fleetId: string,
  previousOwner: string | null,
  depositLanding: boolean,
): void {
  const planet = h.state.planets[location];
  const fleet = h.state.fleets[fleetId];
  if (!planet || !fleet) {
    return;
  }
  planet.owner = fleet.owner;
  // Only a successful ground assault leaves troops behind to garrison; a fleet
  // simply occupying an undefended world keeps its landing troops aboard.
  if (depositLanding) {
    const landing = fleet.landing ?? [];
    if (landing.some((s) => s.count > 0)) {
      planet.garrison = landing;
      fleet.landing = [];
    }
  }
  h.emit('planet.captured', {
    planetId: location,
    owner: fleet.owner,
    by: fleetId,
    from: previousOwner,
  });
}

function releaseOrDestroyFleet(h: HandlerContext, ref: CombatantRef): void {
  if (ref.kind === 'garrison') {
    return;
  }
  const fleet = h.state.fleets[ref.fleetId];
  if (!fleet) {
    return;
  }
  if (fleet.units.length === 0) {
    h.emit('fleet.destroyed', { fleetId: fleet.id, owner: fleet.owner });
    delete h.state.fleets[fleet.id];
  } else {
    fleet.battleId = null; // released, free to move again
  }
}

function finishBattle(h: HandlerContext, battle: Battle, stalemate = false): void {
  const aAlive = sideAlive(h.state, battle.attacker.ref);
  const dAlive = sideAlive(h.state, battle.defender.ref);
  const winner = stalemate
    ? null
    : aAlive && !dAlive
      ? battle.attacker.owner
      : dAlive && !aAlive
        ? battle.defender.owner
        : null;

  // Ground capture must happen BEFORE releaseOrDestroyFleet — a fleet whose
  // ships were lost but whose landing troops won the assault would otherwise be
  // deleted (units.length === 0) before capturePlanet can deposit them as the
  // new garrison.
  if (
    battle.phase === 'ground' &&
    aAlive &&
    !dAlive &&
    battle.attacker.ref.kind === 'landing'
  ) {
    capturePlanet(h, battle.location, battle.attacker.ref.fleetId, battle.defender.owner, true);
  }

  releaseOrDestroyFleet(h, battle.attacker.ref);
  releaseOrDestroyFleet(h, battle.defender.ref);
  delete h.state.battles[battle.id];
  h.emit('battle.resolved', {
    battleId: battle.id,
    location: battle.location,
    phase: battle.phase,
    winner,
    rounds: battle.round,
  });

  if (battle.phase === 'orbital') {
    if (battle.attacker.ref.kind === 'fleet' && aAlive) {
      const f = h.state.fleets[battle.attacker.ref.fleetId];
      if (f) f.orbit = 'far'; // victor holds the far orbit — take the planet via fleet.assault
      engageFleets(h, battle.attacker.ref.fleetId, battle.location); // clear any other defender
    }
  }
}

// --- orbital AA & bombardment (the near orbit, GDD §7.4) ---------------------

/** A planet's orbital-AA firepower = Σ its garrison units' `aaDamage`. */
function aaStrengthAt(planet: { garrison: UnitStack[] }, data: GameData): number {
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
  const candidates = localFleets ?? Object.values(h.state.fleets).filter((f) => f.location === planetId);
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
function runOrbital(h: HandlerContext, hours: number): void {
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

    // Orbital AA — anti-ship, only when not defending the ground.
    if (planet.owner !== null && !groundAssaults.has(planetId)) {
      const aa = aaStrengthAt(planet, data);
      if (aa > 0) {
        const target = nearOrbitHostile(h, planetId, planet.owner, localFleets);
        if (target) {
          applyDamageToSide(h, { kind: 'fleet', fleetId: target.id }, aa * hours, data, planetId);
          const after = h.state.fleets[target.id];
          if (after && after.units.length === 0) {
            h.emit('fleet.destroyed', { fleetId: after.id, owner: after.owner });
            delete h.state.fleets[after.id];
          }
        }
      }
    }
    // Bombardment — each hostile bombarding fleet shells the structures below.
    if (localFleets) {
      for (const f of localFleets) {
        if (
          f.bombarding &&
          f.orbit === 'near' &&
          f.owner !== planet.owner
        ) {
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
 * Combat — a base module (GDD §7). Battles are stateful entities resolved over
 * real hours, one round per `combat.tick`. Fleets collide at map nodes (a
 * `fleet.transit` mid-journey or a `fleet.arrived` at the destination); capture
 * is two sequential phases — orbital then ground (§7.4). Damage runs through the
 * `combat.damage` hook (admiral / tactic / bombardment extension point, with
 * `phase` in its args); deaths publish `unit.died`; outcomes publish
 * `battle.resolved` and `planet.captured`.
 */
export const combatModule: GameModule = {
  id: 'combat',
  version: '1.0.0',
  setup(api) {
    api.on('fleet.arrived', (event, h) => {
      const { fleetId, at } = event.payload as { fleetId: string; at: string };
      const fleet = h.state.fleets[fleetId];
      if (fleet && !fleet.battleId) {
        fleet.orbit = 'far'; // arrive into the safe far orbit; assault is deliberate
      }
      engageFleets(h, fleetId, at);
    });

    api.on('fleet.transit', (event, h) => {
      const { fleetId, at } = event.payload as { fleetId: string; at: string };
      engageFleets(h, fleetId, at);
    });

    // Shift between the far orbit (safe standoff) and the near orbit (lets the
    // fleet bombard / land, but exposes it to the planet's orbital AA).
    api.onAction('fleet.orbit', (action, h) => {
      const { fleetId, orbit } = action.payload as { fleetId?: string; orbit?: string };
      if (typeof fleetId !== 'string' || (orbit !== 'near' && orbit !== 'far')) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, fleetId, action.playerId);
      fleet.orbit = orbit;
      if (orbit === 'far') {
        fleet.bombarding = false; // can't bombard from the far orbit
      }
      h.emit('fleet.orbit', { fleetId, orbit, owner: action.playerId });
    });

    // Land the carried army on the contested world below (near orbit only).
    api.onAction('fleet.assault', (action, h) => {
      const { fleetId } = action.payload as { fleetId?: string };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, fleetId, action.playerId);
      if (fleet.orbit !== 'near') {
        return h.reject('E_WRONG_ORBIT'); // descend to the near orbit first
      }
      const code = assaultPlanet(h, fleet);
      if (code) {
        return h.reject(code);
      }
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

    // The orbital layer accrues over continuous time, like the economy.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) {
        return;
      }
      runOrbital(h, (span / MS_PER_HOUR) * timeScaleOf(h.ctx));
    });

    api.on('combat.tick', (event, h) => {
      const { battleId } = event.payload as { battleId: string };
      const battle = h.state.battles[battleId];
      if (!battle) {
        return; // already resolved
      }
      const data = h.ctx.data;
      if (!sideAlive(h.state, battle.attacker.ref) || !sideAlive(h.state, battle.defender.ref)) {
        finishBattle(h, battle);
        return;
      }

      battle.round += 1;
      if (battle.round > MAX_COMBAT_ROUNDS) {
        finishBattle(h, battle, true); // stalemate safety valve
        return;
      }

      // Simultaneous round, from the pre-round state: the aggressor strikes with
      // its attack stat, the defender returns fire with its defense stat only.
      const dmgToDefender = h.hook<number>(
        'combat.damage',
        sideDamage(h.state, battle.attacker.ref, data, 'attack'),
        {
          battleId,
          phase: battle.phase,
          location: battle.location,
          attacker: battle.attacker.owner,
          defender: battle.defender.owner,
        },
      );
      const dmgToAttacker = h.hook<number>(
        'combat.damage',
        sideDamage(h.state, battle.defender.ref, data, 'defense'),
        {
          battleId,
          phase: battle.phase,
          location: battle.location,
          attacker: battle.defender.owner,
          defender: battle.attacker.owner,
        },
      );
      applyDamageToSide(h, battle.defender.ref, dmgToDefender, data, battle.location);
      applyDamageToSide(h, battle.attacker.ref, dmgToAttacker, data, battle.location);
      h.emit('combat.round', {
        battleId,
        round: battle.round,
        phase: battle.phase,
        location: battle.location,
        attacker: battle.attacker.owner,
        defender: battle.defender.owner,
        dmgToAttacker,
        dmgToDefender,
      });

      if (sideAlive(h.state, battle.attacker.ref) && sideAlive(h.state, battle.defender.ref)) {
        scheduleTick(h, battleId);
      } else {
        finishBattle(h, battle);
      }
    });
  },
};
