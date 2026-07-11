import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, diffState, hashState, type GameState } from '@void/shared-core';
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

  it('delivers fog-filtered domain events AFTER the snapshot they rode in on', () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    let seenState = 0;
    const client = new MultiplayerClient(socket, {
      onSnapshot: (snap) => {
        order.push('snapshot');
        seenState = (snap.state.players.p1?.resources.credits as number) ?? 0;
      },
      onEvents: (events) => {
        order.push('events:' + events.map((e) => e.type).join(','));
        // the handler must observe the POST-delta world (state already patched)
        expect(seenState).toBe(99);
      },
    });
    client.open();
    const s0 = baseState(10);
    const s1 = baseState(99);
    client.receive(welcome(s0)); // welcome carries no events → no onEvents call
    const withEvents = JSON.stringify({
      type: 'delta',
      matchId: 'm',
      seq: 1,
      serverTime: 0,
      delta: diffState(s0, s1),
      events: [{ type: 'artillery.fired', payload: { fleetId: 'a', target: 'b' }, at: 5 }],
    });
    client.receive(withEvents);
    // an empty events array must NOT fire the handler (deltaMsg sends events: [])
    client.receive(deltaMsg(diffState(s1, s1), 2));
    expect(order).toEqual(['snapshot', 'snapshot', 'events:artillery.fired', 'snapshot']);
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

  it('sends chat.send wire messages (dm carries `to`) and dispatches chat.msg', () => {
    const socket = new FakeSocket();
    const heard: unknown[] = [];
    const client = new MultiplayerClient(socket, { onChatMessage: (m) => heard.push(m) });
    client.sendChat('session', 'gl hf');
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'chat.send',
      channel: 'session',
      text: 'gl hf',
    });
    client.sendChat('dm', 'you first', 'p2');
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({
      type: 'chat.send',
      channel: 'dm',
      to: 'p2',
      text: 'you first',
    });
    const message = { id: 'chat:p2:0', from: 'p2', channel: 'dm', to: 'p1', text: 'after you', at: 5 };
    client.receive(JSON.stringify({ type: 'chat.msg', matchId: 'm', message }));
    expect(heard).toEqual([message]);
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

// BF-2 (bug-hunt CRIT): E_RATE_LIMIT / E_OUT_OF_ORDER do NOT consume the gate's
// clientSeq cursor — the server expects the SAME seq again. The client must re-send
// the same envelope after a backoff instead of burning fresh seqs, or one throttle
// wedges the whole session (every later action → E_OUT_OF_ORDER forever).
describe('MultiplayerClient · transient-rejection resend (BF-2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rejection = (actionId: string, code: string): string =>
    JSON.stringify({ type: 'rejection', matchId: 'm', seq: 0, actionId, code });

  it('re-sends the SAME envelope (same clientSeq) after E_RATE_LIMIT, silently', () => {
    const socket = new FakeSocket();
    const rejections: string[] = [];
    const client = new MultiplayerClient(socket, { onRejection: (_id, code) => rejections.push(code) });
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit()); // seq 1
    client.sendAction(orbit()); // seq 2 — this one gets throttled
    expect(socket.sent).toHaveLength(2);

    client.receive(rejection('sess-A:p1:2', 'E_RATE_LIMIT'));
    expect(rejections).toEqual([]); // absorbed — a retry is scheduled, no user-facing toast
    vi.advanceTimersByTime(500);
    expect(socket.sent).toHaveLength(3);
    const resent = (JSON.parse(socket.sent[2] ?? '{}') as { envelope: ActionEnvelope }).envelope;
    expect(resent.clientSeq).toBe(2); // the SAME seq — not a fresh one
    expect(resent.actionId).toBe('sess-A:p1:2');
  });

  it('resends a wedged burst lowest-seq first so the strict cursor re-admits in order', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    for (let i = 0; i < 3; i += 1) client.sendAction(orbit()); // seqs 1..3
    // 2 and 3 rejected out of order (as after a throttle of 1): both must retry.
    client.receive(rejection('sess-A:p1:3', 'E_OUT_OF_ORDER'));
    client.receive(rejection('sess-A:p1:2', 'E_RATE_LIMIT'));
    vi.advanceTimersByTime(500);
    const resent = socket.sent
      .slice(3)
      .map((r) => (JSON.parse(r) as { envelope: ActionEnvelope }).envelope.clientSeq);
    expect(resent).toEqual([2, 3]); // ascending — seq 2 unblocks seq 3
  });

  it('gives up after the retry budget and surfaces the rejection', () => {
    const socket = new FakeSocket();
    const rejections: string[] = [];
    const client = new MultiplayerClient(socket, { onRejection: (_id, code) => rejections.push(code) });
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit()); // seq 1
    for (let round = 0; round < 6; round += 1) {
      client.receive(rejection('sess-A:p1:1', 'E_RATE_LIMIT'));
      vi.advanceTimersByTime(500);
    }
    expect(rejections).toEqual(['E_RATE_LIMIT']); // surfaced exactly once, after exhausting retries
  });

  it('drops the retry state on a reconnect (stale-session envelopes never resend)', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit()); // sess-A:p1:1
    client.receive(rejection('sess-A:p1:1', 'E_RATE_LIMIT')); // retry armed…
    client.receive(gatedWelcome(baseState(10), 'sess-B')); // …but the session died
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toHaveLength(1); // no stale resend under the new session
  });

  it('a non-transient rejection is surfaced immediately and not retried', () => {
    const socket = new FakeSocket();
    const rejections: string[] = [];
    const client = new MultiplayerClient(socket, { onRejection: (_id, code) => rejections.push(code) });
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit());
    client.receive(rejection('sess-A:p1:1', 'E_NO_FLEET'));
    vi.advanceTimersByTime(1000);
    expect(rejections).toEqual(['E_NO_FLEET']);
    expect(socket.sent).toHaveLength(1); // no resend
  });
});

// CP1.4 — reconnect resume: actions issued while the socket is down are queued and
// flushed after the reconnect welcome (fresh session ⇒ gate-valid envelopes, no dupes);
// a delta whose seq goes backwards is dropped and surfaced as a desync.
describe('MultiplayerClient · reconnect resume (CP1.4)', () => {
  it('queues actions while disconnected and flushes them after the reconnect welcome', () => {
    const socket = new FakeSocket();
    const statuses: MultiplayerStatus[] = [];
    const client = new MultiplayerClient(socket, { onStatus: (s) => statuses.push(s) });
    client.open();
    client.receive(gatedWelcome(baseState(10), 'sess-A'));
    client.sendAction(orbit()); // sess-A:p1:1 — sent live
    expect(socket.sent).toHaveLength(1);

    client.connectionLost(); // mobile network dropped
    expect(statuses.at(-1)).toBe('connecting');
    client.sendAction(orbit()); // issued offline → queued, NOT sent
    client.sendAction(orbit());
    expect(socket.sent).toHaveLength(1);

    client.open(); // socket re-opened — still queued: the gated envelope needs the NEW session
    expect(socket.sent).toHaveLength(1);

    client.receive(gatedWelcome(baseState(10), 'sess-B')); // reconnect welcome = resync
    expect(socket.sent).toHaveLength(3); // both queued actions flushed, in order
    const flushed = socket.sent.slice(1).map(
      (raw) => (JSON.parse(raw) as { envelope: ActionEnvelope }).envelope,
    );
    // Fresh session, fresh strict clientSeq — exactly what the sequence gate admits.
    expect(flushed.map((e) => e.actionId)).toEqual(['sess-B:p1:1', 'sess-B:p1:2']);
  });

  it('flushes queued bare actions on an un-gated room too', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket, {});
    client.receive(welcome(baseState(10)));
    client.connectionLost();
    client.sendAction(orbit());
    expect(socket.sent).toHaveLength(0);
    client.receive(welcome(baseState(11)));
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'action', action: { type: 'fleet.orbit' } });
  });

  it('caps the offline queue and surfaces E_OUTBOX_FULL instead of growing unbounded', () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    const client = new MultiplayerClient(socket, { onError: (c) => errors.push(c) });
    client.receive(welcome(baseState(10)));
    client.connectionLost();
    for (let i = 0; i < 70; i += 1) client.sendAction(orbit());
    expect(errors.filter((c) => c === 'E_OUTBOX_FULL')).toHaveLength(6); // 70 − 64
    client.receive(welcome(baseState(10)));
    expect(socket.sent).toHaveLength(64); // the cap flushed, the overflow dropped loudly
  });

  it('connectionLost after a deliberate close stays closed (no phantom reconnect state)', () => {
    const socket = new FakeSocket();
    const statuses: MultiplayerStatus[] = [];
    const client = new MultiplayerClient(socket, { onStatus: (s) => statuses.push(s) });
    client.close();
    client.connectionLost();
    expect(statuses.at(-1)).toBe('closed');
  });

  it('applies forward-gap and equal-seq deltas (legal) but drops a backwards delta as desync', () => {
    const socket = new FakeSocket();
    const snaps: MultiplayerSnapshot[] = [];
    const desyncs: [number, number][] = [];
    const client = new MultiplayerClient(socket, {
      onSnapshot: (s) => snaps.push(s),
      onDesync: (last, got) => desyncs.push([last, got]),
    });
    const s0 = baseState(10);
    const s1 = baseState(20);
    const s2 = baseState(30);
    client.receive(welcome(s0, 5));

    // Forward gap (seq 5 → 8) is legal: rejected actions bump the server seq
    // without a broadcast, so the delta still chains against our view.
    client.receive(deltaMsg(diffState(s0, s1), 8));
    expect(snaps.at(-1)?.state).toEqual(s1);

    // Equal seq is legal too (lobby flips re-broadcast under the current seq).
    client.receive(deltaMsg(diffState(s1, s2), 8));
    expect(snaps.at(-1)?.state).toEqual(s2);

    // Backwards seq = untrustworthy baseline: dropped, surfaced as desync.
    const before = snaps.length;
    client.receive(deltaMsg(diffState(s2, s0), 3));
    expect(snaps).toHaveLength(before);
    expect(snaps.at(-1)?.state).toEqual(s2); // state untouched
    expect(desyncs).toEqual([[8, 3]]);
  });
});

// BF-18: radar contacts / memory-fog ids ride BESIDE the fogged state (a radar-only
// enemy fleet is physically absent from state.fleets) — the snapshot must surface
// them or the client can never draw radar blips in a network match.
describe('MultiplayerClient · fog extras: signatures + remembered (BF-18)', () => {
  it('surfaces signatures/remembered from both the welcome and each delta', () => {
    const socket = new FakeSocket();
    const snaps: MultiplayerSnapshot[] = [];
    const client = new MultiplayerClient(socket, { onSnapshot: (snap) => snaps.push(snap) });
    const s0 = baseState(10);
    const s1 = baseState(20);

    const w = JSON.parse(welcome(s0)) as Record<string, unknown>;
    w.signatures = [{ location: 'B2', size: 'M' }];
    w.remembered = ['C3'];
    client.receive(JSON.stringify(w));
    expect(snaps.at(-1)?.signatures).toEqual([{ location: 'B2', size: 'M' }]);
    expect(snaps.at(-1)?.remembered).toEqual(['C3']);

    const d = JSON.parse(deltaMsg(diffState(s0, s1), 1)) as Record<string, unknown>;
    d.signatures = [{ location: 'D4', size: 'L' }];
    d.remembered = [];
    client.receive(JSON.stringify(d));
    expect(snaps.at(-1)?.signatures).toEqual([{ location: 'D4', size: 'L' }]);
    expect(snaps.at(-1)?.remembered).toEqual([]);
  });
});

// M1 hash-desync detector: the server tags snapshots with hashState(view); on a
// mismatching delta the client reports it (`desync` message) and asks for a full
// resync in the same breath — one in-flight request at a time.
describe('MultiplayerClient · hash desync → report + resync (M1)', () => {
  function hashedDelta(from: GameState, to: GameState, seq: number, hash: string): string {
    return JSON.stringify({
      type: 'delta',
      matchId: 'm',
      seq,
      serverTime: 0,
      delta: diffState(from, to),
      events: [],
      hash,
    });
  }
  function stateMsg(state: GameState, seq: number): string {
    return JSON.stringify({ type: 'state', matchId: 'm', seq, serverTime: 0, state, events: [] });
  }

  it('a matching hash passes silently — no report, no handler', () => {
    const socket = new FakeSocket();
    const desyncs: number[] = [];
    const client = new MultiplayerClient(socket, { onHashDesync: (seq) => desyncs.push(seq) });
    const s0 = baseState(10);
    const s1 = baseState(20);
    client.receive(welcome(s0));
    client.receive(hashedDelta(s0, s1, 1, hashState(s1)));
    expect(desyncs).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  it('a mismatching hash sends ONE desync report and fires onHashDesync', () => {
    const socket = new FakeSocket();
    const desyncs: number[] = [];
    const client = new MultiplayerClient(socket, { onHashDesync: (seq) => desyncs.push(seq) });
    const s0 = baseState(10);
    const s1 = baseState(20);
    const s2 = baseState(30);
    client.receive(welcome(s0));
    client.receive(hashedDelta(s0, s1, 1, 'bogus'));
    // a second mismatch while the resync is pending must NOT flood the wire
    client.receive(hashedDelta(s1, s2, 2, 'still-bogus'));

    expect(desyncs).toEqual([1]);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
      type: 'desync',
      seq: 1,
      hash: hashState(s1), // our reconstruction's hash, for the server log
    });
  });

  it('the full resync snapshot settles the report and re-arms the detector', () => {
    const socket = new FakeSocket();
    const desyncs: number[] = [];
    const client = new MultiplayerClient(socket, { onHashDesync: (seq) => desyncs.push(seq) });
    const s0 = baseState(10);
    const s1 = baseState(20);
    const s2 = baseState(30);
    client.receive(welcome(s0));
    client.receive(hashedDelta(s0, s1, 1, 'bogus')); // report #1 → resync requested
    client.receive(stateMsg(s1, 1)); // the server's full resync lands
    client.receive(hashedDelta(s1, s2, 2, 'bogus-again')); // detector re-armed → report #2

    expect(desyncs).toEqual([1, 2]);
    expect(socket.sent).toHaveLength(2);
  });

  it('a delta without a hash is never checked (un-tagged room)', () => {
    const socket = new FakeSocket();
    const desyncs: number[] = [];
    const client = new MultiplayerClient(socket, { onHashDesync: (seq) => desyncs.push(seq) });
    const s0 = baseState(10);
    const s1 = baseState(20);
    client.receive(welcome(s0));
    client.receive(deltaMsg(diffState(s0, s1), 1));
    expect(desyncs).toEqual([]);
    expect(socket.sent).toEqual([]);
  });
});

// M2 perf telemetry: a light fps/rtt/mem sample the caller (the prototype's 30s
// timer) pushes through the client — dropped while disconnected.
describe('MultiplayerClient · perf sample (M2)', () => {
  it('sends the sample as a perf message', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket);
    client.open();
    client.sendPerf({ fps: 58, rttMs: 42, memMb: 120 });
    expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
      type: 'perf',
      fps: 58,
      rttMs: 42,
      memMb: 120,
    });
  });

  it('drops the sample while the connection is lost (queueing)', () => {
    const socket = new FakeSocket();
    const client = new MultiplayerClient(socket);
    client.open();
    client.connectionLost();
    client.sendPerf({ fps: 60 });
    expect(socket.sent).toEqual([]);
  });
});
