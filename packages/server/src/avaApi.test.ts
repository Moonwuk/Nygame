import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerAvaApi } from './avaApi';
import { AvaService } from './avaService';
import { CorpService, type CorpActor } from './corpService';
import { MemoryAvaChallengeStore, MemoryAvaRosterStore, MemoryCorpStore } from './store';
import type { Identity } from './matchApi';

// AVA-2/3/4 — the AvA HTTP routes. The service owns the state machine (see
// avaService.test.ts); here we verify the HTTP contract: the session gate, the
// code→status map, and a full challenge round-trip over the wire.

function identifyByHeader(request: FastifyRequest): Promise<Identity | null> {
  const login = request.headers['x-test-user'];
  if (typeof login !== 'string' || login === '') return Promise.resolve(null);
  return Promise.resolve({ accountId: `acc-${login}`, login });
}
const as = (login: string): Record<string, string> => ({ 'x-test-user': login });
const actor = (login: string): CorpActor => ({ accountId: `acc-${login}`, login });

interface Harness {
  app: FastifyInstance;
  corpA: string;
  corpB: string;
}

/** Two ready corps (A: alice head, B: bob head), each with influence, over one store. */
async function harness(): Promise<Harness> {
  const store = new MemoryCorpStore();
  const challenges = new MemoryAvaChallengeStore();
  let t = 0;
  const now = (): number => ++t;
  const corp = new CorpService({ store, now });
  const service = new AvaService({
    corpStore: store,
    challengeStore: challenges,
    rosterStore: new MemoryAvaRosterStore(),
    now,
    challengeCost: 100,
    expiryMs: 1000,
    pauseMs: 1000,
    capPerSide: 2,
  });

  const a = await corp.create(actor('alice'), 'Alliance A');
  const b = await corp.create(actor('bob'), 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('harness: create failed');
  await store.addInfluence(a.corpId, 500);
  await store.addInfluence(b.corpId, 500);

  const app = Fastify();
  registerAvaApi(app, { service, identify: identifyByHeader, now });
  return { app, corpA: a.corpId, corpB: b.corpId };
}

describe('AVA · readiness + challenge API', () => {
  it('every route is session-gated: anonymous → uniform 401', async () => {
    const { app } = await harness();
    const routes = [
      { method: 'GET' as const, url: '/ava/pool' },
      { method: 'GET' as const, url: '/ava/challenges' },
      { method: 'POST' as const, url: '/ava/ready/corp' },
      { method: 'POST' as const, url: '/ava/ready/player' },
      { method: 'POST' as const, url: '/ava/challenge', payload: { target: 'x' } },
      { method: 'POST' as const, url: '/ava/challenge/some-id/accept' },
    ];
    for (const route of routes) {
      const res = await app.inject(route);
      expect(res.statusCode, route.url).toBe(401);
    }
    await app.close();
  });

  it('drives a full challenge → accept round-trip over HTTP', async () => {
    const { app, corpA, corpB } = await harness();
    // both heads flag their corps ready
    expect(
      (await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('alice') }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('bob') })).statusCode,
    ).toBe(200);

    // the pool now shows both, with influence
    const pool = (
      await app.inject({ method: 'GET', url: '/ava/pool', headers: as('alice') })
    ).json() as {
      pool: Array<{ corpId: string; influence: number }>;
    };
    expect(pool.pool.map((c) => c.corpId).sort()).toEqual([corpA, corpB].sort());

    // alice challenges B
    const challenge = await app.inject({
      method: 'POST',
      url: '/ava/challenge',
      headers: as('alice'),
      payload: { target: corpB },
    });
    expect(challenge.statusCode).toBe(201);
    const { id } = challenge.json() as { id: string };

    // bob (target head) accepts → S2
    const accept = await app.inject({
      method: 'POST',
      url: `/ava/challenge/${id}/accept`,
      headers: as('bob'),
    });
    expect(accept.statusCode).toBe(200);
    const mine = (
      await app.inject({ method: 'GET', url: '/ava/challenges', headers: as('bob') })
    ).json() as {
      challenges: Array<{ status: string }>;
    };
    expect(mine.challenges[0]).toMatchObject({ status: 'accepted' });
    await app.close();
  });

  it('roster window over HTTP (AVA-6): join, curate, private opponent view', async () => {
    const { app, corpB } = await harness();
    await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('alice') });
    await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('bob') });
    const challenge = await app.inject({
      method: 'POST',
      url: '/ava/challenge',
      headers: as('alice'),
      payload: { target: corpB },
    });
    const { id } = challenge.json() as { id: string };
    await app.inject({ method: 'POST', url: `/ava/challenge/${id}/accept`, headers: as('bob') });

    // anonymous → 401 on every roster route
    for (const route of [
      { method: 'GET' as const, url: `/ava/matchup/${id}` },
      { method: 'POST' as const, url: `/ava/matchup/${id}/join` },
      { method: 'POST' as const, url: `/ava/matchup/${id}/roster`, payload: { players: [] } },
    ]) {
      expect((await app.inject(route)).statusCode, route.url).toBe(401);
    }

    // alice self-enrolls; her flagged head-pick also lands via the curated route
    expect(
      (await app.inject({ method: 'POST', url: `/ava/matchup/${id}/join`, headers: as('alice') }))
        .statusCode,
    ).toBe(200);
    // curating an UNFLAGGED account → 409 E_NOT_FLAGGED (nothing changes)
    const unflagged = await app.inject({
      method: 'POST',
      url: `/ava/matchup/${id}/roster`,
      headers: as('alice'),
      payload: { players: ['acc-ghost'] },
    });
    expect(unflagged.statusCode).toBe(409);
    expect((unflagged.json() as { error: string }).error).toBe('E_NOT_FLAGGED');
    // malformed list → 409, fail-secure
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/ava/matchup/${id}/roster`,
          headers: as('alice'),
          payload: { players: [42] },
        })
      ).statusCode,
    ).toBe(409);

    // bob (target side) sees only alice's HEADCOUNT, not her roster rows
    const view = (
      await app.inject({ method: 'GET', url: `/ava/matchup/${id}`, headers: as('bob') })
    ).json() as { side: string; mine: unknown[]; counts: Record<string, number> };
    expect(view.side).toBe('target');
    expect(view.mine).toHaveLength(0);
    expect(view.counts).toEqual({ challenger: 1, target: 0 });

    // an outsider is not a party → 403
    expect(
      (await app.inject({ method: 'GET', url: `/ava/matchup/${id}`, headers: as('carol') }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it('maps stable codes to statuses: not-ready 409, self 400, forbidden 403', async () => {
    const { app, corpA, corpB } = await harness();
    // challenge before anyone is ready → 409 E_NOT_READY
    const notReady = await app.inject({
      method: 'POST',
      url: '/ava/challenge',
      headers: as('alice'),
      payload: { target: corpB },
    });
    expect(notReady.statusCode).toBe(409);
    expect((notReady.json() as { error: string }).error).toBe('E_NOT_READY');

    await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('alice') });
    await app.inject({ method: 'POST', url: '/ava/ready/corp', headers: as('bob') });

    // self-challenge → 400
    const self = await app.inject({
      method: 'POST',
      url: '/ava/challenge',
      headers: as('alice'),
      payload: { target: corpA },
    });
    expect(self.statusCode).toBe(400);

    // a non-head cannot flag the corp → 403
    const carol = await app.inject({
      method: 'POST',
      url: '/ava/ready/corp',
      headers: as('carol'),
    });
    expect(carol.statusCode).toBe(403);
    await app.close();
  });
});
