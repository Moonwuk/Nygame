import { z } from 'zod';

/**
 * Map-as-content (map-roadmap.md M1.1). A **map** is a data-driven match setup:
 * a graph of **sectors** (the atomic unit — a capture point with paths to its
 * neighbours; a planet is just a smaller sector) plus the starting players and
 * fleets. Validated here before it ever reaches the core (OWASP A05/A08), exactly
 * like the game-content bundle.
 *
 * A sector maps almost 1:1 onto the runtime `Planet` (sector) state; the loader
 * `buildStateFromMap` turns this into a `GameState`. The `paths` edge list is the
 * configurable adjacency — see `validateMatchMap` for the neighbour-only rule.
 */

const PositionSchema = z.object({ x: z.number(), y: z.number() });

const MapUnitStackSchema = z.object({
  unit: z.string(),
  count: z.number().int().positive(),
});

const MapBuildingSchema = z.object({
  type: z.string(),
  level: z.number().int().positive().default(1),
});

export const MapSectorSchema = z.object({
  position: PositionSchema,
  /** Sector kind (planet / asteroid / nebula / empty). Carried for authoring;
   *  the core gains a first-class kind field + registry in M2.1 (capturable /
   *  buildable / orbit flags). Until then the loader does not project it. */
  kind: z.string().default('planet'),
  /** Terrain id → resolved against game data `sectors` (speed / HP modifiers). */
  terrain: z.string().optional(),
  /** World nature id → game data `planetTypes` (production / defense), if a planet. */
  planetType: z.string().optional(),
  /** Starting owner (a declared player id); null / absent = neutral. */
  owner: z.string().nullable().default(null),
  buildings: z.array(MapBuildingSchema).default([]),
  garrison: z.array(MapUnitStackSchema).default([]),
});

const MapPlayerSchema = z.object({
  name: z.string(),
  faction: z.string(),
  resources: z.record(z.string(), z.number()).default({}),
});

const MapFleetSchema = z.object({
  owner: z.string(),
  location: z.string(),
  units: z.array(MapUnitStackSchema).default([]),
  landing: z.array(MapUnitStackSchema).default([]),
});

export const MatchMapSchema = z.object({
  id: z.string(),
  seed: z.string(),
  /** World time the scenario starts at (default 0). */
  time: z.number().default(0),
  sectors: z.record(z.string(), MapSectorSchema),
  /** Undirected adjacency: each pair is a two-way path. Order within a pair is
   *  irrelevant; symmetry, no self-loops and the neighbour-only rule are enforced
   *  in `validateMatchMap`. */
  paths: z.array(z.tuple([z.string(), z.string()])).default([]),
  players: z.record(z.string(), MapPlayerSchema).default({}),
  fleets: z.record(z.string(), MapFleetSchema).default({}),
});

export type MatchMap = z.infer<typeof MatchMapSchema>;
export type MapSector = z.infer<typeof MapSectorSchema>;

/** Strict parse — throws on a malformed map (use at trusted boot). */
export function parseMatchMap(raw: unknown): MatchMap {
  return MatchMapSchema.parse(raw);
}

/** Non-throwing parse — for validating untrusted input before use (A05/A08). */
export function safeParseMatchMap(raw: unknown): z.ZodSafeParseResult<MatchMap> {
  return MatchMapSchema.safeParse(raw);
}
