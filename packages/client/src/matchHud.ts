/**
 * In-match HUD view-models — zones **A (status bar)** and **D (selection panel)**
 * of the mobile HUD (docs/hud-inmatch.md, adapted from the Iron Order reference).
 * Like `welcomeScreen.ts`, this is the **framework-agnostic view-model**: pure
 * factories that project the fog-stripped `GameState` a client holds
 * (`MultiplayerSnapshot.state`) into render-ready descriptions. The renderer draws
 * them and localises ids (resource ids, unit ids, faction id, the status enum) —
 * the model carries stable ids/numbers/enums, never localised sentences.
 *
 * Invariants (mirror the core's discipline): pure + deterministic (no Date/random),
 * outputs are JSON-serialisable, and the projections are **fail-secure** — a viewer
 * or selection that is not present yields `{ ok: false, code }` with a stable code
 * only, never a thrown detail.
 *
 * Grounded strictly in real state — every field traces to a `GameState`/`GameData`
 * field. Elements of the mockup with **no backing data yet** are deliberately
 * omitted rather than faked: a fleet has no display name (labelled by id/owner),
 * `faction` is a content id (not a corp/clan tag), and the commanding `Hero` has a
 * `grade` tier but no numeric level. The **shield** bar is now real (shields-roadmap
 * SH-0.1/0.2 — `shieldHp` pool); a derived power rating / damage-reduction still
 * don't exist in the core (docs/hud-inmatch.md HUD-2 ⏳) and land once they ship.
 */
import { MS_PER_DAY } from '@void/shared-core';
import type {
  Fleet,
  FleetId,
  GameData,
  GameState,
  PlayerId,
  ResourceId,
  UnitStack,
} from '@void/shared-core';

/* ─────────────────────────── Zone A — status bar ─────────────────────────── */

/** One treasury entry for the status bar (`id` resolves against game data; the
 *  renderer localises it to an icon/label). */
export interface StatusResource {
  id: ResourceId;
  amount: number;
}

/** Render-ready description of the top status bar for the viewing commander. */
export interface StatusBarModel {
  /** `player.name` — the commander callsign. */
  commander: string;
  /** `player.faction` — a content faction id (NOT a corporation/clan tag; the
   *  runtime has no such tag). The renderer resolves it to a display name. */
  faction: string;
  /** 1-based placement among all players by `match.scores[*].total` (ties broken
   *  by id for determinism). Early, before any score is computed, everyone ties on
   *  0 and placement falls back to id order. */
  rank: number;
  /** How many commanders are in the match — the denominator for "N-е из M". */
  players: number;
  /** Whole in-match days elapsed: `floor((time − startedAt) / MS_PER_DAY)`, 0-based
   *  and startedAt-anchored — identical to the match browser (`matchRegistry`) and
   *  the technology `dayGate`. A renderer wanting a 1-based label shows `day + 1`. */
  day: number;
  /** Milliseconds into the current day, in `[0, MS_PER_DAY)` — the renderer formats
   *  it as `HH:MM`. */
  dayTimeMs: number;
  /** Treasury, ordered by the game-data resource order when `data` is supplied
   *  (missing keys shown as 0), else by the bag's own key order. */
  resources: StatusResource[];
  /** `player.status === 'defeated'`. */
  defeated: boolean;
}

/** Status-bar projection outcome: the model, or a stable error code. */
export type StatusBarResult = ({ ok: true } & StatusBarModel) | { ok: false; code: string };

/** Project the status bar for `viewerId` from their view of `state`. Fail-secure:
 *  a viewer absent from `state.players` yields `E_NO_PLAYER`. `data` is optional —
 *  it only fixes the canonical resource order (graceful degradation without it). */
export function createStatusBarModel(
  state: GameState,
  viewerId: PlayerId,
  data?: Pick<GameData, 'resources'>,
): StatusBarResult {
  const player = state.players[viewerId];
  if (!player) {
    return { ok: false, code: 'E_NO_PLAYER' };
  }

  // Placement: rank every player by score total, ties by id (deterministic).
  const ids = Object.keys(state.players);
  const ranked = ids
    .map((id) => ({ id, total: state.match.scores[id]?.total ?? 0 }))
    .sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rank = ranked.findIndex((r) => r.id === viewerId) + 1;

  // World clock, anchored on startedAt (the authoritative convention). Elapsed is
  // clamped at 0 so `day` and `dayTimeMs` stay coherent (reconstruct the same
  // instant) even under a backward clock skew where startedAt briefly exceeds time.
  const elapsed = Math.max(0, state.time - (state.startedAt ?? 0));
  const day = Math.floor(elapsed / MS_PER_DAY);
  const dayTimeMs = elapsed % MS_PER_DAY;

  // Treasury in canonical order (data-driven) with missing resources shown as 0,
  // then any extra bag keys not in the canonical list (defensive).
  const bag = player.resources;
  const resources: StatusResource[] = [];
  const seen = new Set<string>();
  for (const id of data?.resources ?? Object.keys(bag)) {
    resources.push({ id, amount: bag[id] ?? 0 });
    seen.add(id);
  }
  for (const id of Object.keys(bag)) {
    const amount = bag[id];
    if (!seen.has(id) && amount !== undefined) resources.push({ id, amount });
  }

  return {
    ok: true,
    commander: player.name,
    faction: player.faction,
    rank,
    players: ids.length,
    day,
    dayTimeMs,
    resources,
    defeated: player.status === 'defeated',
  };
}

/* ──────────────────────── Zone D — selection panel ───────────────────────── */

/** One unit stack in a fleet's composition. `domain` is filled from game data when
 *  supplied (space crew vs ground army). */
export interface SelectionStack {
  unit: string;
  count: number;
  domain?: 'space' | 'ground';
}

/** The hero commanding the selected fleet. Own fleets only — enemy heroes are
 *  fogged out of the viewer's `state.heroes`. `grade` is the rarity tier the core
 *  carries; there is no numeric commander level. */
export interface SelectionCommander {
  name: string;
  grade?: string;
}

/** Where the fleet is / is heading. Exactly one of these is set, matching `status`. */
export interface SelectionTransit {
  from: string;
  to: string;
  destination: string;
  /** Server-authoritative timestamps (ms) — the renderer counts down to `arrivesAt`. */
  departedAt: number;
  arrivesAt: number;
}
export interface SelectionParked {
  from: string;
  to: string;
  /** Fraction along the lane, in (0,1). */
  t: number;
}

/** Render-ready description of a selected fleet. */
export interface FleetSelectionModel {
  kind: 'fleet';
  id: FleetId;
  owner: PlayerId;
  /** `player.name` of the owner (kept through fog even for an identified enemy). */
  ownerName: string;
  /** Owner's `faction` content id. */
  ownerFaction: string;
  /** `owner === viewerId`. */
  mine: boolean;
  /** `transit` (moving), `parked` (stopped mid-lane), or `stationed` (at a node/orbit). */
  status: 'transit' | 'parked' | 'stationed';
  /** Set when `stationed` — the node the fleet occupies. */
  location?: string;
  /** Set when `transit`. */
  transit?: SelectionTransit;
  /** Set when `parked`. */
  parked?: SelectionParked;
  /** Ship stacks crewing the fleet (`fleet.units`). */
  ships: SelectionStack[];
  /** The commanding hero, when one is attached and visible. */
  commander?: SelectionCommander;
  /** Aggregate hull HP `{ current, max }`, derived as `Σ count × def.stats.hp`
   *  (`current` uses the per-stack combat pool when present, else full). Omitted
   *  when `data` is not supplied — max HP cannot be derived without unit defs. */
  hull?: { current: number; max: number };
  /** Aggregate ablative shield `{ current, max }`, derived as `Σ count × def.stats.shield`
   *  (`current` uses the per-stack `shieldHp` pool when present, else full). Omitted
   *  when `data` is absent OR the fleet has no shield capacity (max 0) — a shieldless
   *  fleet shows one HP bar, not an empty second one. */
  shield?: { current: number; max: number };
  /** Engaged in an active battle (`fleet.battleId` set). */
  inCombat: boolean;
}

/** Selection projection outcome: the fleet model, or a stable error code. */
export type SelectionResult = ({ ok: true } & FleetSelectionModel) | { ok: false; code: string };

function toStacks(stacks: UnitStack[], data?: Pick<GameData, 'units'>): SelectionStack[] {
  return stacks.map((s) => {
    const out: SelectionStack = { unit: s.unit, count: s.count };
    const domain = data?.units[s.unit]?.domain;
    if (domain) out.domain = domain;
    return out;
  });
}

function fleetHull(fleet: Fleet, data: Pick<GameData, 'units'>): { current: number; max: number } {
  let current = 0;
  let max = 0;
  for (const s of fleet.units) {
    const perShip = data.units[s.unit]?.stats.hp ?? 0;
    const stackMax = s.count * perShip;
    max += stackMax;
    // `s.hp` is the whole-stack remaining pool during combat; absent = full health.
    current += s.hp ?? stackMax;
  }
  return { current, max };
}

/** Aggregate ablative shield, or undefined when the fleet has no shield capacity. */
function fleetShield(
  fleet: Fleet,
  data: Pick<GameData, 'units'>,
): { current: number; max: number } | undefined {
  let current = 0;
  let max = 0;
  for (const s of fleet.units) {
    const perShip = data.units[s.unit]?.stats.shield ?? 0;
    const stackMax = s.count * perShip;
    max += stackMax;
    // `s.shieldHp` is the whole-stack shield pool; absent = full shield.
    current += s.shieldHp ?? stackMax;
  }
  return max > 0 ? { current, max } : undefined;
}

/** The living hero commanding `fleet`, if any. Self-securing: only the viewer's own
 *  heroes resolve, so an enemy commander never leaks even if this is handed a
 *  non-fogged state (defence in depth — the fog pass already strips enemy heroes). */
function fleetCommander(
  state: GameState,
  fleet: Fleet,
  viewerId: PlayerId,
): SelectionCommander | undefined {
  if (!state.heroes) return undefined;
  for (const hero of Object.values(state.heroes)) {
    if (hero.fleetId !== fleet.id || hero.owner !== viewerId || hero.alive === false) continue;
    const name = hero.name ?? state.players[fleet.owner]?.name ?? fleet.owner;
    const out: SelectionCommander = { name };
    if (hero.grade) out.grade = hero.grade;
    return out;
  }
  return undefined;
}

/** Project the selection panel for the fleet `fleetId`, as seen by `viewerId`.
 *  Fail-secure: a fleet absent from `state.fleets` (gone, or fogged to a radar-only
 *  signature) yields `E_NO_SELECTION`. `data` is optional — without it `hull` and
 *  stack `domain` are omitted (graceful degradation). */
export function createSelectionModel(
  state: GameState,
  fleetId: FleetId,
  viewerId: PlayerId,
  data?: Pick<GameData, 'units'>,
): SelectionResult {
  const fleet = state.fleets[fleetId];
  if (!fleet) {
    return { ok: false, code: 'E_NO_SELECTION' };
  }

  const owner = state.players[fleet.owner];
  const model: FleetSelectionModel = {
    kind: 'fleet',
    id: fleet.id,
    owner: fleet.owner,
    ownerName: owner?.name ?? fleet.owner,
    ownerFaction: owner?.faction ?? '',
    mine: fleet.owner === viewerId,
    status: fleet.movement ? 'transit' : fleet.edge ? 'parked' : 'stationed',
    ships: toStacks(fleet.units, data),
    inCombat: fleet.battleId != null,
  };

  if (fleet.movement) {
    const mv = fleet.movement;
    model.transit = {
      from: mv.from,
      to: mv.to,
      destination: mv.destination ?? mv.to,
      departedAt: mv.departedAt,
      arrivesAt: mv.arrivesAt,
    };
  } else if (fleet.edge) {
    model.parked = { from: fleet.edge.from, to: fleet.edge.to, t: fleet.edge.t };
  } else if (fleet.location) {
    model.location = fleet.location;
  }

  const commander = fleetCommander(state, fleet, viewerId);
  if (commander) model.commander = commander;
  if (data) {
    model.hull = fleetHull(fleet, data);
    const shield = fleetShield(fleet, data);
    if (shield) model.shield = shield;
  }

  return { ok: true, ...model };
}
