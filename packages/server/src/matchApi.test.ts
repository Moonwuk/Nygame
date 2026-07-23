import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerMatchApi, type JoinFailure, type MatchApiDeps } from './matchApi';

// SV-2.4 — the create/join HTTP routes. The route layer maps the deps' results to HTTP;
// the deps (seed a match, resolve a seat, mint a token) are wired in main.ts.

function appWith(deps: MatchApiDeps) {
  const app = Fastify();
  registerMatchApi(app, deps);
  return app;
}

const denyJoin: MatchApiDeps['join'] = () => Promise.resolve({ error: 'E_NO_MATCH' });

describe('SV-2.4 · match API', () => {
  it('POST /matches creates a match and returns its id + seats', async () => {
    const app = appWith({
      createMatch: () => Promise.resolve({ matchId: 'm-1', seats: ['green', 'red'] }),
      join: denyJoin,
    });
    const res = await app.inject({ method: 'POST', url: '/matches' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matchId: 'm-1', seats: ['green', 'red'] });
    await app.close();
  });

  it('GET /matches/:id/join returns a seat + token for a nick', async () => {
    const app = appWith({
      createMatch: () => Promise.resolve({ matchId: 'm-1', seats: [] }),
      join: (matchId, nick) => Promise.resolve({ playerId: 'green', token: `tok:${matchId}:${nick}` }),
    });
    const res = await app.inject({ method: 'GET', url: '/matches/m-1/join?nick=alice' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ playerId: 'green', token: 'tok:m-1:alice' });
    await app.close();
  });

  it('rejects a join with no nick (400)', async () => {
    const app = appWith({
      createMatch: () => Promise.resolve({ matchId: 'm', seats: [] }),
      join: denyJoin,
    });
    const res = await app.inject({ method: 'GET', url: '/matches/m-1/join' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'E_NICK_REQUIRED' });
    await app.close();
  });

  it('maps join failures to stable statuses', async () => {
    const cases: Array<[JoinFailure['error'], number]> = [
      ['E_NO_MATCH', 404],
      ['E_MATCH_FULL', 409],
      ['E_NOT_ROSTERED', 403],
      ['E_ENTRY_CLOSED', 403],
      ['E_AUTH_DISABLED', 501],
    ];
    for (const [error, status] of cases) {
      const app = appWith({
        createMatch: () => Promise.resolve({ matchId: 'm', seats: [] }),
        join: () => Promise.resolve({ error }),
      });
      const res = await app.inject({ method: 'GET', url: '/matches/m/join?nick=a' });
      expect(res.statusCode, error).toBe(status);
      expect(res.json()).toEqual({ error });
      await app.close();
    }
  });

  it('omitting createMatch leaves POST /matches unmounted, but join still serves', async () => {
    // A host that seeds matches out of band (netserver, NETA2-7) exposes join alone.
    const app = appWith({
      join: (matchId, nick) => Promise.resolve({ playerId: 'green', token: `tok:${matchId}:${nick}` }),
    });
    expect((await app.inject({ method: 'POST', url: '/matches' })).statusCode).toBe(404); // not mounted
    const res = await app.inject({ method: 'GET', url: '/matches/m/join?nick=a' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ playerId: 'green', token: 'tok:m:a' });
    await app.close();
  });

  it('rate-limits create+join per IP over a shared window (429 past the cap)', async () => {
    const app = appWith({
      createMatch: () => Promise.resolve({ matchId: 'm', seats: [] }),
      join: (_matchId, nick) => Promise.resolve({ playerId: 'green', token: `tok:${nick}` }),
      now: () => 1_000, // frozen clock → all attempts fall in one window
      rateMax: 2, // create+join share the budget
    });
    // Two attempts pass (one create, one join), the third is throttled.
    expect((await app.inject({ method: 'POST', url: '/matches' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/matches/m/join?nick=a' })).statusCode).toBe(200);
    const throttled = await app.inject({ method: 'POST', url: '/matches' });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: 'E_RATE_LIMIT' });
    await app.close();
  });

  it('a fresh window clears the throttle', async () => {
    let clock = 0;
    const app = appWith({
      createMatch: () => Promise.resolve({ matchId: 'm', seats: [] }),
      join: denyJoin,
      now: () => clock,
      rateMax: 1,
      rateWindowMs: 1_000,
    });
    expect((await app.inject({ method: 'POST', url: '/matches' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/matches' })).statusCode).toBe(429);
    clock = 1_000; // window elapsed → budget refills
    expect((await app.inject({ method: 'POST', url: '/matches' })).statusCode).toBe(200);
    await app.close();
  });
});
