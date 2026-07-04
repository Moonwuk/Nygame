import { describe, expect, it } from 'vitest';
import { createStores } from './persistence';

// 2.2 — createStores wires a durable-capable AccountStore alongside the match/receipt
// stores (review #6). Here we exercise the memory backend (no DATABASE_URL); the Postgres
// AccountStore itself is covered by store.test.ts's shared contract.

describe('createStores', () => {
  it('memory backend provides store, receiptStore, and a working accountStore', async () => {
    const stores = await createStores({}); // no DATABASE_URL → memory
    try {
      expect(stores.kind).toBe('memory');
      expect(stores.store).toBeDefined();
      expect(stores.receiptStore).toBeDefined();

      // The account store is wired and behaves (first-come sticky seat).
      const first = await stores.accountStore.resolveSeat('room-1', 'alice', ['green', 'red']);
      expect(first).toEqual({ playerId: 'green', isNew: true });
      const again = await stores.accountStore.resolveSeat('room-1', 'alice', ['green', 'red']);
      expect(again).toEqual({ playerId: 'green', isNew: false });
    } finally {
      await stores.close();
    }
  });
});
