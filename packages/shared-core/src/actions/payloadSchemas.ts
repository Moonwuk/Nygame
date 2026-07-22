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
  // orbital.ts
  'fleet.orbit': z.object({ fleetId: id, orbit: z.literal('near') }), // a single orbit (GDD §7.4)
  'fleet.bombard': z.object({ fleetId: id, on: z.boolean() }),
  // artillery.ts — focus-fire: a hostile fleet id, or null/absent to resume auto-targeting
  'fleet.barrage': z.object({ fleetId: id, targetId: id.nullish() }),
  'fleet.barrageMode': z.object({
    fleetId: id,
    mode: z.enum(['passive', 'return', 'standard', 'aggressive']),
  }),
  // combat.ts (melee battles)
  'fleet.assault': z.object({ fleetId: id }),
  'fleet.retreat': z.object({ fleetId: id }),
  // army.ts
  'army.load': z.object({ fleetId: id, unit: id, count: count.optional() }),
  'army.unload': z.object({ fleetId: id, unit: id, count: count.optional() }),
  // hero.ts
  'hero.move': z.object({ to: id }),
  'hero.path.create': z.object({ to: id }),
  'planet.annihilate': z.object({ planetId: id }),
  'hero.ability': z.object({ heroId: id, abilityId: id, target: id.optional() }),
  'hero.spawn': z.object({ heroId: id, at: id }),
  'hero.skill.unlock': z.object({ heroId: id, node: id }),
  'hero.fit': z.object({ heroId: id, fitting: id }),
  // station.ts
  'station.deploy': z.object({ planetId: id }),
  // construction.ts
  'building.construct': z.object({ planetId: id, building: id }),
  'building.upgrade': z.object({ planetId: id, building: id }),
  'unit.build': z.object({
    planetId: id,
    unit: id,
    count: count.optional(),
    // The ship loadout chosen in the «Верфь» constructor — validated/priced/stamped by
    // the reducer (validateLoadout); the schema only bounds well-formedness.
    modules: z.array(id).max(32).optional(),
  }),
  // construction.ts — cancel an ACTIVE order (refund the unbuilt share, pause it) by
  // the `scheduled` event's `seq`; resume a paused one (pay the remainder, continue
  // from the same progress) by its `PausedConstructionSite.id` (= the original `seq`).
  'construction.cancel': z.object({ planetId: id, seq: z.number().int().nonnegative() }),
  'construction.resume': z.object({ planetId: id, id: z.number().int().nonnegative() }),
  // technology.ts
  'technology.research': z.object({ technology: id }),
  // SES-3: sink the premium resource into one ACTIVE research (diminishing returns)
  'technology.boost': z.object({ technology: id }),
  // espionage.ts — steal a time-boxed intel window; `planetId` only with kind 'planet'
  'espionage.spy': z
    .object({
      target: id,
      kind: z.enum(['treasury', 'planet', 'fleets']),
      planetId: id.optional(),
    })
    .refine((v) => v.kind !== 'planet' || v.planetId !== undefined, {
      message: "kind 'planet' needs a planetId",
    }),
  // market.ts — amounts are plain positive numbers (resources accrue continuously,
  // so fractional amounts are legal); price is a non-negative unit price.
  'market.list': z.object({
    // `side` is the prototype's two-sided order book (sell lot / buy bid); the core
    // marketModule ignores it (sell-only) — optional so ONE schema serves both hosts.
    side: z.enum(['sell', 'buy']).optional(),
    resource: id,
    amount: z.number().finite().positive(),
    price: z.number().finite().nonnegative(),
  }),
  'market.buy': z.object({ orderId: id, amount: z.number().finite().positive() }),
  // The prototype's fill action (take up to `amount` from an open lot).
  'market.take': z.object({ id: id, amount: z.number().finite().positive().optional() }),
  // The core cancels by `orderId`; the prototype's book cancels by `id` — one schema
  // serves both hosts (the reducer that owns the action reads its own key).
  'market.cancel': z.union([z.object({ orderId: id }), z.object({ id: id })]),
  // diplomacy.ts — one action for the whole protocol (D2+D3): escalation applies
  // at once, a friendlier declaration records/commits a mutual-consent offer
  'diplomacy.declare': z.object({
    target: id,
    stance: z.enum(['war', 'peace', 'pact', 'alliance']),
  }),
  // --- prototype-host actions (the netserver runs the prototype's kernel) -----------
  // fleetLaunch / squadron ops (prototype game.ts modules)
  'fleet.launch': z.object({ planetId: id }),
  'fleet.merge': z.object({ from: id, into: id }),
  'fleet.split': z.object({
    fleetId: id,
    take: z
      .array(z.object({ unit: id, count }))
      .min(1)
      .max(32),
  }),
  'fleet.engage': z.object({ fleetId: id, targetId: id }),
  // capital (hero respawn / re-fit anchor)
  'capital.designate': z.object({ planetId: id }),
  // ground divisions (formation system). `officer: true` mobilises a locked officer
  // premade instead of the player's own template (the ONLY way an officer arrives —
  // there is no runtime attach action). Renaming touches CUSTOM templates only.
  'division.mobilize': z.object({
    planetId: id,
    template: z.number().int().nonnegative(),
    officer: z.boolean().optional(),
  }),
  'division.template': z.object({
    template: z.number().int().nonnegative(),
    slot: z.number().int().nonnegative(),
    unit: z.string().nullable(),
  }),
  'division.rename': z.object({
    template: z.number().int().nonnegative(),
    name: z.string().min(1),
  }),
  'division.load': z.object({ divisionId: id, fleetId: id }),
  'division.unload': z.object({ divisionId: id }),
  // steward («Хранитель») — postures are data-driven; the module gates the value
  'steward.delegate': z.object({ posture: z.string().min(1), until: z.number().finite() }),
  'steward.recall': z.object({}),
  // Hold point (ST-2.1) — a player-designated standing order; the module gates
  // ownership/cap. (`steward.report` stays deliberately ABSENT: the SITREP stamp
  // is the SERVER driver's, like `patrol.stamp` — a client must not forge it.)
  'steward.holdpoint': z.object({ planetId: id, on: z.boolean() }),
  // standing orders (CC-2 auto-storm / CC-4 дежурный вылет) — client toggles only.
  // `patrol.stamp` is deliberately ABSENT: it is the SERVER driver's runtime stamp
  // (submitAction path, gate-exempt); a client stamping its own sortie would refill
  // its fuel — the gate must keep rejecting it from the wire.
  'order.auto': z.object({ fleetId: id, on: z.boolean() }),
  'order.scramble': z.object({ fleetId: id, on: z.boolean() }),
  // BOOST-1 форс-марш: +50% speed for hull wear while in transit — client toggle.
  'fleet.forcemarch': z.object({ fleetId: id, on: z.boolean() }),
  // Платный мгновенный ремонт корпуса (карточка флота): цена выводится из state
  // на сервере — клиент шлёт только намерение.
  'fleet.instantRepair': z.object({ fleetId: id }),
  // ECON-3: экспресс-ремонт за metal у СВОЕГО дока (shipRepair > 0) — цена
  // тоже серверная, клиент шлёт намерение.
  'fleet.repair': z.object({ fleetId: id }),
  // CC-1 order chain — the client atomically sets/cancels ([]) a fleet's whole queued
  // plan; the module re-validates against live state (known worlds, ownership).
  // `chain.stamp` is deliberately ABSENT: it is the SERVER driver's runtime stamp
  // (consumed head / armed wait deadline) — a client must not advance its own chain.
  'order.chain': z.object({
    fleetId: id,
    steps: z
      .array(
        z.union([
          z.object({ kind: z.literal('move'), to: id }),
          z.object({ kind: z.literal('wait'), hours: z.number().positive().finite() }),
          z.object({ kind: z.literal('assault') }),
          z.object({ kind: z.literal('barrage'), target: id.nullable() }),
          // fire window: focus standoff fire for N game-hours, then cease and move on
          z.object({
            kind: z.literal('strike'),
            target: id.nullable(),
            hours: z.number().positive().finite(),
          }),
        ]),
      )
      .max(8),
  }),
};

/** True if `payload` is a valid payload for the client-submittable action `type`. A type
 *  with no schema (an internal scheduled action, or an unknown type) returns false — the
 *  gate then rejects it, so a client can only submit the actions it is meant to. */
export function isValidActionPayload(type: string, payload: unknown): boolean {
  const schema = actionPayloadSchemas[type];
  if (!schema) return false;
  return schema.safeParse(payload).success;
}
