import type { Fleet, FleetId, GameState, PlanetId, PlayerId } from './gameState';
import type { Context } from '../action/types';
import { getStance } from './diplomacy';
import { identifiedNodes, isVisibleTo } from './visibility';
import { journeyDestination, journeyEtaMs } from './route';

/**
 * Node-threat scan — «враг близко к расположению» (ST-3.1, steward-roadmap).
 *
 * A PURE, deterministic read answering one question for a defender: which
 * hostile fleets bear on this node right now — already at it, inbound to it,
 * or camped on one of its lanes? The Steward's evacuation/commit logic (and any
 * HUD warning) keys off this list; the scan itself decides nothing. Call it on
 * a state advanced to `ctx.now` (the server flow: `advanceTo` → read) — the
 * visibility anchors interpolate moving fleets at `state.time`.
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
   *  `present`/`nearby` (it is already in effect), `journeyEtaMs` for
   *  `inbound` (exact final leg, estimated earlier hops — see route.ts). */
  eta: number;
}

/** How `fleet` bears on `nodeId`, or null if it does not. A hostile merely
 *  passing THROUGH on an incident lane is not a bearing — it aims at its own
 *  destination, not this node. */
function classify(
  state: GameState,
  fleet: Fleet,
  nodeId: PlanetId,
  ctx: Context,
): Pick<NodeThreat, 'kind' | 'eta'> | null {
  if (fleet.location === nodeId) {
    return { kind: 'present', eta: ctx.now };
  }
  const mv = fleet.movement;
  if (mv && journeyDestination(mv) === nodeId) {
    return { kind: 'inbound', eta: journeyEtaMs(state, fleet, mv, ctx) };
  }
  const e = fleet.edge;
  if (e && (e.from === nodeId || e.to === nodeId)) {
    return { kind: 'nearby', eta: ctx.now };
  }
  return null;
}

/**
 * All hostile fleets bearing on `nodeId` that `viewerId` can currently see,
 * soonest first (ties by fleet id — the total (eta, fleetId) order alone pins
 * determinism, no pre-sorting needed). Pure: reads state only.
 *
 * `identified` — optional pre-hoisted `identifiedNodes(state, viewerId, data)`
 * (the `isVisibleTo` pattern): a driver scanning MANY nodes for one seat
 * computes the coverage once and passes it in; omitted, it is computed here.
 */
export function scanNodeThreats(
  state: GameState,
  nodeId: PlanetId,
  viewerId: PlayerId,
  ctx: Context,
  identified?: Set<PlanetId>,
): NodeThreat[] {
  const out: NodeThreat[] = [];
  const seen = identified ?? identifiedNodes(state, viewerId, ctx.data);
  for (const fleetId of Object.keys(state.fleets)) {
    const fleet = state.fleets[fleetId]!;
    if (fleet.owner === viewerId) continue;
    if (getStance(state, viewerId, fleet.owner) !== 'war') continue;
    const bearing = classify(state, fleet, nodeId, ctx);
    if (bearing === null) continue;
    if (!isVisibleTo(state, viewerId, { fleetId }, ctx.data, seen)) continue;
    out.push({ fleetId, owner: fleet.owner, ...bearing });
  }
  out.sort((a, b) => a.eta - b.eta || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  return out;
}
