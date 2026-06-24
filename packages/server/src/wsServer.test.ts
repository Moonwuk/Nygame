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
      expect(m1).toMatchObject({ type: 'state', seq: 1 });
      expect(m2).toMatchObject({ type: 'state', seq: 1 });
      if (m1.type !== 'state') throw new Error('expected state');
      expect(m1.state.players.p1?.resources.marker).toBe(1);
    } finally {
      p1.close();
      p2.close();
      await server.close();
    }
  });
});
