import { seedRng, type RngState } from '../rng/rng';

/**
 * The authoritative game state. Stored as JSONB on the server
 * (docs/architecture.md §4.3) and mirrored on the client. Pure data: no class
 * instances, no functions — it must round-trip through JSON unchanged.
 *
 * Note: the core is data-driven (docs/architecture.md §2). Identifiers below
 * (units, buildings, traits, resources) are plain strings that resolve against
 * the loaded game data — the engine never hard-codes any concrete content.
 */

export type PlayerId = string;
export type PlanetId = string;
export type FleetId = string;
export type BattleId = string;
export type ResourceId = string;
export type UnitId = string;
export type BuildingId = string;
export type TraitId = string;

/** A dynamic resource ledger. The engine never assumes a fixed set of
 *  resources (docs/architecture.md §2.3). */
export type ResourceBag = Record<ResourceId, number>;

export interface UnitStack {
  unit: UnitId;
  count: number;
  /** Remaining HP pool of this stack during a battle (≤ count × def.hp).
   *  Undefined outside combat = full health. */
  hp?: number;
}

/** A constructed building on a planet. Buildings are leveled (1..maxLevel) and
 *  carry structural HP that orbital bombardment / ground assault wear down
 *  (GDD §7.4); a destroyed building is removed and stops granting its bonus. */
export interface BuildingInstance {
  type: BuildingId;
  level: number;
  hp: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  faction: string;
  status: 'active' | 'defeated';
  /** The player's treasury — production accrues here, upkeep/costs drain it. */
  resources: ResourceBag;
}

export interface Planet {
  id: PlanetId;
  /** Owning player, or null for a neutral / unclaimed sector. */
  owner: PlayerId | null;
  position: { x: number; y: number };
  /** Star lanes: ids of directly-connected planets. The map is this graph;
   *  fleets travel along lanes (GDD §1 — секторная структура, узлы-планеты). */
  links?: PlanetId[];
  /** Sector terrain type id (resolved against game data `sectors`); its buffs
   *  /debuffs are applied through hooks. Undefined = plain space, no modifier. */
  sectorType?: string;
  /** Planet type id — the world's nature (resolved against game data
   *  `planetTypes`); production/defense modifiers are applied through hooks.
   *  Undefined = generic world, no modifier. */
  planetType?: string;
  resources: ResourceBag;
  buildings: BuildingInstance[];
  garrison: UnitStack[];
  traits: TraitId[];
}

export interface FleetMovement {
  /** Origin of the current leg. */
  from: PlanetId;
  /** Next hop (the planet this leg ends at). */
  to: PlanetId;
  /** Server-authoritative timestamps (ms). */
  departedAt: number;
  arrivesAt: number;
  /** Remaining hops after `to`, in order, ending at `destination`. */
  path?: PlanetId[];
  /** Final destination of the whole journey. */
  destination?: PlanetId;
}

export interface Fleet {
  id: FleetId;
  owner: PlayerId;
  /** Current location, or null while in transit. */
  location: PlanetId | null;
  movement: FleetMovement | null;
  units: UnitStack[];
  /** Ground army carried as cargo (the landing force of a ground assault),
   *  bounded by the ships' transport capacity — see the `army` module. */
  landing?: UnitStack[];
  /** Which orbit the fleet holds while stationed at a planet (GDD §7.4):
   *  `far` is a safe standoff (set on arrival); `near` lets it bombard / land
   *  but exposes it to the planet's orbital AA. Undefined while in transit. */
  orbit?: 'near' | 'far';
  /** Whether the fleet is actively bombarding the planet below (near orbit,
   *  hostile). Damages structures and freezes the owner's production. */
  bombarding?: boolean;
  traits: TraitId[];
  /** Id of the battle this fleet is engaged in; absent/null when free to move. */
  battleId?: BattleId | null;
}

/**
 * A combatant in a battle — the ship units of a fleet (orbital), the landing
 * troops a fleet carries (ground assault), or a planet's garrison (ground
 * defense). One round engine drives all three (GDD §7.3).
 */
export type CombatantRef =
  | { kind: 'fleet'; fleetId: FleetId }
  | { kind: 'landing'; fleetId: FleetId }
  | { kind: 'garrison'; planetId: PlanetId };

export interface BattleSide {
  ref: CombatantRef;
  /** Owner of this side (for victory / planet ownership). */
  owner: PlayerId | null;
}

/**
 * An ongoing battle — a stateful entity that resolves over real hours, one
 * round per `combat.tick` (GDD §7). Capturing a planet is two sequential
 * battles: `orbital` (fleet vs fleet) then `ground` (landing vs garrison) — §7.4.
 */
export interface Battle {
  id: BattleId;
  /** Contested planet where the engagement happens. */
  location: PlanetId;
  phase: 'orbital' | 'ground';
  attacker: BattleSide;
  defender: BattleSide;
  /** Rounds resolved so far. */
  round: number;
}

/**
 * A future occurrence on the world timeline: fleet arrival, construction
 * complete, a recurring combat tick, a dark event, ... The game is real-time
 * (continuous wall-clock time, like the Bytro titles), so durations are
 * expressed by scheduling an event at a future `at` and letting `advanceTo`
 * fire it when the world reaches that instant (docs/architecture.md §4.1).
 *
 * The schedule lives inside the state so it is serializable, deterministic and
 * survives a server restart (the server also mirrors it as delayed jobs to know
 * *when to wake up*, but the source of truth is here).
 */
export interface ScheduledEvent {
  /** Stable id, e.g. `evt:42`. */
  id: string;
  /** When it fires (ms, server-authoritative). */
  at: number;
  /** Domain event type dispatched to module subscribers when it fires. */
  type: string;
  /** Event payload. */
  payload: unknown;
  /** Deterministic tiebreaker among events sharing the same `at`. */
  seq: number;
}

/**
 * Versions pinned to a match. Rules and the active module set are frozen per
 * match (docs/architecture.md §4.4, docs/modulesystem.md) — in-flight matches
 * keep their original rules, integrity-relevant for OWASP A08.
 */
export interface GameVersion {
  /** Game-data (JSON content) version. */
  data: string;
  /** Module-manifest version. */
  manifest: string;
}

export interface GameState {
  version: GameVersion;
  /** Current simulation time (ms), server-authoritative. */
  time: number;
  rng: RngState;
  players: Record<PlayerId, Player>;
  planets: Record<PlanetId, Planet>;
  fleets: Record<FleetId, Fleet>;
  battles: Record<BattleId, Battle>;
  /** Monotonic counter handing each battle its id. */
  battleSeq: number;
  /** Pending timeline, processed in (at, seq) order by `advanceTo`. */
  scheduled: ScheduledEvent[];
  /** Monotonic counter handing each scheduled event its deterministic `seq`. */
  scheduleSeq: number;
}

/** Creates an empty, deterministically-seeded initial state. */
export function createInitialState(params: {
  seed: string | number;
  version: GameVersion;
  time?: number;
}): GameState {
  return {
    version: params.version,
    time: params.time ?? 0,
    rng: seedRng(params.seed),
    players: {},
    planets: {},
    fleets: {},
    battles: {},
    battleSeq: 0,
    scheduled: [],
    scheduleSeq: 0,
  };
}
