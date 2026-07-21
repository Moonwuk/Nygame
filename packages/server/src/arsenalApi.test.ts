import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerArsenalApi } from './arsenalApi';
import { MemoryArsenalStore } from './store';
import type { Identity } from './matchApi';

// The arsenal HTTP contract (ARS-5): session gate, and a caller only ever sees
// their OWN items — never another account's, even by guessing an accountId.

function identifyByHeader(request: FastifyRequest): Promise<Identity | null> {
  const login = request.headers['x-test-user'];
  if (typeof login !== 'string' || login === '') return Promise.resolve(null);
  return Promise.resolve({ accountId: `acc-${login}`, login });
}
const as = (login: string): Record<string, string> => ({ 'x-test-user': login });

async function harness(): Promise<{ app: ReturnType<typeof Fastify>; store: MemoryArsenalStore }> {
  const store = new MemoryArsenalStore();
  const app = Fastify();
  registerArsenalApi(app, { store, identify: identifyByHeader });
  return { app, store };
}

describe('arsenal HTTP API', () => {
  it('is session-gated: anonymous → 401', async () => {
    const { app } = await harness();
    expect((await app.inject({ method: 'GET', url: '/arsenal/me' })).statusCode).toBe(401);
    await app.close();
  });

  it("returns the caller's own items and never a stranger's", async () => {
    const { app, store } = await harness();
    await store.grant({
      itemId: 'starter:acc-alice:hull:cruiser',
      accountId: 'acc-alice',
      kind: 'hull',
      form: 'blueprint',
      defId: 'cruiser',
      soulbound: true,
      origin: 'starter',
      acquiredAt: 0,
    });
    await store.grant({
      itemId: 'starter:acc-bob:hull:cruiser',
      accountId: 'acc-bob',
      kind: 'hull',
      form: 'blueprint',
      defId: 'cruiser',
      soulbound: true,
      origin: 'starter',
      acquiredAt: 0,
    });
    const mine = await app.inject({ method: 'GET', url: '/arsenal/me', headers: as('alice') });
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as { items: Array<{ itemId: string }> };
    expect(body.items.map((i) => i.itemId)).toEqual(['starter:acc-alice:hull:cruiser']);
    await app.close();
  });
});
