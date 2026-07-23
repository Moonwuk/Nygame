import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthApi, liveSession, pwFingerprint } from './authApi';
import {
  signSessionToken,
  verifySessionToken,
  signResetToken,
  verifyResetToken,
  hmacSecret,
} from './auth';
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
  onRegistered?: (accountId: string, login: string) => Promise<void>;
}

function authApp(options: AuthAppOptions = {}): FastifyInstance {
  app = Fastify();
  registerAuthApi(app, {
    users: new MemoryUserStore(),
    signSession: (accountId, login, pwfp) =>
      signSessionToken({ accountId, login, pwfp }, SIGN, { ttlSeconds: 3600 }),
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
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claim.accountId).toBe(body.accountId);
      expect(verified.claim.login).toBe('Vasya');
      expect(verified.claim.pwfp).not.toBe(''); // stamped with the password fingerprint
    }
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

  it('accepts the suggested cyrillic callsigns («Носорог-1») — the welcome golden path', async () => {
    const server = authApp();
    const r = await post(server, '/auth/register', { login: 'Носорог-1', password: 'longenough' });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { login: string }).login).toBe('Носорог-1');
    // …and unicode dedup stays case-insensitive
    const dup = await post(server, '/auth/register', { login: 'носорог-1', password: 'longenough' });
    expect(dup.statusCode).toBe(409);
    const ok = await post(server, '/auth/login', { login: 'НОСОРОГ-1', password: 'longenough' });
    expect(ok.statusCode).toBe(200);
    // spaces/emoji are still out — \p{L}\p{N}_- only
    const emoji = await post(server, '/auth/register', { login: 'зая🔥', password: 'longenough' });
    expect(emoji.statusCode).toBe(400);
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

  it('calls onRegistered once per successful registration (ARS-2 starter hook)', async () => {
    const registered: string[] = [];
    const server = authApp({
      onRegistered: (accountId) => {
        registered.push(accountId);
        return Promise.resolve();
      },
    });
    const r = await post(server, '/auth/register', { login: 'fresh', password: 'longenough' });
    const body = r.json() as { accountId: string };
    expect(registered).toEqual([body.accountId]);
    // a duplicate login fails registration → the hook does not fire again
    await post(server, '/auth/register', { login: 'fresh', password: 'longenough' });
    expect(registered).toHaveLength(1);
  });

  it('a throwing onRegistered never fails the registration itself', async () => {
    const server = authApp({
      onRegistered: () => Promise.reject(new Error('store down')),
    });
    const r = await post(server, '/auth/register', { login: 'lucky', password: 'longenough' });
    expect(r.statusCode).toBe(201); // the account exists; the idempotent hook re-runs out of band
    expect((r.json() as { login: string }).login).toBe('lucky');
  });
});

describe('SE-1.x · session gate on the match API', () => {
  function gatedApp(): { server: FastifyInstance; users: MemoryUserStore } {
    const users = new MemoryUserStore();
    app = Fastify();
    registerAuthApi(app, {
      users,
      signSession: (accountId, login, pwfp) =>
        signSessionToken({ accountId, login, pwfp }, SIGN, { ttlSeconds: 3600 }),
      scryptParams: FAST,
    });
    const deps: MatchApiDeps = {
      createMatch: () => Promise.resolve({ matchId: 'm1', seats: ['green', 'red'] }),
      join: (matchId, nick, accountId) =>
        Promise.resolve({ playerId: 'green', token: `join:${matchId}:${nick}:${accountId}` }),
      // Mirrors production (main.ts / netserver.ts): signature verify THEN a live re-check
      // against the current password, so a reset revokes older sessions at the seat gate.
      identify: async (request) => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const v = await verifySessionToken(header.slice(7), VERIFY);
        return v.ok ? liveSession(v.claim, users) : null;
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

  it('a password change revokes older sessions at the seat gate (pwfp freshness)', async () => {
    const { server, users } = gatedApp();
    const reg = await post(server, '/auth/register', { login: 'carol', password: 'longenough' });
    const { token, accountId } = reg.json() as { token: string; accountId: string };

    // The fresh session joins fine — its stamped fingerprint matches the stored hash.
    const before = await server.inject({
      method: 'GET',
      url: '/matches/m1/join',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    // The password changes (a reset) → the OLD session, stamped with the pre-change
    // fingerprint, is revoked even though its JWT is still valid.
    await users.setPassword(accountId, 'a-different-hash');
    const after = await server.inject({
      method: 'GET',
      url: '/matches/m1/join',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: 'E_AUTH' });
  });
});

describe('SE-1.x · password recovery (/auth/recover + /auth/reset)', () => {
  const RESET_SIGN = { key: KEY, algorithm: 'HS256', issuer: 'test', audience: 'reset' };
  const RESET_VERIFY = { key: KEY, algorithms: ['HS256'], issuer: 'test', audience: 'reset' };

  /** An auth app with recovery wired + a capturing mailer (the reset link never leaves the
   *  test). Mirrors the serverConfig composition: same key, a distinct `reset` audience. */
  function recoverApp(resetBaseUrl = 'https://play.example'): {
    server: FastifyInstance;
    sent: Array<{ to: string; text: string }>;
    users: MemoryUserStore;
  } {
    const sent: Array<{ to: string; text: string }> = [];
    const users = new MemoryUserStore();
    app = Fastify();
    registerAuthApi(app, {
      users,
      signSession: (accountId, login, pwfp) =>
        signSessionToken({ accountId, login, pwfp }, SIGN, { ttlSeconds: 3600 }),
      signReset: (accountId, pwfp) =>
        signResetToken({ accountId, pwfp }, RESET_SIGN, { ttlSeconds: 900 }),
      verifyReset: async (token) => {
        const r = await verifyResetToken(token, RESET_VERIFY);
        return r.ok ? r.claim : null;
      },
      resetBaseUrl,
      sendMail: (msg) => {
        sent.push({ to: msg.to, text: msg.text });
        return Promise.resolve();
      },
      scryptParams: FAST,
    });
    return { server: app, sent, users };
  }

  const tokenFrom = (text: string): string => decodeURIComponent(text.match(/\?reset=(\S+)/)![1]!);

  it('registers with an email, recovers via the mailed link, and sets a new password', async () => {
    const { server, sent } = recoverApp();
    await post(server, '/auth/register', {
      login: 'zoe',
      password: 'oldpassword',
      email: 'zoe@example.com',
    });

    const rec = await post(server, '/auth/recover', { email: 'zoe@example.com' });
    expect(rec.statusCode).toBe(200);
    expect(rec.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('zoe@example.com');
    const token = tokenFrom(sent[0]!.text);

    const reset = await post(server, '/auth/reset', { token, password: 'brandnewpass' });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { login: string }).login).toBe('zoe');

    // The new password works; the old one is dead.
    expect(
      (await post(server, '/auth/login', { login: 'zoe', password: 'brandnewpass' })).statusCode,
    ).toBe(200);
    expect(
      (await post(server, '/auth/login', { login: 'zoe', password: 'oldpassword' })).statusCode,
    ).toBe(401);
  });

  it('a reset token is single-use: the second reset with the same token is refused', async () => {
    const { server, sent } = recoverApp();
    await post(server, '/auth/register', {
      login: 'ana',
      password: 'firstpass1',
      email: 'ana@example.com',
    });
    await post(server, '/auth/recover', { email: 'ana@example.com' });
    const token = tokenFrom(sent[0]!.text);
    expect((await post(server, '/auth/reset', { token, password: 'secondpass1' })).statusCode).toBe(
      200,
    );
    // The password (and thus its fingerprint) changed → the same token no longer matches.
    const again = await post(server, '/auth/reset', { token, password: 'thirdpass12' });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'E_AUTH' });
  });

  it('recover is anti-enumeration: an unknown email still 200s and sends nothing', async () => {
    const { server, sent } = recoverApp();
    const rec = await post(server, '/auth/recover', { email: 'ghost@example.com' });
    expect(rec.statusCode).toBe(200);
    expect(rec.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it('an account registered WITHOUT an email has no recovery (nothing sent)', async () => {
    const { server, sent } = recoverApp();
    await post(server, '/auth/register', { login: 'noemail', password: 'longenough' });
    await post(server, '/auth/recover', { email: 'noemail@example.com' });
    expect(sent).toHaveLength(0);
  });

  it('a duplicate recovery email is refused (E_EMAIL_TAKEN), case-insensitively', async () => {
    const { server } = recoverApp();
    await post(server, '/auth/register', {
      login: 'first',
      password: 'longenough',
      email: 'shared@example.com',
    });
    const dup = await post(server, '/auth/register', {
      login: 'second',
      password: 'longenough',
      email: 'Shared@Example.com',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'E_EMAIL_TAKEN' });
  });

  it('reset rejects a garbage/forged token uniformly (E_AUTH)', async () => {
    const { server } = recoverApp();
    const bad = await post(server, '/auth/reset', { token: 'not-a-jwt', password: 'longenough' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'E_AUTH' });
  });

  it('a malformed email at registration is a 400 (not silently dropped)', async () => {
    const { server } = recoverApp();
    const r = await post(server, '/auth/register', {
      login: 'baddie',
      password: 'longenough',
      email: 'notanemail',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'E_BAD_CREDENTIALS' });
  });

  it('a completed reset kills the pre-reset session but its own new session is live', async () => {
    const { server, sent, users } = recoverApp();
    const reg = await post(server, '/auth/register', {
      login: 'dan',
      password: 'oldpassword',
      email: 'dan@example.com',
    });
    const preToken = (reg.json() as { token: string }).token;
    const preClaim = await verifySessionToken(preToken, VERIFY);
    expect(preClaim.ok).toBe(true);
    // Before the reset, the registration session authenticates against the live store.
    if (preClaim.ok) expect(await liveSession(preClaim.claim, users)).not.toBeNull();

    await post(server, '/auth/recover', { email: 'dan@example.com' });
    const reset = await post(server, '/auth/reset', {
      token: tokenFrom(sent[0]!.text),
      password: 'brandnewpass',
    });
    const postToken = (reset.json() as { token: string }).token;

    // The pre-reset session no longer authenticates; the session the reset handed back does.
    if (preClaim.ok) expect(await liveSession(preClaim.claim, users)).toBeNull();
    const postClaim = await verifySessionToken(postToken, VERIFY);
    expect(postClaim.ok).toBe(true);
    if (postClaim.ok) expect(await liveSession(postClaim.claim, users)).not.toBeNull();
  });

  it('normalizes a resetBaseUrl with trailing slashes to a single-slash link', async () => {
    // Guards the linear trailing-slash trim that replaced `/\/+$/` (ReDoS-free):
    // the emitted link must carry exactly one '/' before '?reset=', for any run.
    const { server, sent } = recoverApp('https://play.example///');
    await post(server, '/auth/register', {
      login: 'liv',
      password: 'longenough',
      email: 'liv@example.com',
    });
    await post(server, '/auth/recover', { email: 'liv@example.com' });
    expect(sent[0]!.text).toContain('https://play.example/?reset=');
    expect(sent[0]!.text).not.toContain('https://play.example//?reset=');
  });

  it('liveSession rejects a session for an unknown/deleted account', async () => {
    const users = new MemoryUserStore();
    const claim = { accountId: 'ghost', login: 'ghost', pwfp: pwFingerprint('whatever') };
    expect(await liveSession(claim, users)).toBeNull();
  });
});
