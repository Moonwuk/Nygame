import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';

/**
 * Runnable dev server: boots the real-core 2-player dev match and serves it over
 * WebSocket so two clients can connect and play against the authoritative core.
 *
 *   pnpm dev:server                 # 127.0.0.1:8787
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server   # reachable from other LAN devices
 *
 * This is a development harness, not the Stage-3 server: state lives in memory
 * (a restart loses the match) and the `?player=` handshake is unauthenticated.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();

const room = createDevMatch(loadShippedData(), { now: () => Date.now(), time: bootTime });
const server = createMultiplayerServer({ room, host, port });

const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

process.stdout.write(
  [
    'Void Dominion — dev server (in-memory, real core)',
    `  health : ${httpUrl}/health`,
    `  green  : ${wsUrl}?player=green`,
    `  red    : ${wsUrl}?player=red`,
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
