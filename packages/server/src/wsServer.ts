import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PlayerId } from '@void/shared-core';
import { WebSocket, WebSocketServer } from 'ws';
import type { MatchRoom } from './matchRoom';
import type { AccountStore } from './store';

export interface MultiplayerServerOptions {
  room: MatchRoom;
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
  const room = options.room;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_768 });

  const indexHtml = options.indexHtml;
  const httpServer = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, matchId: room.id, seq: room.sequence }));
      return;
    }
    if (indexHtml !== undefined && (path === '/' || path === '/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(indexHtml);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  const accountStore = options.accountStore;
  httpServer.on('upgrade', (request, socket, head) => {
    // Async because nick-login resolves a seat through the (possibly DB-backed)
    // account store before we accept the upgrade.
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', baseUrl(request));
        if (url.pathname !== `${pathPrefix}/${room.id}`) {
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
          wss.emit('connection', ws, request, playerId);
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
  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, playerId: string) => {
    sockets.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    room.addPeer(playerId, ws);
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      void room.receive(playerId, ws, raw); // fire-and-forget; ping handling may be async
    });
    ws.on('close', () => {
      sockets.delete(ws);
      room.removePeer(playerId, ws);
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
    httpServer,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          if (typeof address === 'object' && address !== null) {
            resolve(`ws://${host}:${address.port}${pathPrefix}/${room.id}`);
            return;
          }
          resolve(`ws://${host}:${port}${pathPrefix}/${room.id}`);
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
