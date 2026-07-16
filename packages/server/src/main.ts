import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { createDevMatch, loadAvaMaps, loadShippedData, loadStarterArsenal } from './scenario';
import { grantStarterArsenal } from './arsenal';
import { createMultiplayerServer } from './wsServer';
import { createStores, snapshotOf } from './persistence';
import { configFromEnv } from './serverConfig';
import { createMatchLoader } from './serverWiring';
import { registerMatchApi, registerOpenMatchesFeed, type MatchApiDeps } from './matchApi';
import { registerAuthApi } from './authApi';
import { registerCorpApi } from './corpApi';
import { CorpService } from './corpService';
import { registerAvaApi, registerAvaFeed } from './avaApi';
import { AvaService } from './avaService';
import { registerMedalApi } from './medalApi';
import { MedalService } from './medalService';
import { loadMedalCatalog } from './medalCatalog';
import { AvaOrchestrator, warDeclarationsFor } from './avaOrchestrator';
import { MatchKeeper } from './matchFactory';
import { LazyRoomRegistry } from './roomRegistry';

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
const { auth, allowedOrigins, signToken, signSession, verifySession, gateFactory } = configFromEnv(
  process.env,
);

const data = loadShippedData();
// ARS-2: the starter blueprint set, validated against the shipped catalogs at boot
// (a template naming content that does not ship refuses to start — fail-secure).
const starterArsenal = loadStarterArsenal(data);
const stores = await createStores();

// The registry's match loader — the persist/observe/driver wiring lives in
// serverWiring.ts so tests exercise the real composition, not a mirror of it.
const loadMatch = createMatchLoader({
  stores,
  data,
  gateFactory,
  onStall: (matchId) =>
    process.stderr.write(
      `match ${matchId}: world clock stalled (a same-instant scheduling loop) — ` +
        'check for a module scheduling events at its own instant.\n',
    ),
  // An AvA session (AVA-8): the orchestrator owns the diplomacy stances (peace S5 →
  // war S6 by timer), so PLAYER declarations are refused at the wire; and the match
  // end is handed to the settlement (exactly-once by the matchup's own transition —
  // a replayed `end` no-ops). `avaOrchestrator` is initialized below, before any
  // connection can trigger a load.
  matchExtras: async (matchId) => {
    const avaSession = await stores.sessionStore.byMatch(matchId);
    if (!avaSession) return null;
    return {
      denyPlayerActions: (type: string) =>
        type === 'diplomacy.declare' ? 'E_AVA_DIPLOMACY' : null,
      onEnd: (winner: string | null) => {
        void avaOrchestrator.onMatchEnded(matchId, winner).catch((err) => {
          process.stderr.write(
            `ava settlement failed for ${matchId} — ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
      },
    };
  },
});

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

// AvA orchestrator (AVA-7): turns a LOCKED matchup into a live AvA session — pick a map,
// seat the roster into fixed slots (allies grouped, empty slots → AI), build a peaceful
// (S5) state, and raise the room by persisting its first snapshot (the lazy registry loads
// it on connect, like any match). `resolveAvaSeat` then sits each rostered account in ITS
// slot on join; the sweep raises sessions for freshly-locked matchups with no client needed.
const avaOrchestrator = new AvaOrchestrator({
  challengeStore: stores.challengeStore,
  rosterStore: stores.rosterStore,
  sessionStore: stores.sessionStore,
  data,
  maps: loadAvaMaps(),
  createRoom: async ({ matchId, state }) => {
    const room = createDevMatch(data, { id: matchId, initialState: state, time: state.time });
    await stores.store.save(snapshotOf(room));
  },
  // AVA-8 (S6): the peace period, then the war opens on a timer. Env-tunable for
  // playtests (a real day is too long to watch); the MVP default is 24h.
  peaceMs: Number(process.env.AVA_PEACE_MS ?? '') || undefined,
  // Open the war on the LIVE room: load it through the registry (a hibernated match
  // wakes), submit the system declarations via the server-action path (past the wire
  // deny — the orchestrator owns the stances). Deterministic action ids make a
  // re-submitted batch idempotent; false on any transient failure → the sweep retries.
  escalateWar: async (matchId) => {
    const room = await registry.resolve?.(matchId);
    if (!room) return false; // snapshot missing/unloadable — retry next sweep
    let allLanded = true;
    for (const { playerId, action } of warDeclarationsFor(room.state, matchId)) {
      const r = await room.submitServerAction(playerId, action);
      // E_SAME_STANCE = already at war (a replay after a partial pass) — that pair is done.
      if (!r.ok && r.code !== 'E_SAME_STANCE') allLanded = false;
    }
    return allLanded;
  },
  // AVA-8 (S7): settle the ended war — archive the matchup, record the outcome,
  // award influence to the winning corp (exactly-once by the locked→ended gate).
  settle: (matchupId, winnerSide) => avaService.settleMatch(matchupId, winnerSide),
});

// Identity gate (SE-1.x): resolve the caller from the session token. Shared by the
// match API (create/join claim seats for the session's account) and the corp API
// (every corp intent acts as the session's account).
const identify: MatchApiDeps['identify'] = verifySession
  ? async (request) => {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const verified = await verifySession(header.slice('Bearer '.length).trim());
      return verified.ok ? verified.claim : null;
    }
  : undefined;

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
    // AvA session (AVA-7): a rostered account plays its FIXED slot; a non-rostered one is
    // refused. `null` ⇒ an ordinary match → the normal first-come seat resolver.
    const ava = accountId ? await avaOrchestrator.resolveAvaSeat(matchId, accountId) : null;
    if (ava && !ava.ok) return { error: 'E_NOT_ROSTERED' };
    const playerId = ava
      ? ava.playerId
      : (await accountStore.resolveSeat(matchId, nick, Object.keys(snap.state.players)))?.playerId;
    if (playerId === undefined) return { error: 'E_MATCH_FULL' };
    return { playerId, token: await signToken(matchId, playerId, accountId) };
  },
  // Wired ⇒ create/join require a session from /auth/login — the session's login IS
  // the seat nick, so nobody claims a seat as somebody else.
  identify,
};

if (auth && !allowedOrigins) {
  process.stderr.write(
    'warning: AUTH is on but ALLOWED_ORIGINS is unset — no Origin allowlist (CSWSH). ' +
      'Set ALLOWED_ORIGINS before exposing this beyond a trusted network.\n',
  );
}

// AvA service (AVA-2/3/4/6/8): readiness pool + challenge state machine + roster window
// + settlement over the durable stores. One instance is shared by the HTTP API and the
// sweeps.
const avaService = new AvaService({
  corpStore: stores.corpStore,
  challengeStore: stores.challengeStore,
  rosterStore: stores.rosterStore,
  resultStore: stores.resultStore,
  feedStore: stores.feedStore,
});

// Medals (MED-1, corporations.md §3): objective, server-checked corp achievements from the
// AvA match history. The catalog is fixed data (`data/medals.json`), validated once at boot;
// the service authorizes the head/officer manual-grant path over the durable stores.
const medalService = new MedalService({
  corpStore: stores.corpStore,
  resultStore: stores.resultStore,
  medalStore: stores.medalStore,
  catalog: loadMedalCatalog(),
});

// Match factory (SV-2.5): keep OPEN_MATCHES joinable matches available so the feed is
// never empty — when one fills or ends, seed another. The open count is read from the
// durable store, so a restart reconciles instead of over-creating. OPEN_MATCHES=0 off.
const OPEN_MATCHES = Number(process.env.OPEN_MATCHES ?? '3') || 0;
const MATCH_CAPACITY = 2; // createDevMatch seats green/red — a match is full at 2
const keeper =
  OPEN_MATCHES > 0
    ? new MatchKeeper({
        target: OPEN_MATCHES,
        max: MAX_MATCHES,
        capacity: MATCH_CAPACITY,
        listOngoing: () => stores.store.ongoingMatchIds(),
        occupiedSeats: (id) => accountStore.occupiedSeats(id),
        create: async () => {
          await matchApi.createMatch();
        },
        onError: (err) =>
          process.stderr.write(
            `match factory: seed failed — ${err instanceof Error ? err.message : String(err)}\n`,
          ),
      })
    : null;

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
  httpRoutes: (app) => {
    // The open-matches feed is PUBLIC and read-only — browsing joinable matches precedes
    // login and works with or without auth. Joining still needs a session (SE-1.x).
    registerOpenMatchesFeed(app, {
      listOngoing: () => stores.store.ongoingMatchIds(),
      occupiedSeats: (id) => accountStore.occupiedSeats(id),
      capacity: MATCH_CAPACITY,
    });
    // The public AvA feed (AVA-9) — confirmed matchups + results, read-only, no session.
    registerAvaFeed(app, { service: avaService });
    // The account + match WRITE surface only when auth is on (it mints tokens); no auth ⇒
    // the insecure dev ?player= handshake only. It sits behind @fastify/rate-limit in an
    // ENCAPSULATED scope so the coarse per-IP backstop covers only these write routes —
    // liveness probes (/health, /ready) and the feed on the parent app stay unthrottled
    // for load balancers. The route modules keep their own tighter, uniform-401-preserving
    // per-endpoint budgets on top (defence in depth on the auth path).
    if (auth && signSession) {
      void app.register(async (scope) => {
        await scope.register(rateLimit, { max: 100, timeWindow: '1 minute' });
        registerAuthApi(scope, {
          users: stores.userStore,
          signSession,
          // ARS-2: every fresh account starts with the data-driven blueprint set —
          // "an empty arsenal" never exists. Idempotent end to end (deterministic
          // item ids + first-write-wins grant), so a crashed grant re-runs safely.
          onRegistered: async (accountId) => {
            try {
              await grantStarterArsenal(stores.arsenalStore, accountId, starterArsenal, Date.now());
            } catch (err) {
              process.stderr.write(
                `starter arsenal grant failed for ${accountId} — ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
        });
        registerMatchApi(scope, matchApi);
        // Corporations (CORP-0) — session-gated on every route: the acting identity
        // comes from the session, so the API only exists where sessions do.
        if (identify) {
          registerCorpApi(scope, {
            service: new CorpService({ store: stores.corpStore }),
            identify,
          });
          // AvA readiness + challenges (AVA-2/3/4) — the same session gate.
          registerAvaApi(scope, { service: avaService, identify });
          // Medals (MED-1) — head/officer grant + read, session-gated like the corp API.
          registerMedalApi(scope, { service: medalService, identify });
        }
      });
    }
  },
});

const wsBase = await server.listen(); // ws://host:port/matches (multi-match → the base prefix)
const httpUrl = wsBase.replace(/^ws/, 'http').replace(/\/matches.*$/, '');

// Start the factory once the server is up: seed toward OPEN_MATCHES now, then reconcile
// on an interval (a slow, cheap safety net; joins fill matches between ticks).
keeper?.start(30_000);

// AvA sweeps on one interval: challenge expiry (AVA-4, close+refund unanswered) and
// the roster window (AVA-6, lock a full roster / cancel+refund a short one) — the same
// no-client-needed model as the offline scheduler. Unref'd so it never holds the
// process open; errors are swallowed so one bad sweep can't crash the server.
const avaSweep = setInterval(() => {
  void avaService.sweepExpired().catch((err) => {
    process.stderr.write(
      `ava expiry sweep failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  void avaService
    .sweepRosters()
    .then(() =>
      // Raise a live session for every freshly-locked matchup (AVA-7) — after the roster
      // sweep in the same tick, so a lock and its session land together.
      avaOrchestrator.sweep(),
    )
    .then(() =>
      // AVA-8 (S6): open the war on every session whose peace period lapsed — chained
      // after the session sweep so a freshly-raised session gets its timer in the same
      // world the escalation will read.
      avaOrchestrator.sweepWar(),
    )
    .catch((err) => {
      process.stderr.write(
        `ava roster/session sweep failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
}, 60_000);
avaSweep.unref?.();

process.stdout.write(
  [
    'Void Dominion — server (real core, multi-match)',
    `  state  : ${stores.kind}${stores.kind === 'memory' ? ' (restart loses matches — set DATABASE_URL for durability)' : ' (durable — matches resume on restart)'}`,
    `  matches: lazy registry (load on connect, hibernate when idle, wake for events)`,
    `  factory: ${keeper ? `keeps ${OPEN_MATCHES} open match(es) available · GET ${httpUrl}/matches/open` : 'off (OPEN_MATCHES=0)'}`,
    `  auth   : ${auth ? 'on (join token required — connect with ?token=<jwt>)' : 'off (insecure dev ?player=/?nick=)'}`,
    `  gate   : ${gateFactory ? 'ON (clients MUST send action.v1 envelopes echoing welcome.sessionId)' : 'off (bare actions)'}`,
    `  health : ${httpUrl}/health`,
    ...(auth
      ? [
          `  account: POST ${httpUrl}/auth/register  ·  POST ${httpUrl}/auth/login  {login, password}`,
          `  join   : POST ${httpUrl}/matches  ·  GET ${httpUrl}/matches/dev/join  (Authorization: Bearer <session>)`,
          `           (the session's login is your nick; the seat is claimed for YOUR account)`,
          `  corps  : GET/POST ${httpUrl}/corps  ·  POST ${httpUrl}/corps/:id/<intent>  (session required)`,
          `  ava    : GET ${httpUrl}/ava/pool  ·  POST ${httpUrl}/ava/ready/{corp,player}  ·  POST ${httpUrl}/ava/challenge  (session required)`,
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
  keeper?.stop(); // stop reconciling before we drain
  // server.close() drains sockets and awaits registry.shutdown() (persist + stop every
  // live match's driver), so there is no separate driver to stop here.
  void server
    .close()
    .then(() => stores.close())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
