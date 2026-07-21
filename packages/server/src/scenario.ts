import { readFileSync, readdirSync } from 'node:fs';
import {
  armyModule,
  arsenalSyncModule,
  artilleryModule,
  captureOnArrivalModule,
  combatModule,
  constructionModule,
  createInitialState,
  createKernel,
  diplomacyModule,
  economyModule,
  factionModule,
  heroModule,
  interceptModule,
  marketModule,
  movementModule,
  loadGameData,
  parseMatchMap,
  orbitalModule,
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
  type MatchMap,
  type Planet,
  type Player,
} from '@void/shared-core';
import type { ActionGate } from '@void/action-layer';
import { MatchRoom, type ActionReceipt, type RoomObservation } from './matchRoom';
import type { ArsenalStore, MatchSnapshot, StoredReceipt } from './store';
import { validateStarterArsenal, type StarterArsenalTemplate } from './arsenal';
import { validateDropTables, type DropTables } from './dropRoller';

/**
 * A runnable dev match on the *real* simulation core — the smallest faithful
 * scenario two players can connect to and act in (used by `main.ts` and the
 * end-to-end test). It is not a balanced map; it exists to exercise the wire:
 * connect → authoritative `applyAction` → delta broadcast to every peer.
 */

/** The shipped game-content bundle, composed + validated by the shared `loadGameData`
 *  (CP0.3 — one composer for server/tests/client); we only inject the Node file reader. */
export function loadShippedData(): GameData {
  return loadGameData((name) =>
    JSON.parse(readFileSync(new URL(`../../../data/${name}`, import.meta.url), 'utf8')),
  );
}

/** The shipped starter-arsenal templates (ARS-2), validated against the shipped
 *  catalogs — a template naming content that does not ship fails the boot
 *  (fail-secure; the set itself is data — balancing it is a JSON edit). */
export function loadStarterArsenal(data: GameData): StarterArsenalTemplate[] {
  const templates = JSON.parse(
    readFileSync(new URL('../../../data/starterArsenal.json', import.meta.url), 'utf8'),
  ) as StarterArsenalTemplate[];
  const issues = validateStarterArsenal(templates, data);
  if (issues.length > 0) throw new Error(`E_INVALID_STARTER_ARSENAL: ${issues.join('; ')}`);
  return templates;
}

/** The shipped drop tables (ARS-4), validated against the shipped catalogs at boot —
 *  a pool line naming content that does not ship, or a malformed chance/weight,
 *  refuses to start (fail-secure; balancing the loop is a JSON edit). */
export function loadDropTables(data: GameData): DropTables {
  const tables = JSON.parse(
    readFileSync(new URL('../../../data/dropTables.json', import.meta.url), 'utf8'),
  ) as DropTables;
  const issues = validateDropTables(tables, data);
  if (issues.length > 0) throw new Error(`E_INVALID_DROP_TABLES: ${issues.join('; ')}`);
  return tables;
}

/** The AvA-eligible map pool (AVA-5/7): every validated map in `data/maps` tagged
 *  `avaEligible`, the candidate set the orchestrator picks from by requested shape. */
export function loadAvaMaps(): MatchMap[] {
  const dir = new URL('../../../data/maps/', import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseMatchMap(JSON.parse(readFileSync(new URL(name, dir), 'utf8'))))
    .filter((map) => map.avaEligible);
}

/** Full base-module manifest, in a fixed order (invariant #6: execution order =
 *  array order, recorded in the kernel manifest and versioned per match). */
export const DEV_MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  economyModule,
  movementModule,
  heroModule, // per-player hero: redeploy, temp public lanes, planet annihilation
  diplomacyModule, // declarations + consent offers + the `diplomacy` capability combat consults
  // The combat family, split along the bus seams. Order matters (invariant #6):
  // `orbital` stamps orbit on `fleet.arrived` BEFORE `combat` engages, and runs
  // its AA/bombard span BEFORE `artillery`'s standoff span — the exact sequence
  // the old single module had internally.
  orbitalModule, // the single near-orbit: stationing, AA fire, bombardment
  combatModule, // melee battles: engage / tick / assault / retreat / capture
  artilleryModule, // standoff fire accrual + barrage orders
  interceptModule, // schedules lane-crossing meetings (resolved by combat)
  captureOnArrivalModule, // walk-in capture of undefended neutral sectors (after combat)
  constructionModule,
  arsenalSyncModule, // LARS-1: server-driver refresh of live build-catalog ownership (bypasses gate)
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
  /** Observation stream (persistence / metrics wiring — see `main.ts` F8). */
  observe?: (event: RoomObservation) => void;
  /** Resume from a durable snapshot instead of seeding a fresh match: the passed
   *  state replaces the freshly-seeded one (the seed still runs, cheaply, and is
   *  discarded). The clock keeps running from `state.time`. */
  initialState?: GameState;
  /** Rehydrate idempotency receipts on resume (see `MatchRoom.initialReceipts`),
   *  so an action deduped before a restart stays deduped after it. */
  initialReceipts?: ActionReceipt[];
  /** Resume the action counter from a persisted snapshot (see `MatchRoom.initialSeq`). */
  initialSeq?: number;
  /** Strict commit-before-broadcast durable write (see `MatchRoom.persist`). */
  persist?: (snapshot: MatchSnapshot, receipt: StoredReceipt) => Promise<void>;
  /** Opt-in `@void/action-layer` front-door (see `MatchRoom.gate`). */
  gate?: ActionGate;
  /** Per-player action rate limit (see `MatchRoom.actionRateMax` / `actionRateWindowMs`);
   *  pinned in tests to exercise throttling deterministically. */
  actionRateMax?: number;
  actionRateWindowMs?: number;
  /** Player-action deny-list (see `MatchRoom.denyPlayerActions`) — e.g. an AvA room
   *  refuses `diplomacy.declare` because the orchestrator owns the stances (AVA-8). */
  denyPlayerActions?: (type: string) => string | null | undefined;
  /** LARS-1 live ownership read (see `MatchRoom.arsenalStore`). */
  arsenalStore?: ArsenalStore;
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
    const home = planet(`home_${id}`, id, x, y, ['nexus'], 'terran');
    // A starting yard — space-domain hulls need a standing shipyard/spaceport to
    // build at all (enablesShipConstruction); without one, turn-1 fleet-building
    // would be impossible in every dev/test match.
    home.buildings = [{ type: 'spaceport', level: 1, hp: 25 }];
    planets[`home_${id}`] = home;
    fleets[`${id}_1`] = fleet(`${id}_1`, id, `home_${id}`, [
      ['cruiser', 2],
      ['scout_drone', 1],
    ]);
    const heroId = `hero:${id}`;
    heroes[heroId] = { id: heroId, owner: id, location: `home_${id}`, cooldowns: {} };
  });
  const state: GameState = options.initialState ?? { ...base, players, planets, fleets, heroes };
  return new MatchRoom({
    id: options.id ?? 'dev',
    initialState: state,
    kernel: createKernel(DEV_MODULES),
    data,
    now: options.now,
    observe: options.observe,
    initialReceipts: options.initialReceipts,
    initialSeq: options.initialSeq,
    persist: options.persist,
    gate: options.gate,
    actionRateMax: options.actionRateMax,
    actionRateWindowMs: options.actionRateWindowMs,
    ...(options.denyPlayerActions ? { denyPlayerActions: options.denyPlayerActions } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.arsenalStore ? { arsenalStore: options.arsenalStore } : {}),
  });
}
