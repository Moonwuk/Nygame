import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { MatchRoom } from './matchRoom';

export interface MultiplayerServerOptions {
  room: MatchRoom;
  host?: string;
  port?: number;
  pathPrefix?: string;
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
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`);
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

  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, matchId: room.id, seq: room.sequence }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', baseUrl(request));
    if (url.pathname !== `${pathPrefix}/${room.id}`) {
      rejectUpgrade(socket, 404);
      return;
    }
    const playerId = url.searchParams.get('player') ?? '';
    if (!room.hasPlayer(playerId)) {
      rejectUpgrade(socket, 403);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, playerId);
    });
  });

  // Track live sockets so close() can actively drain them: `httpServer.close()`
  // alone waits for in-flight WebSocket connections forever (they never end on
  // their own), so a graceful restart has to close them itself.
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, playerId: string) => {
    sockets.add(ws);
    room.addPeer(playerId, ws);
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      room.receive(playerId, ws, raw);
    });
    ws.on('close', () => {
      sockets.delete(ws);
      room.removePeer(playerId, ws);
    });
  });

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
