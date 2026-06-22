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
    /** Firing range — only meaningful for artillery units (reserved). */
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
});

export const FactionDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
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
  /** Ground-defense edge for the owner's garrison: incoming assault damage is
   *  divided by (1 + this). Positive = defensible world, negative = exposed.
   *  Stacks with building defense. */
  defenseBonus: z.number().default(0),
});

export const GameDataSchema = z.object({
  version: z.string(),
  resources: z.array(z.string()).min(1),
  units: z.record(z.string(), UnitDefSchema),
  factions: z.record(z.string(), FactionDefSchema),
  buildings: z.record(z.string(), BuildingDefSchema),
  events: z.record(z.string(), EffectRuleSchema),
  sectors: z.record(z.string(), SectorTypeDefSchema).default({}),
  planetTypes: z.record(z.string(), PlanetTypeDefSchema).default({}),
});

export type ResourceBag = z.infer<typeof ResourceBagSchema>;
export type UnitStats = z.infer<typeof UnitStatsSchema>;
export type UnitDef = z.infer<typeof UnitDefSchema>;
export type FactionDef = z.infer<typeof FactionDefSchema>;
export type BuildingDef = z.infer<typeof BuildingDefSchema>;
export type BuildingLevel = z.infer<typeof BuildingLevelSchema>;
export type EffectRule = z.infer<typeof EffectRuleSchema>;
export type SectorTypeDef = z.infer<typeof SectorTypeDefSchema>;
export type PlanetTypeDef = z.infer<typeof PlanetTypeDefSchema>;
export type GameData = z.infer<typeof GameDataSchema>;

/** Stats of a building at a given level (1-based). Level 1 = the base fields;
 *  levels 2..N come from `upgrades`. Out-of-range levels fall back to level 1. */
export function buildingLevel(def: BuildingDef, level: number): BuildingLevel {
  if (level <= 1) {
    const { cost, buildTimeHours, produces, hp, defenseBonus } = def;
    return { cost, buildTimeHours, produces, hp, defenseBonus };
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
