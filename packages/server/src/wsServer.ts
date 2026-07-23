import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { PlayerId } from '@void/shared-core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { MatchRoom } from './matchRoom';
import { InMemoryRoomRegistry, type RoomRegistry } from './roomRegistry';
import type { AccountStore } from './store';
import { verifyJoinToken, type JoinTokenVerifyConfig } from './auth';
import { serializeServerMessage, type ServerErrorCode } from './protocol';

export interface MultiplayerServerOptions {
  /** Single-match shortcut. Exactly one of `room` / `registry` must be given; `room`
   *  is sugar for a one-entry registry (backward-compatible with every existing caller). */
  room?: MatchRoom;
  /** Multi-match: host N isolated matches in one process, routed by `${pathPrefix}/:id`.
   *  Any room source fits — the browser `MatchRegistry` implements this structurally. */
  registry?: RoomRegistry;
  host?: string;
  port?: number;
  pathPrefix?: string;
  /** Optional HTML served at `/` and `/index.html` — lets a dev/proto server hand
   *  the client the game itself, so a peer just opens `http://host:port/` (no file
   *  transfer, and the connect overlay auto-fills the same-origin ws:// URL). */
  indexHtml?: string;
  /** Optional nick-login: when a client connects with `?nick=…` (instead of
   *  `?player=`), the seat is resolved/assigned here so a returning nick gets its
   *  own side back. Absent ⇒ only the direct `?player=` handshake works. */
  accountStore?: AccountStore;
  /** Structured logging: pass `true` (or a pino config) to have Fastify emit JSON logs
   *  for boot/shutdown and requests. Default `false` (quiet — the default for tests). */
  logger?: boolean | object;
  /** Readiness probe for `GET /ready` (SV-0.1): return false while a hard dependency (the
   *  durable store) is unreachable, so a load balancer stops routing new traffic without
   *  failing liveness. Absent ⇒ always ready. `/ready` also reports 503 while draining. */
  ready?: () => boolean | Promise<boolean>;
  /** Require a verified join token at the WS handshake (SE-0.1, closes F-01). When set,
   *  the insecure `?player=` / `?nick=` dev handshakes are REFUSED: the token (carried in
   *  `?token=`) is the sole identity, and its claim's `matchId` must match the routed
   *  match and its `playerId` must be a seat in it. Absent ⇒ the dev `?player=`/`?nick=`
   *  handshake (the default for local dev, LAN playtests, and tests). */
  auth?: JoinTokenVerifyConfig;
  /** Seat lock (REL-5) — protect the nick-login path without accounts. On a nick's
   *  FIRST join the server mints a random seat ticket, stores only its sha256 in the
   *  account store and hands the plaintext to that client in `welcome.seatTicket`;
   *  every LATER join of the same nick must present it back (`?ticket=`) or is
   *  refused (401). The direct `?player=` handshake is refused outright — it would
   *  bypass the lock. A seat claimed before the lock existed is adopted (ticketed)
   *  on its owner's next join. Requires `accountStore`; meaningless under `auth`
   *  (the join token is already the identity there). */
  seatLock?: boolean;
  /** Entry window (SES-2.3): may a NEW player still claim a free seat in this match?
   *  Called ONLY on a nick-login that would take a seat the nick does not already hold
   *  (a first-time claim); a RECONNECT — a nick whose seat exists (`accountStore.seatOf`)
   *  — is never gated, so a seated player always gets back in. Returns false ⇒ the
   *  upgrade is refused (403) BEFORE any seat is assigned, so a rejected newcomer never
   *  consumes a chair. Absent ⇒ no window (every join allowed). The direct `?player=`
   *  dev handshake carries no nick and is not gated. */
  admitNewSeat?: (matchId: string) => boolean | Promise<boolean>;
  /** Origin allowlist (CSWSH defense, F-06). When set, an upgrade whose `Origin` header is
   *  not in the list is rejected (403) before any work. Absent ⇒ no Origin check (dev).
   *  Should ship WITH `auth`: a token gates identity, the Origin check gates which sites
   *  may drive an already-authenticated browser session. */
  allowedOrigins?: readonly string[];
  /** Register extra HTTP routes on the Fastify app (e.g. the match create/join API,
   *  SV-2.4), after `/health` and `/ready`. Keeps this transport module generic — the
   *  routes and their dependencies live with the caller. */
  httpRoutes?: (app: FastifyInstance) => void;
  /** Native TLS termination (RS-5.1). When set, the HTTP server is created as an
   *  `https.Server` (Fastify `https` option) and `listen()` returns a `wss://` URL — the
   *  single-node path to encrypted transport with no reverse proxy in front. Absent ⇒
   *  plain `ws://` (a proxy like Nginx/Caddy may still terminate TLS upstream — see
   *  `deploy/setup-proxy.sh`). Values are the PEM key/cert as Node's TLS layer accepts. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** Behind a reverse proxy (Caddy/Nginx terminating TLS), trust `X-Forwarded-For` so
   *  `request.ip` is the CLIENT address, not the proxy's — without this the auth API's
   *  per-IP rate limit would throttle every player behind the proxy as one bucket.
   *  Only enable when a trusted proxy is actually in front (a direct client could
   *  otherwise spoof the header to dodge per-IP limits). Default off. */
  trustProxy?: boolean;
}

export interface MultiplayerServerHandle {
  readonly httpServer: HttpServer;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function baseUrl(request: IncomingMessage): string {
  return `http://${request.headers.host ?? 'localhost'}`;
}

const UPGRADE_REASON: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  500: 'Internal Server Error',
};

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${UPGRADE_REASON[status] ?? 'Not Found'}\r\n\r\n`);
  socket.destroy();
}

/** Seat lock: only the sha256 of a ticket is ever stored or compared. */
function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

/** Constant-time check of a presented ticket against the stored hash (no
 *  early-exit compare an attacker could time; sha256 makes lengths equal). */
function ticketMatches(presented: string, storedHash: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read a native-TLS key/cert pair from the environment (RS-5.1). Returns the PEM
 *  buffers when BOTH `TLS_KEY_FILE` and `TLS_CERT_FILE` point at readable files, else
 *  `undefined` (⇒ plain `ws`, or TLS terminated by a proxy upstream). A PARTIAL config
 *  (only one of the two) throws — a half-configured TLS is a deploy error, not a silent
 *  downgrade to cleartext (fail-secure). Pass the result straight to the `tls` option. */
export function tlsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { key: Buffer; cert: Buffer } | undefined {
  const keyFile = env.TLS_KEY_FILE?.trim();
  const certFile = env.TLS_CERT_FILE?.trim();
  if (!keyFile && !certFile) return undefined;
  if (!keyFile || !certFile) {
    throw new Error('TLS misconfigured: set BOTH TLS_KEY_FILE and TLS_CERT_FILE (or neither)');
  }
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

export function createMultiplayerServer(
  options: MultiplayerServerOptions,
): MultiplayerServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pathPrefix = options.pathPrefix ?? '/matches';
  if (!options.room && !options.registry) {
    throw new Error('createMultiplayerServer: pass either `room` or `registry`');
  }
  const registry: RoomRegistry =
    options.registry ?? new InMemoryRoomRegistry([options.room as MatchRoom]);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_768 });

  const indexHtml = options.indexHtml;
  const ready = options.ready;
  let draining = false; // flips at close() so /ready reports 503 during graceful drain

  // SV-0.1: Fastify owns HTTP routing (health/ready now, match create/join later) and
  // brings structured pino logging; the WebSocket upgrade is still handled on the raw
  // underlying server (`app.server`) via the `ws` noServer instance, byte-identically.
  // `disableRequestLogging`: the HTTP surface is tiny (health/ready now, create/join
  // later) while the real traffic is WebSocket — per-request logs would just be a flood
  // of health-poll noise. Boot/shutdown + explicit logs stay; add per-route logging where
  // it earns its keep.
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: true,
    trustProxy: options.trustProxy ?? false,
    // RS-5.1: native TLS — with a key/cert Fastify builds an https.Server (checked at
    // runtime); the `ws` upgrade rides `app.server` byte-identically, so the socket is
    // wss end-to-end. Absent ⇒ plain http/ws (a proxy may still terminate TLS upstream).
    // The spread keeps `app` a single FastifyInstance type; https.Server ⊆ http.Server,
    // so `httpServer: app.server` stays sound.
    ...(options.tls ? { https: options.tls } : {}),
  });

  // Fail-secure (invariant #4): a route handler that throws/rejects (e.g. a store fault in
  // the match API) must return a stable code with NO internal detail — Fastify's default
  // handler would echo err.message on the wire. The detail stays in the logs.
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    void reply.code(500).send({ error: 'E_INTERNAL' });
  });

  // Liveness: cheap, unauthenticated, and DELIBERATELY contentless — it must not leak
  // match ids/seqs (audit F-13, which the old node:http `/health` did). Readiness is a
  // SEPARATE signal: NOT-ready while a hard dependency is down or the server is draining,
  // so a load balancer stops sending new traffic before shutdown without failing liveness.
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const ok = !draining && (ready ? await ready() : true);
    void reply.code(ok ? 200 : 503);
    return { ready: ok };
  });
  // Minimal ops metrics (OPS-0.1): AGGREGATE gauges only — live match count and total
  // connected sockets. No match ids (F-13). Richer per-match metrics / a Prometheus
  // exposition are a later ops brick.
  app.get('/metrics', async () => {
    const ids = registry.ids();
    let connections = 0;
    for (const id of ids) connections += registry.get(id)?.peerCount ?? 0;
    return { matches: ids.length, connections };
  });
  if (indexHtml !== undefined) {
    // The single-file client changes every rebuild; never let a browser serve a stale
    // cached copy (else client fixes silently don't reach the player).
    const serveIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<string> => {
      void reply.header('content-type', 'text/html; charset=utf-8');
      void reply.header('cache-control', 'no-store, must-revalidate');
      return indexHtml;
    };
    app.get('/', serveIndex);
    app.get('/index.html', serveIndex);
  }

  // Caller-supplied routes (the match create/join API, SV-2.4) — registered after the
  // built-in health/ready so this module stays generic.
  options.httpRoutes?.(app);

  const accountStore = options.accountStore;
  const auth = options.auth;
  const allowedOrigins = options.allowedOrigins;
  app.server.on('upgrade', (request, socket, head) => {
    // Async because auth/nick-login resolve identity through the join-token verifier or
    // the (possibly DB-backed) account store before we accept the upgrade.
    void (async () => {
      // NETA2-1: a refusal the client can READ. A browser hides a rejected WS handshake's
      // HTTP status from JS, so `rejectUpgrade` (raw status + destroy) is indistinguishable
      // from "server down". For NON-security reasons that the public `GET /matches` feed
      // already exposes (match full / entry closed), COMPLETE the upgrade, deliver the
      // reason as an `error` frame (mirrors MatchRoom's E_SLOT_TAKEN path), then close —
      // CloseEvent + message ARE readable. Security refusals (auth/origin/ticket) stay
      // `rejectUpgrade` — no socket for an unauthenticated/cross-origin peer, no leak.
      const refuseWithReason = (id: string, code: ServerErrorCode): void => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          try {
            ws.send(serializeServerMessage({ type: 'error', matchId: id, code }));
          } catch {
            /* peer vanished before the frame went out — nothing to do */
          }
          ws.close(1008, code); // 1008 = policy violation
        });
      };
      try {
        // Origin allowlist (F-06): reject a cross-site upgrade up front. A missing Origin
        // (a non-browser client) is not on any allowlist, so it is refused when configured.
        if (allowedOrigins && !allowedOrigins.includes(request.headers.origin ?? '')) {
          rejectUpgrade(socket, 403);
          return;
        }
        const url = new URL(request.url ?? '/', baseUrl(request));
        // Route by match id: the path is `${pathPrefix}/<matchId>` (one segment, no
        // nesting). Resolve the target match from the registry — an unknown or
        // not-currently-hosted match is a 404, same as before for the single-room case.
        const prefix = `${pathPrefix}/`;
        if (!url.pathname.startsWith(prefix)) {
          rejectUpgrade(socket, 404);
          return;
        }
        let matchId: string;
        try {
          matchId = decodeURIComponent(url.pathname.slice(prefix.length));
        } catch {
          // A malformed %-escape (e.g. `/matches/%zz`) is a bad request path, not a
          // server error — a 404 like any other unroutable path, not a 500.
          rejectUpgrade(socket, 404);
          return;
        }
        if (matchId === '' || matchId.includes('/')) {
          rejectUpgrade(socket, 404);
          return;
        }
        // Load-on-demand for a lazy registry (an evicted match reloads here); an eager
        // registry has no `resolve`, so fall back to the in-memory `get`.
        const room = registry.resolve
          ? await registry.resolve(matchId)
          : registry.get(matchId);
        if (!room) {
          rejectUpgrade(socket, 404);
          return;
        }
        let playerId: string;
        // LARS-1: the JWT's accountId, when present, so the room can key a live
        // ArsenalStore read to this seat. Only the auth handshake ever carries one —
        // the dev/nick paths have no account.
        let accountId: string | undefined;
        // Plaintext seat ticket minted THIS join (seat lock) — delivered once in
        // `welcome.seatTicket`; the server keeps only the hash.
        let mintedTicket: string | undefined;
        if (auth) {
          // Authenticated handshake (SE-0.1): the join token is the SOLE identity —
          // `?player=`/`?nick=` are ignored so they can't bypass it. The token rides in
          // `?token=` (fully browser-settable on the WS URL, unlike request headers).
          const token = url.searchParams.get('token');
          if (!token) {
            rejectUpgrade(socket, 401);
            return;
          }
          const verified = await verifyJoinToken(token, auth);
          if (!verified.ok) {
            rejectUpgrade(socket, 401); // bad/expired/forged — no reason leaked
            return;
          }
          if (verified.claim.matchId !== matchId) {
            rejectUpgrade(socket, 403); // a token for a different match
            return;
          }
          playerId = verified.claim.playerId;
          accountId = verified.claim.accountId;
        } else if (options.seatLock) {
          // Seat lock (REL-5): nick+ticket is the SOLE identity on this path — the
          // direct `?player=` handshake would bypass the lock, so it is refused
          // (the same way `auth` refuses both dev handshakes).
          const nick = url.searchParams.get('nick');
          if (!nick || !accountStore) {
            rejectUpgrade(socket, 401);
            return;
          }
          // Entry window (SES-2.3): a nick that does NOT already hold a seat is a
          // first-time claim — refuse it once the window has closed, BEFORE resolveSeat
          // assigns (so a rejected newcomer never binds/burns a chair). A returning
          // seat-holder skips this and reconnects as always.
          if (options.admitNewSeat && !(await accountStore.seatOf(room.id, nick))) {
            if (!(await options.admitNewSeat(room.id))) {
              refuseWithReason(room.id, 'E_ENTRY_CLOSED'); // real match, closed to newcomers
              return;
            }
          }
          const seats = Object.keys(room.state.players) as PlayerId[];
          const seat = await accountStore.resolveSeat(room.id, nick, seats);
          if (!seat) {
            refuseWithReason(room.id, 'E_MATCH_FULL'); // every side already taken by another nick
            return;
          }
          playerId = seat.playerId;
          const presented = url.searchParams.get('ticket') ?? '';
          const stored = await accountStore.seatTicket(room.id, nick);
          if (stored === null) {
            // First join of this nick (or a seat claimed before the lock existed):
            // mint + bind. Losing the concurrent-bind race means someone else just
            // ticketed this nick — verify against the winner instead (we hold no
            // ticket → refused); never hand out a second ticket for one seat.
            const ticket = randomBytes(24).toString('base64url');
            const winner = await accountStore.bindSeatTicket(room.id, nick, hashTicket(ticket));
            if (winner === null) {
              rejectUpgrade(socket, 401); // seat vanished under us — fail-secure
              return;
            }
            if (winner === hashTicket(ticket)) {
              mintedTicket = ticket; // deliver once in welcome — the client stores it
            } else if (!ticketMatches(presented, winner)) {
              rejectUpgrade(socket, 401);
              return;
            }
          } else if (!ticketMatches(presented, stored)) {
            rejectUpgrade(socket, 401); // locked seat, no/wrong ticket — no detail leaked
            return;
          }
        } else {
          // Insecure dev handshake: `?player=` directly, or `?nick=` via the account store.
          playerId = url.searchParams.get('player') ?? '';
          const nick = url.searchParams.get('nick');
          if (!playerId && nick && accountStore) {
            // Entry window (SES-2.3), same gate as the seat-lock path: a first-time nick
            // is refused once the window closed; a returning seat-holder is not.
            if (options.admitNewSeat && !(await accountStore.seatOf(room.id, nick))) {
              if (!(await options.admitNewSeat(room.id))) {
                refuseWithReason(room.id, 'E_ENTRY_CLOSED'); // real match, closed to newcomers
                return;
              }
            }
            const seats = Object.keys(room.state.players) as PlayerId[];
            const seat = await accountStore.resolveSeat(room.id, nick, seats);
            if (!seat) {
              refuseWithReason(room.id, 'E_MATCH_FULL'); // every side already taken by another nick
              return;
            }
            playerId = seat.playerId;
          }
        }
        if (!room.hasPlayer(playerId)) {
          rejectUpgrade(socket, 403);
          return;
        }
        // Mint a SERVER-owned session id, bound to this connection — never taken from the
        // client (a client-chosen value could reset its own sequence cursor / forge the
        // envelope's session binding, SV-1.1-live-A). A reconnect mints a fresh one.
        const sessionId = randomUUID();
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, playerId, room, sessionId, mintedTicket, accountId);
        });
      } catch {
        rejectUpgrade(socket, 500);
      }
    })();
  });

  // Track live sockets so close() can actively drain them: `httpServer.close()`
  // alone waits for in-flight WebSocket connections forever (they never end on
  // their own), so a graceful restart has to close them itself.
  const sockets = new Set<WebSocket>();
  // Liveness tracking. An ungraceful drop (phone Wi-Fi off, app killed, a tunnel
  // dying) sends no TCP FIN, so 'close' never fires on its own — the peer lingers
  // and keeps its player slot occupied, which (with `singlePeerPerPlayer`) would
  // lock the real player out of their own match on reconnect. A ping/pong
  // heartbeat reaps the dead socket: terminate() → 'close' → removePeer frees it.
  const alive = new WeakMap<WebSocket, boolean>();
  // Connection-level flood guard: a coarse per-socket message cap that drops a raw
  // flood BEFORE the (more expensive) parse — protecting CPU from a spam-clicker or a
  // script. The fine-grained, post-parse throttle is MatchRoom's per-action rate limit;
  // this is the cheap outer net (the connection half of audit F-03).
  const FLOOD_WINDOW_MS = 1_000;
  const FLOOD_MAX = 50; // a legit client sends a few msgs/s (actions + a 2s ping); 50 is slack
  const inbound = new WeakMap<WebSocket, { n: number; since: number }>();
  wss.on(
    'connection',
    (
      ws: WebSocket,
      _request: IncomingMessage,
      playerId: string,
      room: MatchRoom,
      sessionId: string,
      mintedTicket?: string,
      accountId?: string,
    ) => {
      sockets.add(ws);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      // Only retain when the peer actually joined — addPeer rejects (and closes the socket)
      // for an unknown player or a duplicate on a single-seat slot, and a spurious retain
      // would disarm a legitimate hibernation countdown, starving eviction under reconnects.
      if (
        room.addPeer(
          playerId,
          ws,
          sessionId,
          mintedTicket ? { seatTicket: mintedTicket } : undefined,
          accountId,
        )
      ) {
        registry.retain?.(room.id); // keep the match resident while this socket is connected
      }
      ws.on('message', (data) => {
        const now = Date.now();
        const c = inbound.get(ws) ?? { n: 0, since: now };
        if (now - c.since >= FLOOD_WINDOW_MS) {
          c.n = 0;
          c.since = now;
        }
        c.n += 1;
        inbound.set(ws, c);
        if (c.n > FLOOD_MAX) return; // drop a raw flood before the parse (cheap)
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        // Pass the server-minted sessionId so a gated room can authorize the envelope's
        // session binding against it (SV-1.1-live-A). Ignored by an un-gated room.
        void room.receive(playerId, ws, raw, sessionId); // fire-and-forget; ping may be async
      });
      ws.on('close', () => {
        sockets.delete(ws);
        room.removePeer(playerId, ws);
        registry.release?.(room.id); // may start the idle→hibernate countdown if unwatched
      });
    },
  );

  // Each round: reap any socket that didn't answer last round's ping, then ping
  // the rest. Reap window is one interval, so a slot frees within ~2×HEARTBEAT.
  const HEARTBEAT_MS = 15_000;
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref(); // never keep the process alive just for the heartbeat

  return {
    httpServer: app.server,
    listen: async () => {
      await app.listen({ host, port });
      const address = app.server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      // Hosting exactly one match ⇒ return its full URL (backward-compatible: callers
      // connect straight to it). Multiple ⇒ return the base prefix; the client appends
      // `/<matchId>`.
      const ids = registry.ids();
      const suffix = ids.length === 1 ? `${pathPrefix}/${ids[0]}` : pathPrefix;
      app.log.info(
        { host, port: boundPort, matches: ids.length, tls: !!options.tls },
        'server listening',
      );
      return `${options.tls ? 'wss' : 'ws'}://${host}:${boundPort}${suffix}`;
    },
    close: async () => {
      draining = true; // /ready now reports 503 so a load balancer drains us first
      app.log.info('server draining');
      clearInterval(heartbeat);
      // Graceful drain: ask every client to close (1001 "going away"), then
      // terminate any straggler after a short grace so close() always resolves.
      for (const ws of sockets) ws.close(1001, 'server shutting down');
      const grace = setTimeout(() => {
        for (const ws of sockets) ws.terminate();
      }, 1000);
      grace.unref();
      // Persist + tear down every live match (lazy registry); a no-op for an eager one,
      // whose rooms the caller stops via its own shutdown handler.
      await registry.shutdown?.();
      // Stop accepting WS upgrades, then let Fastify close the HTTP server + its plugins.
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await app.close();
      clearTimeout(grace);
    },
  };
}
