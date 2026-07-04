import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { MS_PER_DAY, type GameData } from '@void/shared-core';
import { createMultiplayerServer, type MultiplayerServerHandle } from './wsServer';
import { MatchRegistry, type MatchLists } from './matchRegistry';
import { registerBrowserApi } from './matchApi';
import { MemoryAccountStore } from './store';
import { createDevMatch, loadShippedData } from './scenario';

let data: GameData;
beforeAll(() => {
  data = loadShippedData();
});

let handle: MultiplayerServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

/** Start the server on the registry (as both the room source and the browser
 *  read-model, wired through the `httpRoutes` seam) and return its http base URL. */
async function startHttp(registry: MatchRegistry): Promise<string> {
  handle = createMultiplayerServer({
    registry,
    accountStore: registry.accounts,
    httpRoutes: (app) => registerBrowserApi(app, registry),
  });
  const wsUrl = await handle.listen();
  // listen() returns the single match's full URL, or the bare `/matches` prefix when
  // hosting several — strip either down to the http origin.
  return wsUrl.replace(/^ws/, 'http').replace(/\/matches(\/.*)?$/, '');
}

const getJson = async <T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const r = await fetch(url, init);
  return { status: r.status, body: (await r.json()) as T };
};

describe('match-browser over HTTP (read-model + archive intent)', () => {
  it('GET /matches buckets by nick and carries the status line; POST archive moves it', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(createDevMatch(data, { id: 'm1', time: 5 * MS_PER_DAY }), {
      mapId: 'nexus-duel',
      rules: { timeScale: 1 },
      createdAt: 2,
    });
    reg.register(createDevMatch(data, { id: 'm2' }), {
      mapId: 'nexus-duel',
      rules: { timeScale: 2 },
      createdAt: 1,
    });
    await accounts.resolveSeat('m1', 'alice', ['green', 'red']); // alice is in m1
    const base = await startHttp(reg);

    const { body: l1 } = await getJson<MatchLists>(`${base}/matches?nick=alice`);
    expect(l1.active.map((s) => s.matchId)).toEqual(['m1']);
    expect(l1.available.map((s) => s.matchId)).toEqual(['m2']);
    expect(l1.active[0]?.days).toBe(5);
    expect(l1.active[0]?.players).toEqual({ seated: 1, capacity: 2 });
    expect(l1.active[0]?.mapId).toBe('nexus-duel');

    const arch = await getJson<{ ok: boolean }>(`${base}/matches/m1/archive?nick=alice`, {
      method: 'POST',
    });
    expect(arch.status).toBe(200);
    expect(arch.body).toEqual({ ok: true });

    const { body: l2 } = await getJson<MatchLists>(`${base}/matches?nick=alice`);
    expect(l2.archived.map((s) => s.matchId)).toEqual(['m1']);
    expect(l2.active).toHaveLength(0);

    // Restore: POST unarchive moves it back to the active tab.
    const rest = await getJson<{ ok: boolean }>(`${base}/matches/m1/unarchive?nick=alice`, {
      method: 'POST',
    });
    expect(rest.status).toBe(200);
    expect(rest.body).toEqual({ ok: true });
    const { body: l3 } = await getJson<MatchLists>(`${base}/matches?nick=alice`);
    expect(l3.active.map((s) => s.matchId)).toEqual(['m1']);
    expect(l3.archived).toHaveLength(0);
  });

  it('archive is fail-secure over the wire (404 unknown, 403 non-participant, 404 wrong method)', async () => {
    const accounts = new MemoryAccountStore();
    const reg = new MatchRegistry(accounts);
    reg.register(createDevMatch(data, { id: 'm1' }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
    });
    const base = await startHttp(reg);
    expect((await fetch(`${base}/matches/nope/archive?nick=x`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/matches/m1/archive?nick=stranger`, { method: 'POST' })).status).toBe(
      403,
    );
    // GET on the archive intent matches no route (Fastify's uniform not-found — the
    // wrong method is not accepted, same fail-secure outcome as the old explicit 405).
    expect((await fetch(`${base}/matches/m1/archive?nick=x`)).status).toBe(404);
    // An intent outside the (archive|unarchive) route constraint never reaches the
    // handler — the anchored route regex fails to match → uniform 404.
    expect((await fetch(`${base}/matches/m1/destroy?nick=x`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/matches/m1/rearchive?nick=x`, { method: 'POST' })).status).toBe(404);
  });

  it('GET /health stays contentless (F-13); /metrics carries the aggregate count', async () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    reg.register(createDevMatch(data, { id: 'm1' }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
    });
    const base = await startHttp(reg);
    const health = await getJson<{ ok: boolean }>(`${base}/health`);
    expect(health.body).toEqual({ ok: true }); // no match ids on the liveness probe
    const metrics = await getJson<{ matches: number; connections: number }>(`${base}/metrics`);
    expect(metrics.body).toEqual({ matches: 1, connections: 0 });
  });
});
