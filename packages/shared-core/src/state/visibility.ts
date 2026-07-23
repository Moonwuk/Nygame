import { buildingLevel, type GameData } from '../data/schemas';
import { deepClone } from '../util/clone';
import { offerInvolves } from './diplomacy';
import { fleetNodeAt, fleetPositionAt } from './fleetPosition';
import type { Fleet, GameState, PlanetId, PlayerId, ScheduledEvent } from './gameState';

/** A scheduled event belongs to a player when it clearly references their own planet,
 *  fleet, or is owner-tagged for them. Used to keep a player's OWN pending construction /
 *  production / arrivals in their view (the client renders the build queue + ETAs from
 *  them) while every enemy timer stays hidden. */
function scheduledOwnedBy(event: ScheduledEvent, viewerId: PlayerId, state: GameState): boolean {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (p.owner === viewerId) return true;
  // Per-player events tagged by `playerId` (e.g. `technology.complete`) — the
  // viewer's own research/economy timers, which they should keep in view.
  if (p.playerId === viewerId) return true;
  if (typeof p.planetId === 'string' && state.planets[p.planetId]?.owner === viewerId) return true;
  if (typeof p.fleetId === 'string' && state.fleets[p.fleetId]?.owner === viewerId) return true;
  return false;
}

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

/** Identify (full-detail) range, in jumps, from an owned WORLD — local awareness
 *  around your own territory. */
const IDENTIFY_HOPS = 1;

/** Identify range from a FLEET, in jumps. Ships are near-blind on their own: they
 *  see only the node they occupy (`0` hops). Real reconnaissance comes from RADAR —
 *  a `radar` building/outpost, or a unit/hero carrying a radar module (`radarRange`,
 *  resolved via `fleetRadar`). A radarless fleet is a blind kitten by design. */
const FLEET_IDENTIFY_HOPS = 0;

/** A radar projects TWO concentric ranges: it catches coarse signatures out to its
 *  full reach, and fully identifies contacts within the inner half of that reach
 *  (close contacts are resolved; far ones are just blips). */
const IDENTIFY_REACH_FRACTION = 0.5;

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

/** The state as one player may see it: a filtered `GameState`, the radar
 *  contacts that stand in for fleets detected but not identified, and the ids of
 *  worlds shown from memory (greyed "last known", variant B). */
export type VisibleState = GameState & {
  signatures: SignatureContact[];
  remembered: PlanetId[];
};

/** Total radar signature of a fleet = Σ count × per-unit signature. */
function fleetSignature(fleet: Fleet, data: GameData): number {
  let total = 0;
  for (const stack of fleet.units) {
    total += stack.count * (data.units[stack.unit]?.signature ?? 1);
  }
  return total;
}

/** Radar reach (distance, in map units) a fleet projects, from its loudest radar-ship. */
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

/** Add every node within Euclidean `radius` of `originId`'s position. Radar is a
 *  physical signal, not graph hops: a node that is close in space still shows up
 *  even if it is many jumps away (or unreachable) by the lane graph. Uses squared
 *  distance — exact and deterministic, no sqrt. */
function withinRadiusAt(
  state: GameState,
  origin: { x: number; y: number },
  radius: number,
  out: Set<PlanetId>,
): void {
  const r2 = radius * radius;
  for (const planet of Object.values(state.planets)) {
    const dx = planet.position.x - origin.x;
    const dy = planet.position.y - origin.y;
    if (dx * dx + dy * dy <= r2) out.add(planet.id);
  }
}
function withinRadius(
  state: GameState,
  originId: PlanetId,
  radius: number,
  out: Set<PlanetId>,
): void {
  const origin = state.planets[originId]?.position;
  if (origin) withinRadiusAt(state, origin, radius, out);
}

/** A fleet's CONTINUOUS map position right now — the shared interpolation
 *  (`state/fleetPosition.ts`) evaluated at `state.time`, so a fleet's sensor
 *  reach tracks the SHIP, not its destination. */
function fleetPosition(state: GameState, fleet: Fleet): { x: number; y: number } | null {
  return fleetPositionAt(state, fleet, state.time);
}

/** The node a fleet is NEAREST to right now — its anchor for graph-hop identify and
 *  for where its radar contact blips. Same shared interpolation, at `state.time`. */
function fleetNode(state: GameState, fleet: Fleet): PlanetId | null {
  return fleetNodeAt(state, fleet, state.time);
}

/** ECON-2 «блэкаут»: unpaid energy (the economy module's `arrears` marker) halves
 *  the owner's sensors and AA until the bill is coverable again. One constant for
 *  both surfaces (radar reach here, AA damage in orbital.ts) — a single balance knob. */
export const BLACKOUT_MULT = 0.5;

/** Viewer-wide radar-reach multiplier: ×(1 + Σ completed-tech `radarRangeBonus`
 *  + faction passive `radarRangeBonus`) — how technologies and factions extend
 *  every radar the player fields (A2). Data-driven; no data → ×1. An owner in
 *  energy `arrears` runs at `BLACKOUT_MULT` on top (ECON-2): unpaid grids dim
 *  every screen the player fields — deterministic state read, replays intact. */
function radarMultiplier(state: GameState, viewerId: PlayerId, data: GameData): number {
  const player = state.players[viewerId];
  if (!player) return 1;
  let bonus = data.factions[player.faction]?.passives.radarRangeBonus ?? 0;
  for (const id of player.technologies?.completed ?? []) {
    bonus += data.technologies[id]?.effects.radarRangeBonus ?? 0;
  }
  const mult = Math.max(0, 1 + bonus); // a (mis)configured negative pile-up darkens, never inverts
  return player.arrears?.includes('energy') ? mult * BLACKOUT_MULT : mult;
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
  const mult = radarMultiplier(state, viewerId, data);
  for (const planet of Object.values(state.planets)) {
    if (planet.owner !== viewerId) continue;
    flood(state, planet.id, IDENTIFY_HOPS, identify);
    let reach = 0;
    for (const b of planet.buildings) {
      const def = data.buildings[b.type];
      if (def) reach = Math.max(reach, buildingLevel(def, b.level).radarRange);
    }
    reach *= mult;
    if (reach > 0) {
      withinRadius(state, planet.id, reach, radar); // signatures (outer)
      withinRadius(state, planet.id, reach * IDENTIFY_REACH_FRACTION, identify); // full reveal (inner)
    }
  }
  for (const fleet of Object.values(state.fleets)) {
    if (fleet.owner !== viewerId) continue;
    const node = fleetNode(state, fleet);
    if (node === null) continue;
    flood(state, node, FLEET_IDENTIFY_HOPS, identify); // own node only — ships are near-blind
    const reach = fleetRadar(fleet, data) * mult;
    if (reach > 0) {
      // Radar is a physical signal from the SHIP — centre it on the fleet's actual
      // continuous position, not the node it is heading to.
      const pos = fleetPosition(state, fleet);
      if (pos) {
        withinRadiusAt(state, pos, reach, radar); // signatures (outer)
        withinRadiusAt(state, pos, reach * IDENTIFY_REACH_FRACTION, identify); // full reveal (inner)
      }
    }
  }
  // HERO-FX3 `reveal` (scan): the viewer's OWN living heroes' active time-boxed reveals
  // light a full-identify zone around their target node until it expires. Read per-viewer
  // (this coverage is already scoped to `viewerId`), so a scan never leaks to a rival.
  const heroes = state.heroes;
  if (heroes) {
    for (const hero of Object.values(heroes)) {
      if (hero.owner !== viewerId || hero.alive !== true) continue; // deployed only (BF-24)
      const reveals = hero.activeReveals;
      if (reveals === undefined) continue;
      for (const r of reveals) {
        if (r.until > state.time) withinRadius(state, r.center, r.radius, identify);
      }
    }
  }
  for (const id of identify) radar.add(id); // identify implies radar
  return { identify, radar };
}

/** The set of nodes `viewerId` currently identifies (full detail). Exported so
 *  `visibilityModule` snapshots exactly what the projection treats as live. */
export function identifiedNodes(
  state: GameState,
  viewerId: PlayerId,
  data: GameData,
): Set<PlanetId> {
  return coverageFor(state, viewerId, data).identify;
}

/** Ad-hoc query (A4): can `viewerId` see this object at IDENTIFY detail right
 *  now? Exactly the rule `visibleState` projects by — own objects always, others
 *  when their node is currently identified. A radar-only contact answers false
 *  (detected is not seen), remembered fog answers false (stale is not now), and
 *  an unknown id answers false (fail-secure). Fog is opt-in: a host that does
 *  not enforce it simply never consults this and everything stays visible.
 *
 *  Computing coverage is the expensive part — a caller checking MANY objects for
 *  one viewer should hoist `identifiedNodes(state, viewerId, data)` once and pass
 *  it as `identified` (the matchRoom event-filter pattern); each call is then a
 *  set lookup. Omitted, the coverage is computed per call. */
export function isVisibleTo(
  state: GameState,
  viewerId: PlayerId,
  target: { planetId: PlanetId } | { fleetId: string },
  data: GameData,
  identified?: Set<PlanetId>,
): boolean {
  if ('planetId' in target) {
    const planet = state.planets[target.planetId];
    if (!planet) return false;
    if (planet.owner === viewerId) return true;
    return (identified ?? identifiedNodes(state, viewerId, data)).has(target.planetId);
  }
  const fleet = state.fleets[target.fleetId];
  if (!fleet) return false;
  if (fleet.owner === viewerId) return true;
  const node = fleetNode(state, fleet);
  return node !== null && (identified ?? identifiedNodes(state, viewerId, data)).has(node);
}

/**
 * Project `state` to what `viewerId` may see. Pure: the input is never mutated
 * (works on a `deepClone`). Hides every other player's private data, the
 * unexplored map's contents, unseen fleets/battles and the whole schedule
 * (it leaks future intent); radar-only enemy fleets become coarse signatures.
 */
export function visibleState(state: GameState, viewerId: PlayerId, data: GameData): VisibleState {
  return visibleView(state, viewerId, data).view;
}

/** A player's projection plus the identify set it was computed from. */
export interface VisibleView {
  view: VisibleState;
  /** Nodes the viewer currently identifies — the same set `identifiedNodes` returns. */
  identified: Set<PlanetId>;
}

/**
 * `visibleState` plus the identify set behind it, from ONE coverage pass.
 * The broadcast path needs both (the view to diff, the set to fog-filter
 * events); computing them together halves the per-player coverage work.
 */
export function visibleView(state: GameState, viewerId: PlayerId, data: GameData): VisibleView {
  const coverage = coverageFor(state, viewerId, data);
  return { view: project(state, viewerId, data, coverage), identified: coverage.identify };
}

/** The projection body, over a precomputed coverage (see `visibleView`). */
function project(
  state: GameState,
  viewerId: PlayerId,
  data: GameData,
  { identify, radar }: Coverage,
): VisibleState {
  const view = deepClone(state) as VisibleState;

  // Stolen intel windows (espionage): the viewer's LIVE grants open narrow holes in
  // the fog below. Expired grants open nothing — expiry is enforced HERE, at the
  // security boundary, not only by the module's housekeeping.
  const grants = (state.intel?.[viewerId] ?? []).filter((g) => g.until > state.time);
  const spiedTreasury = new Set(grants.filter((g) => g.kind === 'treasury').map((g) => g.target));
  const spiedPlanets = new Set(grants.filter((g) => g.kind === 'planet').map((g) => g.target));
  const spiedFleets = new Set(grants.filter((g) => g.kind === 'fleets').map((g) => g.target));

  // Other players' private data: keep identity, drop treasury and research (incl. the
  // chosen research leader — its branch focus / +slot is strategic, not public).
  for (const player of Object.values(view.players)) {
    if (player.id === viewerId) continue;
    if (!spiedTreasury.has(player.id)) player.resources = {};
    delete player.technologies;
    delete player.scientist;
    delete player.arrears; // unpaid bills read as treasury intel — owner-private
    // Autopilot status is «спит — можно бить» intel, the SITREP journal narrates
    // the owner's defenses, and hold points are targeting intel («вот его якоря»)
    // — all strictly owner-private (ST-2.4 / ST-2.1).
    delete player.steward;
    delete player.stewardLog;
    delete player.stewardHoldPoints;
    delete player.arsenal; // what an enemy CAN build is strategic intel (ARS-3)
  }
  // Scoreboard: each player's live planet/fleet/unit totals aggregate territory
  // the viewer can't see, so an enemy's `scores` line is fog-sensitive intel
  // (its `total`/`fleets` tick reveals a build-up or a capture behind the fog).
  // Keep only the viewer's own line — the client renders just `scores[ME]`.
  // `status`/`winner` stay: the match's end result is public to everyone.
  if (view.match?.scores) {
    const own = view.match.scores[viewerId];
    view.match.scores = own ? { [viewerId]: own } : {};
  }
  // Stolen intel is the thief's secret: strip everyone else's grants (and the key
  // entirely when the viewer has none — no empty-map blip in third-party deltas).
  if (view.intel) {
    const own = view.intel[viewerId];
    if (own?.length) view.intel = { [viewerId]: own };
    else delete view.intel;
  }
  // Diplomatic OFFERS are private to the two negotiating parties (the committed
  // stances themselves are public): a third party must not see who is suing for
  // peace with whom. Keep only offers the viewer sends or receives; a map left
  // EMPTY after the strip is removed entirely — otherwise the undefined→{} flip
  // rides a third party's delta and leaks "someone made the match's first offer".
  if (view.diplomacyOffers) {
    for (const key of Object.keys(view.diplomacyOffers)) {
      if (!offerInvolves(key, viewerId)) delete view.diplomacyOffers[key];
    }
    if (Object.keys(view.diplomacyOffers).length === 0) delete view.diplomacyOffers;
  }
  // Heroes are private: a viewer sees only their own (position + cooldowns). Temp
  // lanes stay — they are public map topology (real `links`), visible to everyone.
  if (view.heroes) {
    for (const id of Object.keys(view.heroes)) {
      if (view.heroes[id]?.owner !== viewerId) delete view.heroes[id];
    }
  }
  // Order chains and standing orders (host extensions like the prototype's `orders` /
  // `autoAssault` / `patrols` / `forcedMarch`) are future intent — exactly what
  // `scheduled` is stripped for below. Keep only the entries of the viewer's OWN
  // fleets; a map left empty is removed (same delta hygiene as offers).
  for (const key of ['orders', 'autoAssault', 'patrols', 'forcedMarch'] as const) {
    const host = view as unknown as Record<string, Record<string, unknown> | undefined>;
    const map = host[key];
    if (!map) continue;
    for (const fleetId of Object.keys(map)) {
      if (state.fleets[fleetId]?.owner !== viewerId) delete map[fleetId];
    }
    if (Object.keys(map).length === 0) delete host[key];
  }

  // Planets: keep topology (id/position/links) but strip contents you can't see.
  // A world you have seen before shows its remembered snapshot (variant B);
  // one never identified shows nothing.
  const remembered: PlanetId[] = [];
  const memory = state.fog?.[viewerId];
  for (const planet of Object.values(view.planets)) {
    if (planet.owner === viewerId || identify.has(planet.id) || spiedPlanets.has(planet.id))
      continue;
    const snap = memory?.[planet.id];
    if (snap) {
      planet.owner = snap.owner;
      planet.garrison = snap.garrison.map((s) => ({ ...s }));
      planet.buildings = snap.buildings.map((b) => ({ ...b }));
      planet.resources = {};
      if (snap.terrain === undefined) delete planet.terrain;
      else planet.terrain = snap.terrain;
      if (snap.planetType === undefined) delete planet.planetType;
      else planet.planetType = snap.planetType;
      if (snap.kind === undefined) delete planet.kind;
      else planet.kind = snap.kind;
      remembered.push(planet.id);
    } else {
      planet.owner = null;
      planet.garrison = [];
      planet.buildings = [];
      planet.resources = {};
      delete planet.terrain;
      delete planet.planetType;
      delete planet.kind;
    }
  }
  remembered.sort();
  view.remembered = remembered;
  delete view.fog; // memory is authoritative-internal — never shipped raw

  // Fleets: own + identified enemy stay; radar-only enemy → a coarse signature;
  // everything else is removed entirely.
  const signatures: SignatureContact[] = [];
  for (const id of Object.keys(view.fleets).sort()) {
    const fleet = view.fleets[id];
    if (!fleet || fleet.owner === viewerId || spiedFleets.has(fleet.owner)) continue;
    const node = fleetNode(view, fleet);
    if (node !== null && identify.has(node)) continue; // fully identified
    if (node !== null && radar.has(node)) {
      signatures.push({ location: node, size: bucket(fleetSignature(fleet, data)) });
    }
    delete view.fleets[id];
  }
  signatures.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  view.signatures = signatures;

  // Battles you cannot see, and enemy timers from the schedule (it leaks future
  // events) — but KEEP the viewer's own pending events: their construction/production/
  // arrivals are their own information, and the client renders the build queue + ETAs
  // from them. (A blanket strip is why the build queue showed nothing in net mode.)
  for (const id of Object.keys(view.battles)) {
    const battle = view.battles[id];
    if (battle && !identify.has(battle.location)) delete view.battles[id];
  }
  view.scheduled = view.scheduled.filter((e) => scheduledOwnedBy(e, viewerId, state));

  return view;
}
