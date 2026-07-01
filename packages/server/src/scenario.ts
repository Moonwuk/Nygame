import { readFileSync } from 'node:fs';
import {
  armyModule,
  captureOnArrivalModule,
  combatModule,
  constructionModule,
  createInitialState,
  createKernel,
  economyModule,
  factionModule,
  heroModule,
  marketModule,
  movementModule,
  parseGameData,
  planetTypeModule,
  scientistModule,
  sectorModule,
  stationModule,
  technologyModule,
  victoryModule,
  visibilityModule,
  type Fleet,
  type GameData,
  type GameModule,
  type GameState,
  type Hero,
  type MatchConfig,
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
    sectorKinds: readJson('sectorKinds.json'),
    planetTypes: readJson('planetTypes.json'),
    technologies: readJson('technologies.json'),
    scientists: readJson('scientists.json'),
  });
}

/** Full base-module manifest, in a fixed order (invariant #6: execution order =
 *  array order, recorded in the kernel manifest and versioned per match). */
export const DEV_MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  economyModule,
  movementModule,
  heroModule, // per-player hero: redeploy, temp public lanes, planet annihilation
  combatModule,
  captureOnArrivalModule, // walk-in capture of undefended neutral sectors (after combat)
  constructionModule,
  stationModule, // deploy void stations on empty nodes (then build radar/fort there)
  technologyModule,
  scientistModule, // per-player research leader: +slot via research.slots + has_scientist gates
  factionModule, // always-on faction passives (production / speed / combat) via hooks
  marketModule, // session resource bourse: list / buy (15% burn) / cancel
  armyModule,
  victoryModule,
  visibilityModule, // fog-of-war memory (variant B): records last-seen worlds
];

export interface DevMatchOptions {
  /** Match/room id (default `'dev'`). Distinct ids let a registry hold many matches. */
  id?: string;
  /** Server clock. Defaults (in `MatchRoom`) to wall time; pinned in tests. */
  now?: () => number;
  /** World time the scenario starts at. Match it to the first `now` so the
   *  opening `advanceTo` is a no-op rather than a jump across epoch zero. */
  time?: number;
  /** Player ids to seat (default `['green', 'red']`). Each gets a homeworld and
   *  one idle fleet, all joined through a neutral `nexus` — lets soak/load tests
   *  seat N players against one room. */
  players?: string[];
  /** Ruleset for this match (time scale + victory conditions). Defaults in `MatchRoom`
   *  to `{ timeScale: 1 }`; the match browser shows it as the match's "rules". */
  config?: MatchConfig;
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
  kind = 'planet', // every node is a province; planets are one province type among many
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    links,
    terrain: 'empty_space',
    planetType,
    kind,
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
    // freshly placed → not yet in orbit (a single orbit; entered via fleet.orbit / arrival)
    traits: [],
  };
}

const DEV_FACTIONS = ['vanguard', 'swarm'];

/** N homeworlds joined through a neutral junction, one idle fleet each (default
 *  two players: green/red). Homeworlds are spread evenly around the nexus. */
export function createDevMatch(data: GameData, options: DevMatchOptions = {}): MatchRoom {
  const ids = options.players ?? ['green', 'red'];
  const base = createInitialState({
    seed: 'dev-match',
    version: { data: data.version, manifest: '1' },
    time: options.time ?? 0,
  });
  const players: Record<string, Player> = {};
  const planets: Record<string, Planet> = {
    nexus: planet(
      'nexus',
      null,
      0,
      0,
      ids.map((id) => `home_${id}`),
      'barren',
    ),
  };
  const fleets: Record<string, Fleet> = {};
  const heroes: Record<string, Hero> = {};
  ids.forEach((id, i) => {
    // `|| 0` normalizes -0 (Math.round of a tiny negative, e.g. cos(3π/2)) → +0:
    // GameState must be JSON-stable, and JSON has no -0, so a -0 here desyncs a
    // client's reconstruction (server in-memory -0 vs the client's JSON-parsed +0).
    const angle = (2 * Math.PI * i) / ids.length;
    const x = Math.round(Math.cos(angle) * 240) || 0;
    const y = Math.round(Math.sin(angle) * 240) || 0;
    players[id] = player(
      id,
      id.charAt(0).toUpperCase() + id.slice(1),
      DEV_FACTIONS[i % DEV_FACTIONS.length] ?? 'vanguard',
    );
    planets[`home_${id}`] = planet(`home_${id}`, id, x, y, ['nexus'], 'terran');
    fleets[`${id}_1`] = fleet(`${id}_1`, id, `home_${id}`, [
      ['cruiser', 2],
      ['scout_drone', 1],
    ]);
    const heroId = `hero:${id}`;
    heroes[heroId] = { id: heroId, owner: id, location: `home_${id}`, cooldowns: {} };
  });
  const state: GameState = { ...base, players, planets, fleets, heroes };
  return new MatchRoom({
    id: options.id ?? 'dev',
    initialState: state,
    kernel: createKernel(DEV_MODULES),
    data,
    now: options.now,
    ...(options.config ? { config: options.config } : {}),
  });
}
