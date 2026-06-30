import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { applyDelta, visibleState, type Action, type GameData, type GameState } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

/** The visible-`GameState` a player's client reconstructs to (fog applied,
 *  signatures/remembered ride as separate message fields). */
function visibleBase(state: GameState, player: string, data: GameData): GameState {
  const { signatures: _s, remembered: _r, ...base } = visibleState(state, player, data);
  return base as GameState;
}

function orbit(player: string, seq: number, to: 'near'): Action {
  return {
    id: `soak:${player}:${seq}`,
    type: 'fleet.orbit',
    playerId: player,
    payload: { fleetId: `${player}_1`, orbit: to },
    issuedAt: 0,
  };
}

/** Drive one client: connect, fire all its actions, and resolve with the state
 *  reconstructed from welcome + deltas once it has applied the delta carrying
 *  `untilSeq` (the globally-last action). */
function runClient(
  url: string,
  player: string,
  actions: Action[],
  untilSeq: number,
): Promise<GameState> {
  return new Promise<GameState>((resolve, reject) => {
    const ws = new WebSocket(`${url}?player=${player}`);
    let state: GameState | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${player} did not converge`));
    }, 15_000);
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'welcome') {
        state = message.state;
      } else if (message.type === 'delta' && state) {
        state = applyDelta(state, message.delta);
        if (message.seq >= untilSeq) {
          clearTimeout(timer);
          const final = state;
          ws.close();
          resolve(final);
        }
      }
    });
    ws.on('open', () => {
      for (const action of actions) ws.send(JSON.stringify({ type: 'action', action }));
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

// Soak / consistency under concurrent load — part of the multiplayer-test prep.
// N clients each fire K actions at once; the authoritative room must serialize
// all N×K, stay consistent, and every client must converge to ITS OWN visible
// view (fog of war, F6) reconstructed purely from its welcome + delta stream.
// A late-joining client resyncs from its welcome, so connect timing does not matter.
describe('soak: concurrent clients converge on their authoritative view', () => {
  it('serializes N×K concurrent actions and each client reconstructs its own visible state', async () => {
    const players = ['green', 'red', 'blue', 'gold'];
    const K = 6; // K "enter orbit" actions per client (a single orbit; all end 'near')
    const total = players.length * K;
    const data = loadShippedData();
    const room = createDevMatch(data, { players, now: () => 1000, time: 0 });
    const server = createMultiplayerServer({ room });
    const url = await server.listen();
    try {
      const finals = await Promise.all(
        players.map((player) => {
          const actions: Action[] = [];
          for (let k = 0; k < K; k++) actions.push(orbit(player, k, 'near'));
          return runClient(url, player, actions, total);
        }),
      );

      // Every action was applied exactly once, in a single serialized order.
      expect(room.sequence).toBe(total);
      // Each fleet ended in the near orbit (each client's final action).
      for (const player of players) {
        expect(room.state.fleets[`${player}_1`]?.orbit).toBe('near');
      }
      // Each client reconstructed exactly its own visible view of the
      // authoritative state — no drift, and fog hides the other players.
      players.forEach((player, i) => {
        expect(finals[i]).toEqual(visibleBase(room.state, player, data));
      });
    } finally {
      await server.close();
    }
  });

  it('seats N players from the parameterized scenario', async () => {
    const players = ['p1', 'p2', 'p3'];
    const room = createDevMatch(loadShippedData(), { players, now: () => 0, time: 0 });
    expect(Object.keys(room.state.players).sort()).toEqual(players);
    for (const p of players) {
      expect(room.state.fleets[`${p}_1`]?.owner).toBe(p);
      expect(room.state.planets[`home_${p}`]?.owner).toBe(p);
      expect(room.hasPlayer(p)).toBe(true);
    }
    // sanity: the wire still accepts a seated player and rejects an unknown one
    const server = createMultiplayerServer({ room });
    const wsUrl = await server.listen();
    const ok = new WebSocket(`${wsUrl}?player=p1`);
    try {
      const [data] = (await once(ok, 'message')) as [Buffer];
      expect((JSON.parse(String(data)) as ServerMessage).type).toBe('welcome');
    } finally {
      ok.close();
      await server.close();
    }
  });
});
