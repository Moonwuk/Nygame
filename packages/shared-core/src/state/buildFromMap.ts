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
  return Math.hypot(a.x - b.x, a.y - b.y);
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

  // owners reference declared players
  for (const [id, sec] of Object.entries(map.sectors)) {
    if (sec.owner != null && !map.players[sec.owner]) issues.push(`E_SECTOR_UNKNOWN_OWNER:${id}`);
    if (data) {
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
    if (!map.players[fl.owner]) issues.push(`E_FLEET_UNKNOWN_OWNER:${id}`);
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

export interface BuildFromMapOptions {
  /** Manifest version to pin into the match (defaults to '1'). */
  manifest?: string;
  /** Override the map's start time. */
  time?: number;
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

  const planets: Record<string, Planet> = {};
  for (const [id, sec] of Object.entries(map.sectors)) {
    const planet: Planet = {
      id,
      owner: sec.owner ?? null,
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
    planets[id] = planet;
  }

  const players: Record<string, Player> = {};
  for (const [id, pl] of Object.entries(map.players)) {
    players[id] = { id, name: pl.name, faction: pl.faction, status: 'active', resources: { ...pl.resources } };
  }

  const fleets: Record<string, Fleet> = {};
  for (const [id, fl] of Object.entries(map.fleets)) {
    fleets[id] = {
      id,
      owner: fl.owner,
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
