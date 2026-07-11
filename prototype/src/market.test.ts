import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  marketList,
  marketTake,
  marketCancel,
  marketLots,
  declareWar,
  aiOrders,
} from './game';
import type { GameState } from '../../packages/shared-core/src/index';

/** Total of a resource across every player's treasury. */
function held(s: GameState, key: string): number {
  let total = 0;
  for (const p of Object.values(s.players)) total += p.resources[key] ?? 0;
  return total;
}
/** Escrow currently locked inside open lots (goods for sell lots, credits for buy lots). */
function escrow(s: GameState, key: string): number {
  let total = 0;
  for (const lot of marketLots(s)) {
    if (lot.side === 'sell' && lot.resource === key) total += lot.amount;
    if (lot.side === 'buy' && key === 'credits') total += lot.amount * lot.price;
  }
  return total;
}
function rich(): GameState {
  const s = newGame(); // default setup = p1 (human) + p2 (AI)
  for (const id of ['p1', 'p2']) {
    s.players[id]!.resources.credits = 1000;
    s.players[id]!.resources.metal = 1000;
  }
  return s;
}
const ok = (r: { state: GameState; error?: string }): GameState => {
  if (r.error) throw new Error(r.error);
  return r.state;
};

describe('session market — two-sided order book', () => {
  it('a sell lot escrows goods, then a buyer pays credits and receives them', () => {
    let s = rich();
    const total = { metal: held(s, 'metal'), credits: held(s, 'credits') };
    s = ok(order(s, marketList('p1', 'sell', 'metal', 100, 3), 0));
    expect(s.players.p1!.resources.metal).toBe(900); // escrowed out of the treasury
    expect(marketLots(s)).toHaveLength(1);
    s = ok(order(s, marketTake('p2', marketLots(s)[0]!.id), s.time));
    expect(s.players.p2!.resources.metal).toBe(1100); // got the goods
    expect(s.players.p2!.resources.credits).toBe(700); // paid 100 × 3
    expect(s.players.p1!.resources.credits).toBe(1300); // seller received credits
    expect(marketLots(s)).toHaveLength(0);
    // Conservation: nothing minted or lost (treasuries + escrow are constant).
    expect(held(s, 'metal') + escrow(s, 'metal')).toBe(total.metal);
    expect(held(s, 'credits') + escrow(s, 'credits')).toBe(total.credits);
  });

  it('a buy lot escrows credits, then a seller delivers goods for them', () => {
    let s = rich();
    s = ok(order(s, marketList('p1', 'buy', 'food', 50, 2), 0)); // bid 50 food @ 2 → escrow 100 cr
    expect(s.players.p1!.resources.credits).toBe(900);
    s = ok(order(s, marketTake('p2', marketLots(s)[0]!.id), s.time));
    expect(s.players.p2!.resources.food).toBe(70); // p2 delivered 50 (seeded 120)
    expect(s.players.p2!.resources.credits).toBe(1100); // got the escrowed credits
    expect(s.players.p1!.resources.food).toBe(170); // bidder received the food
    expect(marketLots(s)).toHaveLength(0);
  });

  it('partial fills leave the remainder open', () => {
    let s = rich();
    s = ok(order(s, marketList('p1', 'sell', 'metal', 100, 2), 0));
    s = ok(order(s, marketTake('p2', marketLots(s)[0]!.id, 40), s.time)); // take 40 of 100
    expect(marketLots(s)[0]!.amount).toBe(60); // 60 still on offer
    expect(s.players.p2!.resources.metal).toBe(1040);
  });

  it('cancel refunds the remaining escrow to the owner', () => {
    let s = rich();
    s = ok(order(s, marketList('p1', 'sell', 'metal', 100, 3), 0));
    expect(s.players.p1!.resources.metal).toBe(900);
    s = ok(order(s, marketCancel('p1', marketLots(s)[0]!.id), s.time));
    expect(s.players.p1!.resources.metal).toBe(1000); // goods returned
    expect(marketLots(s)).toHaveLength(0);
  });

  it('an embargoing bot refuses to let a soured player take its lot', () => {
    let s = rich();
    s = ok(order(s, declareWar('p1', 'p2'), 0)); // sours p2's favour toward p1 below the embargo line
    s = ok(order(s, marketList('p2', 'sell', 'metal', 50, 2), s.time));
    expect(order(s, marketTake('p1', marketLots(s)[0]!.id), s.time).error).toBe('E_EMBARGO');
  });

  it('rejects a non-tradeable resource, a self-take, and a bad amount', () => {
    let s = rich();
    expect(order(s, marketList('p1', 'sell', 'credits', 10, 1), 0).error).toBe('E_BAD_RESOURCE');
    expect(order(s, marketList('p1', 'sell', 'metal', 0, 1), 0).error).toBe('E_BAD_PAYLOAD');
    s = ok(order(s, marketList('p1', 'sell', 'metal', 10, 1), 0));
    expect(order(s, marketTake('p1', marketLots(s)[0]!.id), s.time).error).toBe('E_OWN_LOT');
  });

  it('rejects a numeric-STRING amount/price on the ungated path (typeof, not coercion)', () => {
    const s = rich();
    // '10' >= 0 and Math.floor('10') both coerce — the handler must typeof-check first.
    const strPrice = marketList('p1', 'sell', 'metal', 10, '3' as unknown as number);
    const strAmount = marketList('p1', 'sell', 'metal', '10' as unknown as number, 3);
    expect(order(s, strPrice, 0).error).toBe('E_BAD_PAYLOAD');
    expect(order(s, strAmount, 0).error).toBe('E_BAD_PAYLOAD');
  });

  it('a bot lists its surplus goods for sale (and the embargo blocks a soured buyer)', () => {
    let s = newGame(); // p2 = AI
    // The building economy taught the bot a working RESERVE (120 food) — its seeded
    // stock is exactly that, so at start it sells NOTHING…
    const atStart = aiOrders(s, 'p2').filter(
      (a) => a.type === 'market.list' && (a.payload as { side?: string }).side === 'sell',
    );
    expect(atStart.find((a) => (a.payload as { resource?: string }).resource === 'food')).toBeUndefined();
    // …and lists only the surplus ABOVE the reserve once it is flush.
    s.players.p2!.resources.food = 220;
    const sells = aiOrders(s, 'p2').filter(
      (a) => a.type === 'market.list' && (a.payload as { side?: string }).side === 'sell',
    );
    const food = sells.find((a) => (a.payload as { resource?: string }).resource === 'food');
    expect(food).toBeDefined();
    expect((food!.payload as { amount: number }).amount).toBe(50); // (220 − 120) / 2

    // Apply the bot's sell orders, then a soured player can't fill them.
    for (const a of sells) s = ok(order(s, a, 0));
    s = ok(order(s, declareWar('p1', 'p2'), s.time)); // sour p2's favour toward p1
    const botFoodLot = marketLots(s).find((l) => l.owner === 'p2' && l.resource === 'food');
    expect(botFoodLot).toBeDefined();
    expect(order(s, marketTake('p1', botFoodLot!.id), s.time).error).toBe('E_EMBARGO');
  });
});
