import type { GameModule } from '../kernel/module';
import type { GameState, MarketOrder } from '../state/gameState';

/**
 * Session resource market — the bourse (in-match, NOT the meta auction in
 * economy-roadmap). A public, per-match order book in `GameState.market`:
 *
 *   - `market.list {resource, amount, price}` — offer a resource. The amount is
 *     ESCROWED out of the seller's treasury, so it can't be double-spent.
 *   - `market.buy {orderId, amount}` — buy (partially) from an order for money
 *     (`credits`). A 15% commission is BURNED — a money sink against inflation: the
 *     buyer pays `amount × price`, the seller receives 85%.
 *   - `market.cancel {orderId}` — the seller reclaims the unsold remainder.
 *
 * Pure, deterministic, fail-secure; lives entirely in state — no kernel change. The
 * order book is public (an exchange), so it is NOT stripped by the fog projection.
 */

const MONEY = 'credits';
const COMMISSION = 0.15;

function findOrder(state: GameState, id: string): MarketOrder | undefined {
  return state.market?.find((o) => o.id === id);
}

export const marketModule: GameModule = {
  id: 'market',
  version: '1.0.0',
  setup(api) {
    api.onAction('market.list', (action, h) => {
      const { resource, amount, price } = action.payload as {
        resource?: string;
        amount?: number;
        price?: number;
      };
      if (typeof resource !== 'string' || typeof amount !== 'number' || typeof price !== 'number') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (!(amount > 0) || !(price >= 0)) return h.reject('E_BAD_PAYLOAD');
      if (!h.ctx.data.resources.includes(resource)) return h.reject('E_UNKNOWN_RESOURCE');
      const seller = h.state.players[action.playerId];
      if (!seller) return h.reject('E_FORBIDDEN');
      if ((seller.resources[resource] ?? 0) < amount) return h.reject('E_INSUFFICIENT');

      seller.resources[resource] = (seller.resources[resource] ?? 0) - amount; // escrow the goods
      const seq = (h.state.marketSeq ?? 0) + 1;
      h.state.marketSeq = seq;
      const o: MarketOrder = { id: `market:${seq}`, seller: action.playerId, resource, amount, price };
      (h.state.market ??= []).push(o);
      h.emit('market.listed', { orderId: o.id, seller: o.seller, resource, amount, price });
    });

    api.onAction('market.buy', (action, h) => {
      const { orderId, amount } = action.payload as { orderId?: string; amount?: number };
      if (typeof orderId !== 'string' || typeof amount !== 'number' || !(amount > 0)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const o = findOrder(h.state, orderId);
      if (!o) return h.reject('E_NO_ORDER');
      if (o.seller === action.playerId) return h.reject('E_OWN_ORDER'); // can't buy your own listing
      if (amount > o.amount) return h.reject('E_BAD_AMOUNT'); // more than is on offer
      const buyer = h.state.players[action.playerId];
      const seller = h.state.players[o.seller];
      if (!buyer || !seller) return h.reject('E_FORBIDDEN');
      const cost = amount * o.price;
      if ((buyer.resources[MONEY] ?? 0) < cost) return h.reject('E_INSUFFICIENT');

      buyer.resources[MONEY] = (buyer.resources[MONEY] ?? 0) - cost;
      seller.resources[MONEY] = (seller.resources[MONEY] ?? 0) + cost * (1 - COMMISSION); // 15% burned
      buyer.resources[o.resource] = (buyer.resources[o.resource] ?? 0) + amount; // deliver the escrowed goods
      o.amount -= amount;
      if (o.amount <= 0) {
        h.state.market = (h.state.market ?? []).filter((x) => x.id !== o.id);
      }
      h.emit('market.bought', {
        orderId,
        buyer: action.playerId,
        seller: o.seller,
        resource: o.resource,
        amount,
        paid: cost,
      });
    });

    api.onAction('market.cancel', (action, h) => {
      const { orderId } = action.payload as { orderId?: string };
      if (typeof orderId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const o = findOrder(h.state, orderId);
      if (!o) return h.reject('E_NO_ORDER');
      if (o.seller !== action.playerId) return h.reject('E_FORBIDDEN');
      const seller = h.state.players[action.playerId];
      if (seller) seller.resources[o.resource] = (seller.resources[o.resource] ?? 0) + o.amount; // refund escrow
      h.state.market = (h.state.market ?? []).filter((x) => x.id !== o.id);
      h.emit('market.cancelled', { orderId, seller: action.playerId, resource: o.resource, amount: o.amount });
    });
  },
};
