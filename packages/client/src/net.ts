/**
 * Browser-WebSocket transport for a live match (CP1.1 + CP1.4 reconnect —
 * docs/cross-platform-roadmap.md). This is the ONLY WebSocket-specific glue around the
 * transport-agnostic {@link MultiplayerClient}: it opens a real socket to the server,
 * wires the socket lifecycle into the client (open → `open()`, message → `receive()`),
 * and hands the client back so callers send actions / read snapshots exactly as they
 * would with a test socket. The server speaks the wire protocol the prototype already uses:
 *   ws://<host>/matches/<matchId>?nick=<you>      (or ?player=p1 on the dev proto-server)
 *
 * Reconnect (CP1.4): an unexpected socket loss flips the client to 'connecting' (it
 * starts queueing actions) and retries with exponential backoff; the server greets every
 * (re)join with a full `welcome`, which IS the resync — the client resets its baseline
 * and flushes the queued actions under the fresh session. Only `close()` on the returned
 * {@link LiveMatch} ends the match for good.
 */
import {
  MultiplayerClient,
  type MultiplayerClientHandlers,
  type MultiplayerSocket,
} from './multiplayer';

export interface LiveMatch {
  /** The transport-agnostic client — send actions, ping, start, place tactical pings. */
  readonly client: MultiplayerClient;
  /** Close the underlying socket for good — no reconnect after this. */
  close(): void;
}

/** Reconnect backoff schedule (CP1.4): doubles per consecutive failure, capped; a
 *  successful open resets it. Mobile-network drops recover on the early short waits. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Open a live match over a browser WebSocket at `url`. The caller's `handlers` receive
 *  `onStatus`/`onSnapshot`/… as usual; the returned {@link LiveMatch} is for sending. */
export function openLiveMatch(url: string, handlers: MultiplayerClientHandlers): LiveMatch {
  let ws!: WebSocket;
  let attempt = 0; // consecutive drops since the last successful open
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closedForGood = false;

  // The client outlives individual sockets: `ws` is rebound on every reconnect while
  // the client keeps its handlers, session and outbox across the swap.
  const socket: MultiplayerSocket = {
    // Only send on an OPEN socket — a queued send before the handshake would throw.
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      closedForGood = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      ws.close();
    },
  };

  const client = new MultiplayerClient(socket, {
    ...handlers,
    // A non-monotonic delta means our baseline can't be trusted — force a fresh
    // socket: the welcome it brings is the full resync. The caller still hears it.
    onDesync: (lastSeq, gotSeq) => {
      handlers.onDesync?.(lastSeq, gotSeq);
      if (!closedForGood) {
        client.connectionLost();
        ws.close(); // → 'close' listener schedules the backoff reconnect
      }
    },
  });

  const scheduleReconnect = (): void => {
    if (closedForGood || timer !== undefined) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      attempt = 0;
      client.open();
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') client.receive(ev.data);
    });
    // ANY close we didn't ask for — server restart, mobile-network drop, backpressure
    // kick — starts the reconnect loop. The client flips to 'connecting' and queues
    // actions until the reconnect welcome (fail-safe: nothing is sent into the void).
    ws.addEventListener('close', () => {
      if (closedForGood) return;
      client.connectionLost();
      scheduleReconnect();
    });
    ws.addEventListener('error', () => handlers.onError?.('E_SOCKET'));
  };
  connect();

  return { client, close: () => client.close() };
}
