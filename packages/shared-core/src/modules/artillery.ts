import type { GameModule, HandlerContext } from '../kernel/module';
import type { BarrageMode, Fleet, GameState, PlanetId } from '../state/gameState';
import type { GameData } from '../data/schemas';
import { timeScaleOf } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { getStance } from '../state/diplomacy';
import { distance } from '../state/route';
import { applyDamageToSide, isHostile, ownFleet, removeIfWiped } from '../util/combat';

/** A fleet's continuous map position at `now`: its node, its parked lane point,
 *  or its interpolated spot mid-leg (mirrors movement's own progress math). null
 *  if it has no resolvable position (units missing from the map). */
function fleetPosition(
  state: GameState,
  fleet: Fleet,
  now: number,
): { x: number; y: number } | null {
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
 *    (i.e. `war` OR `peace`) — it opens fire on un-allied neighbours. */
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
  const shots: { shooterId: string; owner: string; targetId: string; dmg: number; at: string }[] =
    [];
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
    removeIfWiped(h, shot.targetId);
  }
}

/**
 * Artillery — the ranged standoff layer (GDD §7.2), split out of the melee
 * combat module along the bus seams. Accrues over continuous time
 * (`time.advanced`) and owns the barrage orders (focus-fire target + rules of
 * engagement). Degrades gracefully: without this module artillery-trait units
 * simply never fire at range — they still fight in melee battles.
 */
export const artilleryModule: GameModule = {
  id: 'artillery',
  version: '1.0.0',
  setup(api) {
    // The artillery layer accrues over continuous time, like the economy. The
    // manifest registers `orbital` BEFORE this module, preserving the old
    // runOrbital→runArtillery order within each span (invariant #6).
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) {
        return;
      }
      runArtillery(h, (span / MS_PER_HOUR) * timeScaleOf(h.ctx));
    });

    // Focus-fire order for artillery standoff fire: aim this fleet's guns at a
    // specific hostile fleet, or clear (targetId null) to resume auto-targeting.
    // The shot itself fires in `runArtillery` each span; this only records intent
    // (server-authority — the client sends the order, never the damage).
    api.onAction('fleet.barrage', (action, h) => {
      const { fleetId, targetId } = action.payload as {
        fleetId?: string;
        targetId?: string | null;
      };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = ownFleet(h.state, fleetId); // own-key — rejects an injected `__proto__`
      // One opaque code for "no such fleet" AND "not your fleet": otherwise a client
      // could enumerate ids and use E_NO_FLEET vs E_FORBIDDEN to confirm the existence
      // of fog-hidden enemy fleets (A06 — reject-code side-channel).
      if (!fleet || fleet.owner !== action.playerId) {
        return h.reject('E_NO_FLEET');
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
      // A non-existent target and a non-hostile one both answer with the same code, so
      // a client can't probe a fog-hidden fleet's existence / war-stance (A06).
      if (!target || !isHostile(h, fleet.owner, target.owner)) {
        return h.reject('E_NO_TARGET');
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
      // One opaque code for "no such fleet" AND "not your fleet": otherwise a client
      // could enumerate ids and use E_NO_FLEET vs E_FORBIDDEN to confirm the existence
      // of fog-hidden enemy fleets (A06 — reject-code side-channel).
      if (!fleet || fleet.owner !== action.playerId) {
        return h.reject('E_NO_FLEET');
      }
      if (artilleryRange(fleet, h.ctx.data) <= 0) {
        return h.reject('E_NO_ARTILLERY');
      }
      fleet.barrageMode = mode;
      h.emit('fleet.barrageMode', { fleetId, mode, owner: action.playerId });
    });
  },
};
