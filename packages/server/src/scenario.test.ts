import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { applyDelta, type Action, type GameState } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([data]) => JSON.parse(String(data)) as ServerMessage);
}

function orbit(playerId: string, fleetId: string, to: 'near' | 'far', seq: number): Action {
  return {
    id: `test:${playerId}:${seq}`,
    type: 'fleet.orbit',
    playerId,
    payload: { fleetId, orbit: to },
    issuedAt: 0,
  };
}

function fleetOrbit(delta: { changed: { fleets?: Record<string, unknown> } }, id: string): unknown {
  return (delta.changed.fleets?.[id] as { orbit?: unknown } | undefined)?.orbit;
}

// The "second player connection" smoke test, end-to-end over a real socket:
// boot the dev match on the real core, connect two WebSocket clients, and prove
// the authoritative loop — each player's action is broadcast to every peer and a
// peer can reconstruct the exact server state from its welcome + deltas.
describe('dev match (real core, two players over WebSocket)', () => {
  it('broadcasts each player’s authoritative action to both peers', async () => {
    const room = createDevMatch(loadShippedData(), { now: () => 1000, time: 0 });
    const server = createMultiplayerServer({ room });
    const url = await server.listen();
    const green = new WebSocket(`${url}?player=green`);
    const red = new WebSocket(`${url}?player=red`);
    try {
      const welcomeGreen = nextMessage(green);
      const welcomeRed = nextMessage(red);
      await Promise.all([once(green, 'open'), once(red, 'open')]);

      const wg = await welcomeGreen;
      expect(await welcomeRed).toMatchObject({ type: 'welcome', playerId: 'red' });
      expect(wg).toMatchObject({ type: 'welcome', playerId: 'green' });
      if (wg.type !== 'welcome') throw new Error('expected a welcome snapshot');
      let reconstructed: GameState = wg.state;

      // Green orders its fleet into the near orbit; both peers see seq 1.
      const g1 = nextMessage(green);
      const r1 = nextMessage(red);
      green.send(JSON.stringify({ type: 'action', action: orbit('green', 'green_1', 'near', 1) }));
      const [mg1, mr1] = await Promise.all([g1, r1]);
      expect(mr1).toMatchObject({ type: 'delta', seq: 1 });
      if (mg1.type !== 'delta') throw new Error('expected a delta');
      expect(fleetOrbit(mg1.delta, 'green_1')).toBe('near');
      reconstructed = applyDelta(reconstructed, mg1.delta);

      // Red answers on its own fleet; green sees it too — authority is shared.
      const g2 = nextMessage(green);
      const r2 = nextMessage(red);
      red.send(JSON.stringify({ type: 'action', action: orbit('red', 'red_1', 'near', 1) }));
      const [mg2, mr2] = await Promise.all([g2, r2]);
      expect(mr2).toMatchObject({ type: 'delta', seq: 2 });
      if (mg2.type !== 'delta') throw new Error('expected a delta');
      expect(fleetOrbit(mg2.delta, 'red_1')).toBe('near');
      reconstructed = applyDelta(reconstructed, mg2.delta);

      // Welcome + deltas reproduce the authoritative state exactly.
      expect(reconstructed).toEqual(room.state);
      expect(room.state.fleets.green_1?.orbit).toBe('near');
      expect(room.state.fleets.red_1?.orbit).toBe('near');
    } finally {
      green.close();
      red.close();
      await server.close();
    }
  });
});
