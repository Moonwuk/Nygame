import { describe, it, expect, afterEach } from 'vitest';
import type { GameState } from '@void/shared-core';
import { openLiveMatch } from './net';
import type { MultiplayerStatus, MultiplayerSnapshot } from './multiplayer';

// A minimal fake of the browser WebSocket so the transport glue can be tested in Node
// (the client tests run without a DOM). It records sends and lets the test fire lifecycle
// events (open/message/close/error) exactly as the real socket would.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | undefined;
  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', {});
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire('open', {});
  }
  fireMessage(data: string): void {
    this.fire('message', { data });
  }
  fireError(): void {
    this.fire('error', {});
  }
}

const realWebSocket = globalThis.WebSocket;
function installFakeSocket(): void {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  FakeWebSocket.last = undefined;
});

// A tiny, renderable-shaped GameState is enough — the client passes snapshots through
// without validating them, so the transport can be tested with a stub state.
const STATE = { time: 42, planets: {}, fleets: {}, players: {} } as unknown as GameState;

describe('net — openLiveMatch (browser WebSocket transport)', () => {
  it('reports connecting → open across the socket handshake', () => {
    installFakeSocket();
    const statuses: MultiplayerStatus[] = [];
    openLiveMatch('ws://x/matches/proto?player=p1', { onStatus: (s) => statuses.push(s) });
    expect(statuses).toEqual(['connecting']); // client constructor announces connecting
    FakeWebSocket.last!.fireOpen();
    expect(statuses).toEqual(['connecting', 'open']);
    expect(FakeWebSocket.last!.url).toBe('ws://x/matches/proto?player=p1');
  });

  it('surfaces a welcome frame as a full snapshot', () => {
    installFakeSocket();
    const snaps: MultiplayerSnapshot[] = [];
    openLiveMatch('ws://x', { onSnapshot: (s) => snaps.push(s) });
    FakeWebSocket.last!.fireOpen();
    FakeWebSocket.last!.fireMessage(
      JSON.stringify({ type: 'welcome', matchId: 'proto', seq: 1, playerId: 'p1', state: STATE }),
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ matchId: 'proto', seq: 1, playerId: 'p1' });
    expect(snaps[0]!.state.time).toBe(42);
  });

  it('gates sends until the socket is OPEN', () => {
    installFakeSocket();
    const { client } = openLiveMatch('ws://x', {});
    client.ping(100); // before open → dropped, not thrown
    expect(FakeWebSocket.last!.sent).toHaveLength(0);
    FakeWebSocket.last!.fireOpen();
    client.ping(200);
    expect(FakeWebSocket.last!.sent).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.last!.sent[0]!)).toMatchObject({ type: 'ping', clientTime: 200 });
  });

  it('forwards a server error and a server-initiated close', () => {
    installFakeSocket();
    let error: string | undefined;
    const statuses: MultiplayerStatus[] = [];
    openLiveMatch('ws://x', { onError: (c) => (error = c), onStatus: (s) => statuses.push(s) });
    FakeWebSocket.last!.fireError();
    expect(error).toBe('E_SOCKET');
    FakeWebSocket.last!.close();
    expect(statuses).toContain('closed');
  });
});
