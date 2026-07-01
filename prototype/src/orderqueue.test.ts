import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, Action, Context, ApplyResult } from '../../packages/shared-core/src/index';
import {
  orderQueueModule,
  orderEnqueue,
  orderClear,
  orderPop,
  orderHold,
  serverQueueActions,
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
});
