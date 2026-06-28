import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { MS_PER_DAY, type GameData } from '@void/shared-core';
import { createMultiplayerServer, type MultiplayerServerHandle } from './wsServer';
import { MatchRegistry, type MatchLists } from './matchRegistry';
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

/** Start the server on the registry and return its http base URL. */
async function startHttp(registry: MatchRegistry): Promise<string> {
  handle = createMultiplayerServer({ registry });
  const wsUrl = await handle.listen();
  return wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');
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
  });

  it('archive is fail-secure over the wire (404 unknown, 403 non-participant, 405 wrong method)', async () => {
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
    expect((await fetch(`${base}/matches/m1/archive?nick=x`)).status).toBe(405); // GET not allowed
  });

  it('GET /health lists the registered matches', async () => {
    const reg = new MatchRegistry(new MemoryAccountStore());
    reg.register(createDevMatch(data, { id: 'm1' }), {
      mapId: 'duel',
      rules: { timeScale: 1 },
      createdAt: 1,
    });
    const base = await startHttp(reg);
    const { body } = await getJson<{ ok: boolean; matches: string[] }>(`${base}/health`);
    expect(body).toEqual({ ok: true, matches: ['m1'] });
  });
});
