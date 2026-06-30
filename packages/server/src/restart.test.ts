import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createKernel, type Action, type GameState } from '@void/shared-core';
import { MatchRoom } from './matchRoom';
import { DEV_MODULES, createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([data]) => JSON.parse(String(data)) as ServerMessage);
}

function orbit(playerId: string, fleetId: string, to: 'near', seq: number): Action {
  return {
    id: `restart:${playerId}:${seq}`,
    type: 'fleet.orbit',
    playerId,
    payload: { fleetId, orbit: to },
    issuedAt: 0,
  };
}

// Graceful restart with active clients — the integration test the engineering
// review asked for. It proves two things and pins the one missing piece:
//   1. close() actively DRAINS connected clients (clean 1001), so a restart does
//      not hang on in-flight WebSocket connections.
//   2. a fresh server RESUMES a reconnecting client from preserved state — the
//      resume protocol works end-to-end.
// The only thing standing between this and true crash-safe restart is DURABLE
// state: here the snapshot is carried in-memory; in production it comes from
// persistence (F2 / persistence-roadmap.md PE-0.1). That gap is now explicit,
// not a markdown warning.
describe('graceful restart (drain + reconnect-resync)', () => {
  it('drains active clients on close and resumes them from preserved state', async () => {
    const data = loadShippedData();

    // --- server A: a client connects and mutates authoritative state ---
    const roomA = createDevMatch(data, { now: () => 1000, time: 0 });
    const serverA = createMultiplayerServer({ room: roomA });
    const urlA = await serverA.listen();
    const greenA = new WebSocket(`${urlA}?player=green`);
    const welcomeA = nextMessage(greenA);
    await once(greenA, 'open');
    await welcomeA;
    const deltaA = nextMessage(greenA);
    greenA.send(JSON.stringify({ type: 'action', action: orbit('green', 'green_1', 'near', 1) }));
    await deltaA;
    expect(roomA.state.fleets.green_1?.orbit).toBe('near');

    // Persistence boundary: production saves this snapshot (Postgres, F2). Here
    // we carry it in-memory to prove the protocol survives the restart.
    const carried: GameState = roomA.state;

    // --- graceful drain: the active client gets a clean 1001 and close() resolves
    // (without the drain fix this would hang on the live WebSocket connection) ---
    const closedA = once(greenA, 'close');
    await serverA.close();
    const [code] = (await closedA) as [number, Buffer];
    expect(code).toBe(1001);

    // --- server B (the "restarted" process) resumes the client from carried state ---
    const roomB = new MatchRoom({
      id: 'dev',
      initialState: carried,
      kernel: createKernel(DEV_MODULES),
      data,
      now: () => 2000,
    });
    const serverB = createMultiplayerServer({ room: roomB });
    const urlB = await serverB.listen();
    const greenB = new WebSocket(`${urlB}?player=green`);
    try {
      const welcomeB = nextMessage(greenB);
      await once(greenB, 'open');
      const w = await welcomeB;
      if (w.type !== 'welcome') throw new Error('expected a welcome snapshot on resume');
      // The pre-restart orbit change survived → the client resumes seamlessly.
      expect(w.state.fleets.green_1?.orbit).toBe('near');
    } finally {
      greenB.close();
      await serverB.close();
    }
  });
});
