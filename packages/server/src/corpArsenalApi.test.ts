import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerCorpArsenalApi } from './corpArsenalApi';
import { CorpArsenalService } from './corpArsenalService';
import { CorpService, type CorpActor } from './corpService';
import {
  MemoryArsenalStore,
  MemoryAvaChallengeStore,
  MemoryAvaRosterStore,
  MemoryCorpRentStore,
  MemoryCorpStore,
} from './store';
import type { Identity } from './matchApi';

// The corp-arsenal HTTP contract (ARS-6): session gate + a round trip through the
// same RBAC/roster checks the service unit tests already cover in depth.

const HEAD: CorpActor = { accountId: 'head', login: 'head' };
const FIGHTER: CorpActor = { accountId: 'fighter', login: 'fighter' };

function identifyByHeader(request: FastifyRequest): Promise<Identity | null> {
  const login = request.headers['x-test-user'];
  if (typeof login !== 'string' || login === '') return Promise.resolve(null);
  return Promise.resolve({ accountId: login, login });
}
const as = (accountId: string): Record<string, string> => ({ 'x-test-user': accountId });

async function harness(): Promise<{ app: ReturnType<typeof Fastify>; corpId: string; itemId: string }> {
  const corps = new MemoryCorpStore();
  const arsenal = new MemoryArsenalStore();
  const rentals = new MemoryCorpRentStore();
  const challenges = new MemoryAvaChallengeStore();
  const roster = new MemoryAvaRosterStore();
  const corp = new CorpService({ store: corps });
  const a = await corp.create(HEAD, 'Alliance A');
  const b = await corp.create({ accountId: 'other', login: 'other' }, 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('harness');
  await corp.apply(FIGHTER, a.corpId);
  await corp.accept(HEAD, a.corpId, FIGHTER.accountId);

  const matchupId = 'mu-http';
  await challenges.createChallenge({
    id: matchupId,
    challengerCorp: a.corpId,
    targetCorp: b.corpId,
    cost: 0,
    status: 'accepted',
    createdAt: 0,
    expiresAt: 0,
    pauseEndsAt: 100,
  });
  await roster.addEntry({ matchupId, accountId: FIGHTER.accountId, side: 'challenger', source: 'flagged', at: 1 }, 10);

  const itemId = 'flagship-http';
  await arsenal.grant({
    itemId,
    accountId: a.corpId,
    kind: 'hull',
    form: 'blueprint',
    defId: 'cruiser',
    soulbound: false,
    origin: 'auction',
    acquiredAt: 0,
  });

  const service = new CorpArsenalService({
    corpStore: corps,
    arsenalStore: arsenal,
    rentStore: rentals,
    challengeStore: challenges,
    rosterStore: roster,
  });
  const app = Fastify();
  registerCorpArsenalApi(app, { service, identify: identifyByHeader });
  return { app, corpId: a.corpId, itemId };
}

describe('corp-arsenal HTTP API', () => {
  it('is session-gated: anonymous → 401', async () => {
    const { app } = await harness();
    const r = await app.inject({
      method: 'POST',
      url: '/corp-arsenal/rent',
      payload: { corpId: 'x', itemId: 'x', matchupId: 'x', accountId: 'x' },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const { app } = await harness();
    const r = await app.inject({
      method: 'POST',
      url: '/corp-arsenal/rent',
      headers: as(HEAD.accountId),
      payload: { corpId: 'x' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('the head hands the flagship to the rostered fighter — 200, then a re-rent 409s', async () => {
    const { app, corpId, itemId } = await harness();
    const r1 = await app.inject({
      method: 'POST',
      url: '/corp-arsenal/rent',
      headers: as(HEAD.accountId),
      payload: { corpId, itemId, matchupId: 'mu-http', accountId: FIGHTER.accountId },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ok: true });

    const r2 = await app.inject({
      method: 'POST',
      url: '/corp-arsenal/rent',
      headers: as(HEAD.accountId),
      payload: { corpId, itemId, matchupId: 'mu-http', accountId: FIGHTER.accountId },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual({ error: 'E_ALREADY_RENTED' });
    await app.close();
  });

  it('a non-officer gets 403', async () => {
    const { app, corpId, itemId } = await harness();
    const r = await app.inject({
      method: 'POST',
      url: '/corp-arsenal/rent',
      headers: as(FIGHTER.accountId), // a plain member, not head/officer
      payload: { corpId, itemId, matchupId: 'mu-http', accountId: FIGHTER.accountId },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'E_FORBIDDEN' });
    await app.close();
  });
});
