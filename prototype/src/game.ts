/**
 * Void Dominion — playable prototype, game setup.
 *
 * This file is pure game wiring (no DOM): it builds the data-driven content,
 * the map and the kernel out of the REAL `@void/shared-core` simulation, so the
 * browser UI and a Node smoke-test drive exactly the same deterministic core.
 */
import {
  createKernel,
  createInitialState,
  parseGameData,
  buildingLevel,
  isBombarded,
  economyModule,
  movementModule,
  combatModule,
  sectorModule,
  planetTypeModule,
  constructionModule,
  armyModule,
  type GameData,
  type GameModule,
  type GameState,
  type Planet,
  type Fleet,
  type UnitStack,
  type Player,
  type Action,
  type Context,
  type DomainEvent,
} from '../../packages/shared-core/src/index';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// --- data-driven content -----------------------------------------------------

export const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  units: {
    scout: {
      faction: 'blue',
      stats: { attack: 5, defense: 4, speed: 64, hp: 12, cargoCapacity: 1 },
      cost: { metal: 20 },
      buildTimeHours: 1,
      upkeep: { credits: 1 },
    },
    cruiser: {
      faction: 'blue',
      stats: { attack: 16, defense: 14, speed: 40, hp: 60, cargoCapacity: 5 },
      line: 'front',
      cost: { metal: 60, credits: 20 },
      buildTimeHours: 3,
      upkeep: { credits: 4 },
    },
    siege: {
      faction: 'blue',
      stats: { attack: 30, defense: 6, speed: 30, hp: 40, range: 3 },
      traits: ['artillery'],
      cost: { metal: 90, credits: 40 },
      buildTimeHours: 5,
      upkeep: { credits: 6 },
    },
    marine: {
      faction: 'blue',
      stats: { attack: 12, defense: 12, speed: 52, hp: 24 },
      domain: 'ground',
      traits: ['ground'],
      cost: { metal: 30 },
      buildTimeHours: 2,
      upkeep: { credits: 2 },
    },
    orbital_aa: {
      faction: 'blue',
      stats: { attack: 4, defense: 14, speed: 0, hp: 30, aaDamage: 12 },
      domain: 'ground',
      traits: ['ground', 'immobile'], // a fixed emplacement — can't be lifted onto a fleet
      line: 'rear',
      cost: { metal: 110, credits: 30 },
      buildTimeHours: 4,
      upkeep: { credits: 3 },
    },
  },
  factions: {},
  buildings: {
    mine: {
      name: 'Metal Mine',
      cost: { metal: 80 },
      buildTimeHours: 3,
      produces: { metal: 12 },
      hp: 20,
    },
    refinery: {
      name: 'Credit Refinery',
      cost: { metal: 110 },
      buildTimeHours: 4,
      produces: { credits: 8 },
      hp: 20,
    },
    barracks: { name: 'Barracks', cost: { metal: 70 }, buildTimeHours: 3, hp: 25 },
    // radar array — projects a detection radius (in jumps) that grows with its
    // level; enemy fleets inside it show up as coarse signatures (not identified).
    radar: {
      name: 'Radar Array',
      cost: { metal: 90, credits: 40 },
      buildTimeHours: 3,
      hp: 18,
      upgrades: [
        { cost: { metal: 180, credits: 80 }, buildTimeHours: 5, hp: 28 },
        { cost: { metal: 300, credits: 140 }, buildTimeHours: 7, hp: 38 },
      ],
    },
    // space fortress — only built in an asteroid field; turns the junction into a
    // defended, assaultable strongpoint (it garrisons a fixed orbital-AA by default)
    starfort: {
      name: 'Void Fortress',
      cost: { metal: 180, credits: 60 },
      buildTimeHours: 6,
      hp: 70,
      defenseBonus: 0.4,
    },
    fort: {
      name: 'Fort',
      cost: { metal: 100 },
      buildTimeHours: 4,
      hp: 40,
      defenseBonus: 0.3,
      upgrades: [
        { cost: { metal: 200, credits: 80 }, buildTimeHours: 6, hp: 60, defenseBonus: 0.45 },
        { cost: { metal: 340, credits: 160 }, buildTimeHours: 8, hp: 85, defenseBonus: 0.6 },
      ],
    },
  },
  events: {},
  sectors: {
    empty_space: { name: 'Open space', speedBonus: 0.15, hpBonus: 0 },
    asteroid_field: { name: 'Asteroid field', speedBonus: -0.25, hpBonus: 0.1 },
    nebula: { name: 'Nebula', speedBonus: -0.1, hpBonus: 0.05 },
  },
  planetTypes: {
    terran: { name: 'Terran', productionBonus: 0, defenseBonus: 0.1 },
    barren: { name: 'Barren', productionBonus: -0.25, defenseBonus: 0 },
    oceanic: { name: 'Oceanic', productionBonus: 0.15, defenseBonus: 0.05 },
    volcanic: { name: 'Volcanic', productionBonus: 0.25, defenseBonus: -0.05 },
    gas_giant: { name: 'Gas Giant', productionBonus: 0.35, defenseBonus: -0.15 },
  },
});

// --- sectors -----------------------------------------------------------------

/**
 * Sector-type registry — the whole map is a graph of sectors, each of exactly one
 * type. Types are pure data: add/remove them freely; every type carries its own
 * properties, and rendering + behaviour read from here (no hard-coded sector logic).
 *   core       — terrain key in `data.sectors` (speed/HP bonuses) this type maps to
 *   capturable — can be owned/taken (empty space can't — only traversed)
 *   buildable  — structures can be raised here
 *   orbit      — has the near/far orbital layer (cities, fortresses)
 *   color      — map accent for the type
 */
export interface SectorType {
  name: string;
  core: string;
  capturable: boolean;
  buildable: boolean;
  orbit: boolean;
  color: string;
}
export const SECTOR_TYPES: Record<string, SectorType> = {
  planet: { name: 'Planet', core: 'empty_space', capturable: true, buildable: true, orbit: true, color: '#5fd0ff' },
  nebula: { name: 'Nebula', core: 'nebula', capturable: true, buildable: true, orbit: true, color: '#8f6dff' },
  asteroid: { name: 'Asteroid Field', core: 'asteroid_field', capturable: true, buildable: true, orbit: false, color: '#d6a645' },
  empty: { name: 'Empty Space', core: 'empty_space', capturable: false, buildable: false, orbit: false, color: '#46606e' },
};

// --- the map -----------------------------------------------------------------

/** One sector node. `sector` is its type key (see SECTOR_TYPES); `links` are the
 *  paths to neighbouring sectors; `type` is the planet-type (bonuses) for worlds. */
export interface MapNode {
  id: string;
  owner: string | null;
  x: number;
  y: number;
  sector: string;
  type?: string;
  links: string[];
  buildings?: Array<{ type: string; level?: number }>;
  garrison?: Array<[string, number]>;
}

type KeyNode = Omit<MapNode, 'links'>;

// Curated sectors — fixed positions / types / owners / garrisons. The rest of the
// map is filled in around them and everything is wired up by proximity below.
const KEY: KeyNode[] = [
  // home region (west)
  { id: 'HOME', owner: 'p1', x: 150, y: 250, sector: 'planet', type: 'terran', buildings: [{ type: 'mine' }, { type: 'radar' }], garrison: [['marine', 3]] },
  { id: 'ANCHOR', owner: 'p1', x: 130, y: 440, sector: 'planet', type: 'oceanic', buildings: [{ type: 'refinery' }], garrison: [['marine', 2], ['orbital_aa', 1]] },
  { id: 'RELAY', owner: null, x: 320, y: 360, sector: 'planet', type: 'barren', garrison: [['marine', 1]] },
  { id: 'FORGE', owner: null, x: 250, y: 175, sector: 'asteroid' },
  // contested region (centre)
  { id: 'NEXUS', owner: null, x: 560, y: 250, sector: 'nebula', type: 'oceanic', buildings: [{ type: 'fort' }], garrison: [['marine', 3], ['cruiser', 1]] },
  { id: 'VEIL', owner: null, x: 470, y: 430, sector: 'nebula', type: 'gas_giant', buildings: [{ type: 'refinery' }], garrison: [['marine', 2]] },
  { id: 'HARBOR', owner: null, x: 660, y: 430, sector: 'planet', type: 'oceanic', buildings: [{ type: 'barracks' }], garrison: [['marine', 2]] },
  { id: 'DRIFT', owner: null, x: 560, y: 150, sector: 'asteroid' },
  // enemy region (east)
  { id: 'OUTPOST', owner: 'p2', x: 850, y: 250, sector: 'planet', type: 'volcanic', buildings: [{ type: 'mine' }], garrison: [['marine', 3]] },
  { id: 'BASTION', owner: 'p2', x: 930, y: 440, sector: 'nebula', type: 'barren', buildings: [{ type: 'fort' }], garrison: [['marine', 3], ['scout', 1]] },
  { id: 'CRIMSON', owner: 'p2', x: 970, y: 260, sector: 'planet', type: 'terran', buildings: [{ type: 'fort' }, { type: 'mine' }], garrison: [['marine', 4], ['orbital_aa', 1]] },
  { id: 'SLAG', owner: null, x: 1020, y: 390, sector: 'asteroid' },
];

// Fill the rest of the map with sectors on a jittered lattice: mostly empty space,
// with the occasional neutral field/world to seize. Deterministic; bump the grid
// density to get more sectors.
function fillSectors(): KeyNode[] {
  const hash = (a: number, b: number): number => {
    const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const out: KeyNode[] = [];
  let i = 0;
  for (let gx = 60; gx <= 1130; gx += 120) {
    for (let gy = 50; gy <= 520; gy += 120) {
      const x = gx + (hash(gx, gy) - 0.5) * 70;
      const y = gy + (hash(gy, gx) - 0.5) * 70;
      if (KEY.some((k) => Math.hypot(k.x - x, k.y - y) < 90)) continue;
      const r = hash(x * 0.37, y * 0.71);
      const sector = r < 0.1 ? 'asteroid' : r < 0.18 ? 'nebula' : 'empty';
      const node: KeyNode = { id: `S${i++}`, owner: null, x, y, sector };
      if (sector === 'nebula') node.type = 'barren';
      out.push(node);
    }
  }
  return out;
}

// Wire sectors up as a Relative Neighbourhood Graph: a sector links to another
// ONLY if no third sector lies "between" them (closer to both than they are to
// each other). That gives each sector paths to its immediate neighbours only —
// no long criss-crossing lanes — while the map stays one fully-connected graph
// (an RNG always contains the Euclidean minimum spanning tree). Links are
// symmetric. O(n³), trivial for a few dozen sectors.
function withNeighborLinks(nodes: KeyNode[]): MapNode[] {
  const dist = (a: KeyNode, b: KeyNode): number => Math.hypot(a.x - b.x, a.y - b.y);
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dab = dist(a, b);
      const between = nodes.some((c) => c !== a && c !== b && dist(a, c) < dab && dist(b, c) < dab);
      if (!between) {
        adj.get(a.id)!.add(b.id);
        adj.get(b.id)!.add(a.id);
      }
    }
  }
  return nodes.map((n) => ({ ...n, links: [...adj.get(n.id)!] }));
}

export const MAP: MapNode[] = withNeighborLinks([...KEY, ...fillSectors()]);

function player(
  id: string,
  name: string,
  faction: string,
  resources: Record<string, number>,
): Player {
  return { id, name, faction, status: 'active', resources };
}

function fleet(
  id: string,
  owner: string,
  location: string,
  units: Array<[string, number]>,
  landing: Array<[string, number]>,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    landing: landing.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}

/** Move up to `count` of `unit` out of `src` (mutates src, pruning emptied
 *  stacks) and return the removed stacks. Outside combat a unit type is a single
 *  full-health stack, but this stays correct if combat has split it by HP. */
function takeFromStacks(src: UnitStack[], unit: string, count: number): UnitStack[] {
  let remaining = count;
  const taken: UnitStack[] = [];
  for (const st of src) {
    if (st.unit !== unit || remaining <= 0) continue;
    const move = Math.min(st.count, remaining);
    st.count -= move;
    remaining -= move;
    taken.push(st.hp === undefined ? { unit, count: move } : { unit, count: move, hp: st.hp });
  }
  return taken;
}

/** Fold one stack list into another, coalescing stacks that share the same unit
 *  type *and* HP pool (full-health stacks have `hp` undefined and combine). */
function mergeStacks(base: UnitStack[], add: UnitStack[]): UnitStack[] {
  const out = base.map((st) => ({ ...st }));
  for (const st of add) {
    const match = out.find((o) => o.unit === st.unit && o.hp === st.hp);
    if (match) match.count += st.count;
    else out.push({ ...st });
  }
  return out;
}

// --- fleet.launch / fleet.merge: form and consolidate mobile fleets ----------
// The core builds units into a planet's garrison; this small module lets a
// player scramble those into a new fleet (ships → units, ground troops →
// landing) so production feeds offense, and fuse two co-located fleets into one.
// A natural next addition to the core.
export const fleetLaunchModule: GameModule = {
  id: 'fleet-ops',
  version: '0.1.0',
  setup(api) {
    api.onAction('fleet.launch', (action, h) => {
      const payload = action.payload as { planetId?: string };
      if (typeof payload?.planetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const planet = h.state.planets[payload.planetId];
      if (!planet) {
        return h.reject('E_NO_PLANET');
      }
      if (planet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (planet.garrison.length === 0) {
        return h.reject('E_EMPTY_GARRISON');
      }
      // A fleet can't sit where one is already stationed-and-idle? Allow stacking.
      const units = planet.garrison.filter(
        (s) => !h.ctx.data.units[s.unit]?.traits.includes('ground'),
      );
      const landing = planet.garrison.filter((s) =>
        h.ctx.data.units[s.unit]?.traits.includes('ground'),
      );
      if (units.length === 0) {
        return h.reject('E_NO_SHIPS'); // need at least one ship to form a fleet
      }
      const seq = Object.keys(h.state.fleets).length;
      const id = `fleet:${action.playerId}:${h.ctx.now}:${seq}`;
      h.state.fleets[id] = {
        id,
        owner: action.playerId,
        location: planet.id,
        movement: null,
        units: units.map((s) => ({ unit: s.unit, count: s.count })),
        landing: landing.map((s) => ({ unit: s.unit, count: s.count })),
        traits: [],
        battleId: null,
      };
      planet.garrison = [];
      h.emit('fleet.launched', { fleetId: id, planetId: planet.id, owner: action.playerId });
    });

    // Fuse `from` into `into` when both are docked, idle and in the same sector.
    // Bringing the fleets together (flying one to the other) is the caller's job;
    // by the time this action runs the two must already share a location.
    api.onAction('fleet.merge', (action, h) => {
      const payload = action.payload as { from?: string; into?: string };
      if (typeof payload?.from !== 'string' || typeof payload?.into !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (payload.from === payload.into) {
        return h.reject('E_SAME_FLEET');
      }
      const from = h.state.fleets[payload.from];
      const into = h.state.fleets[payload.into];
      if (!from || !into) {
        return h.reject('E_NO_FLEET');
      }
      if (from.owner !== action.playerId || into.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (from.battleId || into.battleId) {
        return h.reject('E_IN_BATTLE');
      }
      if (from.movement || into.movement || !from.location || from.location !== into.location) {
        return h.reject('E_NOT_COLOCATED');
      }
      into.units = mergeStacks(into.units, from.units);
      into.landing = mergeStacks(into.landing ?? [], from.landing ?? []);
      delete h.state.fleets[payload.from];
      h.emit('fleet.merged', {
        from: payload.from,
        into: payload.into,
        owner: action.playerId,
        at: into.location,
      });
    });

    // Peel a chosen set of ships off a docked, idle fleet into a fresh fleet that
    // spawns in the same sector (same orbit). The split must keep ≥1 ship behind
    // and move ≥1 out; carried ground troops stay with the original.
    api.onAction('fleet.split', (action, h) => {
      const payload = action.payload as {
        fleetId?: string;
        take?: Array<{ unit?: string; count?: number }>;
      };
      if (typeof payload?.fleetId !== 'string' || !Array.isArray(payload.take)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = h.state.fleets[payload.fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (fleet.battleId) {
        return h.reject('E_IN_BATTLE');
      }
      if (fleet.movement || !fleet.location) {
        return h.reject('E_IN_TRANSIT');
      }
      const want = new Map<string, number>();
      for (const t of payload.take) {
        if (typeof t?.unit !== 'string' || typeof t?.count !== 'number' || t.count <= 0) {
          return h.reject('E_BAD_PAYLOAD');
        }
        want.set(t.unit, (want.get(t.unit) ?? 0) + Math.floor(t.count));
      }
      const have = (unit: string) =>
        fleet.units.filter((st) => st.unit === unit).reduce((a, st) => a + st.count, 0);
      let takeTotal = 0;
      for (const [unit, n] of want) {
        if (n > have(unit)) return h.reject('E_NOT_ENOUGH');
        takeTotal += n;
      }
      const shipsTotal = fleet.units.reduce((a, st) => a + st.count, 0);
      if (takeTotal <= 0) {
        return h.reject('E_SPLIT_EMPTY');
      }
      if (takeTotal >= shipsTotal) {
        return h.reject('E_SPLIT_ALL'); // must leave at least one ship in the original
      }
      let taken: UnitStack[] = [];
      for (const [unit, n] of want) taken = taken.concat(takeFromStacks(fleet.units, unit, n));
      fleet.units = fleet.units.filter((st) => st.count > 0);
      const seq = Object.keys(h.state.fleets).length;
      const id = `fleet:${action.playerId}:${h.ctx.now}:${seq}`;
      h.state.fleets[id] = {
        id,
        owner: action.playerId,
        location: fleet.location,
        movement: null,
        units: taken,
        landing: [],
        traits: [],
        battleId: null,
        ...(fleet.orbit ? { orbit: fleet.orbit } : {}),
      };
      h.emit('fleet.split', {
        from: payload.fleetId,
        to: id,
        owner: action.playerId,
        at: fleet.location,
      });
    });
  },
};

// --- assembling the match ----------------------------------------------------

export function newGame(): GameState {
  const base = createInitialState({
    seed: 'prototype-1',
    version: { data: '0.1.0', manifest: '1' },
  });
  const planets: Record<string, Planet> = {};
  for (const n of MAP) {
    planets[n.id] = {
      id: n.id,
      owner: n.owner,
      position: { x: n.x, y: n.y },
      links: n.links,
      sectorType: SECTOR_TYPES[n.sector]?.core ?? 'empty_space',
      planetType: n.type,
      resources: {},
      buildings: (n.buildings ?? []).map((b) => {
        const def = data.buildings[b.type];
        const level = b.level ?? 1;
        const hp = def ? hpOfLevel(b.type, level) : 0;
        return { type: b.type, level, hp };
      }),
      garrison: (n.garrison ?? []).map(([unit, count]) => ({ unit, count })),
      traits: [],
    };
  }
  const players: Record<string, Player> = {
    p1: player('p1', 'Azure Compact', 'blue', { credits: 260, metal: 320 }),
    p2: player('p2', 'Crimson Hegemony', 'red', { credits: 240, metal: 300 }),
  };
  const fleets: Record<string, Fleet> = {
    'blue-1': fleet(
      'blue-1',
      'p1',
      'HOME',
      [
        ['cruiser', 2],
        ['scout', 1],
      ],
      [['marine', 3]],
    ),
    'red-1': fleet('red-1', 'p2', 'CRIMSON', [['cruiser', 2]], [['marine', 3]]),
  };
  return { ...base, players, planets, fleets };
}

/** Net per-hour income for a player: production from owned, un-bombarded worlds
 *  minus unit/garrison upkeep (daily ÷ 24). Drives the HUD's `+/h` deltas. */
export function netIncome(state: GameState, playerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Object.values(state.planets)) {
    if (p.owner !== playerId || isBombarded(state, p.id)) continue;
    const mult = 1 + (p.planetType ? (data.planetTypes[p.planetType]?.productionBonus ?? 0) : 0);
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      if (!def) continue;
      const produces = buildingLevel(def, b.level).produces;
      for (const res of Object.keys(produces))
        out[res] = (out[res] ?? 0) + (produces[res] ?? 0) * mult;
    }
  }
  const addUpkeep = (stacks: Array<{ unit: string; count: number }>) => {
    for (const st of stacks) {
      const def = data.units[st.unit];
      if (!def) continue;
      for (const res of Object.keys(def.upkeep))
        out[res] = (out[res] ?? 0) - ((def.upkeep[res] ?? 0) * st.count) / 24;
    }
  };
  for (const f of Object.values(state.fleets))
    if (f.owner === playerId) {
      addUpkeep(f.units);
      if (f.landing) addUpkeep(f.landing);
    }
  for (const p of Object.values(state.planets)) if (p.owner === playerId) addUpkeep(p.garrison);
  return out;
}

/** Max HP of a building level (mirrors the core's per-level data). */
export function hpOfLevel(type: string, level: number): number {
  const def = data.buildings[type];
  if (!def) return 0;
  if (level <= 1) return def.hp;
  return def.upgrades[level - 2]?.hp ?? def.hp;
}

export const MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  economyModule,
  movementModule,
  combatModule,
  constructionModule,
  armyModule,
  fleetLaunchModule,
];

export const kernel = createKernel(MODULES);

export function ctx(now: number): Context {
  return { now, data, config: { timeScale: 1 } };
}

export interface StepOut {
  state: GameState;
  events: DomainEvent[];
  error?: string;
}

/** Advance the world to `now`, collecting events. */
export function advance(state: GameState, now: number): StepOut {
  if (now <= state.time) return { state, events: [] };
  const r = kernel.advanceTo(state, ctx(now));
  if (!r.ok) return { state, events: [], error: r.code };
  return { state: r.state, events: r.events };
}

/** Apply a player order at the current world time (advancing first if needed). */
export function order(state: GameState, action: Action, now: number): StepOut {
  const advanced = advance(state, now);
  const r = kernel.applyAction(advanced.state, action, ctx(Math.max(now, advanced.state.time)));
  if (!r.ok) return { state: advanced.state, events: advanced.events, error: r.code };
  return { state: r.state, events: [...advanced.events, ...r.events] };
}

// --- action builders ---------------------------------------------------------

let seqCounter = 0;
const act = (playerId: string, type: string, payload: unknown): Action => ({
  id: `ui:${playerId}:${seqCounter++}`,
  type,
  playerId,
  payload,
  issuedAt: 0,
});

export const moveFleet = (playerId: string, fleetId: string, to: string) =>
  act(playerId, 'fleet.move', { fleetId, to });
export const stopFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.stop', { fleetId });
export const orbitFleet = (playerId: string, fleetId: string, orbit: 'near' | 'far') =>
  act(playerId, 'fleet.orbit', { fleetId, orbit });
export const assaultFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.assault', { fleetId });
export const bombardFleet = (playerId: string, fleetId: string, on: boolean) =>
  act(playerId, 'fleet.bombard', { fleetId, on });
export const loadArmy = (playerId: string, fleetId: string, unit: string, count = 1) =>
  act(playerId, 'army.load', { fleetId, unit, count });
export const unloadArmy = (playerId: string, fleetId: string, unit: string, count = 1) =>
  act(playerId, 'army.unload', { fleetId, unit, count });
export const launchFleet = (playerId: string, planetId: string) =>
  act(playerId, 'fleet.launch', { planetId });
export const mergeFleet = (playerId: string, from: string, into: string) =>
  act(playerId, 'fleet.merge', { from, into });
export const splitFleet = (
  playerId: string,
  fleetId: string,
  take: Array<{ unit: string; count: number }>,
) => act(playerId, 'fleet.split', { fleetId, take });
export const buildBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.construct', { planetId, building });
export const upgradeBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.upgrade', { planetId, building });
export const buildUnit = (playerId: string, planetId: string, unit: string, count = 1) =>
  act(playerId, 'unit.build', { planetId, unit, count });
