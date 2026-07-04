import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ACTION_ENVELOPE_SCHEMA_VERSION, ActionGate, createActionEnvelope } from '@void/action-layer';
import { createDevMatch, loadShippedData } from './scenario';
import { createMultiplayerServer } from './wsServer';
import { hmacSecret, signJoinToken } from './auth';
import type { ServerMessage, ServerWelcomeMessage } from './protocol';

// SV-1.1-live-A — the server mints a sessionId at the handshake (never client-chosen),
// tells the client in `welcome`, and passes it to `receive`. End-to-end: a gated room
// authorizes an action.v1 envelope against the SERVER-minted sessionId, so a client must
// echo the one from its welcome; a forged sessionId is refused.

const data = loadShippedData();
const secret = hmacSecret('session-gate-secret');
const auth = { key: secret, algorithms: ['HS256'], issuer: 'void', audience: 'match' };
const signCfg = { key: secret, algorithm: 'HS256', issuer: 'void', audience: 'match' };

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return once(ws, 'message').then(([d]) => JSON.parse(d.toString()) as ServerMessage);
}

function orbitEnvelope(sessionId: string) {
  return createActionEnvelope({
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    matchId: 'dev',
    playerId: 'green',
    sessionId,
    clientSeq: 1,
    issuedAt: 1001,
    type: 'fleet.orbit',
    payload: { fleetId: 'green_1', orbit: 'near' },
  });
}

describe('SV-1.1-live-A · server-minted sessionId gates the wire', () => {
  it('mints a sessionId in welcome and admits an envelope bound to it', async () => {
    const room = createDevMatch(data, { gate: new ActionGate(), now: () => 1000, time: 1000 });
    const server = createMultiplayerServer({ room, auth });
    const url = await server.listen();
    const token = await signJoinToken({ matchId: 'dev', playerId: 'green' }, signCfg, {
      ttlSeconds: 300,
    });
    const ws = new WebSocket(`${url}?token=${token}`);
    try {
      const welcome = (await nextMessage(ws)) as ServerWelcomeMessage;
      expect(welcome.type).toBe('welcome');
      expect(typeof welcome.sessionId).toBe('string'); // server-minted, opaque
      expect(welcome.sessionId).not.toBe('green'); // not derived from the player id

      const next = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'action.v1', envelope: orbitEnvelope(welcome.sessionId!) }));
      const msg = await next;

      expect(msg.type).toBe('delta'); // admitted + applied
      expect(room.state.fleets.green_1?.orbit).toBe('near');
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('refuses an envelope bound to a forged sessionId (E_FORBIDDEN)', async () => {
    const room = createDevMatch(data, { gate: new ActionGate(), now: () => 1000, time: 1000 });
    const server = createMultiplayerServer({ room, auth });
    const url = await server.listen();
    const token = await signJoinToken({ matchId: 'dev', playerId: 'green' }, signCfg, {
      ttlSeconds: 300,
    });
    const ws = new WebSocket(`${url}?token=${token}`);
    try {
      await nextMessage(ws); // welcome (ignore its real sessionId)

      const next = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'action.v1', envelope: orbitEnvelope('forged-session') }));
      const msg = await next;

      expect(msg).toMatchObject({ type: 'rejection', code: 'E_FORBIDDEN' });
      expect(room.state.fleets.green_1?.orbit).toBeUndefined(); // unchanged (not yet in orbit)
    } finally {
      ws.close();
      await server.close();
    }
  });
});
