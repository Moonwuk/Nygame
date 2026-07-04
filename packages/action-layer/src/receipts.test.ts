import { describe, expect, it } from 'vitest';
import { InMemoryActionReceiptStore, type ActionReceipt } from './receipts';

// SV-1.1-live-B: the gate's receipt store is bounded (FIFO eviction), so a long-running
// or hostile session can't grow it without limit (the review MAJOR). Idempotency holds
// for the retained window (minutes), matching MatchRoom's bounded receipts.

function receipt(n: number, ok = true): ActionReceipt {
  return {
    actionId: `sess:p1:${n}`,
    matchId: 'm',
    playerId: 'p1',
    sessionId: 'sess',
    clientSeq: n,
    acceptedAt: 1000 + n,
    ok,
  };
}

describe('InMemoryActionReceiptStore · bounded', () => {
  it('holds at the cap, evicting the oldest (FIFO)', () => {
    const store = new InMemoryActionReceiptStore({ maxEntries: 3 });
    for (let n = 1; n <= 10; n++) store.put(receipt(n));

    expect(store.size).toBe(3);
    expect(store.get('sess:p1:8')).toBeDefined(); // last 3 retained
    expect(store.get('sess:p1:9')).toBeDefined();
    expect(store.get('sess:p1:10')).toBeDefined();
    expect(store.get('sess:p1:7')).toBeUndefined(); // evicted → its retry would re-apply
    expect(store.get('sess:p1:1')).toBeUndefined();
  });

  it('deduplicates within the window and re-applies past it', () => {
    const store = new InMemoryActionReceiptStore({ maxEntries: 2 });
    store.put(receipt(1));
    expect(store.get('sess:p1:1')?.ok).toBe(true); // deduped while retained

    store.put(receipt(2));
    store.put(receipt(3)); // evicts #1
    expect(store.get('sess:p1:1')).toBeUndefined(); // past the window → caller re-applies
  });

  it('keeps the first verdict for an id (stable, ignores a later put)', () => {
    const store = new InMemoryActionReceiptStore({ maxEntries: 10 });
    store.put(receipt(1, true));
    store.put(receipt(1, false)); // same id, different verdict → ignored
    expect(store.get('sess:p1:1')?.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it('defaults to a large cap when unset or invalid', () => {
    expect(new InMemoryActionReceiptStore().size).toBe(0);
    const store = new InMemoryActionReceiptStore({ maxEntries: 0 }); // invalid → default
    for (let n = 1; n <= 100; n++) store.put(receipt(n));
    expect(store.size).toBe(100); // nowhere near the 10k default
  });
});
