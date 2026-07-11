import { describe, it, expect, afterEach, vi } from 'vitest';
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
  /** Every socket ever constructed — lets reconnect tests count connection attempts. */
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    FakeWebSocket.all.push(this);
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
  FakeWebSocket.all = [];
  vi.useRealTimers();
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

  it('forwards a server error; an unexpected close flips to connecting (reconnect pending)', () => {
    installFakeSocket();
    vi.useFakeTimers();
    let error: string | undefined;
    const statuses: MultiplayerStatus[] = [];
    openLiveMatch('ws://x', { onError: (c) => (error = c), onStatus: (s) => statuses.push(s) });
    FakeWebSocket.last!.fireError();
    expect(error).toBe('E_SOCKET');
    FakeWebSocket.last!.close();
    // CP1.4: a close we didn't ask for is NOT final — the transport is reconnecting.
    expect(statuses.at(-1)).toBe('connecting');
    expect(statuses).not.toContain('closed');
  });
});

// CP1.4 — auto-reconnect: an unexpected socket loss retries with exponential backoff,
// the reconnect welcome is the resync, and a deliberate close() never reconnects.
describe('net — reconnect and resume (CP1.4)', () => {
  it('reconnects after an unexpected close and resyncs from the fresh welcome', () => {
    installFakeSocket();
    vi.useFakeTimers();
    const statuses: MultiplayerStatus[] = [];
    const snaps: MultiplayerSnapshot[] = [];
    const { client } = openLiveMatch('ws://x/matches/proto?player=p1', {
      onStatus: (s) => statuses.push(s),
      onSnapshot: (s) => snaps.push(s),
    });
    const first = FakeWebSocket.last!;
    first.fireOpen();
    first.fireMessage(
      JSON.stringify({ type: 'welcome', matchId: 'proto', seq: 3, playerId: 'p1', state: STATE }),
    );
    expect(statuses.at(-1)).toBe('open');

    first.close(); // mobile network died
    expect(statuses.at(-1)).toBe('connecting');
    expect(FakeWebSocket.all).toHaveLength(1); // retry is scheduled, not immediate

    vi.advanceTimersByTime(1000); // first backoff step
    expect(FakeWebSocket.all).toHaveLength(2);
    const second = FakeWebSocket.last!;
    expect(second).not.toBe(first);
    expect(second.url).toBe('ws://x/matches/proto?player=p1');

    // An action issued while down is queued…
    client.sendAction({
      id: 'a1',
      type: 'fleet.orbit',
      playerId: 'p1',
      payload: { fleetId: 'f', orbit: 'near' },
      issuedAt: 1,
    });
    expect(second.sent).toHaveLength(0);

    // …and the reconnect welcome resyncs the state AND flushes the queue.
    second.fireOpen();
    second.fireMessage(
      JSON.stringify({ type: 'welcome', matchId: 'proto', seq: 9, playerId: 'p1', state: STATE }),
    );
    expect(statuses.at(-1)).toBe('open');
    expect(snaps.at(-1)?.seq).toBe(9);
    expect(second.sent).toHaveLength(1);
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: 'action', action: { id: 'a1' } });
  });

  it('backs off exponentially while the server stays down', () => {
    installFakeSocket();
    vi.useFakeTimers();
    openLiveMatch('ws://x', {});
    FakeWebSocket.last!.fireOpen();
    FakeWebSocket.last!.close(); // drop #1 → retry in 1s
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(2);

    FakeWebSocket.last!.close(); // retry failed → next wait doubles to 2s
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(2); // 1s is not enough now
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(3); // fires at 2s

    FakeWebSocket.last!.close(); // → 4s
    vi.advanceTimersByTime(3999);
    expect(FakeWebSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(4);

    // A successful open resets the schedule back to 1s.
    FakeWebSocket.last!.fireOpen();
    FakeWebSocket.last!.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(5);
  });

  it('a deliberate close() is final — no reconnect, status closed', () => {
    installFakeSocket();
    vi.useFakeTimers();
    const statuses: MultiplayerStatus[] = [];
    const match = openLiveMatch('ws://x', { onStatus: (s) => statuses.push(s) });
    FakeWebSocket.last!.fireOpen();
    match.close();
    expect(statuses.at(-1)).toBe('closed');
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.all).toHaveLength(1); // nothing reconnected
  });

  it('a pending retry is cancelled by close()', () => {
    installFakeSocket();
    vi.useFakeTimers();
    const match = openLiveMatch('ws://x', {});
    FakeWebSocket.last!.fireOpen();
    FakeWebSocket.last!.close(); // schedules the 1s retry
    match.close(); // user leaves the match while offline
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it('a backwards delta (desync) forces an immediate resync-reconnect', () => {
    installFakeSocket();
    vi.useFakeTimers();
    const snaps: MultiplayerSnapshot[] = [];
    const desyncs: [number, number][] = [];
    openLiveMatch('ws://x', {
      onSnapshot: (s) => snaps.push(s),
      onDesync: (last, got) => desyncs.push([last, got]),
    });
    const first = FakeWebSocket.last!;
    first.fireOpen();
    first.fireMessage(
      JSON.stringify({ type: 'welcome', matchId: 'proto', seq: 7, playerId: 'p1', state: STATE }),
    );
    first.fireMessage(
      JSON.stringify({ type: 'delta', matchId: 'proto', seq: 2, delta: { changed: {}, removed: {} } }),
    );
    expect(desyncs).toEqual([[7, 2]]); // surfaced to the caller too
    expect(first.readyState).toBe(FakeWebSocket.CLOSED); // transport killed the socket
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.all).toHaveLength(2); // …and is already reconnecting
  });
});
