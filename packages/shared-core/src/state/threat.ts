import type { Fleet, FleetId, GameState, PlanetId, PlayerId } from './gameState';
import type { Context } from '../action/types';
import { hoursToMs } from '../action/types';
import { getStance } from './diplomacy';
import { identifiedNodes, isVisibleTo } from './visibility';
import { fleetBaseSpeed, routeDistance } from './route';

/**
 * Node-threat scan — «враг близко к расположению» (ST-3.1, steward-roadmap).
 *
 * A PURE, deterministic read answering one question for a defender: which
 * hostile fleets bear on this node right now — already at it, inbound to it,
 * or camped on one of its lanes? The Steward's evacuation/commit logic (and any
 * HUD warning) keys off this list; the scan itself decides nothing.
 *
 * FOG-HONEST by construction: only fleets `viewerId` currently IDENTIFIES are
 * reported (`isVisibleTo` — the exact rule `visibleState` projects by), so a
 * server-side driver acting for one player reacts only to what that player
 * could legitimately see on their own map. A radar-only blip is NOT a threat
 * yet — composition is unknown, so no forecast could be run against it anyway.
 *
 * Hostility is the D1 stance read (`getStance === 'war'`, unrecorded pairs
 * default to war — FFA), the same base mapping the `diplomacy` capability
 * projects, matching `isHostile`'s no-capability fallback (invariant #3).
 */

/** One hostile force bearing on the node. */
export interface NodeThreat {
  fleetId: FleetId;
  owner: PlayerId;
  /** How it bears on the node: parked/orbiting AT it, in transit whose journey
   *  ends at it, or parked mid-lane on one of its incident lanes (standoff). */
  kind: 'present' | 'inbound' | 'nearby';
  /** Absolute game-time (ms) the force reaches the node — `ctx.now` for
   *  `present`/`nearby` (it is already in effect), the journey's end for
   *  `inbound` (exact for the final leg; later legs estimated at base speed,
   *  and when no estimate is possible the CURRENT leg's arrival is used — the
   *  earliest bound, so an unknown always errs toward reacting sooner). */
  eta: number;
}

/** The node a journey ends at: the last remaining hop, falling back to the
 *  current leg's `to`. A `parkT`/`endT` short-stop still counts — the fleet
 *  ends ON a lane at the node's doorstep, which is a bearing threat all the
 *  same (artillery standoff range); the scan is a tripwire, not a rangefinder. */
function journeyEnd(mv: NonNullable<Fleet['movement']>): PlanetId {
  if (mv.destination !== undefined) return mv.destination;
  if (mv.path && mv.path.length > 0) return mv.path[mv.path.length - 1]!;
  return mv.to;
}

/** ETA (absolute ms) of a moving fleet at its journey's end: the current leg is
 *  exact (`arrivesAt`); remaining hops are estimated at the fleet's base speed
 *  (the same client-preview math as `estimateTravelHours` — the authoritative
 *  legs additionally run the `fleet.speed` hook, so the estimate can drift a
 *  little). No estimate possible (zero speed / broken map) → the current leg's
 *  arrival, the earliest plausible bound (fail-safe: react sooner, not later). */
function journeyEta(state: GameState, fleet: Fleet, ctx: Context): number {
  const mv = fleet.movement!;
  if (!mv.path || mv.path.length === 0) return mv.arrivesAt;
  const speed = fleetBaseSpeed(fleet, ctx.data);
  if (speed <= 0) return mv.arrivesAt;
  const rest = routeDistance(state, mv.to, mv.path);
  return mv.arrivesAt + hoursToMs(ctx, rest / speed);
}

/**
 * All hostile fleets bearing on `nodeId` that `viewerId` can currently see,
 * soonest first (ties by fleet id — deterministic). Pure: reads state only.
 *
 * `present` — hostile parked/orbiting at the node (battle possible now).
 * `inbound` — in transit, journey ends at the node; `eta` says when.
 * `nearby`  — parked mid-lane on a lane incident to the node (standoff camp).
 *
 * A hostile merely passing THROUGH on an incident lane is not reported — it
 * bears on its own destination, not this node.
 */
export function scanNodeThreats(
  state: GameState,
  nodeId: PlanetId,
  viewerId: PlayerId,
  ctx: Context,
): NodeThreat[] {
  const out: NodeThreat[] = [];
  // Hoisted once — each per-fleet visibility check is then a set lookup.
  const identified = identifiedNodes(state, viewerId, ctx.data);
  for (const fleetId of Object.keys(state.fleets).sort()) {
    const fleet = state.fleets[fleetId]!;
    if (fleet.owner === viewerId) continue;
    if (getStance(state, viewerId, fleet.owner) !== 'war') continue;
    let kind: NodeThreat['kind'] | null = null;
    let eta = ctx.now;
    if (fleet.location === nodeId) {
      kind = 'present';
    } else if (fleet.movement && journeyEnd(fleet.movement) === nodeId) {
      kind = 'inbound';
      eta = journeyEta(state, fleet, ctx);
    } else if (fleet.edge && (fleet.edge.from === nodeId || fleet.edge.to === nodeId)) {
      kind = 'nearby';
    }
    if (kind === null) continue;
    if (!isVisibleTo(state, viewerId, { fleetId }, ctx.data, identified)) continue;
    out.push({ fleetId, owner: fleet.owner, kind, eta });
  }
  out.sort((a, b) => a.eta - b.eta || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  return out;
}
