/**
 * Browser-WebSocket transport for a live match (CP1.1 — docs/cross-platform-roadmap.md).
 * This is the ONLY WebSocket-specific glue around the transport-agnostic
 * {@link MultiplayerClient}: it opens a real socket to the server, wires the socket
 * lifecycle into the client (open → `open()`, message → `receive()`, close/error → status),
 * and hands the client back so callers send actions / read snapshots exactly as they would
 * with a test socket. The server speaks the wire protocol the prototype already uses:
 *   ws://<host>/matches/<matchId>?nick=<you>      (or ?player=p1 on the dev proto-server)
 */
import {
  MultiplayerClient,
  type MultiplayerClientHandlers,
  type MultiplayerSocket,
} from './multiplayer';

export interface LiveMatch {
  /** The transport-agnostic client — send actions, ping, start, place tactical pings. */
  readonly client: MultiplayerClient;
  /** Close the underlying socket. */
  close(): void;
}

/** Open a live match over a browser WebSocket at `url`. The caller's `handlers` receive
 *  `onStatus`/`onSnapshot`/… as usual; the returned {@link LiveMatch} is for sending. */
export function openLiveMatch(url: string, handlers: MultiplayerClientHandlers): LiveMatch {
  const ws = new WebSocket(url);
  const socket: MultiplayerSocket = {
    // Only send on an OPEN socket — a queued send before the handshake would throw.
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  };
  const client = new MultiplayerClient(socket, handlers);
  ws.addEventListener('open', () => client.open());
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') client.receive(ev.data);
  });
  // A server-initiated close/error is surfaced as status/error to the caller (the client's
  // own status only flips when WE call close(), so forward the socket's lifecycle here).
  ws.addEventListener('close', () => handlers.onStatus?.('closed'));
  ws.addEventListener('error', () => handlers.onError?.('E_SOCKET'));
  return { client, close: () => ws.close() };
}
