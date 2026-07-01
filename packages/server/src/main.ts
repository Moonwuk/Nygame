import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import { createStores, snapshotOf } from './persistence';
import type { RoomObservation } from './matchRoom';

/**
 * Runnable dev server: boots the real-core 2-player dev match and serves it over
 * WebSocket so two clients can connect and play against the authoritative core.
 *
 *   pnpm dev:server                 # 127.0.0.1:8787, in-memory (restart loses match)
 *   DATABASE_URL=postgres://…  pnpm dev:server   # durable: resumes on restart
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server       # reachable from other LAN devices
 *
 * F8 (docs/infra-sizing-roadmap.md): the match is now persisted after every commit
 * and rehydrated on boot, and a clock driver advances the world 24/7 (scheduled
 * events fire with no player action). Still a dev harness — the `?player=` handshake
 * is unauthenticated. True commit-before-broadcast + async action path is F2/SV-1.1.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();
const matchId = 'dev';

const stores = await createStores();

// Resume a persisted match if one exists; else seed a fresh one below.
const resumed = await stores.store.load(matchId);
const initialReceipts = resumed ? await stores.receiptStore.loadAll(matchId) : undefined;

let driver: ClockDriverHandle | null = null;
const persistSnapshot = (): void => {
  void stores.store.save(snapshotOf(room));
};
// Persist after every committed action (the `observe` action event fires post-commit
// with the receipt fields) and re-arm the clock driver, since the action may have
// scheduled a new event the sleeping timer can't see.
const observe = (event: RoomObservation): void => {
  if (event.kind !== 'action') return;
  void stores.receiptStore.save(matchId, {
    actionId: event.actionId,
    playerId: event.playerId,
    seq: event.seq,
    ok: event.ok,
    ...(event.code ? { code: event.code } : {}),
  });
  persistSnapshot();
  driver?.reschedule();
};

const room = createDevMatch(loadShippedData(), {
  now: () => Date.now(),
  time: bootTime,
  observe,
  initialState: resumed?.state,
  initialReceipts,
  initialSeq: resumed?.seq,
});

// Make a fresh match durable from t0 (a no-op re-save on resume — optimistic by seq).
persistSnapshot();
// The 24/7 heartbeat: fire due scheduled events with no player action, persist each advance.
driver = startClockDriver(room, {
  onTick: persistSnapshot,
  onStall: () =>
    process.stderr.write(
      'wakeup driver idling: the world clock stalled (a same-instant scheduling loop) — ' +
        'check for a module scheduling events at its own instant.\n',
    ),
});

const server = createMultiplayerServer({ room, host, port });

const wsUrl = await server.listen();
const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/matches\/.*$/, '');

process.stdout.write(
  [
    'Void Dominion — dev server (real core)',
    `  state  : ${stores.kind}${stores.kind === 'memory' ? ' (restart loses the match — set DATABASE_URL for durability)' : ' (durable — resumes on restart)'}`,
    `  clock  : driver on (world advances 24/7)${resumed ? ' · resumed a persisted match' : ''}`,
    `  health : ${httpUrl}/health`,
    `  green  : ${wsUrl}?player=green`,
    `  red    : ${wsUrl}?player=red`,
    host === '0.0.0.0'
      ? '  (bound to 0.0.0.0 — connect other devices via this machine’s LAN IP)'
      : '  (set HOST=0.0.0.0 to reach this from another device on the LAN)',
    '',
  ].join('\n'),
);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return; // SIGINT + SIGTERM can both arrive
  shuttingDown = true;
  driver?.stop();
  void server
    .close()
    .then(() => stores.close())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
