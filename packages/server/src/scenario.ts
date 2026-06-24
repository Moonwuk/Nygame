import { readFileSync } from 'node:fs';
import {
  armyModule,
  combatModule,
  constructionModule,
  createInitialState,
  createKernel,
  economyModule,
  movementModule,
  parseGameData,
  planetTypeModule,
  sectorModule,
  technologyModule,
  victoryModule,
  type Fleet,
  type GameData,
  type GameModule,
  type GameState,
  type Planet,
  type Player,
} from '@void/shared-core';
import { MatchRoom } from './matchRoom';

/**
 * A runnable dev match on the *real* simulation core — the smallest faithful
 * scenario two players can connect to and act in (used by `main.ts` and the
 * end-to-end test). It is not a balanced map; it exists to exercise the wire:
 * connect → authoritative `applyAction` → delta broadcast to every peer.
 */

/** The shipped game-content bundle, composed and validated exactly like the
 *  loader in `shared-core`'s `schemas.test.ts` (A05/A08: validate before use). */
export function loadShippedData(): GameData {
  const readJson = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../../../data/${name}`, import.meta.url), 'utf8'));
  const manifest = readJson('manifest.json') as { version: string };
  return parseGameData({
    version: manifest.version,
    resources: readJson('resources.json'),
    units: readJson('units.json'),
    factions: readJson('factions.json'),
    buildings: readJson('buildings.json'),
    events: readJson('events.json'),
    sectors: readJson('sectors.json'),
    planetTypes: readJson('planetTypes.json'),
    technologies: readJson('technologies.json'),
  });
}

/** Full base-module manifest, in a fixed order (invariant #6: execution order =
 *  array order, recorded in the kernel manifest and versioned per match). */
export const DEV_MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  economyModule,
  movementModule,
  combatModule,
  constructionModule,
  technologyModule,
  armyModule,
  victoryModule,
];

export interface DevMatchOptions {
  /** Server clock. Defaults (in `MatchRoom`) to wall time; pinned in tests. */
  now?: () => number;
  /** World time the scenario starts at. Match it to the first `now` so the
   *  opening `advanceTo` is a no-op rather than a jump across epoch zero. */
  time?: number;
}

function player(id: string, name: string, faction: string): Player {
  return { id, name, faction, status: 'active', resources: { credits: 300, metal: 300 } };
}

function planet(
  id: string,
  owner: string | null,
  x: number,
  y: number,
  links: string[],
  planetType: string,
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    links,
    sectorType: 'empty_space',
    planetType,
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}

function fleet(id: string, owner: string, location: string, units: Array<[string, number]>): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    orbit: 'far',
    traits: [],
  };
}

/** Two homeworlds joined through a neutral junction, one idle fleet each. */
export function createDevMatch(data: GameData, options: DevMatchOptions = {}): MatchRoom {
  const base = createInitialState({
    seed: 'dev-match',
    version: { data: data.version, manifest: '1' },
    time: options.time ?? 0,
  });
  const state: GameState = {
    ...base,
    players: {
      green: player('green', 'Verdant Pact', 'vanguard'),
      red: player('red', 'Crimson Swarm', 'swarm'),
    },
    planets: {
      home_green: planet('home_green', 'green', -200, 0, ['nexus'], 'terran'),
      nexus: planet('nexus', null, 0, 0, ['home_green', 'home_red'], 'barren'),
      home_red: planet('home_red', 'red', 200, 0, ['nexus'], 'terran'),
    },
    fleets: {
      green_1: fleet('green_1', 'green', 'home_green', [
        ['cruiser', 2],
        ['scout_drone', 1],
      ]),
      red_1: fleet('red_1', 'red', 'home_red', [['cruiser', 2]]),
    },
  };
  return new MatchRoom({
    id: 'dev',
    initialState: state,
    kernel: createKernel(DEV_MODULES),
    data,
    now: options.now,
  });
}
