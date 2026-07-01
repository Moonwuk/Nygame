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
export type TechnologyId = string;
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
  /** Remaining ablative shield pool of this stack (≤ count × def.shield). Absorbs
   *  damage before `hp`; a ship still dies only when its HULL (`hp`) hits 0.
   *  Undefined = full shield (shields-roadmap SH-0.1). */
  shieldHp?: number;
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
  technologies?: PlayerTechnologyState;
  /** Chosen research leader (scientist), snapshotted at match start and immutable
   *  (GDD §2/§5.2): `id` into `data.scientists`, `level` from the account meta
   *  (supplied at match creation). Drives the `research.slots` hook and
   *  `has_scientist` unlock gates. Absent = no leader chosen. */
  scientist?: { id: string; level: number };
}

export interface ActiveResearch {
  technology: TechnologyId;
  startedAt: number;
  completesAt: number;
}

export interface PlayerTechnologyState {
  completed: TechnologyId[];
  /** Research currently in progress — one entry per occupied slot (base 2,
   *  raisable to a max of 3 via the `research.slots` hook). Absent/empty = idle labs. */
  active?: ActiveResearch[];
}

/** Diplomatic stance between two players (symmetric). Richer than the combat
 *  `hostile|ally|neutral` relation the `diplomacy` capability projects (D2):
 *  - `war`      → hostile (fleets engage, worlds can be assaulted)
 *  - `peace`    → neutral (no auto-combat; the plain "we are not fighting" state)
 *  - `pact`     → neutral (a non-aggression pact — like peace, but a declared,
 *                 breakable agreement rather than mere absence of war)
 *  - `alliance` → ally (shared side; an ally's world can't be attacked)
 *  The stance→relation mapping itself lives in the future `diplomacyModule`. */
export type DiplomaticStance = 'war' | 'peace' | 'pact' | 'alliance';

export type MatchStatus = 'ongoing' | 'ended';
export type MatchEndReason = 'domination' | 'elimination' | 'score' | 'timeout';

export interface MatchScore {
  /** Map control: owned planet/sectors. */
  controlledPlanets: number;
  /** Standing fleets the player still commands. */
  fleets: number;
  /** Ships, carried ground troops and planetary garrisons. */
  units: number;
  /** Aggregate score used by score-limit and timeout victories. */
  total: number;
}

export interface MatchState {
  status: MatchStatus;
  winner: PlayerId | null;
  endedAt?: number;
  reason?: MatchEndReason;
  scores: Record<PlayerId, MatchScore>;
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
  terrain?: string;
  /** Sector kind id (planet / asteroid / nebula / empty …; resolved against game
   *  data `sectorKinds`) — decides capturable / buildable / orbit. Undefined
   *  degrades to the permissive defaults (see `sectorKindDef`). */
  kind?: string;
  /** Relative size / weight of the sector (default 1). Drives how much territory
   *  it claims: a sector's border with a neighbour sits proportionally to their
   *  sizes, so resizing one shifts its neighbours' borders evenly. Undefined = 1. */
  size?: number;
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
  /** Fraction along (`from`,`to`) this leg STARTS at, in [0,1) (default 0). >0
   *  only on the first leg out of a mid-lane parked position — the fleet resumes
   *  partway down the road instead of from a node. */
  startT?: number;
  /** Fraction along (`from`,`to`) this (final) leg ENDS at, in (0,1] (default 1).
   *  <1 means the journey stops at a point ON the lane: on arrival the fleet
   *  parks (`edge`) at this fraction instead of reaching node `to`. */
  endT?: number;
  /** Journey-wide park fraction carried across hops: when the LAST leg fires it
   *  parks at `parkT` (becomes that leg's `endT`). Absent = arrive at a node. */
  parkT?: number;
}

/** A fleet parked at a continuous point ALONG a lane (it stopped mid-march, or
 *  marched to a point on the path — not a node). `t` ∈ (0,1) is the fraction
 *  from `from` to `to`. Mutually exclusive with `location`/`movement`: a fleet is
 *  either at a node, in transit, or parked on a lane. */
export interface FleetEdge {
  from: PlanetId;
  to: PlanetId;
  t: number;
}

export interface Fleet {
  id: FleetId;
  owner: PlayerId;
  /** Current location, or null while in transit / parked on a lane. */
  location: PlanetId | null;
  movement: FleetMovement | null;
  /** Parked at a continuous point on a lane (stopped mid-march or marched to a
   *  point on the path). Set only while `location` and `movement` are both null. */
  edge?: FleetEdge | null;
  units: UnitStack[];
  /** Ground army carried as cargo (the landing force of a ground assault),
   *  bounded by the ships' transport capacity — see the `army` module. */
  landing?: UnitStack[];
  /** Set (`'near'`) while the fleet is stationed in orbit at a planet; undefined while
   *  in transit. There is a SINGLE orbit (GDD §7.4): a stationed fleet can bombard /
   *  land and is exposed to the planet's orbital AA — no separate "far" safe standoff.
   *  (The value stays `'near'` for back-compat; the old near/far split was collapsed.) */
  orbit?: 'near';
  /** Whether the fleet is actively bombarding the planet below (in orbit over a
   *  hostile world). Damages structures and freezes the owner's production. */
  bombarding?: boolean;
  traits: TraitId[];
  /** Id of the battle this fleet is engaged in; absent/null when free to move. */
  battleId?: BattleId | null;
  /** Player-chosen focus-fire target for this fleet's artillery standoff fire
   *  (`fleet.barrage`). Absent/null = auto-target the nearest hostile in range.
   *  Cleared automatically once the target dies or drifts out of range. */
  barrageTarget?: FleetId | null;
  /** Rules of engagement for this fleet's artillery standoff fire. Absent = the
   *  `standard` default. See `BarrageMode`. */
  barrageMode?: BarrageMode;
  /** Set true once this fleet has taken combat damage — the trigger for the
   *  `return` ("ответный") fire mode, which holds fire until first hit. */
  barrageProvoked?: boolean;
  /** World-time (ms) this fleet last took damage. Gates shield regen: shields stay
   *  down for a delay after the last hit (shields-roadmap SH-1.1). Absent = never hit. */
  lastDamagedAt?: number;
}

/**
 * Rules of engagement for a fleet's artillery standoff fire (an aggression
 * ladder):
 *  - `passive`    — never auto-fire (hold fire).
 *  - `return`     — fire only after the fleet has taken damage (`barrageProvoked`).
 *  - `standard`   — fire at the nearest enemy at WAR (the default).
 *  - `aggressive` — fire at the nearest fleet that is NOT a pact/alliance partner
 *                   (i.e. `war` OR `peace`), opening fire on non-allied neighbours.
 */
export type BarrageMode = 'passive' | 'return' | 'standard' | 'aggressive';

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
  /** Server time (ms) the next hourly round fires — the live battle timer the
   *  client counts down to. Set whenever a round is scheduled. */
  nextRoundAt?: number;
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
  /** World time (ms) at which the match began — the anchor for "session day N"
   *  gates (e.g. a technology's `dayGate`). Set to the initial `time` at creation;
   *  the match's elapsed day count is `(time − startedAt) / MS_PER_DAY`, the same
   *  formula the match browser shows (matchRegistry). Optional: matches persisted
   *  before this field existed read as 0 — correct for the 0-based world clock, and
   *  all such nodes are ungated (dayGate 0) anyway. */
  startedAt?: number;
  /** Terminal match state and the latest scoreboard. */
  match: MatchState;
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
  /** Per-player fog-of-war memory (variant B): the last identified snapshot of
   *  each seen world. Maintained by `visibilityModule`; read by `visibleState`
   *  to show greyed "last known" worlds. Internal — stripped from projections. */
  fog?: Record<PlayerId, FogMemory>;
  /** Hero instances, keyed by instance id (`Hero.id`), maintained by `heroModule`.
   *  A player may field several — filter by `owner`. (Key was the `PlayerId` in the
   *  one-hero-per-player skeleton; instance-keyed since the roster migration.) */
  heroes?: Record<string, Hero>;
  /** Active temporary lanes opened by hero abilities — real graph edges for their
   *  duration (added to `Planet.links`), with a per-owner speed bonus. */
  tempLanes?: TempLane[];
  /** Topology version — bumped whenever `Planet.links` change (a temp lane opens or
   *  expires) so the movement route cache can invalidate. */
  topology?: number;
  /** Monotonic counter handing each temp lane its id. */
  heroSeq?: number;
  /** Pairwise diplomatic stances between players, keyed by a canonical unordered
   *  pair key (`pairKey`). Symmetric and PUBLIC (not fog-gated — who is at war /
   *  allied is open knowledge). A pair with no entry defaults to `DEFAULT_STANCE`
   *  (war), so absence = the engine's no-diplomacy FFA. Read/written through
   *  `state/diplomacy.ts`; the future `diplomacyModule` (D2) owns the actions and
   *  exposes it as the `diplomacy` capability that drives combat's `isHostile`. */
  diplomacy?: Record<string, DiplomaticStance>;
  /** Session resource market: a public per-match order book maintained by
   *  `marketModule`. Sellers escrow a resource at a price; buyers pay money. */
  market?: MarketOrder[];
  /** Monotonic counter handing each market order its id. */
  marketSeq?: number;
}

/** A standing sell order on the session market: the `seller` has escrowed `amount`
 *  of `resource` (deducted from their treasury) and offers it at `price` money per
 *  unit. Filled (partially) by `market.buy`; the remainder is refunded on cancel. */
export interface MarketOrder {
  id: string;
  seller: PlayerId;
  resource: ResourceId;
  /** Remaining units on offer (escrowed). */
  amount: number;
  /** Price per unit, in money (`credits`). */
  price: number;
}

/** A player's hero — a per-player entity with a position on the map and ability
 *  cooldowns. Acts from its current node (`location`); relocates with `hero.move`. */
export interface Hero {
  /** Instance id — the key under which this hero lives in `GameState.heroes`.
   *  Identifies the hero across events (death/respawn) independently of `owner`. */
  id: string;
  owner: PlayerId;
  /** Display name — the player's projection of themselves (their nick). Cosmetic;
   *  set at match seed. Absent ⇒ the client falls back to the owner's name. */
  name?: string;
  /** The node the hero currently occupies / respawns at (abilities act from here,
   *  the projection hero returns here after dying). */
  location: PlanetId;
  /** Per-ability `readyAt` timestamp (ms): the ability is on cooldown while now < it.
   *  The projection hero's death timer lives under the `respawn` key. */
  cooldowns: Record<string, number>;
  /** False while the hero is dead and awaiting respawn; absent/true ⇒ alive. */
  alive?: boolean;
  /** Rarity tier (e.g. `common` | `rare` | `legendary` | `main`). Drives the client
   *  roster's module-slot count; the core carries it but does not enforce slots. */
  grade?: string;
  /** Equipped ability "modules", one per grade slot (`null` = empty). Carried with the
   *  hero; per-module gating/effects are a later brick. */
  abilities?: (string | null)[];
  /** Respawn anchor — the owner's capital. A slain hero re-forms here if still held;
   *  absent ⇒ the core falls back to the hero's last node, then any owned world. */
  home?: PlanetId;
  /** The fleet this hero commands (its ship) while deployed; cleared on death. Lets a
   *  death be attributed to the right hero when several share an owner. */
  fleetId?: FleetId;
}

/** A temporary lane a hero opened: a real, routable graph edge between two nodes for
 *  a limited time, granting the owner's fleets a speed bonus along it. */
export interface TempLane {
  id: string;
  owner: PlayerId;
  from: PlanetId;
  to: PlanetId;
  /** Speed multiplier bonus for the owner's fleets traversing this lane (e.g. 0.5). */
  speedBonus: number;
  /** Simulation time (ms) the lane closes. */
  expiresAt: number;
  /** Whether the lane ADDED the `links` edge (vs the nodes were already linked) — so
   *  expiry only removes a link the lane itself created. */
  addedLink: boolean;
}

/** A player's remembered last-known state of one world (fog-of-war memory). */
export interface PlanetSnapshot {
  owner: PlayerId | null;
  garrison: UnitStack[];
  buildings: BuildingInstance[];
  terrain?: string;
  planetType?: string;
  /** Province type (`kind`) at snapshot time — so a remembered node renders its
   *  last-known appearance, and an unseen node never leaks its true kind. */
  kind?: string;
  /** Simulation time (ms) this snapshot was taken. */
  at: number;
}
/** One player's memory: last-known snapshot per world they have ever identified. */
export type FogMemory = Record<PlanetId, PlanetSnapshot>;

/** Creates an empty, deterministically-seeded initial state. */
export function createInitialState(params: {
  seed: string | number;
  version: GameVersion;
  time?: number;
}): GameState {
  return {
    version: params.version,
    time: params.time ?? 0,
    startedAt: params.time ?? 0,
    match: { status: 'ongoing', winner: null, scores: {} },
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
