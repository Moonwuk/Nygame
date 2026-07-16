import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerMedalApi } from './medalApi';
import { MedalService } from './medalService';
import { CorpService, type CorpActor } from './corpService';
import { parseMedalCatalog } from './medalCatalog';
import { MemoryAvaResultStore, MemoryCorpStore, MemoryMedalStore } from './store';
import type { Identity } from './matchApi';

// The medals HTTP contract: session gate, code→status map, and a grant round-trip.

function identifyByHeader(request: FastifyRequest): Promise<Identity | null> {
  const login = request.headers['x-test-user'];
  if (typeof login !== 'string' || login === '') return Promise.resolve(null);
  return Promise.resolve({ accountId: `acc-${login}`, login });
}
const as = (login: string): Record<string, string> => ({ 'x-test-user': login });
const actor = (login: string): CorpActor => ({ accountId: `acc-${login}`, login });

const catalog = parseMedalCatalog({
  medals: {
    first_win: { name: 'First', description: 'd', scope: 'corp', grant: 'manual', condition: { type: 'corp_wins', count: 1 } },
  },
});

async function harness(): Promise<{ app: ReturnType<typeof Fastify>; corpA: string; results: MemoryAvaResultStore }> {
  const store = new MemoryCorpStore();
  const results = new MemoryAvaResultStore();
  const corp = new CorpService({ store });
  const a = await corp.create(actor('alice'), 'Alliance A'); // alice = head
  const b = await corp.create(actor('carol'), 'Alliance B');
  if (!a.ok || !b.ok) throw new Error('harness');
  await corp.apply(actor('bob'), a.corpId);
  await corp.accept(actor('alice'), a.corpId, actor('bob').accountId); // bob = member of A
  const service = new MedalService({ corpStore: store, resultStore: results, medalStore: new MemoryMedalStore(), catalog });
  const app = Fastify();
  registerMedalApi(app, { service, identify: identifyByHeader });
  return { app, corpA: a.corpId, results };
}

describe('medals HTTP API', () => {
  it('is session-gated: anonymous → 401 on every route', async () => {
    const { app } = await harness();
    for (const route of [
      { method: 'GET' as const, url: '/medals' },
      { method: 'GET' as const, url: '/medals/me' },
      { method: 'GET' as const, url: '/medals/eligible' },
      { method: 'POST' as const, url: '/medals/grant', payload: { target: 'x', medalId: 'first_win' } },
    ]) {
      expect((await app.inject(route)).statusCode, route.url).toBe(401);
    }
    await app.close();
  });

  it('grants over HTTP once the corp is eligible, and surfaces the earned medal', async () => {
    const { app, corpA, results } = await harness();
    // catalog is public-ish (session only)
    expect((await app.inject({ method: 'GET', url: '/medals', headers: as('alice') })).json()).toMatchObject({
      medals: [{ id: 'first_win' }],
    });
    // not eligible → 409
    const early = await app.inject({ method: 'POST', url: '/medals/grant', headers: as('alice'), payload: { target: 'acc-bob', medalId: 'first_win' } });
    expect(early.statusCode).toBe(409);
    // record a win for corp A → eligible
    await results.record({ matchupId: 'mu1', challengerCorp: corpA, targetCorp: 'x', winnerCorp: corpA, at: 1 });
    const grant = await app.inject({ method: 'POST', url: '/medals/grant', headers: as('alice'), payload: { target: 'acc-bob', medalId: 'first_win' } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toEqual({ ok: true, awarded: true });
    // bob sees it on his card
    const mine = (await app.inject({ method: 'GET', url: '/medals/me', headers: as('bob') })).json() as { medals: Array<{ medalId: string }> };
    expect(mine.medals.map((m) => m.medalId)).toEqual(['first_win']);
    await app.close();
  });
});
