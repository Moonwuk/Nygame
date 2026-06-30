import { z } from 'zod';

/**
 * Validation schemas for the data-driven game content (docs/architecture.md
 * §2). The engine knows nothing about concrete units/factions/resources — it
 * only enforces these shapes and then operates over the data. New content =
 * new JSON entries, no code changes.
 *
 * All input from disk or from the wire is validated here before it ever
 * reaches the core (OWASP A05 — Injection; A08 — Integrity).
 */

/** A dynamic resource ledger, e.g. { "metal": 220, "credits": 80 }. */
export const ResourceBagSchema = z.record(z.string(), z.number());

/** Combat/movement stats. Extra numeric stats are allowed (data-driven). */
export const UnitStatsSchema = z
  .object({
    /** Damage dealt when attacking. */
    attack: z.number(),
    /** Damage dealt when defending (return fire of a standing fleet). */
    defense: z.number(),
    speed: z.number(),
    /** Hit points per ship — aggregate fleet HP = Σ count × hp (GDD §7.1). */
    hp: z.number().nonnegative().default(1),
    /** Standoff firing radius in MAP UNITS — the Euclidean reach of an
     *  `artillery` unit's ranged attack (combat `runArtillery`). 0 = melee only,
     *  no ranged attack. The longest gun in a fleet sets the fleet's reach. */
    range: z.number().nonnegative().default(0),
    /** Ground-army transport capacity of a ship (0 = carries nothing; a
     *  dedicated dropship carries a lot). Bigger hulls carry more. */
    cargoCapacity: z.number().nonnegative().default(0),
    /** Transport space a ground unit occupies when carried (a tank > infantry). */
    cargoSize: z.number().nonnegative().default(1),
    /** Orbital-AA damage per hour a (ground) unit deals to a hostile fleet on the
     *  NEAR orbit while the planet is not under a ground assault. 0 = no AA. */
    aaDamage: z.number().nonnegative().default(0),
  })
  .catchall(z.number());

export const UnitDefSchema = z.object({
  faction: z.string(),
  stats: UnitStatsSchema,
  /** Where the unit operates: `space` units crew fleets and fight in orbit;
   *  `ground` units are the planetary army (garrison / transported as cargo /
   *  the landing force in a ground assault). Fleets carry ground units up to
   *  their ships' `cargoCapacity`. */
  domain: z.enum(['space', 'ground']).default('space'),
  /** Damage-receiving line (GDD §7.2). `artillery` trait overrides this. */
  line: z.enum(['front', 'mid', 'rear']).default('front'),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
  cost: ResourceBagSchema.default({}),
  /** Build time in hours to produce the unit at a planet (real-time,
   *  timeScale-scaled). Mirrors BuildingDef.buildTimeHours. */
  buildTimeHours: z.number().nonnegative().default(0),
  /** Daily upkeep paid to keep the unit (per day). */
  upkeep: ResourceBagSchema.default({}),
  /** Radar "signature": how detectable the unit is. A fleet's signature is the
   *  sum of count × signature; radar reveals a coarse size bucket, never the
   *  exact composition (fog-of-war — `visibleState`). */
  signature: z.number().nonnegative().default(1),
  /** Radar reach (Euclidean distance, map units) the unit projects as a radar-ship (0 = none). */
  radarRange: z.number().nonnegative().default(0),
});

/** One stack in a faction's starting loadout (a unit id + how many). */
export const StartingStackSchema = z.object({
  unit: z.string(),
  count: z.number().int().positive(),
});

/** What a player of this faction begins a match with (consumed by the match-start
 *  assembly, brick B3). All fields default to empty so a faction can describe only
 *  what differs. */
export const FactionLoadoutSchema = z.object({
  /** Starting treasury. */
  resources: ResourceBagSchema.default({}),
  /** Ships in the starting fleet. */
  fleet: z.array(StartingStackSchema).default([]),
  /** Ground units in the homeworld garrison. */
  garrison: z.array(StartingStackSchema).default([]),
  /** Buildings already standing on the homeworld (ids → `data.buildings`). */
  homeBuildings: z.array(z.string()).default([]),
});

/** Passive faction bonuses — mirrors `TechnologyEffects` so the faction module
 *  (brick B2) can apply them through the same `economy.production` / `fleet.speed` /
 *  `combat.damage` hooks. Absent module → no effect (graceful degradation). */
export const FactionPassivesSchema = z.object({
  /** Multiplier on owned planetary production, e.g. 0.15 = +15%. */
  productionBonus: z.number().default(0),
  /** Multiplier on owned fleet movement speed. */
  fleetSpeedBonus: z.number().default(0),
  /** Multiplier on outgoing combat damage. */
  combatDamageBonus: z.number().default(0),
});

export const FactionDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
  /** Unit ids this faction can field that others cannot (its signature roster). */
  uniqueUnits: z.array(z.string()).default([]),
  /** Match-start loadout (resources / fleet / garrison / homeworld buildings). */
  startingLoadout: FactionLoadoutSchema.default({
    resources: {},
    fleet: [],
    garrison: [],
    homeBuildings: [],
  }),
  /** Always-on faction bonuses, applied by the faction module via hooks. */
  passives: FactionPassivesSchema.default({
    productionBonus: 0,
    fleetSpeedBonus: 0,
    combatDamageBonus: 0,
  }),
});

/** Per-level stats of a building (level 2..N). Level 1 uses the base fields. */
export const BuildingLevelSchema = z.object({
  cost: ResourceBagSchema.default({}),
  buildTimeHours: z.number().nonnegative().default(0),
  produces: ResourceBagSchema.default({}),
  /** Structural HP at this level. */
  hp: z.number().nonnegative().default(0),
  /** Ground-defense bonus this level grants the garrison (0.01 = +1%). */
  defenseBonus: z.number().default(0.01),
  /** Radar reach (Euclidean distance, map units) at this level — lets a radar array widen its
   *  detection radius as it is upgraded. */
  radarRange: z.number().nonnegative().default(0),
  /** Fraction of a garrison stack's max-HP pool restored per game hour (0.1 = 10%/h).
   *  Stacks heal continuously while the planet is owned; destroyed buildings don't heal. */
  healRate: z.number().nonnegative().default(0),
});

export const BuildingDefSchema = z.object({
  name: z.string(),
  cost: ResourceBagSchema.default({}),
  buildTimeHours: z.number().nonnegative().default(0),
  produces: ResourceBagSchema.default({}),
  /** Structural HP — bombarded from orbit and stormed on the ground (GDD §7.4);
   *  a destroyed building stops granting its defense bonus. */
  hp: z.number().nonnegative().default(0),
  /** Ground-defense bonus the building grants the garrison (0.01 = +1%); a
   *  fortress grants much more, and it grows with level. */
  defenseBonus: z.number().default(0.01),
  /** Overrides for levels 2..N (index 0 = level 2). maxLevel = 1 + length. */
  upgrades: z.array(BuildingLevelSchema).default([]),
  traits: z.array(z.string()).default([]),
  /** Victory-score worth of this building; the victory module multiplies it by
   *  the instance's level, so investing in upgrades raises (and losing the
   *  building lowers) the owner's score. */
  scoreValue: z.number().nonnegative().default(0),
  /** Radar reach (Euclidean distance, map units) the building projects from the world it sits on
   *  (0 = none). Drives signature detection in `visibleState`. */
  radarRange: z.number().nonnegative().default(0),
  /** Fraction of garrison max-HP restored per game hour (see BuildingLevelSchema). */
  healRate: z.number().nonnegative().default(0),
});

/**
 * A trigger -> effect rule: the universal vocabulary for traits, abilities and
 * dark events (docs/architecture.md §2.2). `params` is effect-specific and is
 * validated more tightly by the effect handler that consumes it.
 */
export const EffectRuleSchema = z.object({
  trigger: z.string(),
  effect: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  chance: z.number().min(0).max(1).default(1),
});

/**
 * A sector type — terrain of a map node (GDD §1: секторная структура). Carries
 * buffs/debuffs applied through hooks, never hard-coded in the core.
 */
export const SectorTypeDefSchema = z.object({
  name: z.string().optional(),
  /** Fleet speed change for a leg entering this sector, e.g. -0.25 = −25%. */
  speedBonus: z.number().default(0),
  /** Effective fleet HP change for battles in this sector, e.g. 0.1 = +10%. */
  hpBonus: z.number().default(0),
  /** Victory-score worth of controlling a node in this sector (terrain like an
   *  asteroid field is worth holding even without a habitable planet). */
  scoreValue: z.number().nonnegative().default(0),
});

/**
 * A planet type — the world's own nature (terran / barren / volcanic / oceanic /
 * gas giant …), distinct from the sector it sits in. Like a sector it carries
 * buffs/debuffs applied purely through hooks, never hard-coded in the core.
 */
export const PlanetTypeDefSchema = z.object({
  name: z.string().optional(),
  /** Multiplier on the world's production, e.g. 0.25 = +25% (rich), −0.25 = poor. */
  productionBonus: z.number().default(0),
  /** Per-resource production multipliers layered ON TOP of `productionBonus`, e.g.
   *  `{ metal: 0.3 }` = +30% metal only (a depleted dead world is metal-rich). Lets a
   *  type favour one resource without touching the others; applied by `planetTypeModule`. */
  productionByResource: z.record(z.string(), z.number()).default({}),
  /** Ground-defense edge for the owner's garrison: incoming assault damage is
   *  divided by (1 + this). Positive = defensible world, negative = exposed.
   *  Stacks with building defense. */
  defenseBonus: z.number().default(0),
  /** Victory-score worth of owning a world of this type (a developed terran
   *  world is worth more than a barren rock); added on top of the base. */
  scoreValue: z.number().nonnegative().default(0),
});

export const TechnologyUnlocksSchema = z.object({
  units: z.array(z.string()).default([]),
  buildings: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
});

export const TechnologyEffectsSchema = z.object({
  /** Multiplier on owned planetary production, e.g. 0.1 = +10%. */
  productionBonus: z.number().default(0),
  /** Multiplier on owned fleet movement speed, e.g. 0.15 = +15%. */
  fleetSpeedBonus: z.number().default(0),
  /** Multiplier on outgoing combat damage, e.g. 0.1 = +10%. */
  combatDamageBonus: z.number().default(0),
});

export const TechnologyDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tier: z.number().int().positive().default(1),
  cost: ResourceBagSchema.default({}),
  researchTimeHours: z.number().nonnegative().default(0),
  prerequisites: z.array(z.string()).default([]),
  unlocks: TechnologyUnlocksSchema.default({ units: [], buildings: [], abilities: [] }),
  effects: TechnologyEffectsSchema.default({
    productionBonus: 0,
    fleetSpeedBonus: 0,
    combatDamageBonus: 0,
  }),
});

/** How a province type draws on the map — resolved by kind id on the client, never
 *  stored on `Planet` (keeps `GameState` minimal). A missing field degrades to a
 *  neutral default, never a crash. */
export const SectorKindAppearanceSchema = z.object({
  /** Map accent fill / glyph tint (hex). */
  color: z.string().default('#46606e'),
  /** On-map callout. Falls back to the kind's `name`, then the kind id. */
  label: z.string().optional(),
  /** On-map marker family. */
  shape: z.enum(['city', 'junction', 'marker', 'station']).default('city'),
});

/** A sector **kind** = a **province type** (planet / asteroid / nebula / void_station
 *  / empty …): the single registry that decides whether a province can be owned, built
 *  on, what it can be built with, and how it looks on the map. Data-driven
 *  (map-roadmap.md M2.1) — add a province type by adding an entry, no code change.
 *  Absent / unknown kind degrades to the permissive defaults below. */
export const SectorKindDefSchema = z.object({
  name: z.string().optional(),
  /** Victory-score base for controlling a province of this kind (GDD §8.1). A
   *  habitable `planet` is the prize (50); every other province type — asteroid,
   *  nebula, a depleted dead world — is worth a flat 10. Data-driven so the whole
   *  scoring economy is balanced in content, not code. */
  scoreValue: z.number().nonnegative().default(10),
  /** Can this province be owned (captured)? Empty space cannot. */
  capturable: z.boolean().default(true),
  /** Can structures be raised here? */
  buildable: z.boolean().default(true),
  /** Does it have the orbital layer — can fleets station in orbit (cities, fortresses)? */
  orbit: z.boolean().default(true),
  /** Province-centric build roster: the building ids raisable on this province type.
   *  Absent/undefined = ANY building (the permissive default, so kind-less / roster-less
   *  worlds keep building as before). Explicit `[]` = no construction here (empty /
   *  debris). Enforced in the construction module (`E_WRONG_SECTOR`). */
  allowedBuildings: z.array(z.string()).optional(),
  /** Map appearance (color / label / shape); neutral default if absent. */
  appearance: SectorKindAppearanceSchema.default({ color: '#46606e', shape: 'city' }),
});

export const GameDataSchema = z.object({
  version: z.string(),
  resources: z.array(z.string()).min(1),
  units: z.record(z.string(), UnitDefSchema),
  factions: z.record(z.string(), FactionDefSchema),
  buildings: z.record(z.string(), BuildingDefSchema),
  events: z.record(z.string(), EffectRuleSchema),
  sectors: z.record(z.string(), SectorTypeDefSchema).default({}),
  sectorKinds: z.record(z.string(), SectorKindDefSchema).default({}),
  planetTypes: z.record(z.string(), PlanetTypeDefSchema).default({}),
  technologies: z.record(z.string(), TechnologyDefSchema).default({}),
});

export type ResourceBag = z.infer<typeof ResourceBagSchema>;
export type UnitStats = z.infer<typeof UnitStatsSchema>;
export type UnitDef = z.infer<typeof UnitDefSchema>;
export type FactionDef = z.infer<typeof FactionDefSchema>;
export type FactionLoadout = z.infer<typeof FactionLoadoutSchema>;
export type FactionPassives = z.infer<typeof FactionPassivesSchema>;
export type StartingStack = z.infer<typeof StartingStackSchema>;
export type BuildingDef = z.infer<typeof BuildingDefSchema>;
export type BuildingLevel = z.infer<typeof BuildingLevelSchema>;
export type EffectRule = z.infer<typeof EffectRuleSchema>;
export type SectorTypeDef = z.infer<typeof SectorTypeDefSchema>;
export type SectorKindDef = z.infer<typeof SectorKindDefSchema>;
export type SectorKindAppearance = z.infer<typeof SectorKindAppearanceSchema>;
export type PlanetTypeDef = z.infer<typeof PlanetTypeDefSchema>;
export type TechnologyUnlocks = z.infer<typeof TechnologyUnlocksSchema>;
export type TechnologyEffects = z.infer<typeof TechnologyEffectsSchema>;
export type TechnologyDef = z.infer<typeof TechnologyDefSchema>;
export type GameData = z.infer<typeof GameDataSchema>;

/** Stats of a building at a given level (1-based). Level 1 = the base fields;
 *  levels 2..N come from `upgrades`. Out-of-range levels fall back to level 1. */
export function buildingLevel(def: BuildingDef, level: number): BuildingLevel {
  if (level <= 1) {
    const { cost, buildTimeHours, produces, hp, defenseBonus, radarRange, healRate } = def;
    return { cost, buildTimeHours, produces, hp, defenseBonus, radarRange, healRate };
  }
  return def.upgrades[level - 2] ?? buildingLevel(def, 1);
}

/** Highest level this building can reach (level 1 plus its upgrades). */
export function buildingMaxLevel(def: BuildingDef): number {
  return 1 + def.upgrades.length;
}

/** Parses and validates a full game-data bundle, throwing on invalid input. */
export function parseGameData(raw: unknown): GameData {
  return GameDataSchema.parse(raw);
}

/** Non-throwing variant — returns a discriminated result. */
export function safeParseGameData(raw: unknown): z.ZodSafeParseResult<GameData> {
  return GameDataSchema.safeParse(raw);
}
