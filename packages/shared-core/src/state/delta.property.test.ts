import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createKernel, type Kernel } from '../kernel/kernel';
import { deepClone, deepFreeze } from '../util/clone';
import { hashState } from './hash';
import { diffState, applyDelta, type StateDelta } from './delta';
import type { Action, Context } from '../action/types';
import type { GameState } from './gameState';
import { economyModule } from '../modules/economy';
import { movementModule } from '../modules/movement';
import { combatModule } from '../modules/combat';
import { sectorModule } from '../modules/sector';
import { arbSeed, fixtureData, makeFixtureState } from '../testkit/arbitraries';

/**
 * FUZZ-4 (playtest-hardening / secure-sdlc SD-7.3, third bullet): the delta
 * codec must be the identity — `applyDelta(prev, diffState(prev, next))`
 * reconstructs `next` by `hashState` — under BOTH kinds of pairs it meets in
 * production:
 *
 * - SIMULATION-reachable pairs: two instants of a live skirmish (arrivals, a
 *   battle at the nexus, destroyed fleets → the `removed` path, accrual → the
 *   `changed`/meta paths) — exactly what MatchRoom broadcasts between frames.
 * - SYNTHETIC structurally-mutated pairs across different seeds: entity
 *   add/remove/rewrite, meta rewrites, HOST-EXTENSION top-level keys appearing
 *   and disappearing (the `meta`-carry and `removedMeta` paths that guard
 *   against the stale-client desync described in delta.ts).
 *
 * Every pair is also pushed through `JSON.parse(JSON.stringify(delta))` — the
 * actual WebSocket wire — and applied twice (idempotence): a re-delivered
 * patch must not corrupt the copy. All inputs are deep-frozen, so any hidden
 * mutation inside diff/apply throws instead of passing silently.
 */

const HOUR = 3_600_000;
const data = deepFreeze(fixtureData);
const ctx = (now: number): Context => ({ now, data });
const KERNEL = createKernel([economyModule, movementModule, combatModule, sectorModule]);

const order = (playerId: string, type: string, payload: unknown, n: number): Action => ({
  id: `fz4:${playerId}:${n}`,
  type,
  playerId,
  payload,
  issuedAt: 0,
});

function advanceThrough(kernel: Kernel, state: GameState, target: number): GameState {
  let s = state;
  while (s.time < target) {
    const before = s.time;
    const r = kernel.advanceTo(s, ctx(target));
    if (!r.ok) throw new Error(`advance failed: ${r.code}`);
    s = r.state;
    if (!r.partial) break;
    if (s.time === before) throw new Error(`advance stuck at ${s.time}`);
  }
  return s;
}

/** Two instants of a live skirmish: both fleets march on NEXUS at t=0, then the
 *  world runs to t1 (prev), takes one more optional order, and runs on to t2. */
function simPair(
  seed: string,
  t1: number,
  t2: number,
  extra: number,
): { prev: GameState; next: GameState } {
  let s = makeFixtureState(seed);
  for (const o of [
    order('p1', 'fleet.move', { fleetId: 'BLUE', to: 'NEXUS' }, 1),
    order('p2', 'fleet.move', { fleetId: 'RED', to: 'NEXUS' }, 2),
  ]) {
    const r = KERNEL.applyAction(s, o, ctx(0));
    if (r.ok) s = r.state;
  }
  const prev = advanceThrough(KERNEL, s, t1);
  let mid = prev;
  const extras: Action[] = [
    order('p1', 'fleet.assault', { fleetId: 'BLUE' }, 3),
    order('p1', 'fleet.move', { fleetId: 'BLUE', to: 'BASTION' }, 3),
    order('p2', 'fleet.stop', { fleetId: 'RED' }, 3),
  ];
  const pick = extras[extra % extras.length];
  if (pick) {
    const r = KERNEL.applyAction(mid, pick, ctx(t1));
    if (r.ok) mid = r.state;
  }
  return { prev, next: advanceThrough(KERNEL, mid, t2) };
}

/** Structural mutations over a fixture state — each hits a specific delta path:
 *  entity remove/add/rewrite, meta scalars, schedule, optional-field drop, and
 *  host-extension top-level keys (the KNOWN_TOP_KEYS complement). */
const MUTATIONS: Array<(s: GameState, k: number) => void> = [
  (s) => {
    delete s.fleets.BLUE;
  },
  (s, k) => {
    const f = s.fleets.RED;
    if (f) s.fleets[`RED_${k % 3}`] = { ...deepClone(f), id: `RED_${k % 3}` };
  },
  (s, k) => {
    const f = s.fleets.BLUE;
    if (f) f.units = [{ unit: 'cruiser', count: (k % 7) + 1 }];
  },
  (s) => {
    const p = s.planets.NEXUS;
    if (p) p.owner = 'p1';
  },
  (s) => {
    delete s.planets.BASTION;
  },
  (s, k) => {
    s.time = k * 1000;
  },
  (s, k) => {
    s.battleSeq = k;
  },
  (s, k) => {
    (s as unknown as Record<string, unknown>).orders = { chains: [k] }; // host extension
  },
  (s) => {
    const f = s.fleets.RED;
    if (f) delete (f as { landing?: unknown }).landing;
  },
  (s, k) => {
    s.scheduled = [{ id: `m:${k}`, at: k, type: 'fuzz.marker', payload: null, seq: 0 }];
    s.scheduleSeq = 1;
  },
];

const arbMuts = fc.array(
  fc.tuple(fc.integer({ min: 0, max: MUTATIONS.length - 1 }), fc.integer({ min: 0, max: 999 })),
  { maxLength: 6 },
);

function mutated(seed: string, muts: Array<[number, number]>): GameState {
  const s = deepClone(makeFixtureState(seed));
  for (const [i, k] of muts) MUTATIONS[i]?.(s, k);
  return s;
}

/** The shared assertion: diff → apply reconstructs; the JSON wire form does
 *  too; and a re-delivered (twice-applied) patch is harmless. */
function expectRoundTrip(prev: GameState, next: GameState): void {
  const frozenPrev = deepFreeze(deepClone(prev));
  const frozenNext = deepFreeze(deepClone(next));
  const want = hashState(frozenNext);
  const delta = deepFreeze(diffState(frozenPrev, frozenNext));
  expect(hashState(applyDelta(frozenPrev, delta))).toBe(want);
  const wire = deepFreeze(JSON.parse(JSON.stringify(delta)) as StateDelta);
  const once = applyDelta(frozenPrev, wire);
  expect(hashState(once)).toBe(want);
  expect(hashState(applyDelta(once, wire))).toBe(want); // idempotent re-delivery
}

describe('applyDelta ∘ diffState = id under fuzz (FUZZ-4)', () => {
  it('sanity: a live pair genuinely differs and still reconstructs', () => {
    const { prev, next } = simPair('sanity', 2 * HOUR, 24 * HOUR, 0);
    expect(hashState(prev)).not.toBe(hashState(next));
    expectRoundTrip(prev, next);
  });

  it('simulation-reachable pairs (what MatchRoom actually broadcasts) reconstruct bit-exactly', () => {
    fc.assert(
      fc.property(
        arbSeed,
        fc.integer({ min: 0, max: 24 * HOUR }),
        fc.integer({ min: 1, max: 24 * HOUR }),
        fc.integer({ min: 0, max: 2 }),
        (seed, t1, dt, extra) => {
          const { prev, next } = simPair(seed, t1, t1 + dt, extra);
          expectRoundTrip(prev, next);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('synthetic cross-seed pairs — entity add/remove/rewrite, meta, host extensions — reconstruct', () => {
    fc.assert(
      fc.property(arbSeed, arbSeed, arbMuts, arbMuts, (seedA, seedB, mutsA, mutsB) => {
        expectRoundTrip(mutated(seedA, mutsA), mutated(seedB, mutsB));
      }),
      { numRuns: 120 },
    );
  });

  it('a state diffed against itself yields the EMPTY delta, and applying it is the identity', () => {
    fc.assert(
      fc.property(arbSeed, arbMuts, (seed, muts) => {
        const s = deepFreeze(mutated(seed, muts));
        const d = diffState(s, s);
        expect(d.changed).toEqual({});
        expect(d.removed).toEqual({});
        expect(d.meta).toBeUndefined();
        expect(d.removedMeta).toBeUndefined();
        expect(hashState(applyDelta(s, deepFreeze(d)))).toBe(hashState(s));
      }),
      { numRuns: 100 },
    );
  });

  it('an extension key present only in prev is actively deleted (removedMeta), not left stale', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: 999 }), (seed, k) => {
        const next = makeFixtureState(seed);
        const prev = deepClone(next);
        (prev as unknown as Record<string, unknown>).orders = { chains: [k] };
        const d = diffState(deepFreeze(prev), deepFreeze(next));
        expect(d.removedMeta).toEqual(['orders']);
        const rebuilt = applyDelta(deepFreeze(prev), deepFreeze(d));
        expect('orders' in rebuilt).toBe(false);
        expect(hashState(rebuilt)).toBe(hashState(next));
      }),
      { numRuns: 50 },
    );
  });
});
