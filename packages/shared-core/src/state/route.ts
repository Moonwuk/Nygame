import type { Fleet, GameState, PlanetId } from './gameState';
import type { GameData } from '../data/schemas';
import type { Context } from '../action/types';
import { hoursToMs } from '../action/types';
import { effectiveStats } from '../util/loadout';

/**
 * Routing + travel-time over the lane graph (map-roadmap.md). The single source
 * of truth for "what route does a fleet take and how long is it": longer routes
 * take proportionally longer, since a leg's time is its Euclidean length over the
 * fleet's speed. Pure and deterministic — used by the movement module
 * (authoritative) and by the client for a move-preview ETA.
 */

/** Euclidean distance between two map positions. */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Fleet speed = the slowest SHIP in it (data-driven), 0 if it cannot move. Ground
 * troops ride in `landing`, never `units`, so they never affect speed. A badly
 * damaged hull drags: at/above 30% HP a ship runs at full speed; below 30% its
 * speed scales down with the remaining hull (floored so a crippled ship still limps
 * rather than freezing). `stack.hp` is set only during combat — full health
 * otherwise (gameState.ts §30-32) — so the penalty bites once a ship carries hull
 * damage outside a battle.
 */
export function fleetBaseSpeed(fleet: Fleet, data: GameData): number {
  let speed = Infinity;
  for (const stack of fleet.units) {
    const def = data.units[stack.unit];
    if (!def) continue;
    const eff = effectiveStats(def, stack, data);
    let s = eff.speed ?? 0;
    const maxHp = stack.count * (eff.hp ?? 0);
    if (stack.hp !== undefined && maxHp > 0) {
      const frac = stack.hp / maxHp;
      if (frac < 0.3) s *= Math.max(0.2, frac / 0.3); // limp below 30% hull
    }
    speed = Math.min(speed, s);
  }
  return Number.isFinite(speed) ? speed : 0;
}

/**
 * Dijkstra over the lane graph (planets + `links`, weighted by distance).
 * Returns the hops after `fromId` up to and including `toId`, or null if there
 * is no route. Deterministic: ties broken by planet id.
 */
export function planRoute(state: GameState, fromId: PlanetId, toId: PlanetId): PlanetId[] | null {
  if (fromId === toId) {
    return [];
  }
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  dist.set(fromId, 0);

  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (visited.has(node)) {
        continue;
      }
      if (u === null || d < best || (d === best && node < u)) {
        best = d;
        u = node;
      }
    }
    if (u === null || u === toId) {
      break;
    }
    visited.add(u);
    const planet = state.planets[u];
    if (!planet) {
      continue;
    }
    for (const v of [...(planet.links ?? [])].sort()) {
      const vp = state.planets[v];
      if (!vp || visited.has(v)) {
        continue;
      }
      const nd = best + distance(planet.position, vp.position);
      const cur = dist.get(v);
      if (cur === undefined || nd < cur) {
        dist.set(v, nd);
        prev.set(v, u);
      }
    }
  }

  if (!dist.has(toId)) {
    return null;
  }
  const path: string[] = [];
  let cur: string | undefined = toId;
  while (cur !== undefined && cur !== fromId) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return cur === fromId ? path : null;
}

/** Total lane distance of a route (the hops after `fromId`, in order). */
export function routeDistance(state: GameState, fromId: PlanetId, route: readonly PlanetId[]): number {
  let total = 0;
  let cur = state.planets[fromId];
  for (const hop of route) {
    const next = state.planets[hop];
    if (cur && next) {
      total += distance(cur.position, next.position);
    }
    cur = next;
  }
  return total;
}

/**
 * Estimated travel time in game-hours from `fromId` to `toId` along the shortest
 * lane route, at the fleet's base speed (the slowest unit). The client-side
 * preview estimate; the authoritative duration the server schedules additionally
 * runs each leg's speed through the `fleet.speed` hook (terrain), so the real
 * time can differ slightly. null if there is no route, or the fleet can't move.
 */
export function estimateTravelHours(
  state: GameState,
  data: GameData,
  fromId: PlanetId,
  toId: PlanetId,
  fleet: Fleet,
): number | null {
  const route = planRoute(state, fromId, toId);
  if (!route || route.length === 0) {
    return null;
  }
  const speed = fleetBaseSpeed(fleet, data);
  if (speed <= 0) {
    return null;
  }
  return routeDistance(state, fromId, route) / speed;
}

/** The node a fleet's CURRENT journey ends at — the one reading of
 *  `FleetMovement`'s journey fields (the movement module always stamps
 *  `destination`; the `path`-tail and `to` fallbacks keep hand-built or legacy
 *  records reading sanely). A `parkT`/`endT` short-stop still names this node:
 *  the journey ends on a lane at its doorstep. */
export function journeyDestination(mv: NonNullable<Fleet['movement']>): PlanetId {
  if (mv.destination !== undefined) return mv.destination;
  if (mv.path && mv.path.length > 0) return mv.path[mv.path.length - 1]!;
  return mv.to;
}

/** ETA (absolute ms) of a moving fleet at its journey's end: the current leg is
 *  authoritative (`arrivesAt`); remaining hops are estimated over the COMMITTED
 *  `path` at the fleet's base speed ÷ timeScale (the authoritative legs
 *  additionally run the `fleet.speed` hook, so the estimate can drift a
 *  little). No estimate possible (zero speed / broken map) → the current leg's
 *  arrival, the earliest plausible bound (fail-safe: callers react sooner,
 *  never later). */
export function journeyEtaMs(
  state: GameState,
  fleet: Fleet,
  mv: NonNullable<Fleet['movement']>,
  ctx: Context,
): number {
  if (!mv.path || mv.path.length === 0) return mv.arrivesAt;
  const speed = fleetBaseSpeed(fleet, ctx.data);
  if (speed <= 0) return mv.arrivesAt;
  return mv.arrivesAt + hoursToMs(ctx, routeDistance(state, mv.to, mv.path) / speed);
}
