import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { marketModule } from './market';
import { createInitialState, type GameState, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
});
const ctx: Context = { now: 0, data };

function player(id: string, resources: Record<string, number>): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function world(): GameState {
  const s = createInitialState({ seed: 'mkt', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    players: {
      seller: player('seller', { credits: 0, metal: 100 }),
      buyer: player('buyer', { credits: 1000, metal: 0 }),
    },
  };
}
const act = (type: string, playerId: string, payload: unknown, seq = 1): Action => ({
  id: `s:${playerId}:${seq}`, type, playerId, payload, issuedAt: 0,
});
function ok(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function err(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const list = (amount = 40, price = 5) =>
  act('market.list', 'seller', { resource: 'metal', amount, price });

describe('market module — list / buy (15% burn) / cancel', () => {
  const kernel = createKernel([marketModule]);

  it('list escrows the resource and opens an order', () => {
    const r = ok(kernel.applyAction(world(), list(), ctx));
    expect(r.state.players.seller?.resources.metal).toBe(60); // 100 − 40 escrowed
    expect(r.state.market).toHaveLength(1);
    expect(r.state.market?.[0]).toMatchObject({ seller: 'seller', resource: 'metal', amount: 40, price: 5 });
    expect(r.events.map((e) => e.type)).toContain('market.listed');
  });

  it('buy delivers goods, charges the buyer, pays the seller 85%, burns 15%', () => {
    const listed = ok(kernel.applyAction(world(), list(), ctx));
    const orderId = listed.state.market![0]!.id;
    const r = ok(kernel.applyAction(listed.state, act('market.buy', 'buyer', { orderId, amount: 10 }), ctx));
    const cost = 10 * 5; // 50
    expect(r.state.players.buyer?.resources.metal).toBe(10); // delivered
    expect(r.state.players.buyer?.resources.credits).toBe(1000 - cost); // 950
    expect(r.state.players.seller?.resources.credits).toBeCloseTo(cost * 0.85); // 42.5
    expect(r.state.market?.[0]?.amount).toBe(30); // partial fill: 40 − 10
    // money sink: the 15% commission is burned (total money shrinks by it).
    const after = (r.state.players.seller?.resources.credits ?? 0) + (r.state.players.buyer?.resources.credits ?? 0);
    expect(1000 - after).toBeCloseTo(cost * 0.15); // 7.5 burned
  });

  it('buying the whole remainder closes the order', () => {
    const listed = ok(kernel.applyAction(world(), list(), ctx));
    const orderId = listed.state.market![0]!.id;
    const r = ok(kernel.applyAction(listed.state, act('market.buy', 'buyer', { orderId, amount: 40 }), ctx));
    expect(r.state.market).toHaveLength(0);
  });

  it('cancel refunds the unsold escrow to the seller', () => {
    const listed = ok(kernel.applyAction(world(), list(), ctx));
    const orderId = listed.state.market![0]!.id;
    const r = ok(kernel.applyAction(listed.state, act('market.cancel', 'seller', { orderId }), ctx));
    expect(r.state.players.seller?.resources.metal).toBe(100); // 60 + 40 refunded
    expect(r.state.market).toHaveLength(0);
  });

  it('rejects bad list, missing order, own order, over-amount, broke buyer, foreign cancel', () => {
    const st = world();
    expect(err(kernel.applyAction(st, act('market.list', 'seller', { resource: 'metal', amount: 999, price: 1 }), ctx))).toBe('E_INSUFFICIENT');
    expect(err(kernel.applyAction(st, act('market.list', 'seller', { resource: 'gold', amount: 1, price: 1 }), ctx))).toBe('E_UNKNOWN_RESOURCE');
    expect(err(kernel.applyAction(st, act('market.list', 'seller', { resource: 'metal', amount: -1, price: 1 }), ctx))).toBe('E_BAD_PAYLOAD');
    expect(err(kernel.applyAction(st, act('market.buy', 'buyer', { orderId: 'market:999', amount: 1 }), ctx))).toBe('E_NO_ORDER');

    const listed = ok(kernel.applyAction(st, list(), ctx));
    const id = listed.state.market![0]!.id;
    expect(err(kernel.applyAction(listed.state, act('market.buy', 'seller', { orderId: id, amount: 1 }, 2), ctx))).toBe('E_OWN_ORDER');
    expect(err(kernel.applyAction(listed.state, act('market.buy', 'buyer', { orderId: id, amount: 999 }), ctx))).toBe('E_BAD_AMOUNT');
    const poor: GameState = { ...listed.state, players: { ...listed.state.players, buyer: player('buyer', { credits: 10, metal: 0 }) } };
    expect(err(kernel.applyAction(poor, act('market.buy', 'buyer', { orderId: id, amount: 40 }), ctx))).toBe('E_INSUFFICIENT'); // 200 > 10
    expect(err(kernel.applyAction(listed.state, act('market.cancel', 'buyer', { orderId: id }), ctx))).toBe('E_FORBIDDEN');
  });
});
