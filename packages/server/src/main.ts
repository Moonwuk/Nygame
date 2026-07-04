import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import { createStores, snapshotOf } from './persistence';
import { configFromEnv } from './serverConfig';
import { registerMatchApi, type MatchApiDeps } from './matchApi';
import { registerAuthApi } from './authApi';
import { LazyRoomRegistry, type LoadedMatch } from './roomRegistry';
import type { RoomObservation } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';

/**
 * Runnable server entrypoint on the real simulation core. Hosts MANY matches from one
 * process via a LazyRoomRegistry (SV-4.0): each match is loaded from the store on the
 * first connection and hibernated (persisted + evicted) when idle, so live memory scales
 * with concurrently-active matches, not the total ever created. A per-match clock driver
 * advances the world 24/7 while live; the registry wakes a hibernated match for its due
 * events. Every match is persisted commit-before-broadcast and resumes across a restart.
 *
 *   pnpm dev:server                              # 127.0.0.1:8787, in-memory (restart loses state)
 *   DATABASE_URL=postgres://…  pnpm dev:server   # durable: matches resume on restart
 *   HOST=0.0.0.0 PORT=9000 pnpm dev:server       # reachable from other LAN devices
 *   AUTH_JWT_SECRET=… GATE=1  pnpm dev:server    # authenticated handshake + validated envelopes
 *
 * With AUTH_JWT_SECRET set the server also exposes login+password accounts (SE-1.x):
 * `POST /auth/register` / `POST /auth/login` mint a session token, and the create/join
 * API requires it (`Authorization: Bearer`) — the session's login is the seat identity.
 * The `dev` match is still seeded on boot for continuity.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const bootTime = Date.now();

// Security composition from the environment (all switches OFF by default → dev harness):
// AUTH_JWT_SECRET (authenticated handshake + token minting + login/password accounts),
// ALLOWED_ORIGINS (CSWSH), GATE=1 (validated action.v1 envelopes). See serverConfig.ts.
const { auth, allowedOrigins, signToken, signSession, verifySession, gateFactory } =
  configFromEnv(process.env);

const data = loadShippedData();
const stores = await createStores();

/**
 * Rebuild a LIVE, fully-wired room from its durable snapshot (persist + clock driver), or
 * null if no such match exists in the store. The registry calls this on demand; `dispose`
 * persists the final state and stops the driver when the match hibernates or the server
 * stops.
 */
async function loadMatch(matchId: string): Promise<LoadedMatch | null> {
  const snap = await stores.store.load(matchId);
  if (!snap) return null;
  const initialReceipts = await stores.receiptStore.loadAll(matchId);

  let driver: ClockDriverHandle | null = null;
  // Strict commit-before-broadcast: the room awaits this durable write of the new snapshot
  // + receipt before committing state / broadcasting the delta.
  const persist = async (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
    await stores.store.save(snapshot);
    await stores.receiptStore.save(matchId, receipt);
  };
  // The committed path already persists each action; `observe` only re-arms the driver, as
  // an action may have scheduled a new event the sleeping timer can't see.
  const observe = (event: RoomObservation): void => {
    if (event.kind === 'action') driver?.reschedule();
  };

  const room = createDevMatch(data, {
    id: matchId,
    now: () => Date.now(),
    observe,
    persist,
    initialState: snap.state,
    initialReceipts,
    initialSeq: snap.seq,
    gate: gateFactory?.(),
  });

  // The 24/7 heartbeat while this match is live: fire due scheduled events with no player
  // action, persisting each advance. (While hibernated, the registry's wake timer does it.)
  driver = startClockDriver(room, {
    onTick: () => void stores.store.save(snapshotOf(room)),
    onStall: () =>
      process.stderr.write(
        `match ${matchId}: world clock stalled (a same-instant scheduling loop) — ` +
          'check for a module scheduling events at its own instant.\n',
      ),
  });

  const dispose = async (): Promise<void> => {
    driver?.stop();
    await stores.store.save(snapshotOf(room));
  };
  return { room, dispose };
}

// Seed the `dev` match into the store on boot if absent, so the registry can load it on the
// first connection (dev continuity — a real match is created via the SV-2.4 /matches API).
if (!(await stores.store.load('dev'))) {
  const seed = createDevMatch(data, { id: 'dev', time: bootTime });
  await stores.store.save(snapshotOf(seed));
}

const registry = new LazyRoomRegistry({ load: loadMatch });

// The dev-grade match create/join API (SV-2.4): a nick claims a seat first-come (shared
// with the ?nick= WS login) and gets a short-lived join token for the authenticated
// handshake. NOT an authorization boundary — see matchApi.ts. It is only exposed when auth
// is configured (its whole job is minting join tokens), so a default dev server has no
// unauthenticated HTTP write surface; a per-process creation cap bounds abuse until a real
// deployment gates creation behind identity + a rate-limit.
const accountStore = stores.accountStore; // durable alongside the match when DATABASE_URL is set
const MAX_MATCHES = 1000;
let matchCount = 1; // the seeded 'dev' match
const matchApi: MatchApiDeps = {
  createMatch: async () => {
    if (matchCount >= MAX_MATCHES) throw new Error('match capacity reached'); // → 500, bounded
    const matchId = `m-${randomUUID()}`;
    const seed = createDevMatch(data, { id: matchId, time: Date.now() });
    await stores.store.save(snapshotOf(seed));
    matchCount += 1;
    return { matchId, seats: Object.keys(seed.state.players) };
  },
  join: async (matchId, nick, accountId) => {
    const snap = await stores.store.load(matchId);
    if (!snap) return { error: 'E_NO_MATCH' };
    if (!signToken) return { error: 'E_AUTH_DISABLED' }; // no token auth configured
    const seat = await accountStore.resolveSeat(matchId, nick, Object.keys(snap.state.players));
    if (!seat) return { error: 'E_MATCH_FULL' };
    return { playerId: seat.playerId, token: await signToken(matchId, seat.playerId, accountId) };
  },
  // Identity gate (SE-1.x): create/join require a session from /auth/login — the
  // session's login IS the seat nick, so nobody claims a seat as somebody else.
  identify: verifySession
    ? async (request) => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const verified = await verifySession(header.slice('Bearer '.length).trim());
        return verified.ok ? verified.claim : null;
      }
    : undefined,
};

if (auth && !allowedOrigins) {
  process.stderr.write(
    'warning: AUTH is on but ALLOWED_ORIGINS is unset — no Origin allowlist (CSWSH). ' +
      'Set ALLOWED_ORIGINS before exposing this beyond a trusted network.\n',
  );
}

const server = createMultiplayerServer({
  registry,
  host,
  port,
  logger: true, // structured pino logs for boot/shutdown (dev harness → prod entrypoint)
  // Behind a TLS-terminating proxy (Caddy), set TRUST_PROXY=1 so request.ip (and the
  // auth API's per-IP rate limit) sees the client, not the proxy.
  trustProxy: process.env.TRUST_PROXY === '1',
  // /ready is red while the durable store is unreachable, so a load balancer stops
  // routing new traffic without failing liveness (/health).
  ready: () => stores.store.ping?.() ?? Promise.resolve(true),
  auth,
  allowedOrigins,
  accountStore, // dev ?nick= WS login (when auth is off)
  // Only expose the account + match APIs when auth is on (they mint tokens);
  // no auth ⇒ the insecure dev ?player= handshake only.
  httpRoutes:
    auth && signSession
      ? (app) => {
          // The account + match surface sits behind @fastify/rate-limit, registered in an
          // ENCAPSULATED scope so the coarse per-IP backstop covers only these write
          // routes — liveness probes (/health, /ready) on the parent app stay unthrottled
          // for load balancers. The route modules keep their own tighter, uniform-401-
          // preserving per-endpoint budgets on top (defence in depth on the auth path).
          void app.register(async (scope) => {
            await scope.register(rateLimit, { max: 100, timeWindow: '1 minute' });
            registerAuthApi(scope, { users: stores.userStore, signSession });
            registerMatchApi(scope, matchApi);
          });
        }
      : undefined,
});

const wsBase = await server.listen(); // ws://host:port/matches (multi-match → the base prefix)
const httpUrl = wsBase.replace(/^ws/, 'http').replace(/\/matches.*$/, '');

process.stdout.write(
  [
    'Void Dominion — server (real core, multi-match)',
    `  state  : ${stores.kind}${stores.kind === 'memory' ? ' (restart loses matches — set DATABASE_URL for durability)' : ' (durable — matches resume on restart)'}`,
    `  matches: lazy registry (load on connect, hibernate when idle, wake for events)`,
    `  auth   : ${auth ? 'on (join token required — connect with ?token=<jwt>)' : 'off (insecure dev ?player=/?nick=)'}`,
    `  gate   : ${gateFactory ? 'ON (clients MUST send action.v1 envelopes echoing welcome.sessionId)' : 'off (bare actions)'}`,
    `  health : ${httpUrl}/health`,
    ...(auth
      ? [
          `  account: POST ${httpUrl}/auth/register  ·  POST ${httpUrl}/auth/login  {login, password}`,
          `  join   : POST ${httpUrl}/matches  ·  GET ${httpUrl}/matches/dev/join  (Authorization: Bearer <session>)`,
          `           (the session's login is your nick; the seat is claimed for YOUR account)`,
        ]
      : [`  dev    : ${wsBase}/dev?player=green  ·  ${wsBase}/dev?player=red`]),
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
  // server.close() drains sockets and awaits registry.shutdown() (persist + stop every
  // live match's driver), so there is no separate driver to stop here.
  void server
    .close()
    .then(() => stores.close())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
