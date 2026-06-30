import type { GameData, SectorKindAppearance, SectorKindDef } from '../data/schemas';
import type { Planet } from './gameState';

/**
 * Province-type accessors (map-roadmap.md M2.1). A province's `kind` is the single
 * registry deciding whether it can be captured, built on, **what** it can be built
 * with (`allowedBuildings` roster), and how it looks on the map (`appearance`).
 * Resolved against game data `sectorKinds`; an absent or unknown kind degrades to the
 * permissive default so worlds without kind data — the existing scenarios — keep
 * behaving exactly as before (invariant: every extension point degrades gracefully).
 */

/** Permissive default. `allowedBuildings: undefined` is load-bearing — it is the
 *  "ANY building" signal the construction gate reads (NOT `[]`, which means "none"). */
const DEFAULT_APPEARANCE: SectorKindAppearance = { color: '#46606e', shape: 'city' };
const DEFAULT_KIND: SectorKindDef = {
  scoreValue: 10,
  capturable: true,
  buildable: true,
  orbit: true,
  allowedBuildings: undefined,
  appearance: DEFAULT_APPEARANCE,
};

/** The kind definition for a sector, or the permissive default. */
export function sectorKindDef(data: GameData, planet: Pick<Planet, 'kind'>): SectorKindDef {
  const k = planet.kind;
  return (k !== undefined ? data.sectorKinds[k] : undefined) ?? DEFAULT_KIND;
}

/** Victory-score base for controlling this province, by its kind (a `planet` is the
 *  prize, every other kind a flat lower worth). The territory term of `computeScore`. */
export function provinceScore(data: GameData, planet: Pick<Planet, 'kind'>): number {
  return sectorKindDef(data, planet).scoreValue;
}

/** Can this sector be owned (captured)? Empty space cannot. */
export function isCapturable(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).capturable;
}

/** Can structures be raised on this sector? */
export function isBuildable(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).buildable;
}

/** Does this sector have the orbital layer (fleets can station in orbit)? */
export function hasOrbit(data: GameData, planet: Pick<Planet, 'kind'>): boolean {
  return sectorKindDef(data, planet).orbit;
}

/** The build roster of this province type — the building ids it may host, or
 *  `undefined` = any building (permissive). Explicit `[]` = no construction here. */
export function allowedBuildings(
  data: GameData,
  planet: Pick<Planet, 'kind'>,
): string[] | undefined {
  return sectorKindDef(data, planet).allowedBuildings;
}

/** Map appearance (color / label / shape) of this province type; neutral default if absent. */
export function sectorAppearance(data: GameData, planet: Pick<Planet, 'kind'>): SectorKindAppearance {
  return sectorKindDef(data, planet).appearance;
}
