import type { Fleet, GameState, PlanetId } from './gameState';

/** The interpolation parameter along a leg at `now`: how far the fleet sits
 *  within the lane's [0,1] span, honoring the leg's own [startT, endT]
 *  sub-segment and clamping outside the travel window. THE one copy of the
 *  progress math — movement (fleet.stop), visibility (sensor reach / radar
 *  anchor) and artillery (standoff range) all read it from here, so the
 *  interpolation semantics cannot silently fork. */
export function legT(mv: NonNullable<Fleet['movement']>, now: number): number {
  const span = mv.arrivesAt - mv.departedAt;
  const progress = span > 0 ? Math.min(1, Math.max(0, (now - mv.departedAt) / span)) : 1;
  const startT = mv.startT ?? 0;
  return startT + ((mv.endT ?? 1) - startT) * progress;
}

/** A fleet's CONTINUOUS map position at `now`: its node, its interpolated spot
 *  mid-leg (a moving fleet), or its parked lane point — so range and sensor
 *  checks track the SHIP, not its destination. `null` when no position resolves
 *  (nodes missing from the map). */
export function fleetPositionAt(
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
  if (mv) return lerp(mv.from, mv.to, legT(mv, now));
  const e = fleet.edge;
  if (e) return lerp(e.from, e.to, e.t);
  return null;
}

/** The node a fleet is NEAREST to at `now` — its anchor for graph-hop identify
 *  and for where its radar contact blips. Tracks the ship along its leg, not
 *  pinned to the destination. */
export function fleetNodeAt(state: GameState, fleet: Fleet, now: number): PlanetId | null {
  if (fleet.location) return fleet.location;
  const mv = fleet.movement;
  if (mv) return legT(mv, now) <= 0.5 ? mv.from : mv.to;
  if (fleet.edge) return fleet.edge.t <= 0.5 ? fleet.edge.from : fleet.edge.to;
  return null;
}
