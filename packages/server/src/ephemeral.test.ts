import { describe, expect, it } from 'vitest';
import { InMemoryEphemeralStore } from './ephemeral';

/**
 * The in-memory EphemeralStore is the single-process implementation of the seam a
 * Redis-backed store later replaces (docs/tech-stack.md). It must behave like Redis:
 * set/get/delete, prefix scan, and LAZY TTL expiry (a key vanishes on read once its
 * TTL passes). `now` is injectable so expiry is deterministic.
 */
describe('InMemoryEphemeralStore', () => {
  it('stores, reads and deletes values', async () => {
    const store = new InMemoryEphemeralStore(() => 0);
    await store.set('a', { v: 1 }, 1000);
    expect(await store.get<{ v: number }>('a')).toEqual({ v: 1 });
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });

  it('expires keys lazily once the TTL passes', async () => {
    let t = 0;
    const store = new InMemoryEphemeralStore(() => t);
    await store.set('k', 'live', 1000); // expiresAt = 1000

    t = 999;
    expect(await store.get('k')).toBe('live'); // still alive

    t = 1000;
    expect(await store.get('k')).toBeUndefined(); // expired at/after TTL
  });

  it('scans only live entries under a prefix', async () => {
    let t = 0;
    const store = new InMemoryEphemeralStore(() => t);
    await store.set('match:1:ping:a', { id: 'a' }, 1000);
    await store.set('match:1:ping:b', { id: 'b' }, 500);
    await store.set('match:2:ping:c', { id: 'c' }, 1000); // different prefix

    expect((await store.entries('match:1:ping:')).map((e) => e.key).sort()).toEqual([
      'match:1:ping:a',
      'match:1:ping:b',
    ]);

    t = 600; // 'b' (ttl 500) is gone, 'a' (ttl 1000) remains
    const live = await store.entries<{ id: string }>('match:1:ping:');
    expect(live.map((e) => e.value.id)).toEqual(['a']);
  });
});
