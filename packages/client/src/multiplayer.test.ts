import { describe, expect, it } from 'vitest';
import { createInitialState, diffState, type GameState } from '@void/shared-core';
import {
  authorizeActionEnvelope,
  validateActionEnvelope,
  type ActionEnvelope,
} from '@void/action-layer';
import {
  MultiplayerClient,
  type MultiplayerSnapshot,
  type MultiplayerSocket,
  type MultiplayerStatus,
} from './multiplayer';

function baseState(credits: number): GameState {
  const s = createInitialState({ seed: 'client-test', version: { data: '1', manifest: '1' } });
  return {
    ...s,
    players: { p1: { id: 'p1', name: 'One', faction: 'vanguard', status: 'active', resources: { credits } } },
  };
}

class FakeSocket implements MultiplayerSocket {
  readonly sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

function welcome(state: GameState, seq = 0): string {
  return JSON.stringify({ type: 'welcome', matchId: 'm', playerId: 'p1', seq, serverTime: 0, state });
}
function deltaMsg(delta: unknown, seq: number): string {
  return JSON.stringify({ type: 'delta', matchId: 'm', seq, serverTime: 0, delta, events: [] });
}

// The adapter the browser test client is built on: welcome resets the baseline,
// deltas patch it, and a full snapshot is surfaced through onSnapshot. This is
// the exact receive() path the headless server tests never exercise.
describe('MultiplayerClient', () => {
  it('reconstructs state from welcome + delta and reports status', () => {
    const socket = new FakeSocket();
    const snaps: MultiplayerSnapshot[] = [];
    const statuses: MultiplayerStatus[] = [];
    const client = new MultiplayerClient(socket, {
      onStatus: (s) => statuses.push(s),
      onSnapshot: (snap) => snaps.push(snap),
    });
    expect(statuses).toContain('connecting');
    client.open();
    expect(statuses).toContain('open');

    const s0 = baseState(10);
    const s1 = baseState(99);

    client.receive(welcome(s0));
    expect(snaps.at(-1)?.state).toEqual(s0);
    expect(snaps.at(-1)?.playerId).toBe('p1');

    client.receive(deltaMsg(diffState(s0, s1), 1));
    expect(snaps.at(-1)?.state).toEqual(s1);
    expect(snaps.at(-1)?.seq).toBe(1);
  });

  it('surfaces rejections and errors, and ignores a delta before any baseline', () => {
    const socket = new FakeSocket();
    let rejected: [string, string] | null = null;
    let errored: string | null = null;
    let snaps = 0;
    const client = new MultiplayerClient(socket, {
      onSnapshot: () => (snaps += 1),
      onRejection: (id, code) => (rejected = [id, code]),
      onError: (code) => (errored = code),
    });

    client.receive(deltaMsg({ changed: {}, removed: {} }, 1)); // no welcome yet → ignored
    expect(snaps).toBe(0);

    client.receive('{not json'); // malformed → E_BAD_MESSAGE
    expect(errored).toBe('E_BAD_MESSAGE');

    client.receive(
      JSON.stringify({ type: 'rejection', matchId: 'm', seq: 2, actionId: 'a1', code: 'E_FORBIDDEN' }),
    );
    expect(rejected).toEqual(['a1', 'E_FORBIDDEN']);
  });

  it('sends actions as wire messages and closes the socket', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.sendAction({
      id: 'a1',
      type: 'fleet.orbit',
      playerId: 'p1',
      payload: { fleetId: 'f', orbit: 'near' },
      issuedAt: 0,
    });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'action',
      action: { type: 'fleet.orbit', playerId: 'p1' },
    });
    client.close();
    expect(socket.closed).toBe(true);
  });

  it('sends ping.place / ping.clear as wire messages', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.placePing({ kind: 'mark', target: { node: 'C1R1' }, label: 'rally here' });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'ping.place',
      ping: { kind: 'mark', target: { node: 'C1R1' }, label: 'rally here' },
    });
    client.clearPing('ping:p1:0');
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({ type: 'ping.clear', pingId: 'ping:p1:0' });
    client.clearPing();
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ type: 'ping.clear' });
  });

  it('dispatches ping.added and ping.removed to handlers', () => {
    const socket = new FakeSocket();
    const added: unknown[] = [];
    const removed: Array<[string, string]> = [];
    const client = new MultiplayerClient(socket, {
      onPingAdded: (p) => added.push(p),
      onPingRemoved: (id, reason) => removed.push([id, reason]),
    });
    const ping = {
      id: 'ping:p2:3',
      owner: 'p2',
      kind: 'mark' as const,
      target: { node: 'C3R3' },
      label: 'enemy seen',
      createdAt: 10,
      expiresAt: 310,
    };
    client.receive(JSON.stringify({ type: 'ping.added', matchId: 'm', ping }));
    expect(added).toEqual([ping]);
    client.receive(
      JSON.stringify({ type: 'ping.removed', matchId: 'm', pingId: 'ping:p2:3', reason: 'expired' }),
    );
    expect(removed).toEqual([['ping:p2:3', 'expired']]);
    // a ping.removed without a reason defaults to 'cleared'
    client.receive(JSON.stringify({ type: 'ping.removed', matchId: 'm', pingId: 'ping:p2:4' }));
    expect(removed[1]).toEqual(['ping:p2:4', 'cleared']);
  });
});

// SV-1.1 bridge — on a GATED room the client wraps intents in `action.v1` envelopes so
// the server's action-layer gate admits them. These prove the client speaks exactly what
// the gate accepts by running its output through the SAME validate + authorize the gate does.
function gatedWelcome(state: GameState, sessionId: string, seq = 0): string {
  return JSON.stringify({
    type: 'welcome',
    matchId: 'm',
    playerId: 'p1',
    seq,
    serverTime: 0,
    state,
    sessionId,
    gated: true,
  });
}
const orbit = (): Parameters<MultiplayerClient['sendAction']>[0] => ({
  id: 'client-picks-this',
  type: 'fleet.orbit',
  playerId: 'p1',
  payload: { fleetId: 'f', orbit: 'near' },
  issuedAt: 1234,
});

describe('MultiplayerClient · gated envelope path (SV-1.1)', () => {
  it('wraps actions in an action.v1 envelope the gate validates + authorizes', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.receive(gatedWelcome(baseState(10), 'sess-A'));

    client.sendAction(orbit());
    client.sendAction(orbit());

    const first = JSON.parse(socket.sent[0] ?? '{}') as { type: string; envelope: ActionEnvelope };
    expect(first.type).toBe('action.v1');
    expect(first.envelope).toMatchObject({
      schemaVersion: 1,
      matchId: 'm',
      playerId: 'p1',
      sessionId: 'sess-A',
      clientSeq: 1,
      actionId: 'sess-A:p1:1', // sessionId:playerId:clientSeq — the key the gate dedups on
      issuedAt: 1234,
      action: { type: 'fleet.orbit', playerId: 'p1', payload: { fleetId: 'f', orbit: 'near' } },
    });
    // clientSeq is strict 1,2,… per session.
    const second = JSON.parse(socket.sent[1] ?? '{}') as { envelope: ActionEnvelope };
    expect(second.envelope.clientSeq).toBe(2);
    expect(second.envelope.actionId).toBe('sess-A:p1:2');

    // End-to-end contract: the emitted envelope passes the exact gates the server runs.
    const validated = validateActionEnvelope(first.envelope);
    expect(validated.ok).toBe(true);
    const authorized = authorizeActionEnvelope(first.envelope, {
      matchId: 'm',
      playerId: 'p1',
      sessionId: 'sess-A',
    });
    expect(authorized.ok).toBe(true);
  });

  it('falls back to a bare action when the room is not gated', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    // welcome with a sessionId but NO gated flag ⇒ bare action (un-gated room).
    client.receive(
      JSON.stringify({ type: 'welcome', matchId: 'm', playerId: 'p1', seq: 0, serverTime: 0, state: baseState(10), sessionId: 'sess-A' }),
    );
    client.sendAction(orbit());
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ type: 'action', action: { type: 'fleet.orbit' } });
  });

  it('restarts clientSeq on a fresh session (reconnect mints a new sessionId)', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit()); // clientSeq 1 under sess-A

    client.receive(gatedWelcome(baseState(10), 'sess-B')); // reconnect → new session
    client.sendAction(orbit());
    const env = (JSON.parse(socket.sent[1] ?? '{}') as { envelope: ActionEnvelope }).envelope;
    expect(env.sessionId).toBe('sess-B');
    expect(env.clientSeq).toBe(1); // reset, not 2
    expect(env.actionId).toBe('sess-B:p1:1');
  });
});
