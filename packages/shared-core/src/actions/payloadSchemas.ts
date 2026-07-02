import { z } from 'zod';

/**
 * SV-1.2 — per-action-type payload schemas, enforced at the action-layer gate BEFORE the
 * reducer, so a well-formed envelope carrying a garbage payload is rejected up front
 * (CLAUDE.md invariant #5: "payload already validated by the action layer"). These mirror
 * exactly what each module handler reads off `action.payload`; they are intentionally not
 * stricter than the handlers (unknown extra keys are ignored, as the handlers ignore them),
 * only well-formedness of the fields the reducer actually consumes.
 *
 * The map is game knowledge, so it lives in shared-core (next to the modules that own the
 * actions); the generic gate stays game-agnostic and receives `isValidActionPayload` as an
 * injected validator. A type with no entry is NOT client-submittable (internal scheduled
 * actions like `arrive`, or an unknown type) — `isValidActionPayload` returns false for it.
 */

const id = z.string().min(1); // a planet / fleet / unit / building / technology id
const count = z.number().int().positive().safe(); // a unit count: positive safe integer

export const actionPayloadSchemas: Record<string, z.ZodType> = {
  // movement.ts
  'fleet.move': z
    .object({
      fleetId: id,
      to: id.optional(),
      toEdge: z.object({ from: id, to: id, t: z.number().finite() }).optional(),
    })
    .refine((p) => p.to !== undefined || p.toEdge !== undefined, {
      message: 'fleet.move needs a `to` node or a `toEdge`',
    }),
  'fleet.stop': z.object({ fleetId: id }),
  // combat.ts
  'fleet.orbit': z.object({ fleetId: id, orbit: z.literal('near') }), // a single orbit (GDD §7.4)
  'fleet.assault': z.object({ fleetId: id }),
  'fleet.bombard': z.object({ fleetId: id, on: z.boolean() }),
  // artillery focus-fire: a hostile fleet id, or null/absent to resume auto-targeting
  'fleet.barrage': z.object({ fleetId: id, targetId: id.nullish() }),
  'fleet.barrageMode': z.object({
    fleetId: id,
    mode: z.enum(['passive', 'return', 'standard', 'aggressive']),
  }),
  'fleet.retreat': z.object({ fleetId: id }),
  // army.ts
  'army.load': z.object({ fleetId: id, unit: id, count: count.optional() }),
  'army.unload': z.object({ fleetId: id, unit: id, count: count.optional() }),
  // hero.ts
  'hero.move': z.object({ to: id }),
  'hero.path.create': z.object({ to: id }),
  'planet.annihilate': z.object({ planetId: id }),
  // station.ts
  'station.deploy': z.object({ planetId: id }),
  // construction.ts
  'building.construct': z.object({ planetId: id, building: id }),
  'building.upgrade': z.object({ planetId: id, building: id }),
  'unit.build': z.object({ planetId: id, unit: id, count: count.optional() }),
  // technology.ts
  'technology.research': z.object({ technology: id }),
  // market.ts — amounts are plain positive numbers (resources accrue continuously,
  // so fractional amounts are legal); price is a non-negative unit price.
  'market.list': z.object({
    resource: id,
    amount: z.number().finite().positive(),
    price: z.number().finite().nonnegative(),
  }),
  'market.buy': z.object({ orderId: id, amount: z.number().finite().positive() }),
  'market.cancel': z.object({ orderId: id }),
};

/** True if `payload` is a valid payload for the client-submittable action `type`. A type
 *  with no schema (an internal scheduled action, or an unknown type) returns false — the
 *  gate then rejects it, so a client can only submit the actions it is meant to. */
export function isValidActionPayload(type: string, payload: unknown): boolean {
  const schema = actionPayloadSchemas[type];
  if (!schema) return false;
  return schema.safeParse(payload).success;
}
