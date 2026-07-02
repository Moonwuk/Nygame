import { z } from 'zod';

import { ResourceBagSchema } from './schemas';

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
  /** Province type (planet / asteroid / nebula / void_station / empty …). Projected to
   *  `Planet.kind` by the loader and resolved against game data `sectorKinds` —
   *  capturable / buildable / orbit + the build roster + map appearance. */
  kind: z.string().default('planet'),
  /** Terrain id → resolved against game data `sectors` (speed / HP modifiers). */
  terrain: z.string().optional(),
  /** World nature id → game data `planetTypes` (production / defense), if a planet. */
  planetType: z.string().optional(),
  /** Relative size / weight (default 1): how much territory the sector claims —
   *  borders with neighbours sit proportionally to size, so resizing one shifts
   *  the neighbours' borders evenly. */
  size: z.number().positive().default(1),
  /** Starting owner — a declared player id OR a slot id (a slot is resolved to a
   *  concrete player at load by `buildStateFromMap`); null / absent = neutral. */
  owner: z.string().nullable().default(null),
  buildings: z.array(MapBuildingSchema).default([]),
  garrison: z.array(MapUnitStackSchema).default([]),
});

const MapPlayerSchema = z.object({
  name: z.string(),
  faction: z.string(),
  resources: ResourceBagSchema.default({}),
  /** AI-driven seat (bot). Rules may key off it (e.g. bots are not invitable to
   *  an alliance). Default: human. */
  ai: z.boolean().default(false),
});

/** A player id. `|` is barred: it is the diplomacy pair-key separator — an id
 *  containing it would make `pairKey('a|b','c')` collide with `pairKey('a','b|c')`
 *  and break the participant check that fogs diplomatic offers. */
const playerIdSchema = z.string().min(1).regex(/^[^|]+$/, 'player id must not contain "|"');

const MapFleetSchema = z.object({
  owner: z.string(),
  location: z.string(),
  units: z.array(MapUnitStackSchema).default([]),
  landing: z.array(MapUnitStackSchema).default([]),
});

/** How a slot's home is placed at session creation (read by the server
 *  orchestrator; the deterministic loader works on already-resolved ownership).
 *  `fixed` = the sectors this slot owns in the map; `choice` = player-picked from
 *  candidates; `random` = randomly assigned. */
export const SpawnPolicySchema = z.enum(['fixed', 'choice', 'random']);

/**
 * A team-aware **start slot** (`corporation-wars.md` §4): a start position
 * decoupled from any concrete player. AvA / matchmade maps declare slots instead
 * of baking in specific players; the orchestrator seats real players into slots at
 * session creation (`buildStateFromMap`'s `slots` assignments). A sector or fleet
 * names a slot id as its `owner`.
 */
export const MapSlotSchema = z.object({
  /** Side this slot fights for (e.g. 'A' / 'B'); a free-for-all map gives each slot its own team. */
  team: z.string(),
  /** Home-placement policy at session creation (orchestrator-read). */
  spawn: SpawnPolicySchema.default('fixed'),
  /** Starting resources granted to whoever fills the slot (a symmetric start kit). */
  resources: ResourceBagSchema.default({}),
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
  players: z.record(playerIdSchema, MapPlayerSchema).default({}),
  /** Team-aware start slots (`corporation-wars.md`): start positions decoupled from
   *  concrete players. A sector/fleet `owner` may name a slot id; `buildStateFromMap`
   *  seats real players into slots via its `slots` assignments. */
  slots: z.record(z.string(), MapSlotSchema).default({}),
  fleets: z.record(z.string(), MapFleetSchema).default({}),
});

export type MatchMap = z.infer<typeof MatchMapSchema>;
export type MapSector = z.infer<typeof MapSectorSchema>;
export type MapSlot = z.infer<typeof MapSlotSchema>;
export type SpawnPolicy = z.infer<typeof SpawnPolicySchema>;

/** Strict parse — throws on a malformed map (use at trusted boot). */
export function parseMatchMap(raw: unknown): MatchMap {
  return MatchMapSchema.parse(raw);
}

/** Non-throwing parse — for validating untrusted input before use (A05/A08). */
export function safeParseMatchMap(raw: unknown): z.ZodSafeParseResult<MatchMap> {
  return MatchMapSchema.safeParse(raw);
}
