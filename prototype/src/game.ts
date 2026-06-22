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
      traits: ['ground'],
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

// --- the map -----------------------------------------------------------------

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

export const MAP: MapNode[] = [
  {
    id: 'HOME',
    owner: 'p1',
    x: 130,
    y: 330,
    sector: 'empty_space',
    type: 'terran',
    links: ['FORGE', 'RELAY'],
    buildings: [{ type: 'mine' }],
    garrison: [['marine', 3]],
  },
  {
    id: 'FORGE',
    owner: null,
    x: 320,
    y: 165,
    sector: 'asteroid_field',
    type: 'volcanic',
    links: ['HOME', 'NEXUS'],
    garrison: [['marine', 2]],
  },
  {
    id: 'RELAY',
    owner: null,
    x: 320,
    y: 480,
    sector: 'empty_space',
    type: 'barren',
    links: ['HOME', 'NEXUS'],
    garrison: [['marine', 1]],
  },
  {
    id: 'NEXUS',
    owner: null,
    x: 520,
    y: 320,
    sector: 'nebula',
    type: 'oceanic',
    links: ['FORGE', 'RELAY', 'OUTPOST', 'CRIMSON'],
    buildings: [{ type: 'fort' }],
    garrison: [['marine', 3], ['cruiser', 1]],
  },
  {
    id: 'OUTPOST',
    owner: 'p2',
    x: 740,
    y: 175,
    sector: 'asteroid_field',
    type: 'volcanic',
    links: ['NEXUS', 'CRIMSON'],
    buildings: [{ type: 'mine' }],
    garrison: [['marine', 3]],
  },
  {
    id: 'CRIMSON',
    owner: 'p2',
    x: 830,
    y: 380,
    sector: 'empty_space',
    type: 'terran',
    links: ['NEXUS', 'OUTPOST'],
    buildings: [{ type: 'fort' }, { type: 'mine' }],
    garrison: [['marine', 4], ['orbital_aa', 1]],
  },
];

function player(id: string, name: string, faction: string, resources: Record<string, number>): Player {
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

// --- fleet.launch: raise a mobile fleet from a planet's garrison -------------
// The core builds units into a planet's garrison; this small module lets a
// player scramble those into a new fleet (ships → units, ground troops →
// landing) so production feeds offense. A natural next addition to the core.
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
      const units = planet.garrison.filter((s) => !h.ctx.data.units[s.unit]?.traits.includes('ground'));
      const landing = planet.garrison.filter((s) => h.ctx.data.units[s.unit]?.traits.includes('ground'));
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
  },
};

// --- assembling the match ----------------------------------------------------

export function newGame(): GameState {
  const base = createInitialState({ seed: 'prototype-1', version: { data: '0.1.0', manifest: '1' } });
  const planets: Record<string, Planet> = {};
  for (const n of MAP) {
    planets[n.id] = {
      id: n.id,
      owner: n.owner,
      position: { x: n.x, y: n.y },
      links: n.links,
      sectorType: n.sector,
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
    'blue-1': fleet('blue-1', 'p1', 'HOME', [['cruiser', 2], ['scout', 1]], [['marine', 3]]),
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
      for (const res of Object.keys(produces)) out[res] = (out[res] ?? 0) + (produces[res] ?? 0) * mult;
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
export const buildBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.construct', { planetId, building });
export const upgradeBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.upgrade', { planetId, building });
export const buildUnit = (playerId: string, planetId: string, unit: string, count = 1) =>
  act(playerId, 'unit.build', { planetId, unit, count });
