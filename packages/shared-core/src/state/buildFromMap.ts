import type { GameData } from '../data/schemas';
import { buildingLevel } from '../data/schemas';
import type { MatchMap } from '../data/mapSchema';
import { createInitialState, type Fleet, type GameState, type Planet, type Player } from './gameState';

/**
 * Map-as-content loader (map-roadmap.md M1.2 / M1.3). Turns a validated `MatchMap`
 * into a runtime `GameState`, deriving each sector's `links` from the undirected
 * `paths` edge list. Pure and deterministic (no time/random): same map + data →
 * same state. Replaces the procedural prototype map and the hard-coded server
 * scenario with a single "load this map file" path.
 */

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  // Plain sqrt (not Math.hypot): correctly-rounded √ is bit-exact across JS engines,
  // matching state/route.ts so map geometry agrees with runtime distances (determinism).
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Structural + geometric validation of a map (M1.3). Returns a list of stable
 * issue codes (empty = valid); `buildStateFromMap` rejects on any. Beyond shape
 * (zod already did that), this enforces the **neighbour-only** path rule: a path
 * may join two sectors only if no third sector lies "between" them (closer to
 * both than they are to each other — the relative-neighbourhood criterion). That
 * keeps the graph to immediate neighbours: no long criss-crossing lanes.
 */
export function validateMatchMap(map: MatchMap, data?: GameData): string[] {
  const issues: string[] = [];
  const ids = Object.keys(map.sectors);
  const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(map.sectors, id);
  const isOwnerRef = (ref: string): boolean =>
    Object.prototype.hasOwnProperty.call(map.players, ref) ||
    Object.prototype.hasOwnProperty.call(map.slots, ref);

  // a slot id must not collide with a player id (an ambiguous owner reference)
  for (const sid of Object.keys(map.slots)) {
    if (Object.prototype.hasOwnProperty.call(map.players, sid)) issues.push(`E_SLOT_PLAYER_ID_CLASH:${sid}`);
  }

  // owners reference a declared player or slot
  for (const [id, sec] of Object.entries(map.sectors)) {
    if (sec.owner != null && !isOwnerRef(sec.owner)) issues.push(`E_SECTOR_UNKNOWN_OWNER:${id}`);
    if (data) {
      if (sec.kind && !data.sectorKinds[sec.kind]) issues.push(`E_UNKNOWN_KIND:${id}`);
      if (sec.terrain && !data.sectors[sec.terrain]) issues.push(`E_UNKNOWN_TERRAIN:${id}`);
      if (sec.planetType && !data.planetTypes[sec.planetType]) issues.push(`E_UNKNOWN_PLANET_TYPE:${id}`);
      for (const b of sec.buildings) if (!data.buildings[b.type]) issues.push(`E_UNKNOWN_BUILDING:${b.type}`);
      for (const g of sec.garrison) if (!data.units[g.unit]) issues.push(`E_UNKNOWN_UNIT:${g.unit}`);
    }
  }

  // paths: known endpoints, no self-loop, no duplicate, neighbour-only
  const seen = new Set<string>();
  for (const [a, b] of map.paths) {
    if (!has(a) || !has(b)) {
      issues.push(`E_PATH_UNKNOWN_SECTOR:${a}-${b}`);
      continue;
    }
    if (a === b) {
      issues.push(`E_PATH_SELF_LOOP:${a}`);
      continue;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) {
      issues.push(`E_PATH_DUPLICATE:${key}`);
      continue;
    }
    seen.add(key);
    const pa = map.sectors[a]!.position;
    const pb = map.sectors[b]!.position;
    const dab = dist(pa, pb);
    const between = ids.some(
      (c) => c !== a && c !== b && dist(pa, map.sectors[c]!.position) < dab && dist(pb, map.sectors[c]!.position) < dab,
    );
    if (between) issues.push(`E_PATH_NOT_NEIGHBOR:${key}`);
  }

  // fleets reference an existing sector + a declared player
  for (const [id, fl] of Object.entries(map.fleets)) {
    if (!has(fl.location)) issues.push(`E_FLEET_UNKNOWN_SECTOR:${id}`);
    if (!isOwnerRef(fl.owner)) issues.push(`E_FLEET_UNKNOWN_OWNER:${id}`);
  }

  // graph connectivity (BFS over the valid undirected edges)
  if (ids.length > 1) {
    const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const [a, b] of map.paths) {
      if (has(a) && has(b) && a !== b) {
        adj.get(a)!.push(b);
        adj.get(b)!.push(a);
      }
    }
    const seenN = new Set<string>([ids[0]!]);
    const queue = [ids[0]!];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of adj.get(cur) ?? []) {
        if (!seenN.has(n)) {
          seenN.add(n);
          queue.push(n);
        }
      }
    }
    if (seenN.size !== ids.length) issues.push('E_MAP_DISCONNECTED');
  }

  return issues;
}

/** Seats a concrete player into a map slot at session creation (the server
 *  orchestrator supplies these once it has matched accounts to slots). */
export interface SlotAssignment {
  /** Concrete player id to create and own this slot's sectors/fleets. */
  playerId: string;
  /** Display name (defaults to the player id). */
  name?: string;
  /** Faction tag — legacy/dormant field on `Player`; defaults to ''. */
  faction?: string;
}

export interface BuildFromMapOptions {
  /** Manifest version to pin into the match (defaults to '1'). */
  manifest?: string;
  /** Override the map's start time. */
  time?: number;
  /** Slot id → the player seated there. Required for every slot referenced as an
   *  `owner`; a slot-based (AvA) map is inert data until these are supplied. */
  slots?: Record<string, SlotAssignment>;
}

/** Build a `GameState` from a validated map. Throws `E_INVALID_MAP` listing the
 *  issue codes if the map fails {@link validateMatchMap} (fail-secure at boot). */
export function buildStateFromMap(map: MatchMap, data: GameData, options: BuildFromMapOptions = {}): GameState {
  const issues = validateMatchMap(map, data);
  if (issues.length > 0) throw new Error(`E_INVALID_MAP: ${issues.join('; ')}`);

  const base = createInitialState({
    seed: map.seed,
    version: { data: data.version, manifest: options.manifest ?? '1' },
    time: options.time ?? map.time,
  });

  // derive per-sector links from the undirected paths (sorted = JSON-stable)
  const links: Record<string, string[]> = {};
  for (const id of Object.keys(map.sectors)) links[id] = [];
  for (const [a, b] of map.paths) {
    links[a]!.push(b);
    links[b]!.push(a);
  }

  // Resolve an owner ref (a player id or a slot id) to a concrete player id.
  // `validateMatchMap` already proved the ref is a known player or slot; a slot
  // named as an owner must have an assignment (fail-secure at boot).
  const slotAssign = options.slots ?? {};
  const resolveOwner = (ref: string): string => {
    if (Object.prototype.hasOwnProperty.call(map.players, ref)) return ref;
    const a = slotAssign[ref];
    if (!a) throw new Error(`E_SLOT_UNASSIGNED: ${ref}`);
    return a.playerId;
  };

  const planets: Record<string, Planet> = {};
  for (const [id, sec] of Object.entries(map.sectors)) {
    const planet: Planet = {
      id,
      owner: sec.owner == null ? null : resolveOwner(sec.owner),
      position: { x: sec.position.x, y: sec.position.y },
      links: [...new Set(links[id])].sort(),
      resources: {},
      buildings: sec.buildings.map((b) => ({
        type: b.type,
        level: b.level,
        hp: buildingLevel(data.buildings[b.type]!, b.level).hp,
      })),
      garrison: sec.garrison.map((g) => ({ unit: g.unit, count: g.count })),
      traits: [],
    };
    if (sec.terrain) planet.terrain = sec.terrain;
    if (sec.planetType) planet.planetType = sec.planetType;
    if (sec.kind) planet.kind = sec.kind;
    if (sec.size !== 1) planet.size = sec.size;
    planets[id] = planet;
  }

  const players: Record<string, Player> = {};
  for (const [id, pl] of Object.entries(map.players)) {
    players[id] = { id, name: pl.name, faction: pl.faction, status: 'active', resources: { ...pl.resources } };
  }
  // seat assigned slots as concrete players (start kit = the slot's resources)
  for (const [slotId, a] of Object.entries(slotAssign)) {
    const slot = map.slots[slotId];
    if (!slot) continue; // ignore assignments for slots this map does not declare
    players[a.playerId] = {
      id: a.playerId,
      name: a.name ?? a.playerId,
      faction: a.faction ?? '',
      status: 'active',
      resources: { ...slot.resources },
    };
  }

  const fleets: Record<string, Fleet> = {};
  for (const [id, fl] of Object.entries(map.fleets)) {
    fleets[id] = {
      id,
      owner: resolveOwner(fl.owner),
      location: fl.location,
      movement: null,
      units: fl.units.map((u) => ({ unit: u.unit, count: u.count })),
      landing: fl.landing.map((u) => ({ unit: u.unit, count: u.count })),
      orbit: 'far',
      traits: [],
    };
  }

  return { ...base, players, planets, fleets };
}
