import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, Action, Context, ApplyResult } from '../../packages/shared-core/src/index';
import {
  orderQueueModule,
  orderEnqueue,
  orderClear,
  orderPop,
  orderHold,
  orderRemove,
  orderBlock,
  orderRetry,
  serverQueueActions,
  popChainStep,
  MAX_CHAIN_STEPS,
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
  it('order.enqueue appends a step to the owner fleet', () => {
    const s = ok(kernel.applyAction(stateWith(fleet('F')), orderEnqueue('green', 'F', { kind: 'move', to: 'p7' }), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'move', to: 'p7' }]);
  });

  it('preserves chain order across enqueues', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'p2' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'move', to: 'p2' }, { kind: 'assault' }]);
  });

  it('order.pop drops the head and removes the entry when the chain empties', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    s = ok(kernel.applyAction(s, orderPop('green', 'F'), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'assault' }]);
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
    expect(ordersOf(s).F).toEqual([{ kind: 'wait', hours: 6, until: 99 }]);
    // hold on a non-wait head → rejected, chain untouched.
    let s2 = stateWith(fleet('G'));
    s2 = ok(kernel.applyAction(s2, orderEnqueue('green', 'G', { kind: 'orbit' }), ctx()));
    expect(rej(kernel.applyAction(s2, orderHold('green', 'G', 5), ctx()))).toBe('E_NO_WAIT');
  });

  it('is fail-secure: unknown fleet / not your fleet / malformed step all reject', () => {
    const s = stateWith(fleet('F'), fleet('E', { owner: 'red' }));
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'ghost', { kind: 'orbit' }), ctx()))).toBe('E_NO_FLEET');
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'E', { kind: 'orbit' }), ctx()))).toBe('E_FORBIDDEN');
    const bad: Action = { ...orderEnqueue('green', 'F', { kind: 'orbit' }), payload: { fleetId: 'F', step: { kind: 'bogus' } } };
    expect(rej(kernel.applyAction(s, bad, ctx()))).toBe('E_BAD_PAYLOAD');
  });

  it('does not mutate the input state (purity / immutability invariant)', () => {
    const s0 = stateWith(fleet('F'));
    kernel.applyAction(s0, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx());
    expect(ordersOf(s0).F).toBeUndefined(); // the original draft is untouched
  });
});

describe('chain bounds, editing and verdicts (CC-4.1 / CC-5.1 minimum)', () => {
  it('order.enqueue caps the chain (E_QUEUE_FULL) — bounded plans', () => {
    let s = stateWith(fleet('F'));
    for (let i = 0; i < MAX_CHAIN_STEPS; i++) {
      s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()));
    }
    expect(rej(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'orbit' }), ctx()))).toBe('E_QUEUE_FULL');
  });

  it('wait hours must be finite and bounded (Infinity would wedge the chain + break JSON)', () => {
    const s = stateWith(fleet('F'));
    for (const hours of [Infinity, NaN, -1, MAX_WAIT_HOURS + 1]) {
      expect(rej(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours }), ctx()))).toBe('E_BAD_PAYLOAD');
    }
    ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'wait', hours: MAX_WAIT_HOURS }), ctx()));
  });

  it('order.enqueue strips client-supplied runtime stamps (until / blocked)', () => {
    const sneaky = { kind: 'wait', hours: 1, until: 5, blocked: 'E_FAKE' } as QStep;
    const s = ok(kernel.applyAction(stateWith(fleet('F')), orderEnqueue('green', 'F', sneaky), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'wait', hours: 1 }]);
  });

  it('order.remove deletes one step by index (fail-secure on bad indexes)', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'move', to: 'a' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'load' }), ctx()));
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 1), ctx()));
    expect(ordersOf(s).F).toEqual([{ kind: 'move', to: 'a' }, { kind: 'load' }]);
    expect(rej(kernel.applyAction(s, orderRemove('green', 'F', 2), ctx()))).toBe('E_NO_STEP');
    expect(rej(kernel.applyAction(s, orderRemove('green', 'F', 1.5), ctx()))).toBe('E_BAD_PAYLOAD');
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 1), ctx()));
    s = ok(kernel.applyAction(s, orderRemove('green', 'F', 0), ctx()));
    expect(ordersOf(s).F).toBeUndefined(); // emptied → entry dropped
  });

  it('order.block pauses the chain on the head with its reason; order.retry re-arms it', () => {
    let s = stateWith(fleet('F'));
    s = ok(kernel.applyAction(s, orderEnqueue('green', 'F', { kind: 'assault' }), ctx()));
    s = ok(kernel.applyAction(s, orderBlock('green', 'F', 'E_FORBIDDEN'), ctx()));
    expect(ordersOf(s).F![0]).toEqual({ kind: 'assault', blocked: 'E_FORBIDDEN' });
    expect(serverQueueActions(s, 0)).toEqual([]); // the driver holds a blocked chain
    s = ok(kernel.applyAction(s, orderRetry('green', 'F'), ctx()));
    expect(ordersOf(s).F![0]).toEqual({ kind: 'assault' });
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
