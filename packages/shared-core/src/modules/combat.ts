import type { GameModule, HandlerContext } from '../kernel/module';
import type {
  BarrageMode,
  Battle,
  CombatantRef,
  Fleet,
  GameState,
  PlanetId,
  UnitStack,
} from '../state/gameState';
import type { GameData, UnitDef } from '../data/schemas';
import { timeScaleOf, type Context } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { sumUnitStat } from '../util/stacks';
import { requireOwnedIdleFleet } from '../util/fleet';
import { isCapturable } from '../state/sectorKind';
import { getStance } from '../state/diplomacy';
import { distance } from '../state/route';
/** Hard cap on rounds so a zero-damage stalemate can't run forever (fail-secure). */
const MAX_COMBAT_ROUNDS = 240;
/** Fraction of a bombarding fleet's firepower that rains on the planet below. */
const BOMBARD_FRACTION = 0.5;

type Tier = 'front' | 'mid' | 'rear' | 'artillery';
/** Damage-receiving order (GDD §7.2): artillery is only reachable once the
 *  front, mid and rear lines are gone. */
const TIER_ORDER: readonly Tier[] = ['front', 'mid', 'rear', 'artillery'];

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
  // Diplomacy lives in `state.diplomacy` (D1). Only an explicit `war` stance is
  // hostile; the default for an unrecorded pair is `war` (FFA), so behaviour is
  // unchanged unless a game seeds peace/pact/alliance (the prototype does).
  return getStance(h.state, a, b) === 'war';
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
  // Tag the casualty's owner NOW: a wiped fleet is deleted before the `unit.died`
  // event drains, so listeners (heroes / score / reanimate) can't re-find it.
  const owner =
    ref.kind === 'garrison'
      ? h.state.planets[ref.planetId]?.owner
      : h.state.fleets[ref.fleetId]?.owner;
  if (owner != null) {
    source.owner = owner;
  }
  // Taking damage provokes a fleet's `return` ("ответный") artillery fire mode.
  if (ref.kind === 'fleet' && dmg > 0) {
    const f = h.state.fleets[ref.fleetId];
    if (f) f.barrageProvoked = true;
  }
  setSideUnits(h.state, ref, applyDamage(h, units, dmg, data, source));
}

// --- battle lifecycle --------------------------------------------------------

function scheduleTick(h: HandlerContext, battleId: string): void {
  const at = h.ctx.now + roundIntervalMs(h.ctx);
  h.schedule(at, 'combat.tick', { battleId });
  // Surface the round clock so the client can render a live battle countdown.
  const battle = h.state.battles[battleId];
  if (battle) {
    battle.nextRoundAt = at;
  }
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
 * separate, deliberate act from orbit (`fleet.assault`), so simply arriving
 * never captures — the fleet just holds the orbit (a single orbit, GDD §7.4).
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

// --- lane intercept (two hostile fleets crossing ON a lane, GDD §7.4) ---------

/** |Δfraction| below which two fleets on a lane count as co-located (a crossing). */
const INTERCEPT_TOL = 1e-6;
/** Keep a pinned crossing point off the lane's endpoints (avoids a degenerate
 *  node-equivalent edge); mirrors movement's own EPS. */
const EDGE_EPS = 1e-4;

/**
 * A fleet's occupancy of a lane as a linear function of time: its normalized
 * position `s ∈ [0,1]` along the canonical lane (endpoints sorted `lo`→`hi`, so
 * fleets travelling opposite ways share one axis), valid over [`t0`,`t1`]. A
 * moving fleet interpolates s0→s1 across its leg; a parked fleet is constant
 * (s0===s1) over an unbounded window.
 */
interface LaneOcc {
  lo: PlanetId;
  hi: PlanetId;
  s0: number;
  s1: number;
  t0: number;
  t1: number;
  moving: boolean;
}

/** Where a fleet sits on a lane as a time-parametrized segment — or null if it is
 *  at a node / gone (not on a lane). */
function laneOccupancy(fleet: Fleet): LaneOcc | null {
  const mv = fleet.movement;
  if (mv) {
    if (mv.arrivesAt <= mv.departedAt) {
      return null; // degenerate zero-length leg — no meaningful segment
    }
    const reversed = mv.from > mv.to;
    const startT = mv.startT ?? 0;
    const endT = mv.endT ?? 1;
    return {
      lo: reversed ? mv.to : mv.from,
      hi: reversed ? mv.from : mv.to,
      s0: reversed ? 1 - startT : startT,
      s1: reversed ? 1 - endT : endT,
      t0: mv.departedAt,
      t1: mv.arrivesAt,
      moving: true,
    };
  }
  const e = fleet.edge;
  if (e) {
    const reversed = e.from > e.to;
    const s = reversed ? 1 - e.t : e.t;
    return {
      lo: reversed ? e.to : e.from,
      hi: reversed ? e.from : e.to,
      s0: s,
      s1: s,
      t0: -Infinity,
      t1: Infinity,
      moving: false,
    };
  }
  return null;
}

/** Normalized position of an occupant at time `t` (linear; constant if parked). */
function posAt(occ: LaneOcc, t: number): number {
  if (!occ.moving) {
    return occ.s0;
  }
  return occ.s0 + ((occ.s1 - occ.s0) * (t - occ.t0)) / (occ.t1 - occ.t0);
}

/** Pulls a fleet out of transit and pins it at a continuous point on a lane. */
function pinToEdge(fleet: Fleet, from: PlanetId, to: PlanetId, t: number): void {
  fleet.location = null;
  fleet.movement = null;
  fleet.edge = { from, to, t };
}

/**
 * Schedules a `fleet.intercept` for every hostile fleet whose lane occupancy
 * crosses `fleetId`'s on the SAME lane — the analytic "встреча по формуле". Each
 * pair's position difference is linear in time, so the crossing instant is solved
 * exactly by interpolating the well-conditioned 0..1 positions at the overlap
 * window's ends (never dividing by a tiny rate). The intercept re-validates when
 * it fires, so a re-route before contact harmlessly no-ops a stale crossing.
 */
function scanLaneIntercepts(h: HandlerContext, fleetId: string): void {
  const fleet = h.state.fleets[fleetId];
  if (!fleet || fleet.battleId || !fleet.units.some((s) => s.count > 0)) {
    return;
  }
  const occA = laneOccupancy(fleet);
  if (!occA) {
    return; // not on a lane (at a node / gone)
  }
  const now = h.ctx.now;
  for (const id of Object.keys(h.state.fleets)) {
    if (id === fleetId) {
      continue;
    }
    const other = h.state.fleets[id];
    if (!other || other.battleId || !isHostile(h, fleet.owner, other.owner)) {
      continue;
    }
    if (!other.units.some((s) => s.count > 0)) {
      continue;
    }
    const occB = laneOccupancy(other);
    if (!occB || occB.lo !== occA.lo || occB.hi !== occA.hi) {
      continue; // not on the same lane
    }
    const lo = Math.max(occA.t0, occB.t0, now);
    const hi = Math.min(occA.t1, occB.t1);
    if (!(hi >= lo)) {
      continue; // no shared time window
    }
    let tc: number | null = null;
    if (!occA.moving && !occB.moving) {
      // Both parked: a crossing only if they sit on the very same point (rare).
      if (Math.abs(occA.s0 - occB.s0) <= INTERCEPT_TOL) {
        tc = lo;
      }
    } else {
      // At least one moving ⇒ `hi` is finite. d(t)=posA−posB is linear; find its
      // zero between the window ends.
      const dLo = posAt(occA, lo) - posAt(occB, lo);
      const dHi = posAt(occA, hi) - posAt(occB, hi);
      if (Math.abs(dLo) <= INTERCEPT_TOL) {
        tc = lo; // already together at the window's start
      } else if (Math.abs(dHi) <= INTERCEPT_TOL) {
        tc = hi; // together exactly at the window's end
      } else if (dLo < 0 !== dHi < 0) {
        tc = lo + ((hi - lo) * Math.abs(dLo)) / (Math.abs(dLo) + Math.abs(dHi));
      }
    }
    if (tc !== null) {
      h.schedule(tc, 'fleet.intercept', { a: fleetId, b: id });
    }
  }
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
  if (!isCapturable(h.ctx.data, planet)) {
    return; // empty space (sector kind not capturable) can't be owned, even after a fight
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

  // The battle is over. GROUND survivors (a planet garrison or a fleet's landing
  // troops) return "at rest": clear their transient combat HP pool (a UnitStack with
  // `hp` undefined = full health out of combat, gameState.ts §30-32). This must stay
  // for ground because `findHealthyStack` only matches `hp === undefined`, so stale
  // partial `hp` would make army.load/unload skip those stacks forever.
  //
  // SHIPS (a fleet's `units`) deliberately KEEP their `hp`: hull damage is persistent
  // now — a battered fleet limps (route.ts speed drag) and only mends at a friendly
  // repair base (construction.ts). `applyDamage` reads `stack.hp ?? full`, so a
  // damaged ship simply re-enters its next battle at its current hull.
  for (const ref of [battle.attacker.ref, battle.defender.ref]) {
    if (ref.kind === 'fleet') continue; // ships carry hull damage out of combat
    const survivors = sideUnits(h.state, ref);
    if (survivors) {
      for (const stack of survivors) delete stack.hp;
    }
  }

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
    // Whichever fleet SURVIVED holds the node — not just the attacker. The victor
    // stays in orbit and stops bombarding (re-issue to resume), and must auto-engage
    // any other hostile fleet idling at the node — one that couldn't engage earlier
    // because every fleet there already had a battleId (findEnemyFleetAt skips
    // battleId fleets). Previously only the attacker-victor re-engaged, so a
    // defender that won left a third hostile fleet coexisting at the node forever.
    const victorId =
      battle.attacker.ref.kind === 'fleet' && aAlive
        ? battle.attacker.ref.fleetId
        : battle.defender.ref.kind === 'fleet' && dAlive
          ? battle.defender.ref.fleetId
          : null;
    if (victorId !== null) {
      const f = h.state.fleets[victorId];
      if (f) {
        f.orbit = 'near';
        f.bombarding = false;
        // Chain into any other defender only when the victor holds a NODE; a lane
        // intercept leaves it parked on the edge (location null) — never teleport it.
        // engageFleets is battleId-guarded, so this starts at most one new battle.
        if (f.location !== null) {
          engageFleets(h, victorId, battle.location);
        }
      }
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

// --- artillery standoff fire (the ranged layer, GDD §7.2) --------------------

/** A fleet's continuous map position at `now`: its node, its parked lane point,
 *  or its interpolated spot mid-leg (mirrors movement's own progress math). null
 *  if it has no resolvable position (units missing from the map). */
function fleetPosition(state: GameState, fleet: Fleet, now: number): { x: number; y: number } | null {
  if (fleet.location !== null) {
    return state.planets[fleet.location]?.position ?? null;
  }
  const lerp = (from: PlanetId, to: PlanetId, t: number): { x: number; y: number } | null => {
    const a = state.planets[from]?.position;
    const b = state.planets[to]?.position;
    if (!a || !b) return null;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const mv = fleet.movement;
  if (mv) {
    const startT = mv.startT ?? 0;
    const endT = mv.endT ?? 1;
    const span = mv.arrivesAt - mv.departedAt;
    const progress = span > 0 ? Math.min(1, Math.max(0, (now - mv.departedAt) / span)) : 1;
    return lerp(mv.from, mv.to, startT + (endT - startT) * progress);
  }
  const e = fleet.edge;
  if (e) return lerp(e.from, e.to, e.t);
  return null;
}

/** Look up a fleet by id treating `fleets` as a plain map — an OWN key only, so a
 *  prototype-chain string (`__proto__` / `constructor` / `toString`) can never
 *  resolve to `Object.prototype` and slip a non-fleet object past validation
 *  (fail-secure: a poisoned id reads as "no such fleet", not a later crash). */
function ownFleet(state: GameState, id: string): Fleet | undefined {
  return Object.prototype.hasOwnProperty.call(state.fleets, id) ? state.fleets[id] : undefined;
}

/** A fleet's standoff firepower = Σ over its artillery units (count × attack).
 *  Only `artillery`-trait units fire at range; the rest are melee-only. */
function artilleryPower(fleet: Fleet, data: GameData): number {
  let total = 0;
  for (const s of fleet.units) {
    const def = data.units[s.unit];
    if (def && def.traits.includes('artillery')) {
      total += s.count * def.stats.attack;
    }
  }
  return total;
}

/** A fleet's firing radius (map units) = the MAX `range` among its live artillery
 *  units (the longest gun sets the reach). 0 = no artillery aboard / no range. */
function artilleryRange(fleet: Fleet, data: GameData): number {
  let r = 0;
  for (const s of fleet.units) {
    if (s.count <= 0) continue;
    const def = data.units[s.unit];
    if (def && def.traits.includes('artillery')) {
      r = Math.max(r, def.stats.range ?? 0);
    }
  }
  return r;
}

/** Whether a `mode` artillery shooter owned by `owner` may fire on `target`:
 *  - `standard` / `return`: only an enemy at WAR (the base hostility rule).
 *  - `aggressive`: any other-owner fleet that is NOT a pact/alliance partner
 *    (war OR peace) — it opens fire on un-allied neighbours. */
function targetableBy(h: HandlerContext, owner: string, target: Fleet, mode: BarrageMode): boolean {
  if (owner === target.owner) return false;
  if (mode === 'aggressive') {
    const stance = getStance(h.state, owner, target.owner);
    return stance !== 'pact' && stance !== 'alliance';
  }
  return isHostile(h, owner, target.owner); // war only
}

/** The fleet an artillery shooter fires on this span: its player-chosen
 *  `barrageTarget` if still targetable (per `mode`), alive and in range, else the
 *  NEAREST such fleet (ties broken by lowest id). null = nothing in range. A
 *  now-invalid chosen target is cleared as a side effect (falls back to auto). */
function pickBarrageTarget(
  h: HandlerContext,
  shooter: Fleet,
  from: { x: number; y: number },
  range: number,
  mode: BarrageMode,
): Fleet | null {
  const inRange = (f: Fleet): boolean => {
    if (f.id === shooter.id || !targetableBy(h, shooter.owner, f, mode)) return false;
    if (!Array.isArray(f.units) || !f.units.some((s) => s.count > 0)) return false;
    // A fleet already pinned in a melee battle is not a standoff target: shelling
    // (and deleting) a combatant from outside the fight would let a third party
    // decide a battle it isn't in. Free fleets only — matching the shooter guard.
    if (f.battleId) return false;
    // Only a STATIONARY target can be shelled: a fleet in transit has a position
    // that changes across the span, so a fixed-instant range test over the whole
    // span would over/under-bill (and make the damage depend on how finely time
    // advances). A holding/sieging target has a constant position — exact.
    if (f.movement) return false;
    const p = fleetPosition(h.state, f, h.ctx.now);
    return p !== null && distance(from, p) <= range;
  };
  const chosen = shooter.barrageTarget;
  if (chosen != null) {
    // own-key lookup: a poisoned `barrageTarget` (e.g. an injected `__proto__`)
    // reads as no-fleet → cleared → auto-target, never a crash on the next span.
    const t = ownFleet(h.state, chosen);
    if (t && inRange(t)) return t;
    shooter.barrageTarget = null; // stale / invalid — drop it, fall back to auto-target
  }
  let best: Fleet | null = null;
  let bestDist = Infinity;
  // Sorted ids ⇒ deterministic; the first at the minimal distance wins ties.
  for (const id of Object.keys(h.state.fleets).sort()) {
    const f = h.state.fleets[id];
    if (!f || !inRange(f)) continue;
    const d = distance(from, fleetPosition(h.state, f, h.ctx.now)!);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}

/**
 * Artillery standoff fire (GDD §7.2 — "бьёт на расстоянии"): each FREE,
 * STATIONARY fleet carrying artillery shells ONE hostile stationary fleet within
 * its firing radius. A pure standoff — no return fire and no battle is entered;
 * the only counter is to close the distance and engage it in melee. Auto-targets
 * the nearest target, or the player's `fleet.barrage` focus target, subject to
 * the fleet's rules of engagement (`barrageMode`: passive / return / standard /
 * aggressive — see `BarrageMode`).
 *
 * Two invariants drive the design:
 *  - Only stationary shooters AND targets fire/are-hit (no `movement`): their
 *    positions are constant across the span, so the single-instant range test and
 *    the full-span damage bill are EXACT — total damage stays independent of how
 *    finely time advances (a fleet in transit fights via melee collision instead).
 *  - SIMULTANEOUS resolution: every shot is resolved from the pre-span snapshot
 *    (pass 1) before any damage lands (pass 2), so two artillery fleets that wipe
 *    each other both get their shot off — mirroring `combat.tick`'s pre-round model
 *    (no first-strike advantage to the lower fleet id).
 */
function runArtillery(h: HandlerContext, hours: number): void {
  const data = h.ctx.data;
  // Pass 1 — resolve every shot from the PRE-span state (no damage applied yet).
  const shots: { shooterId: string; owner: string; targetId: string; dmg: number; at: string }[] = [];
  for (const id of Object.keys(h.state.fleets).sort()) {
    const shooter = h.state.fleets[id];
    if (!shooter || shooter.battleId || shooter.movement) continue; // pinned in melee / maneuvering
    // Rules of engagement: hold fire when passive, or when `return` and not yet hit.
    const mode: BarrageMode = shooter.barrageMode ?? 'standard';
    if (mode === 'passive') continue;
    if (mode === 'return' && !shooter.barrageProvoked) continue;
    const range = artilleryRange(shooter, data);
    const power = artilleryPower(shooter, data);
    if (range <= 0 || power <= 0) continue;
    const from = fleetPosition(h.state, shooter, h.ctx.now);
    if (!from) continue;
    const target = pickBarrageTarget(h, shooter, from, range, mode);
    if (!target) continue;
    shots.push({
      shooterId: id,
      owner: shooter.owner,
      targetId: target.id,
      // a node id for the casualty tag — fall back to a lane endpoint, never a
      // fleet id (both may be lane-parked with `location` null).
      at: shooter.location ?? target.location ?? shooter.edge?.from ?? target.edge?.from ?? id,
      dmg: power * hours,
    });
  }
  // Pass 2 — apply all shots in deterministic order, then resolve wiped targets.
  for (const shot of shots) {
    applyDamageToSide(h, { kind: 'fleet', fleetId: shot.targetId }, shot.dmg, data, shot.at);
    h.emit('artillery.fired', {
      fleetId: shot.shooterId,
      owner: shot.owner,
      target: shot.targetId,
      power: shot.dmg,
      at: h.ctx.now,
    });
    const after = h.state.fleets[shot.targetId];
    if (after && after.units.length === 0) {
      h.emit('fleet.destroyed', { fleetId: after.id, owner: after.owner });
      delete h.state.fleets[shot.targetId];
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
        fleet.orbit = 'near'; // a single orbit (GDD §7.4): arriving = stationed in orbit
        fleet.bombarding = false; // not bombarding until the player orders it
      }
      engageFleets(h, fleetId, at);
    });

    api.on('fleet.transit', (event, h) => {
      const { fleetId, at } = event.payload as { fleetId: string; at: string };
      engageFleets(h, fleetId, at);
    });

    // Lane combat: a fleet just began a leg / parked on a lane → look for a hostile
    // fleet it will cross ON the lane (not only at a node) and schedule the meeting.
    api.on('fleet.leg', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      scanLaneIntercepts(h, fleetId);
    });
    api.on('fleet.parked', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      scanLaneIntercepts(h, fleetId);
    });

    // The crossing instant arrives: re-validate (both still on the lane, hostile,
    // alive, free) — a re-route since scheduling makes this a stale no-op — then pin
    // both fleets to the meeting point and open an orbital fleet-vs-fleet battle.
    api.on('fleet.intercept', (event, h) => {
      const { a, b } = event.payload as { a: string; b: string };
      const fa = h.state.fleets[a];
      const fb = h.state.fleets[b];
      if (!fa || !fb || fa.battleId || fb.battleId) {
        return;
      }
      if (!isHostile(h, fa.owner, fb.owner)) {
        return;
      }
      if (!fa.units.some((s) => s.count > 0) || !fb.units.some((s) => s.count > 0)) {
        return;
      }
      const oa = laneOccupancy(fa);
      const ob = laneOccupancy(fb);
      if (!oa || !ob || oa.lo !== ob.lo || oa.hi !== ob.hi) {
        return; // one left the lane (re-routed / arrived) — stale intercept
      }
      const sa = posAt(oa, h.ctx.now);
      const sb = posAt(ob, h.ctx.now);
      if (Math.abs(sa - sb) > INTERCEPT_TOL) {
        return; // not actually meeting now — stale
      }
      const t = Math.min(1 - EDGE_EPS, Math.max(EDGE_EPS, (sa + sb) / 2));
      pinToEdge(fa, oa.lo, oa.hi, t);
      pinToEdge(fb, oa.lo, oa.hi, t);
      startBattle(h, {
        id: `battle:${h.state.battleSeq++}`,
        location: t <= 0.5 ? oa.lo : oa.hi, // nearest node — for display / event labels
        phase: 'orbital',
        attacker: { ref: { kind: 'fleet', fleetId: fa.id }, owner: fa.owner },
        defender: { ref: { kind: 'fleet', fleetId: fb.id }, owner: fb.owner },
        round: 0,
      });
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

    // Land the carried army on the contested world below. A single orbit (GDD §7.4):
    // the fleet must be stationed in that orbit (not in transit / on a lane).
    api.onAction('fleet.assault', (action, h) => {
      const { fleetId } = action.payload as { fleetId?: string };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = requireOwnedIdleFleet(h, fleetId, action.playerId);
      if (fleet.orbit !== 'near') {
        return h.reject('E_WRONG_ORBIT'); // must be stationed in orbit, not in transit
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

    // The orbital + artillery layers accrue over continuous time, like the economy.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) {
        return;
      }
      const hours = (span / MS_PER_HOUR) * timeScaleOf(h.ctx);
      runOrbital(h, hours);
      runArtillery(h, hours);
    });

    // Focus-fire order for artillery standoff fire: aim this fleet's guns at a
    // specific hostile fleet, or clear (targetId null) to resume auto-targeting.
    // The shot itself fires in `runArtillery` each span; this only records intent
    // (server-authority — the client sends the order, never the damage).
    api.onAction('fleet.barrage', (action, h) => {
      const { fleetId, targetId } = action.payload as { fleetId?: string; targetId?: string | null };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = ownFleet(h.state, fleetId); // own-key — rejects an injected `__proto__`
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (artilleryRange(fleet, h.ctx.data) <= 0) {
        return h.reject('E_NO_ARTILLERY'); // nothing aboard can fire at range
      }
      if (targetId == null) {
        fleet.barrageTarget = null; // clear → auto-target the nearest in range
        h.emit('fleet.barrage', { fleetId, target: null, owner: action.playerId });
        return;
      }
      if (typeof targetId !== 'string' || targetId === fleetId) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const target = ownFleet(h.state, targetId); // own-key — a poisoned id can't persist
      if (!target) {
        return h.reject('E_NO_TARGET');
      }
      if (!isHostile(h, fleet.owner, target.owner)) {
        return h.reject('E_NOT_HOSTILE');
      }
      fleet.barrageTarget = targetId;
      h.emit('fleet.barrage', { fleetId, target: targetId, owner: action.playerId });
    });

    // Set a fleet's artillery rules of engagement (passive / return / standard /
    // aggressive). Records intent only; `runArtillery` reads it each span.
    api.onAction('fleet.barrageMode', (action, h) => {
      const { fleetId, mode } = action.payload as { fleetId?: string; mode?: string };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (mode !== 'passive' && mode !== 'return' && mode !== 'standard' && mode !== 'aggressive') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = ownFleet(h.state, fleetId);
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (artilleryRange(fleet, h.ctx.data) <= 0) {
        return h.reject('E_NO_ARTILLERY');
      }
      fleet.barrageMode = mode;
      h.emit('fleet.barrageMode', { fleetId, mode, owner: action.playerId });
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
