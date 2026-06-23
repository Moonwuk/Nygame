import type { GameModule, HandlerContext } from '../kernel/module';
import type { Fleet, GameState, PlanetId } from '../state/gameState';
import type { GameData } from '../data/schemas';
import { timeScaleOf } from '../action/types';

const MS_PER_HOUR = 3_600_000;

interface MovePayload {
  fleetId: string;
  to: string;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Fleet speed = the slowest unit in it (data-driven), 0 if it cannot move. */
function fleetBaseSpeed(fleet: Fleet, data: GameData): number {
  let speed = Infinity;
  for (const stack of fleet.units) {
    const def = data.units[stack.unit];
    if (def) {
      speed = Math.min(speed, def.stats.speed);
    }
  }
  return Number.isFinite(speed) ? speed : 0;
}

/**
 * Dijkstra over the lane graph (planets + `links`, weighted by distance).
 * Returns the hops after `fromId` up to and including `toId`, or null if there
 * is no route. Deterministic: ties broken by planet id.
 */
function shortestPath(state: GameState, fromId: PlanetId, toId: PlanetId): PlanetId[] | null {
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

/**
 * Lazily-built route cache. The map topology (planet positions + links) is
 * static within a match, so each (from, to) pair is computed once with
 * Dijkstra and then served from the cache — O(V² log V) amortized over all
 * `fleet.move` orders, versus O(V² log V) per order without it.
 */
class RouteCache {
  private readonly cache = new Map<string, PlanetId[] | null>();

  lookup(state: GameState, from: PlanetId, to: PlanetId): PlanetId[] | null {
    const key = `${from}\0${to}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      // Return a copy so the caller can't mutate our cache.
      return cached ? [...cached] : null;
    }
    const result = shortestPath(state, from, to);
    this.cache.set(key, result);
    // Return a copy; the cache holds the authoritative reference.
    return result ? [...result] : null;
  }
}

/** Starts the next leg of a journey from `originId` along `hops`. */
function beginLeg(h: HandlerContext, fleet: Fleet, originId: PlanetId, hops: PlanetId[]): boolean {
  const nextHop = hops[0];
  const origin = h.state.planets[originId];
  const dest = nextHop ? h.state.planets[nextHop] : undefined;
  if (!nextHop || !origin || !dest) {
    return false;
  }
  const speed = h.hook<number>('fleet.speed', fleetBaseSpeed(fleet, h.ctx.data), {
    fleetId: fleet.id,
    from: originId,
    to: nextHop,
  });
  if (speed <= 0) {
    return false;
  }
  // timeScale compresses all real-time durations (GDD §3.1).
  const legMs =
    ((distance(origin.position, dest.position) / speed) * MS_PER_HOUR) / timeScaleOf(h.ctx);
  fleet.movement = {
    from: originId,
    to: nextHop,
    departedAt: h.ctx.now,
    arrivesAt: h.ctx.now + legMs,
    path: hops.slice(1),
    destination: hops[hops.length - 1],
  };
  fleet.location = null;
  h.schedule(fleet.movement.arrivesAt, 'fleet.arrival', { fleetId: fleet.id });
  return true;
}

/**
 * Movement — a base module (docs/modulesystem.md). Turns the intent
 * `fleet.move` into a real-time journey along star lanes (the map graph): it
 * routes with Dijkstra and travels hop by hop, scheduling each arrival. At each
 * node it announces `fleet.transit` (intermediate) or `fleet.arrived` (final) so
 * the combat module can detect a collision and pull the fleet into battle —
 * which cancels the rest of the journey. Final speed runs through the
 * `fleet.speed` hook (the computeSpeed pipeline, docs/modulesystem.md).
 */
export const movementModule: GameModule = {
  id: 'movement',
  version: '1.0.0',
  setup(api) {
    // Closure-scoped cache: topology is static within a kernel's lifetime.
    const routes = new RouteCache();

    api.onAction('fleet.move', (action, h) => {
      const payload = action.payload as Partial<MovePayload>;
      if (typeof payload?.fleetId !== 'string' || typeof payload?.to !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = h.state.fleets[payload.fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (fleet.location === null || fleet.movement !== null || fleet.battleId) {
        return h.reject('E_FLEET_BUSY');
      }
      if (payload.to === fleet.location) {
        return h.reject('E_SAME_LOCATION');
      }
      if (!h.state.planets[payload.to]) {
        return h.reject('E_NO_DESTINATION');
      }
      const path = routes.lookup(h.state, fleet.location, payload.to);
      if (!path || path.length === 0) {
        return h.reject('E_NO_ROUTE'); // not connected by lanes
      }
      const origin = fleet.location;
      if (!beginLeg(h, fleet, origin, path)) {
        return h.reject('E_FLEET_IMMOBILE');
      }
      h.emit('fleet.departed', { fleetId: fleet.id, from: origin, to: payload.to, path });
    });

    api.onAction('fleet.stop', (action, h) => {
      const { fleetId } = action.payload as { fleetId?: string };
      if (typeof fleetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = h.state.fleets[fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (!fleet.movement || fleet.battleId) {
        return h.reject('E_FLEET_BUSY'); // not under way (or in a battle) → nothing to halt
      }
      // A fleet can't halt in deep space — it stops at the next node it reaches:
      // drop the remaining hops so the current leg becomes the final one.
      fleet.movement.path = [];
      fleet.movement.destination = fleet.movement.to;
      h.emit('fleet.stopped', { fleetId, at: fleet.movement.to });
    });

    api.on('fleet.arrival', (event, h) => {
      const { fleetId } = event.payload as { fleetId: string };
      const fleet = h.state.fleets[fleetId];
      const mv = fleet?.movement;
      if (!fleet || !mv || fleet.battleId) {
        return; // fleet gone, stale leg, or pulled into a battle → journey ends
      }
      const at = mv.to;
      const remaining = mv.path ?? [];
      fleet.location = at;
      fleet.movement = null;

      if (remaining.length === 0) {
        h.emit('fleet.arrived', { fleetId, at }); // final destination
      } else {
        // Intermediate hop: announce for collision checks, then continue. If a
        // collision starts a battle, it nulls this fleet's movement and this
        // next leg's scheduled arrival is ignored.
        h.emit('fleet.transit', { fleetId, at });
        if (!fleet.battleId && !beginLeg(h, fleet, at, remaining)) {
          h.emit('fleet.stranded', { fleetId, at });
        }
      }
    });
  },
};
