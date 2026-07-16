import type { HandlerContext } from '../kernel/module';
import type { CombatantRef, Fleet, GameState, PlanetId, UnitStack } from '../state/gameState';
import type { GameData, UnitDef } from '../data/schemas';
import { sumUnitStat } from './stacks';
import { effectiveStats } from './loadout';
import { getStance, type DiplomacyCapability } from '../state/diplomacy';

/**
 * Shared combat primitives — the damage model, combatant-side accessors,
 * hostility test and lane-occupancy math used by the combat family of modules
 * (`combat` melee battles, `orbital` AA/bombardment, `artillery` standoff fire,
 * `intercept` lane crossings). A helper library, NOT a module: the modules stay
 * decoupled from each other (invariant #3) and share only these pure(ish)
 * functions, exactly like `util/fleet.ts` / `state/route.ts`.
 */

/** Stalemate safety valve: a battle is force-resolved (winner null) once its round
 *  counter EXCEEDS this — shared by the live combat module and the previewBattle
 *  forecast so the two can never drift apart. */
export const MAX_COMBAT_ROUNDS = 240;

export type Tier = 'front' | 'mid' | 'rear' | 'artillery';
/** Damage-receiving order (GDD §7.2): artillery is only reachable once the
 *  front, mid and rear lines are gone. */
export const TIER_ORDER: readonly Tier[] = ['front', 'mid', 'rear', 'artillery'];

export function unitTier(def: UnitDef): Tier {
  return def.traits.includes('artillery') ? 'artillery' : def.line;
}

// --- combatant side access (ships / landing troops / planet garrison) --------

export function sideUnits(state: GameState, ref: CombatantRef): UnitStack[] | null {
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

export function setSideUnits(state: GameState, ref: CombatantRef, units: UnitStack[]): void {
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

export function sideAlive(state: GameState, ref: CombatantRef): boolean {
  const units = sideUnits(state, ref);
  return !!units && units.some((s) => s.count > 0);
}

/**
 * Damage a side deals in one round = Σ count × stat. The aggressor uses its
 * `attack` stat; a standing fleet that is attacked (the defender) answers with
 * its `defense` stat only — the return-fire mechanic (no separate attack order).
 */
export function sideDamage(
  state: GameState,
  ref: CombatantRef,
  data: GameData,
  stat: 'attack' | 'defense',
): number {
  const units = sideUnits(state, ref);
  return units ? sumUnitStat(units, data, stat) : 0;
}

export function isHostile(h: HandlerContext, a: string, b: string): boolean {
  if (a === b) {
    return false;
  }
  // The `diplomacy` capability (D2) owns the stance→relation projection; consult
  // it when a diplomacy module is present. Without one, fall back to the D1 read:
  // only an explicit `war` stance is hostile, and the default for an unrecorded
  // pair is `war` (FFA) — the capability's base mapping matches, so behaviour is
  // identical either way (graceful degradation, invariant #3).
  const diplomacy = h.capability<DiplomacyCapability>('diplomacy');
  if (diplomacy) {
    return diplomacy.getRelation(h.state, a, b) === 'hostile';
  }
  return getStance(h.state, a, b) === 'war';
}

// --- damage ------------------------------------------------------------------

/** THE one copy of the damage model's hull accounting, shared with the battle
 *  forecast (`previewBattle`'s `hullPool`): per-ship hull floors at 1 (a
 *  zero-hp def still takes a hit to die), a stack's current pool is its
 *  residual `hp` or full `count × perShip`. Change it here and the live model
 *  and the forecast's denominator move together — they must never drift. */
export function stackHull(
  stack: UnitStack,
  effHp: number | undefined,
): { perShip: number; pool: number } {
  const perShip = effHp !== undefined && effHp > 0 ? effHp : 1;
  return { perShip, pool: stack.hp ?? stack.count * perShip };
}

/**
 * The PURE damage model: applies `totalDamage` to a unit list, filling the
 * receiving lines in tier order. Tracks each stack's remaining HP pool so
 * partial damage persists across rounds; whole ships/troops are lost as the
 * pool drops. No bus access — losses are RETURNED (`deaths`, in processing
 * order) so the math is unit-testable in isolation; the `applyDamage` wrapper
 * turns each loss into a `unit.died` event.
 */
export function damageUnits(
  units: UnitStack[],
  totalDamage: number,
  data: GameData,
): { survivors: UnitStack[]; deaths: { unit: string; count: number }[] } {
  const deaths: { unit: string; count: number }[] = [];
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
      const eff = effectiveStats(def, stack, data);
      const { perShip, pool: startPool } = stackHull(stack, eff.hp);

      // Ablative shield absorbs first (shields-roadmap SH-0.2); only the overflow
      // reaches the hull. A shield never kills — a ship dies only when its hull hits 0.
      const shieldPerShip = eff.shield ?? 0;
      if (shieldPerShip > 0) {
        let shield = stack.shieldHp ?? stack.count * shieldPerShip;
        const shieldAbsorbed = Math.min(remaining, shield);
        shield -= shieldAbsorbed;
        remaining -= shieldAbsorbed;
        stack.shieldHp = shield;
        if (remaining <= 0) {
          continue; // shield soaked it all — hull untouched
        }
      }

      let pool = startPool;
      const absorbed = Math.min(remaining, pool);
      pool -= absorbed;
      remaining -= absorbed;

      const newCount = pool <= 0 ? 0 : Math.ceil(pool / perShip);
      const lost = stack.count - newCount;
      if (lost > 0) {
        deaths.push({ unit: stack.unit, count: lost });
      }
      stack.count = newCount;
      stack.hp = newCount > 0 ? pool : 0;
      // Dead ships take their shields with them: cap the pool at surviving capacity.
      if (shieldPerShip > 0) {
        stack.shieldHp = newCount > 0 ? Math.min(stack.shieldHp ?? 0, newCount * shieldPerShip) : 0;
      }
    }
  }
  return { survivors: units.filter((s) => s.count > 0), deaths };
}

/** The bus-facing wrapper over {@link damageUnits}: each loss is announced via
 *  `unit.died` (tagged with `source`), and the surviving stacks are returned. */
export function applyDamage(
  h: HandlerContext,
  units: UnitStack[],
  totalDamage: number,
  data: GameData,
  source: Record<string, string>,
): UnitStack[] {
  const { survivors, deaths } = damageUnits(units, totalDamage, data);
  for (const d of deaths) {
    h.emit('unit.died', { unit: d.unit, count: d.count, ...source });
  }
  return survivors;
}

export function applyDamageToSide(
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
  // event drains, so listeners (heroes / score) can't re-find it.
  const owner =
    ref.kind === 'garrison'
      ? h.state.planets[ref.planetId]?.owner
      : h.state.fleets[ref.fleetId]?.owner;
  if (owner != null) {
    source.owner = owner;
  }
  // Taking damage provokes a fleet's `return` ("ответный") artillery fire mode and
  // stamps `lastDamagedAt` (shields hold their regen for a delay after being hit).
  if (ref.kind === 'fleet' && dmg > 0) {
    const f = h.state.fleets[ref.fleetId];
    if (f) {
      f.barrageProvoked = true;
      f.lastDamagedAt = h.ctx.now;
    }
  }
  setSideUnits(h.state, ref, applyDamage(h, units, dmg, data, source));
}

/** Delete a fleet whose LAST ship just died outside a battle (orbital AA or
 *  standoff fire), announcing `fleet.destroyed`. A battle-side wipe goes through
 *  the melee module's own release path instead. */
export function removeIfWiped(h: HandlerContext, fleetId: string): void {
  const after = h.state.fleets[fleetId];
  if (after && after.units.length === 0) {
    h.emit('fleet.destroyed', { fleetId: after.id, owner: after.owner });
    delete h.state.fleets[fleetId];
  }
}

/** Look up a fleet by id treating `fleets` as a plain map — an OWN key only, so a
 *  prototype-chain string (`__proto__` / `constructor` / `toString`) can never
 *  resolve to `Object.prototype` and slip a non-fleet object past validation
 *  (fail-secure: a poisoned id reads as "no such fleet", not a later crash). */
export function ownFleet(state: GameState, id: string): Fleet | undefined {
  return Object.prototype.hasOwnProperty.call(state.fleets, id) ? state.fleets[id] : undefined;
}

// --- lane occupancy (two fleets sharing a lane, GDD §7.4) ---------------------

/** |Δfraction| below which two fleets on a lane count as co-located (a crossing). */
export const INTERCEPT_TOL = 1e-6;

/**
 * A fleet's occupancy of a lane as a linear function of time: its normalized
 * position `s ∈ [0,1]` along the canonical lane (endpoints sorted `lo`→`hi`, so
 * fleets travelling opposite ways share one axis), valid over [`t0`,`t1`]. A
 * moving fleet interpolates s0→s1 across its leg; a parked fleet is constant
 * (s0===s1) over an unbounded window.
 */
export interface LaneOcc {
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
export function laneOccupancy(fleet: Fleet): LaneOcc | null {
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
export function posAt(occ: LaneOcc, t: number): number {
  if (!occ.moving) {
    return occ.s0;
  }
  return occ.s0 + ((occ.s1 - occ.s0) * (t - occ.t0)) / (occ.t1 - occ.t0);
}
