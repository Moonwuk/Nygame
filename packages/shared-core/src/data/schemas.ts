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
    attack: z.number(),
    defense: z.number(),
    speed: z.number(),
    /** Hit points per ship — aggregate fleet HP = Σ count × hp (GDD §7.1). */
    hp: z.number().nonnegative().default(1),
  })
  .catchall(z.number());

export const UnitDefSchema = z.object({
  faction: z.string(),
  stats: UnitStatsSchema,
  /** Damage-receiving line (GDD §7.2). `artillery` trait overrides this. */
  line: z.enum(['front', 'mid', 'rear']).default('front'),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
  cost: ResourceBagSchema.default({}),
});

export const FactionDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
});

export const BuildingDefSchema = z.object({
  name: z.string(),
  cost: ResourceBagSchema.default({}),
  buildTimeHours: z.number().nonnegative().default(0),
  produces: ResourceBagSchema.default({}),
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

export const GameDataSchema = z.object({
  version: z.string(),
  resources: z.array(z.string()).min(1),
  units: z.record(z.string(), UnitDefSchema),
  factions: z.record(z.string(), FactionDefSchema),
  buildings: z.record(z.string(), BuildingDefSchema),
  events: z.record(z.string(), EffectRuleSchema),
});

export type ResourceBag = z.infer<typeof ResourceBagSchema>;
export type UnitStats = z.infer<typeof UnitStatsSchema>;
export type UnitDef = z.infer<typeof UnitDefSchema>;
export type FactionDef = z.infer<typeof FactionDefSchema>;
export type BuildingDef = z.infer<typeof BuildingDefSchema>;
export type EffectRule = z.infer<typeof EffectRuleSchema>;
export type GameData = z.infer<typeof GameDataSchema>;

/** Parses and validates a full game-data bundle, throwing on invalid input. */
export function parseGameData(raw: unknown): GameData {
  return GameDataSchema.parse(raw);
}

/** Non-throwing variant — returns a discriminated result. */
export function safeParseGameData(raw: unknown): z.ZodSafeParseResult<GameData> {
  return GameDataSchema.safeParse(raw);
}
