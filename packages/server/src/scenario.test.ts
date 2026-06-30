import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { applyDelta, visibleState, type Action, type GameState } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([data]) => JSON.parse(String(data)) as ServerMessage);
}

function orbit(playerId: string, fleetId: string, to: 'near', seq: number): Action {
  return {
    id: `test:${playerId}:${seq}`,
    type: 'fleet.orbit',
    playerId,
    payload: { fleetId, orbit: to },
    issuedAt: 0,
  };
}

/** The visible-`GameState` baseline a player's client reconstructs to (fog
 *  extras stripped — they ride as separate message fields). */
function visibleBase(state: GameState, playerId: string, data: ReturnType<typeof loadShippedData>): GameState {
  const { signatures: _s, remembered: _r, ...base } = visibleState(state, playerId, data);
  return base as GameState;
}

// End-to-end fog of war (F6): the server is the boundary — it physically never
// sends a player what they can't see. On the dev map home_green—nexus—home_red,
// green identifies only home_green + nexus, so red's distant homeworld and fleet
// are hidden. Each player still drives their own authoritative actions.
describe('dev match — fog of war over WebSocket (F6)', () => {
  it('hides a distant enemy fleet from a player and never leaks it on the wire', async () => {
    const data = loadShippedData();
    const room = createDevMatch(data, { now: () => 1000, time: 0 });
    const server = createMultiplayerServer({ room });
    const url = await server.listen();
    const green = new WebSocket(`${url}?player=green`);
    const red = new WebSocket(`${url}?player=red`);
    const greenSeen: string[] = [];
    green.on('message', (d) => greenSeen.push(String(d)));
    try {
      const welcomeGreen = nextMessage(green);
      const welcomeRed = nextMessage(red);
      await Promise.all([once(green, 'open'), once(red, 'open')]);

      const wg = await welcomeGreen;
      await welcomeRed;
      if (wg.type !== 'welcome') throw new Error('expected a welcome snapshot');
      // Fog: green's welcome carries its own fleet but NOT red's, and red's
      // homeworld is stripped to bare topology.
      expect(wg.state.fleets.green_1).toBeDefined();
      expect(wg.state.fleets.red_1).toBeUndefined();
      expect(wg.state.planets.home_red?.owner).toBeNull();
      expect(wg.state.planets.nexus).toBeDefined(); // 1 jump away → identified
      let reconstructed: GameState = wg.state;

      // Green orders its own fleet — green sees it.
      const g1 = nextMessage(green);
      green.send(JSON.stringify({ type: 'action', action: orbit('green', 'green_1', 'near', 1) }));
      const mg1 = await g1;
      if (mg1.type !== 'delta') throw new Error('expected a delta');
      expect((mg1.delta.changed.fleets?.green_1 as { orbit?: string } | undefined)?.orbit).toBe('near');
      reconstructed = applyDelta(reconstructed, mg1.delta);

      // Red orders ITS fleet (at the hidden homeworld). Green gets a delta too,
      // but it must carry nothing about red_1 — the enemy stays invisible.
      const g2 = nextMessage(green);
      red.send(JSON.stringify({ type: 'action', action: orbit('red', 'red_1', 'near', 1) }));
      const mg2 = await g2;
      if (mg2.type !== 'delta') throw new Error('expected a delta');
      expect(mg2.delta.changed.fleets?.red_1).toBeUndefined();
      reconstructed = applyDelta(reconstructed, mg2.delta);

      // The authoritative sim is correct (both fleets moved); the projections hide it.
      expect(room.state.fleets.green_1?.orbit).toBe('near');
      expect(room.state.fleets.red_1?.orbit).toBe('near');
      // Green reconstructs exactly its own visible view — not the full state.
      expect(reconstructed).toEqual(visibleBase(room.state, 'green', data));
      // The hard anti-leak: red's fleet id never appeared on green's socket.
      expect(greenSeen.join('')).not.toContain('red_1');
    } finally {
      green.close();
      red.close();
      await server.close();
    }
  });
});
