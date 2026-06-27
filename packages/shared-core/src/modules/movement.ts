import type { GameModule, HandlerContext } from '../kernel/module';
import type { Fleet, FleetEdge, GameState, PlanetId } from '../state/gameState';
import { timeScaleOf } from '../action/types';
import { MS_PER_HOUR } from '../util/time';
import { distance, fleetBaseSpeed, planRoute, routeDistance } from '../state/route';

/** A target a `fleet.move` can aim at: a node, or a continuous point on a lane. */
interface MovePayload {
  fleetId: string;
  /** Destination node. */
  to?: string;
  /** Destination point ON a lane (continuous position) — the army stops partway
   *  down the road, Bytro-style, instead of at a node. */
  toEdge?: { from: string; to: string; t: number };
}

/** A planned journey, ready for `beginLeg`: the first leg runs `fromId`→`hops[0]`
 *  (starting at fraction `startT`), then each hop in turn; the LAST leg parks at
 *  `parkT` (<1) instead of reaching its node. */
interface Journey {
  fromId: PlanetId;
  hops: PlanetId[];
  startT: number;
  parkT: number;
}

/** Below this, a fraction is treated as a node (avoids degenerate parked edges). */
const EPS = 1e-4;

/**
 * Lazily-built route cache. The map topology (planet positions + links) is mostly
 * static, so each (from, to) node pair is computed once with Dijkstra and served
 * from the cache — keyed by `state.topology` so a hero temp lane (which mutates
 * `links`) bumps the version and invalidates stale routes.
 */
class RouteCache {
  private readonly cache = new Map<string, PlanetId[] | null>();

  lookup(state: GameState, from: PlanetId, to: PlanetId): PlanetId[] | null {
    // Key includes the topology version: a hero opening/closing a temp lane bumps it,
    // so stale routes computed before the link change are never served.
    const key = `${state.topology ?? 0}\0${from}\0${to}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      return cached ? [...cached] : null;
    }
    const result = planRoute(state, from, to);
    this.cache.set(key, result);
    return result ? [...result] : null;
  }
}

/** Euclidean length of the lane between two nodes (0 if either is missing). */
function laneLength(state: GameState, a: PlanetId, b: PlanetId): number {
  const pa = state.planets[a]?.position;
  const pb = state.planets[b]?.position;
  return pa && pb ? distance(pa, pb) : 0;
}

/**
 * Starts a leg of a journey: the fleet travels `fromId`→`hops[0]` along the
 * sub-segment [`startT`, endT] of that lane, where endT = `parkT` when this is
 * the final hop (so the journey ends at a point on the lane) else 1. Schedules
 * the leg's arrival. Returns false if the leg cannot start (no nodes, or speed 0).
 */
function beginLeg(
  h: HandlerContext,
  fleet: Fleet,
  fromId: PlanetId,
  hops: PlanetId[],
  startT: number,
  parkT: number,
): boolean {
  const nextHop = hops[0];
  const origin = h.state.planets[fromId];
  const dest = nextHop ? h.state.planets[nextHop] : undefined;
  if (!nextHop || !origin || !dest) {
    return false;
  }
  const endT = hops.length === 1 ? parkT : 1;
  const span = endT - startT;
  if (span <= 0) {
    return false;
  }
  const speed = h.hook<number>('fleet.speed', fleetBaseSpeed(fleet, h.ctx.data), {
    fleetId: fleet.id,
    from: fromId,
    to: nextHop,
  });
  if (speed <= 0) {
    return false;
  }
  // Distance covered = the fraction [startT,endT] of the full lane length.
  const legDist = distance(origin.position, dest.position) * span;
  // timeScale compresses all real-time durations (GDD §3.1).
  const legMs = ((legDist / speed) * MS_PER_HOUR) / timeScaleOf(h.ctx);
  fleet.movement = {
    from: fromId,
    to: nextHop,
    departedAt: h.ctx.now,
    arrivesAt: h.ctx.now + legMs,
    path: hops.slice(1),
    destination: hops[hops.length - 1],
    ...(startT > 0 ? { startT } : {}),
    ...(endT < 1 ? { endT } : {}),
    ...(parkT < 1 ? { parkT } : {}),
  };
  fleet.location = null;
  fleet.edge = null;
  h.schedule(fleet.movement.arrivesAt, 'fleet.arrival', {
    fleetId: fleet.id,
    departedAt: h.ctx.now,
    arrivesAt: fleet.movement.arrivesAt,
  });
  // A leg just started: the fleet now occupies the lane (`from`,`to`) over a known
  // window. Announced for EVERY leg (journey start AND each intermediate hop, which
  // `fleet.departed` does not cover) so collision modules can compute lane-crossing
  // intercepts. Carries no journey context — listeners read `fleet.movement`.
  h.emit('fleet.leg', { fleetId: fleet.id });
  return true;
}

/** Origin candidate: where a leg can start from (a node, or one end of the lane
 *  a parked fleet sits on). `lead` is the node(s) the first leg traverses to
 *  reach `routingNode`; `cost` is that lead's distance. */
interface Origin {
  fromId: PlanetId;
  routingNode: PlanetId;
  lead: PlanetId[];
  startT: number;
  cost: number;
}

/** Target candidate: the node Dijkstra routes to, plus an optional final partial
 *  leg into a lane (so the journey ends at a point), with its park fraction. */
interface Target {
  routeTo: PlanetId;
  final: PlanetId[];
  parkT: number;
  cost: number;
}

/** The places a fleet can begin a journey from. At a node: just that node. Parked
 *  on a lane: either end (the cheaper one wins after routing). */
function originsOf(state: GameState, fleet: Fleet): Origin[] {
  if (fleet.location) {
    return [{ fromId: fleet.location, routingNode: fleet.location, lead: [], startT: 0, cost: 0 }];
  }
  const e = fleet.edge;
  if (!e) {
    return [];
  }
  const len = laneLength(state, e.from, e.to);
  return [
    // forward to `to`
    { fromId: e.from, routingNode: e.to, lead: [e.to], startT: e.t, cost: len * (1 - e.t) },
    // back to `from`
    { fromId: e.to, routingNode: e.from, lead: [e.from], startT: 1 - e.t, cost: len * e.t },
  ];
}

/** The node(s) a journey can route toward. A node target: that node. An
 *  edge-point target: route to either endpoint, then a final partial leg parks. */
function targetsOf(state: GameState, payload: MovePayload): Target[] | { error: string } {
  if (payload.toEdge) {
    const { from, to, t } = payload.toEdge;
    if (typeof from !== 'string' || typeof to !== 'string' || typeof t !== 'number') {
      return { error: 'E_BAD_PAYLOAD' };
    }
    const a = state.planets[from];
    const b = state.planets[to];
    if (!a || !b) {
      return { error: 'E_NO_DESTINATION' };
    }
    if (!a.links?.includes(to) || !b.links?.includes(from)) {
      return { error: 'E_NOT_A_LANE' }; // a point can only sit on a real lane
    }
    // Near a node → just go to that node (no degenerate parked edge).
    if (t <= EPS) {
      return [{ routeTo: from, final: [], parkT: 1, cost: 0 }];
    }
    if (t >= 1 - EPS) {
      return [{ routeTo: to, final: [], parkT: 1, cost: 0 }];
    }
    const len = laneLength(state, from, to);
    return [
      { routeTo: from, final: [to], parkT: t, cost: len * t },
      { routeTo: to, final: [from], parkT: 1 - t, cost: len * (1 - t) },
    ];
  }
  if (typeof payload.to === 'string') {
    if (!state.planets[payload.to]) {
      return { error: 'E_NO_DESTINATION' };
    }
    return [{ routeTo: payload.to, final: [], parkT: 1, cost: 0 }];
  }
  return { error: 'E_BAD_PAYLOAD' };
}

/**
 * Plans the shortest journey for `fleet` to a node or a point on a lane,
 * considering every origin/target endpoint pairing (so a parked fleet may reverse
 * down its road and a lane-point may be approached from either end). Pure; ties
 * broken deterministically by the hop string. Returns null if nowhere is reachable.
 */
function planJourney(
  state: GameState,
  routes: RouteCache,
  fleet: Fleet,
  payload: MovePayload,
): Journey | { error: string } | null {
  const targets = targetsOf(state, payload);
  if ('error' in targets) {
    return targets;
  }
  const origins = originsOf(state, fleet);
  if (origins.length === 0) {
    return { error: 'E_FLEET_BUSY' }; // in transit / no anchor
  }

  // Fast path: repositioning ALONG the lane the fleet is already parked on — a
  // single direct leg, no detour to an endpoint (Bytro "drag the army down the
  // road"). Only when the target point is interior; node-ish targets fall through.
  const e = fleet.edge;
  if (e && payload.toEdge) {
    const te = payload.toEdge;
    const same =
      (te.from === e.from && te.to === e.to) || (te.from === e.to && te.to === e.from);
    const q = te.from === e.from ? te.t : 1 - te.t; // target fraction along (e.from,e.to)
    if (same && q > EPS && q < 1 - EPS) {
      if (Math.abs(q - e.t) <= EPS) {
        return { error: 'E_SAME_LOCATION' };
      }
      return q > e.t
        ? { fromId: e.from, hops: [e.to], startT: e.t, parkT: q }
        : { fromId: e.to, hops: [e.from], startT: 1 - e.t, parkT: 1 - q };
    }
  }

  let best: Journey | null = null;
  let bestCost = Infinity;
  let bestKey = '';
  for (const o of origins) {
    for (const t of targets) {
      const mid = routes.lookup(state, o.routingNode, t.routeTo);
      if (mid === null) {
        continue; // unreachable by lanes from this origin endpoint
      }
      const hops = [...o.lead, ...mid, ...t.final];
      if (hops.length === 0) {
        continue; // already there
      }
      const cost = o.cost + routeDistance(state, o.routingNode, mid) + t.cost;
      const key = hops.join('\0');
      if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && key < bestKey)) {
        best = { fromId: o.fromId, hops, startT: o.startT, parkT: t.parkT };
        bestCost = cost;
        bestKey = key;
      }
    }
  }
  return best;
}

/**
 * Movement — a base module (docs/modulesystem.md). Turns the intent `fleet.move`
 * into a real-time journey along the lane graph: it routes with Dijkstra and
 * travels hop by hop, scheduling each arrival. A fleet's position is continuous —
 * it can march to a node OR to any point ON a lane (`toEdge`), `fleet.stop` parks
 * it wherever it is, and a parked fleet re-routes from there (Bytro-style). At
 * each node it announces `fleet.transit` (intermediate) or `fleet.arrived` (final)
 * for collision checks; a mid-lane park announces `fleet.parked`, and every leg
 * start announces `fleet.leg` (so collision modules can intercept two hostile
 * fleets crossing ON a lane, not only at a node). Speed runs through the
 * `fleet.speed` hook (terrain).
 */
export const movementModule: GameModule = {
  id: 'movement',
  version: '1.1.0',
  setup(api) {
    // Closure-scoped cache, shared across actions; keyed by `state.topology` so a
    // hero temp lane mutating `links` invalidates stale routes (see RouteCache).
    const routes = new RouteCache();

    api.onAction('fleet.move', (action, h) => {
      const payload = action.payload as Partial<MovePayload>;
      if (typeof payload?.fleetId !== 'string' || (payload.to === undefined && !payload.toEdge)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = h.state.fleets[payload.fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (fleet.movement || fleet.battleId || (fleet.location === null && !fleet.edge)) {
        return h.reject('E_FLEET_BUSY'); // in transit / in battle → not free to re-task
      }
      if (payload.to !== undefined && payload.to === fleet.location) {
        return h.reject('E_SAME_LOCATION');
      }
      const plan = planJourney(h.state, routes, fleet, payload as MovePayload);
      if (plan === null) {
        return h.reject('E_NO_ROUTE'); // not connected by lanes
      }
      if ('error' in plan) {
        return h.reject(plan.error);
      }
      const origin = fleet.location ?? fleet.edge?.from ?? null;
      if (!beginLeg(h, fleet, plan.fromId, plan.hops, plan.startT, plan.parkT)) {
        return h.reject('E_FLEET_IMMOBILE');
      }
      h.emit('fleet.departed', {
        fleetId: fleet.id,
        from: origin,
        to: payload.to ?? plan.hops[plan.hops.length - 1],
        path: plan.hops,
      });
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
      const mv = fleet.movement;
      if (!mv || fleet.battleId) {
        return h.reject('E_FLEET_BUSY'); // not under way (or in a battle) → nothing to halt
      }
      // Park the fleet at its CURRENT continuous position on the lane — not at the
      // next node. The fraction is how far this leg has progressed within its own
      // [startT, endT] sub-segment, clamped to the lane interior.
      const startT = mv.startT ?? 0;
      const endT = mv.endT ?? 1;
      const progress =
        mv.arrivesAt > mv.departedAt
          ? Math.min(1, Math.max(0, (h.ctx.now - mv.departedAt) / (mv.arrivesAt - mv.departedAt)))
          : 1;
      const frac = Math.min(1 - EPS, Math.max(EPS, startT + (endT - startT) * progress));
      const edge: FleetEdge = { from: mv.from, to: mv.to, t: frac };
      fleet.movement = null;
      fleet.location = null;
      fleet.edge = edge;
      // The leg's scheduled arrival is now stale; the arrival handler ignores it
      // (its `departedAt` no longer matches this fleet's movement).
      h.emit('fleet.parked', { fleetId, edge });
    });

    api.on('fleet.arrival', (event, h) => {
      const { fleetId, departedAt, arrivesAt } = event.payload as {
        fleetId: string;
        departedAt?: number;
        arrivesAt?: number;
      };
      const fleet = h.state.fleets[fleetId];
      const mv = fleet?.movement;
      if (!fleet || !mv || fleet.battleId) {
        return; // fleet gone, stale leg, or pulled into a battle → journey ends
      }
      // Stale arrival from a leg this fleet has since abandoned (stop/re-route). The
      // departure instant alone is NOT a unique leg id: a stop+reroute handled within
      // the same instant stamps both legs with the same `departedAt`, so we also match
      // the scheduled arrival time. (When two legs share BOTH, firing either at that
      // shared instant yields the correct result for the live movement.)
      if (
        (departedAt !== undefined && mv.departedAt !== departedAt) ||
        (arrivesAt !== undefined && mv.arrivesAt !== arrivesAt)
      ) {
        return;
      }
      // Final leg ends at a point ON the lane → park there (no node arrival).
      if (mv.endT !== undefined && mv.endT < 1) {
        const edge: FleetEdge = { from: mv.from, to: mv.to, t: mv.endT };
        fleet.movement = null;
        fleet.location = null;
        fleet.edge = edge;
        h.emit('fleet.parked', { fleetId, edge });
        return;
      }
      const at = mv.to;
      const remaining = mv.path ?? [];
      const parkT = mv.parkT ?? 1;
      fleet.location = at;
      fleet.edge = null;
      fleet.movement = null;

      if (remaining.length === 0) {
        h.emit('fleet.arrived', { fleetId, at }); // final destination (a node)
      } else {
        // Intermediate hop: announce for collision checks, then continue. If a
        // collision starts a battle, it nulls this fleet's movement and this
        // next leg's scheduled arrival is ignored.
        h.emit('fleet.transit', { fleetId, at });
        if (!fleet.battleId && !beginLeg(h, fleet, at, remaining, 0, parkT)) {
          h.emit('fleet.stranded', { fleetId, at });
        }
      }
    });
  },
};
