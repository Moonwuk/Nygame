import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createKernel, Kernel } from './kernel';
import type { GameModule } from './module';
import { deepClone, deepFreeze } from '../util/clone';
import { hashState } from '../state/hash';
import type { Action, AdvanceFailure, Context, DomainEvent } from '../action/types';
import type { GameState, ScheduledEvent } from '../state/gameState';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';
import { constructionModule } from '../modules/construction';
import { marketModule } from '../modules/market';
import { arbSeed, fixtureData, makeFixtureState } from '../testkit/arbitraries';

/**
 * FUZZ-3 (playtest-hardening / secure-sdlc SD-7.3): property-based fuzz of
 * `advanceTo` — the real-time timeline — over arbitrary targets and arbitrary
 * PARTITIONS of the same interval.
 *
 * The partition properties encode the RPL-1 finding precisely:
 * - On a kernel with NO `time.advanced` accruers (movement/combat/sector/market
 *   — every effect is a scheduled event), the timeline is partition-INVARIANT
 *   **bit-exactly**: advanceTo(t₁)→t₂ ≡ advanceTo(t₂) by `hashState`, and the
 *   domain-event stream is identical. The event machinery itself owes this.
 * - On the FULL stack (economy accrues `rate × Δt` per span) the engine only
 *   promises coarse ≈ fine: the discrete skeleton (everything but accrued
 *   resource bags) stays bit-exact, resources land within IEEE-754 float dust.
 *   That gap is WHY advance boundaries are part of the replay log (replay.ts).
 *   Players get deep credits here so the dust cannot graze the brownout
 *   threshold — a knife-edge flip between two legal partitions is by-design
 *   (coarse ≈ fine), not what this property hunts.
 *
 * Plus the fail-secure/fail-open contracts: spans contiguous over the whole
 * interval, `time === ctx.now` when not partial, dead-lettered module bombs
 * never wedge the clock or leak details (A10), frozen inputs never mutate.
 */

const HOUR = 3_600_000;
const data = deepFreeze(fixtureData);
const ctx = (now: number): Context => ({ now, data });

// A module whose scheduled event always throws — the roadmap's "модуль-бомба".
const bombModule: GameModule = {
  id: 'fuzz-bomb',
  version: '1.0.0',
  setup(api) {
    api.on('fuzz.boom', () => {
      throw new Error('secret internal detail that must never leak');
    });
  },
};

const DISCRETE = [movementModule, combatModule, sectorModule, marketModule];
const FULL = [economyModule, ...DISCRETE, constructionModule];
const DISCK = createKernel(DISCRETE);
const FULLK = createKernel(FULL);
const BOMBK = createKernel([...FULL, bombModule]);

const move = (playerId: string, fleetId: string, to: string, n: number): Action => ({
  id: `fz3:${playerId}:${n}`,
  type: 'fleet.move',
  playerId,
  payload: { fleetId, to },
  issuedAt: 0,
});

/** Fixture state with both fleets ordered onto NEXUS at t=0 — arrivals, a clash
 *  and capture all live on the schedule, so advancing genuinely fires events. */
function seeded(kernel: Kernel, seed: string, opts?: { richCredits?: boolean }): GameState {
  let state = makeFixtureState(seed);
  if (opts?.richCredits) {
    state = {
      ...state,
      players: Object.fromEntries(
        Object.entries(state.players).map(([id, p]) => [
          id,
          { ...p, resources: { ...p.resources, credits: 1_000_000 } },
        ]),
      ),
    };
  }
  for (const order of [move('p1', 'BLUE', 'NEXUS', 1), move('p2', 'RED', 'NEXUS', 2)]) {
    const r = kernel.applyAction(state, order, ctx(0));
    if (r.ok) state = r.state;
  }
  return state;
}

/** The server loop: chase `target` through partial rounds, refusing to spin. */
function advanceThrough(
  kernel: Kernel,
  state: GameState,
  target: number,
): { state: GameState; events: DomainEvent[]; failures: AdvanceFailure[] } {
  let s = state;
  const events: DomainEvent[] = [];
  const failures: AdvanceFailure[] = [];
  while (s.time < target) {
    const before = s.time;
    const r = kernel.advanceTo(s, ctx(target));
    if (!r.ok) throw new Error(`advance failed: ${r.code}`);
    s = r.state;
    events.push(...r.events);
    failures.push(...r.failures);
    if (!r.partial) break;
    if (s.time === before) throw new Error(`advance stuck at ${s.time}`);
  }
  return { state: s, events, failures };
}

const spansOf = (events: DomainEvent[]): Array<{ from: number; to: number }> =>
  events
    .filter((e) => e.type === 'time.advanced')
    .map((e) => e.payload as { from: number; to: number });
const nonSpan = (events: DomainEvent[]): DomainEvent[] =>
  events.filter((e) => e.type !== 'time.advanced');

/** Blank out the span-accrued resource bags — what remains is the discrete
 *  skeleton that must be partition-invariant bit-exactly even on the full stack. */
function stripAccrual(state: GameState): GameState {
  const s = deepClone(state);
  for (const p of Object.values(s.players)) p.resources = {};
  for (const planet of Object.values(s.planets)) planet.resources = {};
  return s;
}

const arbTarget = fc.integer({ min: 60_000, max: 72 * HOUR });
const arbCutFractions = fc.array(fc.double({ min: 0.01, max: 0.99, noNaN: true }), {
  maxLength: 4,
});
/** Distinct interior cut points of (0, target), sorted ascending. */
const cutsOf = (target: number, fractions: number[]): number[] =>
  [...new Set(fractions.map((f) => Math.round(target * f)))]
    .filter((t) => t > 0 && t < target)
    .sort((a, b) => a - b);

describe('advanceTo under fuzz (FUZZ-3)', () => {
  it('sanity: the seeded fixture is alive — fleets march, events fire, the clock lands on target', () => {
    const state = seeded(FULLK, 'sanity');
    expect(state.scheduled.length).toBeGreaterThan(0);
    const r = advanceThrough(FULLK, deepFreeze(state), 48 * HOUR);
    expect(r.state.time).toBe(48 * HOUR);
    expect(nonSpan(r.events).length).toBeGreaterThan(0);
    expect(r.state.fleets.BLUE?.location === 'HOME').toBe(false);
  });

  it('spans are contiguous and cover [state.time, committed time] exactly; time === ctx.now when not partial', () => {
    fc.assert(
      fc.property(arbSeed, arbTarget, (seed, target) => {
        const state = deepFreeze(seeded(FULLK, seed));
        const r = FULLK.advanceTo(state, ctx(target));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        if (!r.partial) expect(r.state.time).toBe(target);
        let cursor = state.time;
        for (const span of spansOf(r.events)) {
          expect(span.from).toBe(cursor); // no hole, no overlap
          expect(span.to).toBeGreaterThanOrEqual(span.from);
          cursor = span.to;
        }
        expect(cursor).toBe(r.state.time); // full coverage, no overshoot
      }),
      { numRuns: 80 },
    );
  });

  it('discrete kernel: an arbitrary partition of the interval is BIT-EXACT equivalent to one jump', () => {
    fc.assert(
      fc.property(arbSeed, arbTarget, arbCutFractions, (seed, target, fractions) => {
        const state = seeded(DISCK, seed);
        const direct = advanceThrough(DISCK, deepFreeze(state), target);
        let s = deepClone(state);
        const events: DomainEvent[] = [];
        const failures: AdvanceFailure[] = [];
        for (const t of [...cutsOf(target, fractions), target]) {
          const step = advanceThrough(DISCK, s, t);
          s = step.state;
          events.push(...step.events);
          failures.push(...step.failures);
        }
        expect(hashState(s)).toBe(hashState(direct.state));
        expect(nonSpan(events)).toEqual(nonSpan(direct.events));
        expect(failures).toEqual(direct.failures);
      }),
      { numRuns: 60 },
    );
  });

  it('full stack: partitioning shifts accrued resources by float dust ONLY — the discrete skeleton stays bit-exact', () => {
    fc.assert(
      fc.property(arbSeed, arbTarget, arbCutFractions, (seed, target, fractions) => {
        const state = seeded(FULLK, seed, { richCredits: true });
        const direct = advanceThrough(FULLK, deepFreeze(state), target);
        let s = deepClone(state);
        for (const t of [...cutsOf(target, fractions), target]) {
          s = advanceThrough(FULLK, s, t).state;
        }
        expect(hashState(stripAccrual(s))).toBe(hashState(stripAccrual(direct.state)));
        for (const pid of Object.keys(direct.state.players)) {
          const a = direct.state.players[pid]?.resources ?? {};
          const b = s.players[pid]?.resources ?? {};
          for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            expect(b[k] ?? 0).toBeCloseTo(a[k] ?? 0, 6); // ≈, NOT bit-equal — by design
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('module bomb: every due bomb is dead-lettered (E_INTERNAL, no detail leak), the clock never wedges', () => {
    fc.assert(
      fc.property(
        arbSeed,
        arbTarget,
        fc.array(fc.integer({ min: 1, max: 72 * HOUR }), { minLength: 1, maxLength: 6 }),
        (seed, target, times) => {
          const base = seeded(BOMBK, seed);
          const bombs: ScheduledEvent[] = [...times]
            .sort((a, b) => a - b)
            .map((at, i) => ({
              id: `bomb:${i}`,
              at,
              type: 'fuzz.boom',
              payload: null,
              seq: base.scheduleSeq + i,
            }));
          const state: GameState = {
            ...base,
            scheduled: [...base.scheduled, ...bombs],
            scheduleSeq: base.scheduleSeq + bombs.length,
          };
          const r = advanceThrough(BOMBK, deepFreeze(state), target);
          expect(r.state.time).toBe(target); // dead-letters never stall the world
          const due = bombs.filter((b) => b.at <= target);
          // toEqual pins BOTH: every due bomb dead-lettered in (at, seq) order AND
          // zero failures from the legitimate modules around them.
          expect(r.failures).toEqual(
            due.map((b) => ({ at: b.at, type: 'fuzz.boom', code: 'E_INTERNAL' })),
          );
          expect(JSON.stringify(r.failures)).not.toContain('secret'); // A10
          const left = r.state.scheduled.filter((e) => e.type === 'fuzz.boom');
          expect(left).toEqual(bombs.filter((b) => b.at > target)); // future bombs untouched
        },
      ),
      { numRuns: 60 },
    );
  });

  it('purity & determinism: frozen and thawed inputs advance to identical outcomes', () => {
    fc.assert(
      fc.property(arbSeed, arbTarget, (seed, target) => {
        const frozen = deepFreeze(seeded(FULLK, seed));
        const thawed = deepClone(frozen);
        const a = advanceThrough(FULLK, frozen, target);
        const b = advanceThrough(FULLK, thawed, target);
        expect(hashState(b.state)).toBe(hashState(a.state));
        expect(b.events).toEqual(a.events);
        expect(b.failures).toEqual(a.failures);
      }),
      { numRuns: 60 },
    );
  });

  it('fail-secure: a rewound clock is always E_TIME_BACKWARDS, never a silent no-op', () => {
    fc.assert(
      fc.property(
        arbSeed,
        fc
          .tuple(fc.integer({ min: 0, max: 72 * HOUR }), fc.integer({ min: 0, max: 72 * HOUR }))
          .filter(([a, b]) => a !== b),
        (seed, pair) => {
          const forward = Math.max(...pair);
          const back = Math.min(...pair);
          const advanced = advanceThrough(FULLK, seeded(FULLK, seed), forward).state;
          const r = FULLK.advanceTo(advanced, ctx(back));
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.code).toBe('E_TIME_BACKWARDS');
        },
      ),
      { numRuns: 40 },
    );
  });
});
