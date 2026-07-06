import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthApi } from './authApi';
import { signSessionToken, verifySessionToken, hmacSecret } from './auth';
import { MemoryUserStore } from './store';
import { registerMatchApi, type MatchApiDeps } from './matchApi';
import type { ScryptParams } from './password';

// SE-1.x — the login+password HTTP API: registration, login, uniform failures,
// rate limiting, and the session gate on the match API.

const FAST: ScryptParams = { N: 2 ** 12, r: 8, p: 1 };
const KEY = hmacSecret('test-secret');
const SIGN = { key: KEY, algorithm: 'HS256', issuer: 'test', audience: 'session' };
const VERIFY = { key: KEY, algorithms: ['HS256'], issuer: 'test', audience: 'session' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

interface AuthAppOptions {
  now?: () => number;
  rateMax?: number;
  rateWindowMs?: number;
}

function authApp(options: AuthAppOptions = {}): FastifyInstance {
  app = Fastify();
  registerAuthApi(app, {
    users: new MemoryUserStore(),
    signSession: (accountId, login) =>
      signSessionToken({ accountId, login }, SIGN, { ttlSeconds: 3600 }),
    scryptParams: FAST,
    ...options,
  });
  return app;
}

const post = (
  server: FastifyInstance,
  url: string,
  body: unknown,
): Promise<{ statusCode: number; json(): unknown }> =>
  server.inject({ method: 'POST', url, payload: body as object });

describe('SE-1.x · /auth/register + /auth/login', () => {
  it('registers an account and returns a working session token', async () => {
    const server = authApp();
    const r = await post(server, '/auth/register', { login: 'Vasya', password: 'longenough' });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { accountId: string; login: string; token: string };
    expect(body.login).toBe('Vasya');
    expect(body.accountId).not.toBe('');
    const verified = await verifySessionToken(body.token, VERIFY);
    expect(verified).toEqual({
      ok: true,
      claim: { accountId: body.accountId, login: 'Vasya' },
    });
  });

  it('logs in with the right password; rejects a wrong one and an unknown login UNIFORMLY', async () => {
    const server = authApp();
    await post(server, '/auth/register', { login: 'alice', password: 'password-1' });

    const ok = await post(server, '/auth/login', { login: 'alice', password: 'password-1' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { login: string }).login).toBe('alice');

    const wrongPw = await post(server, '/auth/login', { login: 'alice', password: 'password-2' });
    const noUser = await post(server, '/auth/login', { login: 'nobody99', password: 'password-1' });
    // The SAME status and the SAME body — account existence does not leak.
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual({ error: 'E_AUTH' });
    expect(noUser.json()).toEqual({ error: 'E_AUTH' });
  });

  it('login lookup is case-insensitive and keeps the registered display form', async () => {
    const server = authApp();
    await post(server, '/auth/register', { login: 'Vasya', password: 'longenough' });
    const dup = await post(server, '/auth/register', { login: 'vasya', password: 'longenough' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'E_LOGIN_TAKEN' });

    const r = await post(server, '/auth/login', { login: 'VASYA', password: 'longenough' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { login: string }).login).toBe('Vasya'); // display form preserved
  });

  it('rejects malformed credentials with one stable code (no field-level detail)', async () => {
    const server = authApp();
    for (const bad of [
      { login: 'ok_login', password: 'short' }, // < 8 chars
      { login: 'ok_login', password: 'x'.repeat(129) }, // > 128 chars
      { login: 'no', password: 'longenough' }, // login too short
      { login: 'bad name!', password: 'longenough' }, // forbidden chars
      { login: 'ok_login' }, // missing password
      {}, // missing everything
    ]) {
      const r = await post(server, '/auth/register', bad);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'E_BAD_CREDENTIALS' });
    }
    // A JSON body that isn't an object at all (same stable code)…
    const str = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: '"not an object"',
      headers: { 'content-type': 'application/json' },
    });
    expect(str.statusCode).toBe(400);
    expect(str.json()).toEqual({ error: 'E_BAD_CREDENTIALS' });
    // …and a non-JSON body never reaches the route as credentials — Fastify's
    // content-type/JSON parsing refuses it with a 4xx (415 or 400 by version).
    const text = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: 'login=x&password=y',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBeGreaterThanOrEqual(400);
    expect(text.statusCode).toBeLessThan(500);
  });

  it('rate-limits per IP across register+login, and the window resets', async () => {
    let clock = 1_000;
    const server = authApp({ now: () => clock, rateMax: 3, rateWindowMs: 60_000 });
    const creds = { login: 'busy_bee', password: 'longenough' };
    await post(server, '/auth/register', creds);
    await post(server, '/auth/login', creds);
    await post(server, '/auth/login', creds);
    const throttled = await post(server, '/auth/login', creds);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: 'E_RATE_LIMIT' });

    clock += 60_001; // backoff past the window → attempts admit again
    const after = await post(server, '/auth/login', creds);
    expect(after.statusCode).toBe(200);
  });
});

describe('SE-1.x · session gate on the match API', () => {
  function gatedApp(): { server: FastifyInstance; users: MemoryUserStore } {
    const users = new MemoryUserStore();
    app = Fastify();
    registerAuthApi(app, {
      users,
      signSession: (accountId, login) =>
        signSessionToken({ accountId, login }, SIGN, { ttlSeconds: 3600 }),
      scryptParams: FAST,
    });
    const deps: MatchApiDeps = {
      createMatch: () => Promise.resolve({ matchId: 'm1', seats: ['green', 'red'] }),
      join: (matchId, nick, accountId) =>
        Promise.resolve({ playerId: 'green', token: `join:${matchId}:${nick}:${accountId}` }),
      identify: async (request) => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const v = await verifySessionToken(header.slice(7), VERIFY);
        return v.ok ? v.claim : null;
      },
    };
    registerMatchApi(app, deps);
    return { server: app, users };
  }

  it('join requires a session; the seat goes to the SESSION login, not a query nick', async () => {
    const { server } = gatedApp();
    const reg = await post(server, '/auth/register', { login: 'bob', password: 'longenough' });
    const { token, accountId } = reg.json() as { token: string; accountId: string };

    // No session → 401; a ?nick= cannot substitute for identity.
    const anon = await server.inject({ method: 'GET', url: '/matches/m1/join?nick=mallory' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: 'E_AUTH' });

    // With a session, the nick IS the account login (query nick ignored).
    const joined = await server.inject({
      method: 'GET',
      url: '/matches/m1/join?nick=mallory',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(joined.statusCode).toBe(200);
    expect((joined.json() as { token: string }).token).toBe(`join:m1:bob:${accountId}`);
  });

  it('create requires a session too; garbage bearer tokens are rejected', async () => {
    const { server } = gatedApp();
    const anon = await server.inject({ method: 'POST', url: '/matches' });
    expect(anon.statusCode).toBe(401);
    const forged = await server.inject({
      method: 'POST',
      url: '/matches',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(forged.statusCode).toBe(401);

    const reg = await post(server, '/auth/register', { login: 'creator', password: 'longenough' });
    const { token } = reg.json() as { token: string };
    const created = await server.inject({
      method: 'POST',
      url: '/matches',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ matchId: 'm1', seats: ['green', 'red'] });
  });
});
