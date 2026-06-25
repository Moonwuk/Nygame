// Serves the prototype's OWN world over WebSocket so two browsers — or two phones
// running the APK — can play the same session against one authoritative core.
//
//   pnpm dev:proto-server                          # 127.0.0.1:8788
//   HOST=0.0.0.0 PORT=8788 pnpm dev:proto-server   # reachable on the LAN
//   (then expose it with a tunnel — see docs/multiplayer.md — for a remote friend)
//
// Throwaway dev harness, like the prototype itself: built by esbuild
// (netserver.mjs), ESLint-ignored, and never typechecked. It reuses the
// prototype's exact `kernel` + `data` + `newGame()`, so the world the server
// hosts is byte-identical to the one the client already knows how to draw — the
// client's `MAP` lines up 1:1 with the server's planets and the renderer needs
// no changes. This is NOT the Stage-3 server: state lives in memory (a restart
// loses the match) and the `?player=` handshake is unauthenticated.
import { MatchRoom, createMultiplayerServer } from '../packages/server/src/index';
import { newGame, kernel, data } from './src/game';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8788);

// World time starts at 0 and tracks real elapsed time since boot, so the in-game
// clock reads "Day 1" at launch (rather than ~Day 20000 from a wall-clock epoch)
// while still advancing in real wall-clock seconds.
const bootTime = Date.now();
const room = new MatchRoom({
  id: 'proto',
  initialState: newGame(),
  kernel,
  data,
  now: () => Date.now() - bootTime,
});

const server = createMultiplayerServer({ room, host, port });
const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

process.stdout.write(
  [
    'Void Dominion — prototype dev server (in-memory, real core)',
    `  health : ${httpUrl}/health`,
    `  Azure  : ${wsUrl}?player=p1`,
    `  Crimson: ${wsUrl}?player=p2`,
    host === '0.0.0.0'
      ? '  (bound to 0.0.0.0 — other devices connect via this machine’s LAN IP)'
      : '  (set HOST=0.0.0.0 to reach this from another device / a tunnel)',
    '',
  ].join('\n'),
);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
