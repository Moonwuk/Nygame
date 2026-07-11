import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions } from 'fastify';
import { registerCorpApi, type CorpApiDeps } from './corpApi';
import { CorpService } from './corpService';
import { MemoryCorpStore } from './store';
import type { Identity } from './matchApi';

// CORP-0 — the corp HTTP routes. The service owns the rights matrix (see
// corpService.test.ts); here we verify the HTTP contract: the session gate on every
// route, payload parsing, the code→status map, and the write-path rate limit.

/** Test identity: `x-test-user: <login>` — the shape main.ts resolves from the
 *  session JWT. No header → anonymous (401 everywhere). */
function identifyByHeader(request: FastifyRequest): Promise<Identity | null> {
  const login = request.headers['x-test-user'];
  if (typeof login !== 'string' || login === '') return Promise.resolve(null);
  return Promise.resolve({ accountId: `acc-${login}`, login });
}

function appWith(overrides: Partial<CorpApiDeps> = {}): FastifyInstance {
  const app = Fastify();
  registerCorpApi(app, {
    service: new CorpService({ store: new MemoryCorpStore(), now: () => 7 }),
    identify: identifyByHeader,
    ...overrides,
  });
  return app;
}

const as = (login: string): Record<string, string> => ({ 'x-test-user': login });

async function createCorp(app: FastifyInstance, login: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/corps',
    headers: as(login),
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { corpId: string }).corpId;
}

describe('CORP-0 · corp API', () => {
  it('every route is session-gated: anonymous → uniform 401 E_AUTH', async () => {
    const app = appWith();
    const routes = [
      { method: 'GET' as const, url: '/corps' },
      { method: 'GET' as const, url: '/corps/me' },
      { method: 'GET' as const, url: '/corps/some-id' },
      { method: 'GET' as const, url: '/corps/some-id/audit' },
      { method: 'POST' as const, url: '/corps', payload: { name: 'Ghost Corp' } },
      { method: 'POST' as const, url: '/corps/some-id/apply' },
    ];
    for (const route of routes) {
      const res = await app.inject(route);
      expect(res.statusCode, route.url).toBe(401);
      expect(res.json()).toEqual({ error: 'E_AUTH' });
    }
    await app.close();
  });

  it('create → browse → detail → me: the full read surface', async () => {
    const app = appWith();
    const corpId = await createCorp(app, 'alice', 'Void Miners');

    const list = await app.inject({ method: 'GET', url: '/corps', headers: as('bob') });
    expect(list.json()).toEqual({
      corps: [{ corpId, name: 'Void Miners', members: 1, influence: 0 }],
    });

    const detail = await app.inject({ method: 'GET', url: `/corps/${corpId}`, headers: as('bob') });
    expect(detail.json()).toEqual({
      corp: { corpId, name: 'Void Miners', influence: 0 },
      members: [{ corpId, accountId: 'acc-alice', login: 'alice', role: 'head' }],
    });

    const mine = await app.inject({ method: 'GET', url: '/corps/me', headers: as('alice') });
    expect(mine.json()).toMatchObject({
      corp: { corpId },
      membership: { role: 'head' },
    });
    const nobody = await app.inject({ method: 'GET', url: '/corps/me', headers: as('bob') });
    expect(nobody.json()).toEqual({ corp: null, membership: null });
    await app.close();
  });

  it('apply → accept → role → transfer → leave: intents thread the session identity', async () => {
    const app = appWith();
    const corpId = await createCorp(app, 'alice', 'Void Miners');
    const post = (login: string, intent: string, payload?: object) =>
      app.inject({
        method: 'POST',
        url: `/corps/${corpId}/${intent}`,
        headers: as(login),
        payload,
      });

    expect((await post('bob', 'apply')).statusCode).toBe(200);
    expect((await post('alice', 'accept', { target: 'acc-bob' })).statusCode).toBe(200);
    expect((await post('alice', 'role', { target: 'acc-bob', role: 'officer' })).statusCode).toBe(
      200,
    );
    expect((await post('alice', 'transfer', { target: 'acc-bob' })).statusCode).toBe(200);
    expect((await post('alice', 'leave')).statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/corps/${corpId}`, headers: as('bob') });
    expect((detail.json() as { members: Array<{ login: string; role: string }> }).members).toEqual([
      { corpId, accountId: 'acc-bob', login: 'bob', role: 'head' },
    ]);
    await app.close();
  });

  it('maps stable codes to statuses (400/403/404/409)', async () => {
    const app = appWith();
    const corpId = await createCorp(app, 'alice', 'Void Miners');

    const expectFail = async (
      route: InjectOptions,
      status: number,
      code: string,
    ): Promise<void> => {
      const res = await app.inject(route);
      expect(res.statusCode, code).toBe(status);
      expect(res.json()).toEqual({ error: code });
    };

    // 400 — malformed payloads
    await expectFail(
      { method: 'POST', url: '/corps', headers: as('zoe'), payload: { name: 'x' } },
      400,
      'E_BAD_NAME',
    );
    await expectFail(
      { method: 'POST', url: `/corps/${corpId}/kick`, headers: as('alice'), payload: {} },
      400,
      'E_BAD_TARGET',
    );
    // 403 — an outsider acting on the corp
    await expectFail(
      {
        method: 'POST',
        url: `/corps/${corpId}/kick`,
        headers: as('mallory'),
        payload: { target: 'acc-alice' },
      },
      403,
      'E_FORBIDDEN',
    );
    await expectFail(
      { method: 'GET', url: `/corps/${corpId}/audit`, headers: as('mallory') },
      403,
      'E_FORBIDDEN',
    );
    // 404 — missing corp
    await expectFail({ method: 'GET', url: '/corps/nope', headers: as('alice') }, 404, 'E_NO_CORP');
    await expectFail(
      { method: 'POST', url: '/corps/nope/apply', headers: as('carol') },
      404,
      'E_NO_CORP',
    );
    // 409 — duplicate name (case-insensitive) / double membership
    await expectFail(
      { method: 'POST', url: '/corps', headers: as('dave'), payload: { name: 'VOID MINERS' } },
      409,
      'E_NAME_TAKEN',
    );
    await expectFail(
      { method: 'POST', url: '/corps', headers: as('alice'), payload: { name: 'Another' } },
      409,
      'E_IN_CORP',
    );
    await app.close();
  });

  it('the head with members cannot leave (409 E_HEAD_MUST_TRANSFER)', async () => {
    const app = appWith();
    const corpId = await createCorp(app, 'alice', 'Void Miners');
    await app.inject({ method: 'POST', url: `/corps/${corpId}/apply`, headers: as('bob') });
    await app.inject({
      method: 'POST',
      url: `/corps/${corpId}/accept`,
      headers: as('alice'),
      payload: { target: 'acc-bob' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/corps/${corpId}/leave`,
      headers: as('alice'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'E_HEAD_MUST_TRANSFER' });
    await app.close();
  });

  it('audit is readable by head/officers and reflects the actions taken', async () => {
    const app = appWith();
    const corpId = await createCorp(app, 'alice', 'Void Miners');
    await app.inject({ method: 'POST', url: `/corps/${corpId}/apply`, headers: as('bob') });
    await app.inject({
      method: 'POST',
      url: `/corps/${corpId}/decline`,
      headers: as('alice'),
      payload: { target: 'acc-bob' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/corps/${corpId}/audit`,
      headers: as('alice'),
    });
    expect(res.statusCode).toBe(200);
    const { audit } = res.json() as { audit: Array<{ action: string; actor: string }> };
    expect(audit.map((e) => e.action)).toEqual(['decline', 'create']); // newest first
    expect(audit[0]).toMatchObject({ actor: 'acc-alice' });
    await app.close();
  });

  it('rate-limits the WRITE routes per IP; reads stay free', async () => {
    const app = appWith({ now: () => 1_000, rateMax: 2 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/corps',
          headers: as('a'),
          payload: { name: 'Corp One' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url: '/corps/nope/apply', headers: as('b') })).statusCode,
    ).toBe(404);
    const throttled = await app.inject({
      method: 'POST',
      url: '/corps',
      headers: as('c'),
      payload: { name: 'Corp Two' },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: 'E_RATE_LIMIT' });
    // reads share no budget with writes
    expect((await app.inject({ method: 'GET', url: '/corps', headers: as('a') })).statusCode).toBe(
      200,
    );
    await app.close();
  });
});
