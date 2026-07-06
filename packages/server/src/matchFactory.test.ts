import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GameData } from '@void/shared-core';
import { MatchKeeper, type MatchKeeperOptions } from './matchFactory';
import { registerOpenMatchesFeed } from './matchApi';
import { MemoryMatchStore, MemoryAccountStore } from './store';
import { createDevMatch, loadShippedData } from './scenario';
import { snapshotOf } from './persistence';

// SV-2.5 — the match factory keeps a target number of OPEN matches available, reading
// the open count from the durable store so it is restart-safe. Plus the /matches/open feed.

/** A keeper over in-memory fakes: `create` just appends an open (0-seat) match id. */
function fakeKeeper(over: Partial<MatchKeeperOptions> = {}) {
  const ongoing: string[] = [];
  const occ = new Map<string, number>();
  let n = 0;
  const opts: MatchKeeperOptions = {
    target: 3,
    max: 10,
    capacity: 2,
    listOngoing: () => Promise.resolve([...ongoing]),
    occupiedSeats: (id: string) => Promise.resolve(occ.get(id) ?? 0),
    create: () => {
      const id = `m${++n}`;
      ongoing.push(id);
      occ.set(id, 0);
      return Promise.resolve();
    },
    ...over,
  };
  return { keeper: new MatchKeeper(opts), ongoing, occ, opts };
}

describe('SV-2.5 · MatchKeeper — keep N open matches', () => {
  it('seeds up to target when the feed is empty', async () => {
    const { keeper, ongoing } = fakeKeeper({ target: 3, max: 10 });
    expect(await keeper.tick()).toBe(3);
    expect(ongoing).toHaveLength(3);
    // A second pass is a no-op — target already met.
    expect(await keeper.tick()).toBe(0);
    expect(ongoing).toHaveLength(3);
  });

  it('counts full matches as NOT open and tops up to keep target joinable', async () => {
    const { keeper, ongoing, occ } = fakeKeeper({ target: 2, max: 10 });
    await keeper.tick(); // → 2 open matches (m1, m2)
    expect(ongoing).toHaveLength(2);
    occ.set('m1', 2); // m1 fills up → only m2 is open now
    expect(await keeper.tick()).toBe(1); // seed one more to keep 2 open
    expect(ongoing).toHaveLength(3);
    expect(await keeper.tick()).toBe(0); // 2 open again (m2, m3) — steady
  });

  it('never pushes past the max concurrent cap', async () => {
    // 9 FULL matches already exist; target 3 wants more open, but the cap allows only 1.
    const ongoing = Array.from({ length: 9 }, (_, i) => `full${i}`);
    const occ = new Map<string, number>(ongoing.map((id) => [id, 2]));
    let made = 0;
    const keeper = new MatchKeeper({
      target: 3,
      max: 10,
      capacity: 2,
      listOngoing: () => Promise.resolve([...ongoing]),
      occupiedSeats: (id) => Promise.resolve(occ.get(id) ?? 0),
      create: () => {
        made += 1;
        ongoing.push(`new${made}`);
        occ.set(`new${made}`, 0);
        return Promise.resolve();
      },
    });
    expect(await keeper.tick()).toBe(1); // min(target-open=3, cap-total=10-9=1) = 1
    expect(made).toBe(1);
  });

  it('contains a create failure, then recovers on the next tick', async () => {
    let fail = true;
    const errors: unknown[] = [];
    let made = 0;
    const keeper = new MatchKeeper({
      target: 2,
      max: 10,
      capacity: 2,
      listOngoing: () => Promise.resolve([]),
      occupiedSeats: () => Promise.resolve(0),
      create: () => {
        if (fail) return Promise.reject(new Error('store down'));
        made += 1;
        return Promise.resolve();
      },
      onError: (e) => errors.push(e),
    });
    expect(await keeper.tick()).toBe(0); // first create throws → burst stops, no crash
    expect(errors).toHaveLength(1);
    fail = false;
    // listOngoing still returns [] (the fake never recorded a match), so target is 2.
    expect(await keeper.tick()).toBe(2);
    expect(made).toBe(2);
  });

  it('is reentrancy-guarded: an overlapping tick does not double-create', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let created = 0;
    const keeper = new MatchKeeper({
      target: 3,
      max: 10,
      capacity: 2,
      listOngoing: async () => {
        await gate; // hold the first tick inside its read
        return [];
      },
      occupiedSeats: () => Promise.resolve(0),
      create: () => {
        created += 1;
        return Promise.resolve();
      },
    });
    const first = keeper.tick();
    const second = await keeper.tick(); // starts while `first` is parked → skipped
    expect(second).toBe(0);
    release();
    expect(await first).toBe(3);
    expect(created).toBe(3); // exactly one tick did the work
  });

  it('a store-read failure is swallowed (retried next tick), never thrown', async () => {
    const errors: unknown[] = [];
    let down = true;
    const keeper = new MatchKeeper({
      target: 1,
      max: 10,
      capacity: 2,
      listOngoing: () => (down ? Promise.reject(new Error('db')) : Promise.resolve([])),
      occupiedSeats: () => Promise.resolve(0),
      create: () => Promise.resolve(),
      onError: (e) => errors.push(e),
    });
    expect(await keeper.tick()).toBe(0);
    expect(errors).toHaveLength(1);
    down = false;
    expect(await keeper.tick()).toBe(1);
  });
});

describe('SV-2.5 · MatchKeeper — integration over the real memory stores', () => {
  let data: GameData;
  beforeAll(() => {
    data = loadShippedData();
  });

  it('fills the store to target and keeps it topped up as seats fill', async () => {
    const store = new MemoryMatchStore();
    const accounts = new MemoryAccountStore();
    let n = 0;
    const keeper = new MatchKeeper({
      target: 2,
      max: 100,
      capacity: 2,
      listOngoing: () => store.ongoingMatchIds(),
      occupiedSeats: (id) => accounts.occupiedSeats(id),
      create: async () => {
        const seed = createDevMatch(data, { id: `m-${++n}`, time: 0 });
        await store.save(snapshotOf(seed));
      },
    });

    await keeper.tick();
    expect((await store.ongoingMatchIds()).sort()).toEqual(['m-1', 'm-2']);

    // Fill m-1 completely (both seats), then reconcile → a third match is seeded so two
    // stay OPEN, while m-1 remains ongoing-but-full.
    await accounts.resolveSeat('m-1', 'alice', ['green', 'red']);
    await accounts.resolveSeat('m-1', 'bob', ['green', 'red']);
    await keeper.tick();
    expect((await store.ongoingMatchIds()).sort()).toEqual(['m-1', 'm-2', 'm-3']);
    // Steady state: m-2 and m-3 are open (2), m-1 is full → no further seeding.
    expect(await keeper.tick()).toBe(0);
  });
});

describe('SV-2.5 · GET /matches/open feed', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('lists ongoing matches with a free seat, omitting full ones', async () => {
    const store = new MemoryMatchStore();
    const accounts = new MemoryAccountStore();
    const data = loadShippedData();
    for (const id of ['open1', 'full1', 'open2']) {
      await store.save(snapshotOf(createDevMatch(data, { id, time: 0 })));
    }
    await accounts.resolveSeat('full1', 'a', ['green', 'red']);
    await accounts.resolveSeat('full1', 'b', ['green', 'red']); // full1 now 2/2

    app = Fastify();
    registerOpenMatchesFeed(app, {
      listOngoing: () => store.ongoingMatchIds(),
      occupiedSeats: (id) => accounts.occupiedSeats(id),
      capacity: 2,
    });
    const res = await app.inject({ method: 'GET', url: '/matches/open' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { open: Array<{ matchId: string; seated: number; capacity: number }> };
    expect(body.open.map((m) => m.matchId).sort()).toEqual(['open1', 'open2']);
    expect(body.open.every((m) => m.capacity === 2 && m.seated < 2)).toBe(true);
  });
});
