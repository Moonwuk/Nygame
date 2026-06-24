import type { GameData } from '../data/schemas';
import { deepClone } from '../util/clone';
import type { Fleet, GameState, PlanetId, PlayerId } from './gameState';

/**
 * Fog of war as a SECURITY boundary (docs/modulesystem.md, deep-technical-roadmap
 * §6). `visibleState` is a pure projection the server runs before sending state
 * to a client: it physically removes everything `viewerId` may not see, so a
 * tampered client has no hidden data to reveal — not "send all, hide on the
 * client". It never feeds back into the reducer (determinism is untouched); it
 * is a read-only view.
 *
 * This is the first brick (current-visibility + radar signatures). Persistent
 * memory of last-seen state (variant B) layers on top in a follow-up.
 */

/** Identify (full-detail) range, in jumps, from any owned world or fleet. */
const IDENTIFY_HOPS = 1;

/** Size buckets for a radar contact — a coarse image, never the composition. */
export type SignatureSize = 'S' | 'M' | 'L';
function bucket(signature: number): SignatureSize {
  return signature >= 13 ? 'L' : signature >= 5 ? 'M' : 'S';
}

/** A radar contact: an enemy fleet detected by radar only — position + a coarse
 *  size, no identity or composition. */
export interface SignatureContact {
  location: PlanetId;
  size: SignatureSize;
}

/** The state as one player may see it: a filtered `GameState` plus the radar
 *  contacts that stand in for fleets detected but not identified. */
export type VisibleState = GameState & { signatures: SignatureContact[] };

/** Total radar signature of a fleet = Σ count × per-unit signature. */
function fleetSignature(fleet: Fleet, data: GameData): number {
  let total = 0;
  for (const stack of fleet.units) {
    total += stack.count * (data.units[stack.unit]?.signature ?? 1);
  }
  return total;
}

/** Radar reach (jumps) a fleet projects, from its loudest radar-ship. */
function fleetRadar(fleet: Fleet, data: GameData): number {
  let reach = 0;
  for (const stack of fleet.units) {
    if (stack.count > 0) reach = Math.max(reach, data.units[stack.unit]?.radarRange ?? 0);
  }
  return reach;
}

/** Flood `hops` jumps out from `start` over the lane graph, into `out`. */
function flood(state: GameState, start: PlanetId, hops: number, out: Set<PlanetId>): void {
  out.add(start);
  let frontier: PlanetId[] = [start];
  for (let d = 0; d < hops; d++) {
    const next: PlanetId[] = [];
    for (const id of frontier) {
      const links = state.planets[id]?.links;
      if (!links) continue;
      for (const link of links) {
        if (!out.has(link)) {
          out.add(link);
          next.push(link);
        }
      }
    }
    frontier = next;
  }
}

/** The node a fleet occupies or is travelling over. */
function fleetNode(fleet: Fleet): PlanetId | null {
  return fleet.location ?? fleet.movement?.to ?? fleet.movement?.from ?? null;
}

interface Coverage {
  identify: Set<PlanetId>;
  radar: Set<PlanetId>;
}
/** What `viewerId` can sense this instant: an identify range (full detail) and a
 *  wider radar range (signatures only), driven by world/fleet radar reach. */
function coverageFor(state: GameState, viewerId: PlayerId, data: GameData): Coverage {
  const identify = new Set<PlanetId>();
  const radar = new Set<PlanetId>();
  for (const planet of Object.values(state.planets)) {
    if (planet.owner !== viewerId) continue;
    flood(state, planet.id, IDENTIFY_HOPS, identify);
    let reach = 0;
    for (const b of planet.buildings) reach = Math.max(reach, data.buildings[b.type]?.radarRange ?? 0);
    if (reach > 0) flood(state, planet.id, reach, radar);
  }
  for (const fleet of Object.values(state.fleets)) {
    if (fleet.owner !== viewerId) continue;
    const node = fleetNode(fleet);
    if (node === null) continue;
    flood(state, node, IDENTIFY_HOPS, identify);
    const reach = fleetRadar(fleet, data);
    if (reach > 0) flood(state, node, reach, radar);
  }
  for (const id of identify) radar.add(id); // identify implies radar
  return { identify, radar };
}

/**
 * Project `state` to what `viewerId` may see. Pure: the input is never mutated
 * (works on a `deepClone`). Hides every other player's private data, the
 * unexplored map's contents, unseen fleets/battles and the whole schedule
 * (it leaks future intent); radar-only enemy fleets become coarse signatures.
 */
export function visibleState(state: GameState, viewerId: PlayerId, data: GameData): VisibleState {
  const view = deepClone(state) as VisibleState;
  const { identify, radar } = coverageFor(state, viewerId, data);

  // Other players' private data: keep identity, drop treasury and research.
  for (const player of Object.values(view.players)) {
    if (player.id === viewerId) continue;
    player.resources = {};
    delete player.technologies;
  }

  // Planets: keep topology (id/position/links) but strip contents you can't see.
  for (const planet of Object.values(view.planets)) {
    if (planet.owner === viewerId || identify.has(planet.id)) continue;
    planet.owner = null;
    planet.garrison = [];
    planet.buildings = [];
    planet.resources = {};
    delete planet.sectorType;
    delete planet.planetType;
  }

  // Fleets: own + identified enemy stay; radar-only enemy → a coarse signature;
  // everything else is removed entirely.
  const signatures: SignatureContact[] = [];
  for (const id of Object.keys(view.fleets).sort()) {
    const fleet = view.fleets[id];
    if (!fleet || fleet.owner === viewerId) continue;
    const node = fleetNode(fleet);
    if (node !== null && identify.has(node)) continue; // fully identified
    if (node !== null && radar.has(node)) {
      signatures.push({ location: node, size: bucket(fleetSignature(fleet, data)) });
    }
    delete view.fleets[id];
  }
  signatures.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  view.signatures = signatures;

  // Battles you cannot see, and the whole schedule (it leaks future events).
  for (const id of Object.keys(view.battles)) {
    const battle = view.battles[id];
    if (battle && !identify.has(battle.location)) delete view.battles[id];
  }
  view.scheduled = [];

  return view;
}
