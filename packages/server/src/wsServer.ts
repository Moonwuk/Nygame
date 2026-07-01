import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PlayerId } from '@void/shared-core';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { MatchRoom } from './matchRoom';
import { InMemoryMatchRegistry, type MatchRegistry } from './matchRegistry';
import type { AccountStore } from './store';

export interface MultiplayerServerOptions {
  /** Single-match shortcut. Exactly one of `room` / `registry` must be given; `room`
   *  is sugar for a one-entry registry (backward-compatible with every existing caller). */
  room?: MatchRoom;
  /** Multi-match: host N isolated matches in one process, routed by `${pathPrefix}/:id`. */
  registry?: MatchRegistry;
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
}

export interface MultiplayerServerHandle {
  readonly httpServer: HttpServer;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function baseUrl(request: IncomingMessage): string {
  return `http://${request.headers.host ?? 'localhost'}`;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason =
    status === 403
      ? 'Forbidden'
      : status === 409
        ? 'Conflict'
        : status === 500
          ? 'Internal Server Error'
          : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
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
  const registry: MatchRegistry =
    options.registry ?? new InMemoryMatchRegistry([options.room as MatchRoom]);
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
  const app = Fastify({ logger: options.logger ?? false, disableRequestLogging: true });

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

  const accountStore = options.accountStore;
  app.server.on('upgrade', (request, socket, head) => {
    // Async because nick-login resolves a seat through the (possibly DB-backed)
    // account store before we accept the upgrade.
    void (async () => {
      try {
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
        let playerId = url.searchParams.get('player') ?? '';
        const nick = url.searchParams.get('nick');
        if (!playerId && nick && accountStore) {
          const seats = Object.keys(room.state.players) as PlayerId[];
          const seat = await accountStore.resolveSeat(room.id, nick, seats);
          if (!seat) {
            rejectUpgrade(socket, 409); // every side already taken by another nick
            return;
          }
          playerId = seat.playerId;
        }
        if (!room.hasPlayer(playerId)) {
          rejectUpgrade(socket, 403);
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, playerId, room);
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
  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, playerId: string, room: MatchRoom) => {
    sockets.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    // Only retain when the peer actually joined — addPeer rejects (and closes the socket)
    // for an unknown player or a duplicate on a single-seat slot, and a spurious retain
    // would disarm a legitimate hibernation countdown, starving eviction under reconnects.
    if (room.addPeer(playerId, ws)) {
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
      void room.receive(playerId, ws, raw); // fire-and-forget; ping handling may be async
    });
    ws.on('close', () => {
      sockets.delete(ws);
      room.removePeer(playerId, ws);
      registry.release?.(room.id); // may start the idle→hibernate countdown if unwatched
    });
  });

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
      app.log.info({ host, port: boundPort, matches: ids.length }, 'server listening');
      return `ws://${host}:${boundPort}${suffix}`;
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
