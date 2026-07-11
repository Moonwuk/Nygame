/**
 * Effects — the universal trait/effect rule engine (EFX-1, docs/architecture.md §2.2).
 *
 * Interprets `data.events` (`EffectRuleSchema`): each rule is a trigger → effect pair
 * that until now was only VALIDATED, never executed. This module is the executor —
 * a mechanic authored as data, not as code.
 *
 * Trigger vocabulary (a rule with an unknown trigger is inert — graceful degradation):
 *   - `planet_captured` — TRAIT-SCOPED: fires when a planet is captured by a force
 *     that carries the RULE ID as a unit trait (`traits: ["infect_planet"]` on a unit
 *     def turns that rule into the unit's trait — exactly the architecture-doc example).
 *     The capturing force is the `by` fleet of the `planet.captured` event, or, when
 *     the event carries no fleet (capture-on-arrival), every fleet of the new owner
 *     parked at the world.
 *   - `schedule` — GLOBAL dark event. Fires at every multiple of `params.cadenceHours`
 *     (match-time, compressed by `timeScale` like every other duration) crossed by a
 *     `time.advanced` span, for EACH active player independently — so `chance` reads
 *     as "each cadence, each player has this probability to be struck". The absolute
 *     cadence grid keeps it stateless and deterministic across offline catch-up.
 *
 * Effect vocabulary — resolved through the capability registry FIRST
 * (`effect.<name>`, the designed extension seam: a module can add or override an
 * effect without touching this interpreter), then the built-ins:
 *   - `add_trait { trait }`         — tag the trigger's planet with a trait.
 *   - `modify_resource { resource, amount }` — credit/debit the scoped player
 *     (clamped at 0; negative amounts are penalties).
 * An unknown effect (or malformed params) makes the rule inert, never a crash.
 *
 * Every applied rule emits `effect.applied { ruleId, effect, planetId?, playerId? }`
 * so hosts/UI can narrate dark events without knowing the vocabulary.
 */
import type { GameModule, HandlerContext } from '../kernel/module';
import type { EffectRule } from '../data/schemas';
import { hoursToMs } from '../action/types';
import { stacksHaveTrait } from '../data/traits';
import type { UnitStack } from '../state/gameState';

/** The scope a rule fired in — what the effect may act on. */
export interface EffectOccurrence {
  ruleId: string;
  rule: EffectRule;
  /** Planet the trigger centred on (present for planet-scoped triggers). */
  planetId?: string;
  /** Player the effect applies to (the capturer / the rolled player). */
  playerId?: string;
}

/** Contract for a capability-provided effect: `provideCapability('effect.<name>', impl)`. */
export type EffectImpl = (occurrence: EffectOccurrence, h: HandlerContext) => void;

/** Degenerate-cadence guard: at most this many grid crossings are honoured per rule
 *  per `time.advanced` span (a real dark event has an hours-scale cadence; a
 *  milliseconds-scale one must not spin the handler unbounded — fail-secure cap). */
const MAX_FIRINGS_PER_SPAN = 100;

const builtinEffects: Record<string, EffectImpl> = {
  add_trait(occurrence, h) {
    const trait = occurrence.rule.params['trait'];
    const planet = occurrence.planetId ? h.state.planets[occurrence.planetId] : undefined;
    if (typeof trait !== 'string' || trait.length === 0 || !planet) return;
    if (!planet.traits.includes(trait)) planet.traits.push(trait);
  },
  modify_resource(occurrence, h) {
    const resource = occurrence.rule.params['resource'];
    const amount = occurrence.rule.params['amount'];
    const player = occurrence.playerId ? h.state.players[occurrence.playerId] : undefined;
    if (typeof resource !== 'string' || resource.length === 0) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !player) return;
    const current = player.resources[resource] ?? 0;
    player.resources[resource] = Math.max(0, current + amount);
  },
};

/** Rules for one trigger, id-sorted — the rng draw order must not depend on JSON key order. */
function rulesFor(h: HandlerContext, trigger: string): Array<[string, EffectRule]> {
  return Object.entries(h.ctx.data.events)
    .filter(([, rule]) => rule.trigger === trigger)
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

function applyRule(h: HandlerContext, occurrence: EffectOccurrence): void {
  const impl =
    h.capability<EffectImpl>(`effect.${occurrence.rule.effect}`) ??
    builtinEffects[occurrence.rule.effect];
  if (!impl) return; // unknown effect → the rule is inert, never a crash
  impl(occurrence, h);
  h.emit('effect.applied', {
    ruleId: occurrence.ruleId,
    effect: occurrence.rule.effect,
    ...(occurrence.planetId !== undefined ? { planetId: occurrence.planetId } : {}),
    ...(occurrence.playerId !== undefined ? { playerId: occurrence.playerId } : {}),
  });
}

/** The units of the capturing force: the event's `by` fleet, or (capture-on-arrival
 *  emits no fleet id) every fleet of the new owner parked at the captured world. */
function capturingStacks(
  h: HandlerContext,
  payload: { planetId: string; owner: string; by?: unknown },
): UnitStack[] {
  if (typeof payload.by === 'string') {
    return h.state.fleets[payload.by]?.units ?? [];
  }
  return Object.values(h.state.fleets)
    .filter((f) => f.owner === payload.owner && f.location === payload.planetId)
    .flatMap((f) => f.units);
}

export const effectsModule: GameModule = {
  id: 'effects',
  version: '0.1.0',
  setup(api) {
    api.on('planet.captured', (event, h) => {
      const p = event.payload as { planetId?: unknown; owner?: unknown; by?: unknown };
      if (typeof p?.planetId !== 'string' || typeof p?.owner !== 'string') return;
      const payload = { planetId: p.planetId, owner: p.owner, by: p.by };
      let stacks: UnitStack[] | null = null; // resolved lazily — most captures carry no rule traits
      for (const [ruleId, rule] of rulesFor(h, 'planet_captured')) {
        stacks ??= capturingStacks(h, payload);
        if (!stacksHaveTrait(h.ctx.data, stacks, ruleId)) continue; // trait-scoped
        if (!h.rng.chance(rule.chance)) continue;
        applyRule(h, { ruleId, rule, planetId: payload.planetId, playerId: payload.owner });
      }
    });

    api.on('time.advanced', (event, h) => {
      const span = event.payload as { from?: unknown; to?: unknown };
      if (typeof span?.from !== 'number' || typeof span?.to !== 'number') return;
      if (!(span.to > span.from)) return;
      const rules = rulesFor(h, 'schedule');
      if (rules.length === 0) return;
      const players = Object.keys(h.state.players)
        .sort()
        .filter((id) => h.state.players[id]?.status === 'active');
      for (const [ruleId, rule] of rules) {
        const cadence = rule.params['cadenceHours'];
        if (typeof cadence !== 'number' || !(cadence > 0)) continue; // no cadence → inert
        const stepMs = hoursToMs(h.ctx, cadence);
        if (!(stepMs > 0)) continue;
        let fired = 0;
        for (
          let k = Math.floor(span.from / stepMs) + 1;
          k * stepMs <= span.to && fired < MAX_FIRINGS_PER_SPAN;
          k += 1, fired += 1
        ) {
          for (const playerId of players) {
            if (!h.rng.chance(rule.chance)) continue;
            applyRule(h, { ruleId, rule, playerId });
          }
        }
      }
    });
  },
};
