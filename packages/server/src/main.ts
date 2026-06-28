import type { MatchConfig } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { MatchRegistry } from './matchRegistry';
import { MemoryAccountStore } from './store';
import { createMultiplayerServer } from './wsServer';

/**
 * Runnable dev server: boots a few real-core dev matches into a registry and serves
 * them over WebSocket, plus the match-browser read-model over HTTP, so a client can
 * list/join/archive matches against the authoritative core.
 *
 *   pnpm dev:server                 # 127.0.0.1:8787
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server   # reachable from other LAN devices
 *
 * This is a development harness, not the Stage-3 server: state lives in memory
 * (a restart loses the matches) and the `?nick=`/`?player=` handshake is unauthenticated.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();

const data = loadShippedData();
const registry = new MatchRegistry(new MemoryAccountStore());
const now = (): number => Date.now();

// A handful of seeded matches with differing rules so the browser has rows to show.
// (Lobby/create-match is a later brick — docs/matchmaking-roadmap.md MM-1.1.)
const seed: Array<{ id: string; mapId: string; players: string[]; config: MatchConfig }> = [
  { id: 'dev-1', mapId: 'nexus-duel', players: ['green', 'red'], config: { timeScale: 1 } },
  {
    id: 'dev-2',
    mapId: 'nexus-duel',
    players: ['green', 'red'],
    config: { timeScale: 2, victory: { scoreLimit: 500 } },
  },
  { id: 'dev-3', mapId: 'nexus-trio', players: ['green', 'red', 'blue'], config: { timeScale: 4 } },
];
for (const s of seed) {
  const room = createDevMatch(data, {
    id: s.id,
    now,
    time: bootTime,
    players: s.players,
    config: s.config,
  });
  registry.register(room, { mapId: s.mapId, rules: s.config, createdAt: bootTime, startedAt: bootTime });
}

const server = createMultiplayerServer({ registry, host, port });
const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

process.stdout.write(
  [
    'Void Dominion — dev server (in-memory, real core)',
    `  health  : ${httpUrl}/health`,
    `  browser : ${httpUrl}/matches?nick=<you>   (the three tabs as JSON)`,
    ...registry.ids().map((id) => `  join    : ${httpUrl.replace(/^http/, 'ws')}/matches/${id}?nick=<you>`),
    host === '0.0.0.0'
      ? '  (bound to 0.0.0.0 — connect other devices via this machine’s LAN IP)'
      : '  (set HOST=0.0.0.0 to reach this from another device on the LAN)',
    '',
  ].join('\n'),
);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
