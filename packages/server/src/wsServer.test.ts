import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type GameModule,
  type Player,
} from '@void/shared-core';
import { MatchRoom } from './matchRoom';
import { createMultiplayerServer } from './wsServer';
import { MemoryAccountStore } from './store';
import type { ServerMessage } from './protocol';

const markerModule: GameModule = {
  id: 'marker-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('marker.set', (action, h) => {
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_FORBIDDEN');
      player.resources.marker = (player.resources.marker ?? 0) + 1;
      h.emit('marker.set', { playerId: action.playerId });
    });
  },
};

function player(id: string): Player {
  return { id, name: id, faction: id, status: 'active', resources: {} };
}

function makeRoom(): MatchRoom {
  const base = createInitialState({ seed: 'ws-test', version: { data: 'test', manifest: 'test' } });
  return new MatchRoom({
    id: 'ws-room',
    initialState: { ...base, players: { p1: player('p1'), p2: player('p2') } },
    kernel: createKernel([markerModule]),
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

describe('createMultiplayerServer', () => {
  it('accepts two players and broadcasts authoritative action results', async () => {
    const server = createMultiplayerServer({ room: makeRoom() });
    const url = await server.listen();
    const p1 = new WebSocket(`${url}?player=p1`);
    const p2 = new WebSocket(`${url}?player=p2`);
    try {
      const welcome1 = nextMessage(p1);
      const welcome2 = nextMessage(p2);
      await Promise.all([once(p1, 'open'), once(p2, 'open')]);
      expect(await welcome1).toMatchObject({ type: 'welcome', playerId: 'p1' });
      expect(await welcome2).toMatchObject({ type: 'welcome', playerId: 'p2' });

      const state1 = nextMessage(p1);
      const state2 = nextMessage(p2);
      p1.send(
        JSON.stringify({
          type: 'action',
          action: { id: 'p1:1', type: 'marker.set', playerId: 'p1', issuedAt: 1, payload: {} },
        }),
      );

      const [m1, m2] = await Promise.all([state1, state2]);
      expect(m1).toMatchObject({ type: 'delta', seq: 1 });
      expect(m2).toMatchObject({ type: 'delta', seq: 1 });
      if (m1.type !== 'delta') throw new Error('expected delta');
      const changedP1 = m1.delta.changed.players?.p1 as
        | { resources?: Record<string, number> }
        | undefined;
      expect(changedP1?.resources?.marker).toBe(1);
    } finally {
      p1.close();
      p2.close();
      await server.close();
    }
  });

  it('drops a connection-level message flood before parsing', async () => {
    const server = createMultiplayerServer({ room: makeRoom() });
    const url = await server.listen();
    const ws = new WebSocket(`${url}?player=p1`);
    try {
      await once(ws, 'open');
      let pongs = 0;
      ws.on('message', (data) => {
        if ((JSON.parse(data.toString()) as ServerMessage).type === 'pong') pongs += 1;
      });
      // Pings aren't action-rate-limited, so each one that reaches the room pongs back —
      // a clean probe for the connection flood guard. Burst far past the per-window cap.
      const BURST = 200;
      for (let i = 0; i < BURST; i += 1) ws.send(JSON.stringify({ type: 'ping', clientTime: i }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pongs).toBeGreaterThan(0); // the connection still works
      expect(pongs).toBeLessThanOrEqual(100); // ≪ 200 sent ⇒ the flood was dropped, not parsed
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('nick-login: seats a nick and returns the SAME side on reconnect', async () => {
    const server = createMultiplayerServer({ room: makeRoom(), accountStore: new MemoryAccountStore() });
    const url = await server.listen();
    const alice = new WebSocket(`${url}?nick=alice`);
    try {
      const w = await nextMessage(alice);
      expect(w).toMatchObject({ type: 'welcome' });
      const seat = (w as { playerId: string }).playerId;
      expect(['p1', 'p2']).toContain(seat);
      alice.close();

      // a DIFFERENT nick gets the OTHER side
      const bob = new WebSocket(`${url}?nick=bob`);
      const wb = await nextMessage(bob);
      expect((wb as { playerId: string }).playerId).not.toBe(seat);
      bob.close();

      // alice returns → same side as before
      const alice2 = new WebSocket(`${url}?nick=alice`);
      const w2 = await nextMessage(alice2);
      expect((w2 as { playerId: string }).playerId).toBe(seat);
      alice2.close();
    } finally {
      await server.close();
    }
  });

  it('NETA2-1: a full match refuses a newcomer with a READABLE error, not a dead socket', async () => {
    const server = createMultiplayerServer({ room: makeRoom(), accountStore: new MemoryAccountStore() });
    const url = await server.listen();
    try {
      const alice = new WebSocket(`${url}?nick=alice`);
      await nextMessage(alice); // seats p1
      const bob = new WebSocket(`${url}?nick=bob`);
      await nextMessage(bob); // seats p2 — the 2-seat room is now full
      // A third nick finds every seat taken. Before NETA2-1 the upgrade was destroyed
      // (which a browser reads as "server down"); now the handshake COMPLETES and the
      // reason rides an `error` frame the client can actually show.
      const carol = new WebSocket(`${url}?nick=carol`);
      const msg = await nextMessage(carol);
      expect(msg).toMatchObject({ type: 'error', code: 'E_MATCH_FULL' });
      alice.close();
      bob.close();
      carol.close();
    } finally {
      await server.close();
    }
  });
});
