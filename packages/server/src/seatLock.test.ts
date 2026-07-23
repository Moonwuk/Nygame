import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type Player,
} from '@void/shared-core';
import { MatchRoom } from './matchRoom';
import { createMultiplayerServer } from './wsServer';
import { MemoryAccountStore } from './store';
import type { ServerMessage } from './protocol';

// REL-5 — the seat lock on the nick-login path. A nick's FIRST join mints a seat
// ticket (delivered once in `welcome.seatTicket`, stored server-side as a hash);
// every LATER join must present it back (`?ticket=`) or is refused, and the direct
// `?player=` handshake is refused outright (it would bypass the lock). Without
// `seatLock` the open dev handshake is unchanged (covered by wsServer.test.ts).

function player(id: string): Player {
  return { id, name: id, faction: id, status: 'active', resources: {} };
}

function makeRoom(): MatchRoom {
  const base = createInitialState({ seed: 'lock-test', version: { data: 'test', manifest: 'test' } });
  return new MatchRoom({
    id: 'lock-room',
    initialState: { ...base, players: { p1: player('p1'), p2: player('p2') } },
    kernel: createKernel([]),
    data: parseGameData({
      version: 'test',
      resources: ['marker'],
      units: {},
      factions: {},
      buildings: {},
      events: {},
      sectors: {},
      planetTypes: {},
    }),
    now: () => 10,
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([data]) => JSON.parse(data.toString()) as ServerMessage);
}

/** Connect expecting the upgrade to be REJECTED; resolves the HTTP status the server sent. */
function rejectStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('expected the handshake to be rejected, but it connected'));
    });
    ws.on('error', () => {
      /* the server writes a raw 401 then destroys — 'unexpected-response' carries it */
    });
  });
}

/** Connect expecting an INFORMATIONAL refusal (NETA2-1): the handshake COMPLETES and the
 *  server delivers the reason as an `error` frame (readable by a browser, unlike a raw
 *  handshake status), then closes. Resolves the code. */
function refuseReason(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.on('message', (data) => {
      ws.close();
      const msg = JSON.parse(data.toString()) as { type?: string; code?: string };
      if (msg.type === 'error' && msg.code) resolve(msg.code);
      else reject(new Error('expected an error frame, got ' + data.toString()));
    });
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      reject(new Error('expected a readable error frame, got a raw ' + (res.statusCode ?? 0)));
    });
    ws.on('error', () => {
      /* transient — the message/unexpected-response handlers settle the promise */
    });
  });
}

type Welcome = ServerMessage & { playerId?: string; seatTicket?: string };

async function join(target: string): Promise<{ ws: WebSocket; welcome: Welcome }> {
  const ws = new WebSocket(target);
  const welcome = (await nextMessage(ws)) as Welcome;
  expect(welcome).toMatchObject({ type: 'welcome' });
  return { ws, welcome };
}

describe('REL-5 · seat lock (nick + ticket)', () => {
  it('mints a ticket on first join, requires it on reconnect, refuses without it', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      // First join: seated + a plaintext ticket rides the welcome exactly once.
      const first = await join(`${url}?nick=alice`);
      const ticket = first.welcome.seatTicket;
      expect(typeof ticket).toBe('string');
      expect((ticket ?? '').length).toBeGreaterThanOrEqual(24);
      const seat = first.welcome.playerId;
      first.ws.close();
      await once(first.ws, 'close');

      // Reconnect WITHOUT the ticket → refused (the hijack this brick closes).
      expect(await rejectStatus(`${url}?nick=alice`)).toBe(401);
      // Wrong ticket → refused.
      expect(await rejectStatus(`${url}?nick=alice&ticket=forged`)).toBe(401);

      // Reconnect WITH the ticket → same seat back, and NO re-mint (hash-only server).
      const again = await join(`${url}?nick=alice&ticket=${encodeURIComponent(ticket ?? '')}`);
      expect(again.welcome.playerId).toBe(seat);
      expect(again.welcome.seatTicket).toBeUndefined();
      again.ws.close();
    } finally {
      await server.close();
    }
  });

  it('each nick gets its OWN ticket; one ticket cannot open another seat', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      const alice = await join(`${url}?nick=alice`);
      const bob = await join(`${url}?nick=bob`);
      expect(bob.welcome.playerId).not.toBe(alice.welcome.playerId);
      expect(bob.welcome.seatTicket).not.toBe(alice.welcome.seatTicket);
      alice.ws.close();
      await once(alice.ws, 'close');
      // Bob's ticket does not open Alice's seat.
      expect(
        await rejectStatus(`${url}?nick=alice&ticket=${encodeURIComponent(bob.welcome.seatTicket ?? '')}`),
      ).toBe(401);
      bob.ws.close();
    } finally {
      await server.close();
    }
  });

  it('refuses the direct ?player= handshake (no lock bypass) and a missing nick', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      expect(await rejectStatus(`${url}?player=p1`)).toBe(401);
      expect(await rejectStatus(url)).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('adopts a seat claimed BEFORE the lock existed: the owner’s next join mints its ticket', async () => {
    const store = new MemoryAccountStore();
    // Pre-lock world: alice already holds a seat, no ticket bound (e.g. rows written
    // by a server that ran before REL-5).
    await store.resolveSeat('lock-room', 'alice', ['p1', 'p2']);
    const server = createMultiplayerServer({ room: makeRoom(), accountStore: store, seatLock: true });
    const url = await server.listen();
    try {
      const adopted = await join(`${url}?nick=alice`);
      expect(typeof adopted.welcome.seatTicket).toBe('string'); // ticketed on this join
      adopted.ws.close();
      await once(adopted.ws, 'close');
      expect(await rejectStatus(`${url}?nick=alice`)).toBe(401); // and locked from now on
    } finally {
      await server.close();
    }
  });

  it('two concurrent FIRST joins of one nick: exactly one is ticketed, the other refused', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      // Same nick, no tickets, dialed in the same tick — racing resolveSeat + bind.
      // Whichever loses the bind race holds no ticket and must be refused; the winner
      // is admitted WITH the freshly minted ticket. Never two tickets, never zero.
      const dial = (): Promise<{ ok: true; w: Welcome } | { ok: false; status: number }> =>
        new Promise((resolve) => {
          const ws = new WebSocket(`${url}?nick=alice`);
          ws.on('unexpected-response', (_req, res) => {
            ws.terminate();
            resolve({ ok: false, status: res.statusCode ?? 0 });
          });
          ws.on('error', () => {});
          ws.on('message', (data) => {
            const m = JSON.parse(data.toString()) as Welcome;
            if (m.type === 'welcome') {
              ws.close();
              resolve({ ok: true, w: m });
            }
          });
        });
      const results = await Promise.all([dial(), dial()]);
      const admittedResults = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      expect(admittedResults).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(typeof (admittedResults[0] as { w: Welcome }).w.seatTicket).toBe('string');
      expect((refused[0] as { status: number }).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('a full room refuses a NEW nick with a readable E_MATCH_FULL (NETA2-1)', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
    });
    const url = await server.listen();
    try {
      const a = await join(`${url}?nick=alice`);
      const b = await join(`${url}?nick=bob`);
      expect(await refuseReason(`${url}?nick=carol`)).toBe('E_MATCH_FULL');
      a.ws.close();
      b.ws.close();
    } finally {
      await server.close();
    }
  });
});

describe('SES-2.3 · entry window (admitNewSeat)', () => {
  it('seat-lock path: a closed window refuses a NEW nick (E_ENTRY_CLOSED) but a seated nick reconnects', async () => {
    let open = true;
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
      seatLock: true,
      admitNewSeat: () => open,
    });
    const url = await server.listen();
    try {
      // While the window is open, alice claims a seat + gets her ticket.
      const alice = await join(`${url}?nick=alice`);
      const ticket = alice.welcome.seatTicket ?? '';
      const seat = alice.welcome.playerId;
      alice.ws.close();
      await once(alice.ws, 'close');
      // Window closes: a brand-new nick is refused BEFORE any seat is assigned.
      open = false;
      expect(await refuseReason(`${url}?nick=bob`)).toBe('E_ENTRY_CLOSED');
      // …and bob never burned a chair, so the room still has a free seat (entry closed,
      // not full). Meanwhile alice — already seated — reconnects with her ticket.
      const again = await join(`${url}?nick=alice&ticket=${encodeURIComponent(ticket)}`);
      expect(again.welcome.playerId).toBe(seat);
      again.ws.close();
    } finally {
      await server.close();
    }
  });

  it('dev nick path (no lock): a closed window refuses a first-time nick, admits a returning one', async () => {
    let open = true;
    const store = new MemoryAccountStore();
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: store,
      admitNewSeat: () => open,
    });
    const url = await server.listen();
    try {
      const alice = await join(`${url}?nick=alice`);
      const seat = alice.welcome.playerId;
      alice.ws.close();
      await once(alice.ws, 'close');
      open = false;
      expect(await refuseReason(`${url}?nick=bob`)).toBe('E_ENTRY_CLOSED'); // first-time claim, window shut
      const again = await join(`${url}?nick=alice`); // already a participant → admitted
      expect(again.welcome.playerId).toBe(seat);
      again.ws.close();
    } finally {
      await server.close();
    }
  });

  it('no admitNewSeat ⇒ every join allowed (backward-compatible)', async () => {
    const server = createMultiplayerServer({
      room: makeRoom(),
      accountStore: new MemoryAccountStore(),
    });
    const url = await server.listen();
    try {
      const a = await join(`${url}?nick=alice`);
      expect(a.welcome.playerId).toBeDefined();
      a.ws.close();
    } finally {
      await server.close();
    }
  });
});
