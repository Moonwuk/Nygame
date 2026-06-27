import { buildingLevel, type GameData, type ResourceBag } from '../data/schemas';
import type { BuildingInstance, UnitStack } from './gameState';

/** The concrete pieces a faction brings to the start of a match. */
export interface FactionStart {
  /** Starting treasury. */
  resources: ResourceBag;
  /** Ground units for the homeworld garrison. */
  garrison: UnitStack[];
  /** Buildings already standing on the homeworld (level 1, hp from data). */
  buildings: BuildingInstance[];
  /** Ships for the starting fleet. */
  fleet: UnitStack[];
}

/**
 * Resolve a faction's `startingLoadout` (data, B1) into the concrete state pieces a
 * match-setup needs (CR-1.3 / B3): the starting treasury, the homeworld garrison +
 * buildings, and the starting fleet. Pure and **deterministic** — no RNG, no time, and
 * a fresh clone every call (mutating the result never touches game data). An unknown
 * faction (or one with no loadout) yields empty pieces (graceful degradation). The
 * caller owns WHERE these land (homeworld + fleet placement); this resolves WHAT the
 * faction brings.
 */
export function factionStart(data: GameData, factionId: string): FactionStart {
  const loadout = data.factions[factionId]?.startingLoadout;
  if (!loadout) {
    return { resources: {}, garrison: [], buildings: [], fleet: [] };
  }
  return {
    resources: { ...loadout.resources },
    garrison: loadout.garrison.map((s) => ({ unit: s.unit, count: s.count })),
    fleet: loadout.fleet.map((s) => ({ unit: s.unit, count: s.count })),
    buildings: loadout.homeBuildings.map((type) => {
      const def = data.buildings[type];
      return { type, level: 1, hp: def ? buildingLevel(def, 1).hp : 0 };
    }),
  };
}
