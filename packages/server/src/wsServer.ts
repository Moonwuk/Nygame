import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PlayerId } from '@void/shared-core';
import { WebSocket, WebSocketServer } from 'ws';
import type { MatchRoom } from './matchRoom';
import { MatchRegistry } from './matchRegistry';
import { MemoryAccountStore, type AccountStore } from './store';

export interface MultiplayerServerOptions {
  /** Multi-match mode: the registry of joinable matches. The WS layer routes
   *  `/<pathPrefix>/<id>` to the registered room and exposes the match-browser
   *  read-model (`GET /matches`) + archive intents over HTTP. */
  registry?: MatchRegistry;
  /** Single-match mode (legacy): one room, wrapped into a registry-of-one so the
   *  routing/serving path is identical. */
  room?: MatchRoom;
  host?: string;
  port?: number;
  pathPrefix?: string;
  /** Optional HTML served at `/` and `/index.html` — lets a dev/proto server hand
   *  the client the game itself, so a peer just opens `http://host:port/` (no file
   *  transfer, and the connect overlay auto-fills the same-origin ws:// URL). */
  indexHtml?: string;
  /** Optional nick-login for the single-match path: when a client connects with
   *  `?nick=…` (instead of `?player=`), the seat is resolved/assigned here so a
   *  returning nick gets its own side back. Absent ⇒ only `?player=` works. In
   *  multi-match mode the registry's own account store is used instead. */
  accountStore?: AccountStore;
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

/** In single-match mode, wrap the one room in a registry-of-one so routing and the
 *  read-model have a uniform source. The legacy meta is a placeholder (legacy callers
 *  don't read the browser); real metadata comes from the caller's registry. */
function toRegistry(options: MultiplayerServerOptions): MatchRegistry {
  if (options.registry) return options.registry;
  const registry = new MatchRegistry(options.accountStore ?? new MemoryAccountStore());
  if (options.room) {
    registry.register(options.room, { mapId: 'dev', rules: { timeScale: 1 }, createdAt: Date.now() });
  }
  return registry;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createMultiplayerServer(
  options: MultiplayerServerOptions,
): MultiplayerServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pathPrefix = options.pathPrefix ?? '/matches';
  const registry = toRegistry(options);
  // Seat resolver for `?nick=`: the registry's store in multi-match mode, or the
  // explicitly-provided store in legacy mode (absent ⇒ `?nick=` is rejected, as before).
  const seatResolver: AccountStore | undefined = options.registry
    ? registry.accounts
    : options.accountStore;
  // listen() reports a concrete match URL when there is one (back-compat: tests dial it).
  const firstRoomId = options.room?.id ?? registry.ids()[0];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_768 });

  const archiveRe = new RegExp(`^${escapeRe(pathPrefix)}/([^/]+)/(archive|unarchive)$`);
  const indexHtml = options.indexHtml;
  const httpServer = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (path === '/health') {
      json(200, { ok: true, matches: registry.ids() });
      return;
    }
    // Match-browser read-model: the three tabs (available/active/archived) for a
    // viewer (`?nick=`). A server projection — the client only reads it (A10/fog rule).
    if (path === pathPrefix || path === `${pathPrefix}/`) {
      void (async () => {
        try {
          const nick = new URL(request.url ?? '/', baseUrl(request)).searchParams.get('nick');
          json(200, await registry.list(nick));
        } catch {
          json(500, { ok: false, code: 'E_INTERNAL' });
        }
      })();
      return;
    }
    // Archive / restore intent: POST /<prefix>/<id>/archive?nick=… — fail-secure.
    const archive = archiveRe.exec(path);
    if (archive) {
      if (method !== 'POST') {
        json(405, { ok: false, code: 'E_METHOD' });
        return;
      }
      void (async () => {
        try {
          const matchId = decodeURIComponent(archive[1] ?? '');
          const nick = new URL(request.url ?? '/', baseUrl(request)).searchParams.get('nick') ?? '';
          const result =
            archive[2] === 'archive'
              ? await registry.archive(matchId, nick)
              : await registry.unarchive(matchId, nick);
          json(result.ok ? 200 : result.code === 'E_NO_MATCH' ? 404 : 403, result);
        } catch {
          json(500, { ok: false, code: 'E_INTERNAL' });
        }
      })();
      return;
    }
    if (indexHtml !== undefined && (path === '/' || path === '/index.html')) {
      // The single-file client changes every rebuild; never let a browser serve a
      // stale cached copy (else client fixes silently don't reach the player).
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, must-revalidate',
      });
      response.end(indexHtml);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  httpServer.on('upgrade', (request, socket, head) => {
    // Async because nick-login resolves a seat through the (possibly DB-backed)
    // account store before we accept the upgrade.
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', baseUrl(request));
        if (!url.pathname.startsWith(`${pathPrefix}/`)) {
          rejectUpgrade(socket, 404);
          return;
        }
        const matchId = decodeURIComponent(url.pathname.slice(pathPrefix.length + 1));
        const room = registry.get(matchId);
        if (!room) {
          rejectUpgrade(socket, 404);
          return;
        }
        let playerId = url.searchParams.get('player') ?? '';
        const nick = url.searchParams.get('nick');
        if (!playerId && nick && seatResolver) {
          const seats = Object.keys(room.state.players) as PlayerId[];
          const seat = await seatResolver.resolveSeat(matchId, nick, seats);
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
          wss.emit('connection', ws, request, { room, playerId });
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
    (ws: WebSocket, _request: IncomingMessage, ctx: { room: MatchRoom; playerId: string }) => {
      const { room, playerId } = ctx;
      sockets.add(ws);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      room.addPeer(playerId, ws);
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

  const matchUrl = (addrPort: number): string =>
    firstRoomId !== undefined
      ? `ws://${host}:${addrPort}${pathPrefix}/${firstRoomId}`
      : `ws://${host}:${addrPort}`;

  return {
    httpServer,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          resolve(matchUrl(typeof address === 'object' && address !== null ? address.port : port));
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(heartbeat);
        // Graceful drain: ask every client to close (1001 "going away"), then
        // terminate any straggler after a short grace so close() always resolves.
        for (const ws of sockets) ws.close(1001, 'server shutting down');
        const grace = setTimeout(() => {
          for (const ws of sockets) ws.terminate();
        }, 1000);
        grace.unref();
        wss.close(() => {
          httpServer.close((error) => {
            clearTimeout(grace);
            if (error) reject(error);
            else resolve();
          });
        });
      }),
  };
}
