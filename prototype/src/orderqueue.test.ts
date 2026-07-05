import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, Action, Context, ApplyResult } from '../../packages/shared-core/src/index';
import {
  orderQueueModule,
  subscriptionModule,
  orderEnqueue,
  orderClear,
  orderPop,
  orderHold,
  orderRemove,
  orderBlock,
  orderRetry,
  serverQueueActions,
  popChainStep,
  chainOrderCount,
  CHAIN_ORDERS_BASE,
  CHAIN_ORDERS_PREMIUM,
  MAX_ORDER_STEPS,
  MAX_WAIT_HOURS,
  data,
  type QStep,
} from './game';

const kernel = createKernel([orderQueueModule]);
const ctx = (now = 0): Context => ({ now, data });
const HOUR = 3_600_000;

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id, owner: 'green', location: 'p1', movement: null,
    units: [{ unit: 'cruiser', count: 1 }], landing: [], traits: [], battleId: null, ...over,
  } as unknown as Fleet;
}
function stateWith(...fleets: Fleet[]): GameState {
  const s = createInitialState({ seed: 'cc', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, fleets: f };
}
function ok(r: ApplyResult): GameState {
  if (!r.ok) throw new Error('apply failed: ' + r.code);
  return r.state;
}
function rej(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const ordersOf = (s: GameState): Record<string, QStep[]> =>
  (s as { orders?: Record<string, QStep[]> }).orders ?? {};

describe('orderQueueModule — authoritative order chain in state (CC-server)', () => {
  it('order.enqueue appends a step to the owner fleet (stamped with its order group)', () => {
    const s = ok(kernel.applyAction(stateWith(fleet('F')), orderEnqueue('green', 'F', { kind: 'move', to: 'p7' }), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'move', to: 'p7', group: 1 }]);
  });

  it('preserves chain order across enqueues — one enqueue = one order group', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'p2' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    expect(ordersOf(s).F).toEqual([
      { kind: 'move', to: 'p2', group: 1 },
      { kind: 'assault', group: 2 },
    ]);
  });

  it('a compiled pattern (capture = move + assault) shares ONE group — one limit slot', () => {
    const s = ok(
      kernel.applyAction(
        stateWith(fleet('F')),
        orderEnqueue('green', 'F', [{ kind: 'move', to: 'p7' }, { kind: 'assault' }]),
        ctx(),
      ),
    );
    expect(ordersOf(s).F).toEqual([
      { kind: 'move', to: 'p7', group: 1 },
      { kind: 'assault', group: 1 },
    ]);
    expect(chainOrderCount(ordersOf(s).F!)).toBe(1);
  });

  it('order.pop drops the head and removes the entry when the chain empties', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    s = ok(kernel.applyAction(s, orderPop('green', 'F'), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'assault', group: 2 }]);
    s = ok(kernel.applyAction(s, orderPop('green', 'F'), ctx()));
    expect(ordersOf(s).F).toBeUndefined();
  });

  it('order.clear drops the whole chain', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours: 6 }), ctx()));
    s = ok(kernel.applyAction(s, orderClear('green', 'F'), ctx()));
    expect(ordersOf(s).F).toBeUndefined();
  });

  it('order.hold stamps the head wait step (only on a wait head)', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours: 6 }), ctx()));
    s = ok(kernel.applyAction(s, orderHold('green', 'F', 99), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'wait', hours: 6, until: 99, group: 1 }]);
    // hold on a non-wait head → rejected, chain untouched.
    let s2 = stateWith(fleet('G'));
    s2 = ok(kernel.applyAction(s2, orderEnqueue('green', 'G', { kind: 'orbit' }), ctx()));
    expect(rej(kernel.applyAction(s2, orderHold('green', 'G', 5), ctx()))).toBe('E_NO_WAIT');
  });

  it('is fail-secure: unknown fleet / not your fleet / malformed step all reject', () => {
    const s = stateWith(fleet('F'), fleet('E', { owner: 'red' }));
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'ghost', { kind: 'orbit' }), ctx()))).toBe('E_NO_FLEET');
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'E', { kind: 'orbit' }), ctx()))).toBe('E_FORBIDDEN');
    const bad: Action = { ...orderEnqueue('green', 'F', { kind: 'orbit' }), payload: { fleetId: 'F', steps: [{ kind: 'bogus' }] } };
    expect(rej(kernel.applyAction(s, bad, ctx()))).toBe('E_BAD_PAYLOAD');
    // A payload must be a non-empty steps array, bounded by MAX_ORDER_STEPS.
    const legacy: Action = { ...bad, payload: { fleetId: 'F', step: { kind: 'orbit' } } };
    expect(rej(kernel.applyAction(s, legacy, ctx()))).toBe('E_BAD_PAYLOAD');
    const empty: Action = { ...bad, payload: { fleetId: 'F', steps: [] } };
    expect(rej(kernel.applyAction(s, empty, ctx()))).toBe('E_BAD_PAYLOAD');
    const fat: Action = {
      ...bad,
      payload: { fleetId: 'F', steps: Array.from({ length: MAX_ORDER_STEPS + 1 }, () => ({ kind: 'orbit' })) },
    };
    expect(rej(kernel.applyAction(s, fat, ctx()))).toBe('E_BAD_PAYLOAD');
  });

  it('does not mutate the input state (purity / immutability invariant)', () => {
    const s0 = stateWith(fleet('F'));
    kernel.applyAction(s0, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx());
    expect(ordersOf(s0).F).toBeUndefined(); // the original draft is untouched
  });
});

describe('chain bounds, editing and verdicts (CC-4.1 / CC-5.1 / CC-6)', () => {
  it(`order.enqueue caps the chain at ${CHAIN_ORDERS_BASE} ORDERS (E_QUEUE_FULL)`, () => {
    let s = stateWith(fleet('F'));
    for (let i = 0; i < CHAIN_ORDERS_BASE; i++) {
      // Each order is a two-step capture pattern — patterns must not eat extra slots.
      s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', [{ kind: 'move', to: 'p' + i }, { kind: 'assault' }]), ctx()));
    }
    expect(ordersOf(s).F).toHaveLength(CHAIN_ORDERS_BASE * 2);
    expect(chainOrderCount(ordersOf(s).F!)).toBe(CHAIN_ORDERS_BASE);
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()))).toBe('E_QUEUE_FULL');
  });

  it('the 🔁 marker rides outside the order limit (a full plan can still patrol) — but only one', () => {
    let s = stateWith(fleet('F'));
    for (let i = 0; i < CHAIN_ORDERS_BASE; i++) {
      s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'p' + i }), ctx()));
    }
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'repeat' }), ctx()));
    expect(chainOrderCount(ordersOf(s).F!)).toBe(CHAIN_ORDERS_BASE);
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'repeat' }), ctx()))).toBe('E_LIMIT');
    // …and it is a lone plan property, never part of a step pattern.
    const mixed = orderEnqueue('green', 'F', [{ kind: 'orbit' }, { kind: 'repeat' }]);
    expect(rej(kernel.applyAction(stateWith(fleet('F')), mixed, ctx()))).toBe('E_BAD_PAYLOAD');
  });

  it(`a subscription raises the limit to ${CHAIN_ORDERS_PREMIUM} via the order.chainLimit hook`, () => {
    const subbed = createKernel([orderQueueModule, subscriptionModule]);
    let s = { ...stateWith(fleet('F')), subscribers: { green: true } } as GameState;
    for (let i = 0; i < CHAIN_ORDERS_PREMIUM; i++) {
      s = ok(subbed.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'p' + i }), ctx()));
    }
    expect(rej(subbed.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()))).toBe('E_QUEUE_FULL');
    // An unsubscribed seat in the same match stays at the base limit.
    let s2 = { ...stateWith(fleet('F')), subscribers: { red: true } } as GameState;
    for (let i = 0; i < CHAIN_ORDERS_BASE; i++) {
      s2 = ok(subbed.applyAction(s2, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    }
    expect(rej(subbed.applyAction(s2, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()))).toBe('E_QUEUE_FULL');
    // No subscription module at all → base default, never a crash (graceful degradation).
    let s3 = { ...stateWith(fleet('F')), subscribers: { green: true } } as GameState;
    for (let i = 0; i < CHAIN_ORDERS_BASE; i++) {
      s3 = ok(kernel.applyAction(s3, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    }
    expect(rej(kernel.applyAction(s3, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()))).toBe('E_QUEUE_FULL');
  });

  it('wait hours must be finite and bounded (Infinity would wedge the chain + break JSON)', () => {
    const s = stateWith(fleet('F'));
    for (const hours of [Infinity, NaN, -1, MAX_WAIT_HOURS + 1]) {
      expect(rej(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours }), ctx()))).toBe('E_BAD_PAYLOAD');
    }
    ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours: MAX_WAIT_HOURS }), ctx()));
  });

  it('order.enqueue strips client-supplied runtime stamps (until / blocked / group)', () => {
    const sneaky = { kind: 'wait', hours: 1, until: 5, blocked: 'E_FAKE', group: 99 } as QStep;
    const s = ok(kernel.applyAction(stateWith(fleet('F')), orderEnqueue('green', 'F', sneaky), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'wait', hours: 1, group: 1 }]);
  });

  it('order.remove deletes the WHOLE order the index points into (fail-secure on bad indexes)', () => {
    let s = stateWith(fleet('F'));
    // Order 1 is a two-step capture; removing it via EITHER step's index drops both —
    // half a capture (a move without its assault) is not a plan anyone asked for.
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', [{ kind: 'move', to: 'a' }, { kind: 'assault' }]), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'load' }), ctx()));
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 1), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'load', group: 2 }]);
    expect(rej(kernel.applyAction(s, orderRemove('green', 'F', 1), ctx()))).toBe('E_NO_STEP');
    expect(rej(kernel.applyAction(s, orderRemove('green', 'F', 0.5), ctx()))).toBe('E_BAD_PAYLOAD');
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 0), ctx()));
    expect(ordersOf(s).F).toBeUndefined(); // emptied → entry dropped
  });

  it('removing an order frees its limit slot (and group stamps stay monotonic)', () => {
    let s = stateWith(fleet('F'));
    for (let i = 0; i < CHAIN_ORDERS_BASE; i++) {
      s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'p' + i }), ctx()));
    }
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 0), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    // The freed slot is usable again, and the new order got a FRESH group id.
    expect(chainOrderCount(ordersOf(s).F!)).toBe(CHAIN_ORDERS_BASE);
    expect(ordersOf(s).F!.at(-1)).toEqual({ kind: 'orbit', group: CHAIN_ORDERS_BASE + 1 });
  });

  it('order.block pauses the chain on the head with its reason; order.retry re-arms it', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    s = ok(kernel.applyAction(s, orderBlock('green', 'F', 'E_FORBIDDEN'), ctx()));
    expect(ordersOf(s).F![0]).toEqual({ kind: 'assault', blocked: 'E_FORBIDDEN', group: 1 });
    expect(serverQueueActions(s, 0)).toEqual([]); // the driver holds a blocked chain
    s = ok(kernel.applyAction(s, orderRetry('green', 'F'), ctx()));
    expect(ordersOf(s).F![0]).toEqual({ kind: 'assault', group: 1 });
    expect(serverQueueActions(s, 0)).toHaveLength(1); // …and it runs again
    expect(rej(kernel.applyAction(s, orderRetry('green', 'F'), ctx()))).toBe('E_NO_STEP');
    expect(rej(kernel.applyAction(s, orderBlock('green', 'F', 'not a code!'), ctx()))).toBe('E_BAD_PAYLOAD');
  });

  it('order.hold puts the resume moment on the schedule so an offline room wakes for it', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours: 6 }), ctx()));
    s = ok(kernel.applyAction(s, orderHold('green', 'F', 6 * HOUR), ctx()));
    expect(s.scheduled.some((e) => e.type === 'order.wake' && e.at === 6 * HOUR)).toBe(true);
  });

  it('sweeps the chain of a dead fleet on advance (no immortal orders in state)', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    const gone = { ...s, fleets: {} } as GameState;
    const r = kernel.advanceTo(gone, ctx(HOUR));
    if (!r.ok) throw new Error('advance failed');
    expect((r.state as { orders?: unknown }).orders).toBeUndefined();
  });
});

describe('🔁 repeat — a chain that patrols until cleared', () => {
  it('popChainStep rotates finished steps to the tail on a looping chain', () => {
    const q: QStep[] = [{ kind: 'move', to: 'a' }, { kind: 'move', to: 'b' }, { kind: 'repeat' }];
    popChainStep(q);
    expect(q).toEqual([{ kind: 'move', to: 'b' }, { kind: 'repeat' }, { kind: 'move', to: 'a' }]);
    popChainStep(q);
    expect(q).toEqual([{ kind: 'repeat' }, { kind: 'move', to: 'a' }, { kind: 'move', to: 'b' }]);
    popChainStep(q); // the marker itself rotates, restoring the original order
    expect(q).toEqual([{ kind: 'move', to: 'a' }, { kind: 'move', to: 'b' }, { kind: 'repeat' }]);
  });

  it('a re-queued step is cleansed: wait re-counts, a stale verdict does not survive the loop', () => {
    const q: QStep[] = [{ kind: 'wait', hours: 2, until: 99, blocked: 'E_X' }, { kind: 'repeat' }];
    popChainStep(q);
    expect(q).toEqual([{ kind: 'repeat' }, { kind: 'wait', hours: 2 }]);
  });

  it('without the marker, popChainStep is a plain shift (one-shot chains unchanged)', () => {
    const q: QStep[] = [{ kind: 'orbit' }, { kind: 'assault' }];
    popChainStep(q);
    expect(q).toEqual([{ kind: 'assault' }]);
  });
});

describe('serverQueueActions — the server-side chain driver core (CC-server)', () => {
  function withOrders(fleets: Fleet[], orders: Record<string, QStep[]>): GameState {
    return { ...stateWith(...fleets), orders } as GameState;
  }

  it('issues the head step for an idle fleet and pops it', () => {
    const s = withOrders([fleet('F')], { F: [{ kind: 'move', to: 'p9' }, { kind: 'assault' }] });
    const out = serverQueueActions(s, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.owner).toBe('green');
    expect(out[0]!.actions.map((a) => a.type)).toEqual(['fleet.move']);
    expect(out[0]!.pop).toBe(true);
  });

  it('holds a fleet that is in transit or in battle (no order issued)', () => {
    const moving = withOrders([fleet('F', { movement: { to: 'p2' } as never })], { F: [{ kind: 'assault' }] });
    const fighting = withOrders([fleet('G', { battleId: 'b1' })], { G: [{ kind: 'assault' }] });
    expect(serverQueueActions(moving, 0)).toEqual([]);
    expect(serverQueueActions(fighting, 0)).toEqual([]);
  });

  it('a wait head stamps its resume time first (holdUntil), then pops once elapsed', () => {
    const s = withOrders([fleet('F')], { F: [{ kind: 'wait', hours: 12 }] });
    const first = serverQueueActions(s, 1000);
    expect(first[0]).toMatchObject({ actions: [], pop: false, holdUntil: 1000 + 12 * HOUR });
    // With `until` set and now before it → nothing; once reached → pop.
    const held = withOrders([fleet('F')], { F: [{ kind: 'wait', hours: 12, until: 1000 + 12 * HOUR }] });
    expect(serverQueueActions(held, 1000 + 12 * HOUR - 1)).toEqual([]);
    expect(serverQueueActions(held, 1000 + 12 * HOUR)[0]).toMatchObject({ actions: [], pop: true });
  });

  it('skips a stale entry whose fleet is gone', () => {
    const s = withOrders([], { GONE: [{ kind: 'orbit' }] });
    expect(serverQueueActions(s, 0)).toEqual([]);
  });

  it('rotates a 🔁 head (empty pop) and lets an orphan marker idle', () => {
    const looping = withOrders([fleet('F')], { F: [{ kind: 'repeat' }, { kind: 'orbit' }] });
    expect(serverQueueActions(looping, 0)[0]).toMatchObject({ actions: [], pop: true });
    const orphan = withOrders([fleet('G')], { G: [{ kind: 'repeat' }] });
    expect(serverQueueActions(orphan, 0)).toEqual([]);
  });

  it("an 'unload' head empties the hold onto the world; nothing aboard fails loudly", () => {
    const dock = (st: ReturnType<typeof withOrders>) =>
      ({ ...st, planets: { p1: { id: 'p1' } as never } }) as typeof st;
    const full = dock(
      withOrders([fleet('F', { landing: [{ unit: 'infantry', count: 2 }] } as Partial<Fleet>)], {
        F: [{ kind: 'unload' }],
      }),
    );
    const out = serverQueueActions(full, 0);
    expect(out[0]!.actions.map((a) => a.type)).toEqual(['army.unload']);
    expect(out[0]!.pop).toBe(true);
    const empty = dock(withOrders([fleet('G')], { G: [{ kind: 'unload' }] }));
    expect(serverQueueActions(empty, 0)[0]).toMatchObject({ actions: [], pop: false, fail: 'E_NO_CARGO' });
  });

  it("a planned 'load' with nothing liftable fails loudly instead of skipping", () => {
    // p1 does not exist in this bare state → nothing to lift → the plan is broken.
    const s = withOrders([fleet('F')], { F: [{ kind: 'load' }] });
    expect(serverQueueActions(s, 0)[0]).toMatchObject({ actions: [], pop: false, fail: 'E_NO_CARGO' });
  });

  it("a 'bombard' head enters orbit first when needed", () => {
    const s = withOrders([fleet('F')], { F: [{ kind: 'bombard' }] });
    expect(serverQueueActions(s, 0)[0]!.actions.map((a) => a.type)).toEqual(['fleet.orbit', 'fleet.bombard']);
    const inOrbit = withOrders([fleet('G', { orbit: 'near' } as Partial<Fleet>)], { G: [{ kind: 'bombard' }] });
    expect(serverQueueActions(inOrbit, 0)[0]!.actions.map((a) => a.type)).toEqual(['fleet.bombard']);
  });
});
