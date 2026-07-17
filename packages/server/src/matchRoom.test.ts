import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  createInitialState,
  createKernel,
  hashState,
  parseGameData,
  type Action,
  type GameData,
  type GameModule,
  type GameState,
  type Player,
} from '@void/shared-core';
import { MatchRoom, type RoomObservation, type RoomPeer } from './matchRoom';
import type { ServerMessage } from './protocol';

class MemoryPeer implements RoomPeer {
  readonly messages: ServerMessage[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
}

const renameModule: GameModule = {
  id: 'rename-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('player.rename', (action, h) => {
      const payload = action.payload;
      if (typeof payload !== 'object' || payload === null || !('name' in payload)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const name = (payload as { name: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_FORBIDDEN');
      player.name = name;
      h.emit('player.renamed', { playerId: action.playerId, name });
    });
  },
};

function player(id: string, name: string): Player {
  return { id, name, faction: id, status: 'active', resources: {} };
}

function testData(): GameData {
  return parseGameData({
    version: 'test',
    resources: ['credits'],
    units: {},
    factions: {},
    buildings: {},
    events: {},
    sectors: {},
    planetTypes: {},
  });
}

function testState(): GameState {
  const base = createInitialState({
    seed: 'server-test',
    version: { data: 'test', manifest: 'test' },
  });
  return { ...base, players: { p1: player('p1', 'One'), p2: player('p2', 'Two') } };
}

function action(id: string, playerId: string, name: string): Action {
  return { id, type: 'player.rename', playerId, issuedAt: 1, payload: { name } };
}

function room(): MatchRoom {
  return new MatchRoom({
    id: 'test-room',
    initialState: testState(),
    kernel: createKernel([renameModule]),
    data: testData(),
    now: () => 10,
  });
}

describe('MatchRoom — player-action deny-list (AVA-8)', () => {
  function deniedRoom(): MatchRoom {
    return new MatchRoom({
      id: 'ava-room',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => 10,
      // The AvA wire rule: the orchestrator owns this action type — players don't.
      denyPlayerActions: (type) => (type === 'player.rename' ? 'E_AVA_DIPLOMACY' : null),
    });
  }

  it('refuses a denied type on the wire with the stable code; nothing applies', async () => {
    const r = deniedRoom();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    await r.receive(
      'p1',
      p1,
      JSON.stringify({ type: 'action', matchId: 'ava-room', action: action('a1', 'p1', 'Sneaky') }),
    );
    expect(p1.messages.at(-1)).toMatchObject({
      type: 'rejection',
      actionId: 'a1',
      code: 'E_AVA_DIPLOMACY',
    });
    expect(r.state.players.p1?.name).toBe('One'); // the reducer never saw it
  });

  it('server-internal submits bypass the wire deny (the orchestrator owns the stances)', async () => {
    const r = deniedRoom();
    const result = await r.submitServerAction('p1', action('a2', 'p1', 'System'));
    expect(result.ok).toBe(true);
    expect(r.state.players.p1?.name).toBe('System');
  });
});

describe('MatchRoom', () => {
  it('welcomes each player with the authoritative snapshot', () => {
    const r = room();
    const p1 = new MemoryPeer();

    expect(r.addPeer('p1', p1)).toBe(true);

    expect(p1.messages).toHaveLength(1);
    expect(p1.messages[0]).toMatchObject({ type: 'welcome', matchId: 'test-room', playerId: 'p1' });
  });

  it('serializes an action and broadcasts the new state to every peer', () => {
    const r = room();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);

    const result = r.submitAction('p1', action('a1', 'p1', 'Commander'), p1);

    expect(result.ok).toBe(true);
    expect(r.state.players.p1?.name).toBe('Commander');
    // each peer gets a delta carrying only the changed entity, not the full state
    expect(p1.messages.at(-1)).toMatchObject({
      type: 'delta',
      seq: 1,
      delta: { changed: { players: { p1: { name: 'Commander' } } } },
    });
    expect(p2.messages.at(-1)).toMatchObject({ type: 'delta', seq: 1 });
  });

  it('a peer reconstructs the exact server state from welcome + deltas', () => {
    const r = room();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    const welcome = p1.messages[0];
    if (welcome?.type !== 'welcome') throw new Error('expected a welcome snapshot');
    let clientState = welcome.state;
    r.submitAction('p1', action('a1', 'p1', 'Commander'), p1);
    r.submitAction('p1', action('a2', 'p1', 'Admiral'), p1);
    for (const m of p1.messages) {
      if (m.type === 'delta') clientState = applyDelta(clientState, m.delta);
    }
    expect(clientState).toEqual(r.state);
  });

  it('rejects cross-player spoofed actions without broadcasting state', () => {
    const r = room();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);

    const result = r.submitAction('p2', action('spoof', 'p1', 'Spoofed'), p2);

    expect(result).toMatchObject({ ok: false, code: 'E_FORBIDDEN' });
    expect(r.state.players.p1?.name).toBe('One');
    expect(p2.messages.at(-1)).toMatchObject({
      type: 'rejection',
      actionId: 'spoof',
      code: 'E_FORBIDDEN',
    });
    expect(p1.messages).toHaveLength(1);
  });

  it('deduplicates retried action ids', () => {
    const r = room();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    const first = r.submitAction('p1', action('a1', 'p1', 'First'), p1);
    const second = r.submitAction('p1', action('a1', 'p1', 'Second'), p1);

    expect(first).toMatchObject({ ok: true, seq: 1 });
    expect(second).toMatchObject({ ok: true, seq: 1 });
    expect(r.state.players.p1?.name).toBe('First');
    // first action → delta broadcast; the deduped retry → full state resync
    expect(p1.messages.filter((m) => m.type === 'delta' || m.type === 'state')).toHaveLength(2);
  });

  it('validates inbound client messages before applying them', () => {
    const r = room();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    r.receive('p1', p1, '{bad json');
    r.receive('p1', p1, JSON.stringify({ type: 'action', action: action('a2', 'p1', 'Valid') }));

    expect(p1.messages[1]).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
    expect(r.state.players.p1?.name).toBe('Valid');
  });
});

// Ends the match on a `match.surrender` action so observeEndIfNeeded fires.
const surrenderModule: GameModule = {
  id: 'surrender-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('match.surrender', (action, h) => {
      const other = action.playerId === 'p1' ? 'p2' : 'p1';
      h.state.match.status = 'ended';
      h.state.match.winner = other;
      h.state.match.reason = 'elimination';
      h.emit('match.ended', { winner: other });
    });
  },
};

function surrenderAction(id: string, playerId: string): Action {
  return { id, type: 'match.surrender', playerId, issuedAt: 1, payload: {} };
}

describe('MatchRoom — observation & state hash (M0)', () => {
  function observed(options?: { emitStateHash?: boolean }): {
    r: MatchRoom;
    events: RoomObservation[];
  } {
    const events: RoomObservation[] = [];
    const r = new MatchRoom({
      id: 'obs',
      initialState: testState(),
      kernel: createKernel([renameModule, surrenderModule]),
      data: testData(),
      now: () => 10,
      observe: (e) => events.push(e),
      ...(options?.emitStateHash ? { emitStateHash: true } : {}),
    });
    return { r, events };
  }

  it('reports join, action (ok + reject) and leave to the observer', () => {
    const { r, events } = observed();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.submitAction('p1', action('a1', 'p1', 'Commander'), p1); // ok
    r.submitAction('p1', action('a2', 'p1', ''), p1); // rejected (empty name)
    r.removePeer('p1', p1);

    // Lifecycle kinds only — the M1 metrics kinds (events/broadcast/timing) ride the
    // same stream and have their own describe below.
    const lifecycle = events.filter(
      (e) => e.kind === 'join' || e.kind === 'action' || e.kind === 'leave',
    );
    expect(lifecycle).toEqual([
      { kind: 'join', playerId: 'p1' },
      { kind: 'action', actionId: 'a1', playerId: 'p1', type: 'player.rename', ok: true, seq: 1 },
      {
        kind: 'action',
        actionId: 'a2',
        playerId: 'p1',
        type: 'player.rename',
        ok: false,
        seq: 2,
        code: 'E_BAD_PAYLOAD',
      },
      { kind: 'leave', playerId: 'p1' },
    ]);
  });

  it('reports a match end exactly once', () => {
    const { r, events } = observed();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);
    r.submitAction('p1', surrenderAction('s1', 'p1'), p1);
    // a deduped retry of the same ending action must not re-report the end
    r.submitAction('p1', surrenderAction('s1', 'p1'), p1);

    const ends = events.filter((e) => e.kind === 'end');
    expect(ends).toEqual([{ kind: 'end', winner: 'p2', reason: 'elimination' }]);
  });

  it('reports lobby running/paused flips when a gate is configured', () => {
    const events: RoomObservation[] = [];
    const r = new MatchRoom({
      id: 'obs-lobby',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => 10,
      waitForPlayers: ['p1', 'p2'],
      observe: (e) => events.push(e),
    });
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1); // still waiting — no flip
    r.addPeer('p2', p2); // both in → running
    r.removePeer('p2', p2); // one dropped → paused

    expect(events.filter((e) => e.kind === 'lobby')).toEqual([
      { kind: 'lobby', waiting: false },
      { kind: 'lobby', waiting: true },
    ]);
  });

  it('omits the hash field unless emitStateHash is set', () => {
    const { r } = observed();
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    expect(p1.messages[0]).not.toHaveProperty('hash');
  });

  it('attaches a hash the client can verify against its reconstructed state', () => {
    const { r } = observed({ emitStateHash: true });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    const welcome = p1.messages[0];
    if (welcome?.type !== 'welcome') throw new Error('expected a welcome snapshot');
    expect(typeof (welcome as { hash?: string }).hash).toBe('string');

    let clientState = welcome.state;
    r.submitAction('p1', action('a1', 'p1', 'Commander'), p1);
    const delta = p1.messages.at(-1);
    if (delta?.type !== 'delta') throw new Error('expected a delta');
    clientState = applyDelta(clientState, delta.delta);
    // the desync check the overlay runs: our rebuild hashes to the server's tag
    expect(hashState(clientState)).toBe((delta as { hash?: string }).hash);
  });
});

describe('MatchRoom — M1 observations (events / broadcast / timing / desync)', () => {
  function observed(): { r: MatchRoom; events: RoomObservation[]; peers: [MemoryPeer, MemoryPeer] } {
    const events: RoomObservation[] = [];
    const r = new MatchRoom({
      id: 'obs-m1',
      initialState: testState(),
      kernel: createKernel([renameModule, surrenderModule]),
      data: testData(),
      now: () => 10,
      observe: (e) => events.push(e),
    });
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);
    return { r, events, peers: [p1, p2] };
  }

  it('surfaces the domain events of a committed action, with clock spans excluded', () => {
    const { r, events } = observed();
    r.submitAction('p1', action('a1', 'p1', 'Commander'));

    const ev = events.filter((e) => e.kind === 'events');
    expect(ev).toHaveLength(1);
    if (ev[0]?.kind !== 'events') throw new Error('expected an events observation');
    expect(ev[0].seq).toBe(1);
    const types = ev[0].events.map((e) => e.type);
    expect(types).toContain('player.renamed');
    // the world advanced 0 → 10 under this submit, but the clock span is noise
    expect(types).not.toContain('time.advanced');
  });

  it('reports broadcast fan-out with a per-player delta size', () => {
    const { r, events } = observed();
    r.submitAction('p1', action('a1', 'p1', 'Commander'));

    const b = events.filter((e) => e.kind === 'broadcast');
    expect(b).toHaveLength(1);
    if (b[0]?.kind !== 'broadcast') throw new Error('expected a broadcast observation');
    expect(b[0].seq).toBe(1);
    expect(b[0].ms).toBeGreaterThanOrEqual(0);
    // both connected players got a measured delta payload
    expect(Object.keys(b[0].deltaBytes).sort()).toEqual(['p1', 'p2']);
    expect(b[0].deltaBytes.p1).toBeGreaterThan(0);
  });

  it('reports a submit timing for accepted and rejected actions alike', () => {
    const { r, events } = observed();
    r.submitAction('p1', action('a1', 'p1', 'Commander')); // ok
    r.submitAction('p1', action('a2', 'p1', '')); // rejected

    const timings = events.filter((e) => e.kind === 'timing');
    expect(timings).toHaveLength(2);
    expect(timings).toEqual([
      expect.objectContaining({ op: 'submit', seq: 1, actionType: 'player.rename' }),
      expect.objectContaining({ op: 'submit', seq: 2, actionType: 'player.rename' }),
    ]);
    for (const t of timings) if (t.kind === 'timing') expect(t.ms).toBeGreaterThanOrEqual(0);
  });

  it('logs a desync report and answers it with a full resync snapshot', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    const before = p1.messages.length;

    await r.receive('p1', p1, JSON.stringify({ type: 'desync', seq: 3, hash: 'client-hash' }));

    expect(events.filter((e) => e.kind === 'desync')).toEqual([
      { kind: 'desync', playerId: 'p1', atSeq: 3, clientHash: 'client-hash' },
    ]);
    const reply = p1.messages[before];
    expect(reply).toMatchObject({ type: 'state', matchId: 'obs-m1' });
  });

  it('cools down repeat resync replies but never stops observing the reports', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    const before = p1.messages.length;

    await r.receive('p1', p1, JSON.stringify({ type: 'desync', seq: 3, hash: 'h1' }));
    await r.receive('p1', p1, JSON.stringify({ type: 'desync', seq: 4, hash: 'h2' })); // within cool-down

    // both reports observed (a desync storm must be visible in the metrics) …
    expect(events.filter((e) => e.kind === 'desync')).toHaveLength(2);
    // … but only the first got the (costly) full-state reply
    const states = p1.messages.slice(before).filter((m) => m.type === 'state');
    expect(states).toHaveLength(1);
  });

  it('rejects a malformed desync report as E_BAD_MESSAGE', async () => {
    const { r, peers } = observed();
    const [p1] = peers;
    await r.receive('p1', p1, JSON.stringify({ type: 'desync', seq: 'nope' }));
    expect(p1.messages.at(-1)).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
  });

  it('observes a client perf sample and never answers it (M2)', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    const before = p1.messages.length;

    await r.receive('p1', p1, JSON.stringify({ type: 'perf', fps: 58, rttMs: 42, memMb: 120 }));

    expect(events.filter((e) => e.kind === 'client_perf')).toEqual([
      { kind: 'client_perf', playerId: 'p1', fps: 58, rttMs: 42, memMb: 120 },
    ]);
    expect(p1.messages).toHaveLength(before); // telemetry is not a conversation
  });

  it('rate-limits perf samples per player — a flood is dropped silently', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    const before = p1.messages.length;

    await r.receive('p1', p1, JSON.stringify({ type: 'perf', fps: 60 }));
    await r.receive('p1', p1, JSON.stringify({ type: 'perf', fps: 59 })); // same instant → dropped

    expect(events.filter((e) => e.kind === 'client_perf')).toHaveLength(1);
    expect(p1.messages).toHaveLength(before); // no error either — silent drop
  });

  it('rejects an out-of-range perf sample as E_BAD_MESSAGE (fail-secure)', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    await r.receive('p1', p1, JSON.stringify({ type: 'perf', fps: -5 }));
    await r.receive('p1', p1, JSON.stringify({ type: 'perf', fps: Infinity }));
    expect(events.filter((e) => e.kind === 'client_perf')).toHaveLength(0);
    expect(p1.messages.at(-1)).toMatchObject({ type: 'error', code: 'E_BAD_MESSAGE' });
  });

  it('drops garbage optional fields but keeps the valid fps (parse clamps)', async () => {
    const { r, events, peers } = observed();
    const [p1] = peers;
    await r.receive(
      'p1',
      p1,
      JSON.stringify({ type: 'perf', fps: 30, rttMs: 'huge', memMb: -1 }),
    );
    expect(events.filter((e) => e.kind === 'client_perf')).toEqual([
      { kind: 'client_perf', playerId: 'p1', fps: 30 },
    ]);
  });
});

describe('MatchRoom — lobby gate (waitForPlayers)', () => {
  function lobby(): { r: MatchRoom; tick: (ms: number) => void } {
    let real = 1000;
    const r = new MatchRoom({
      id: 'lobby',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      waitForPlayers: ['p1', 'p2'],
    });
    return { r, tick: (ms) => (real += ms) };
  }
  const waitingOf = (m: ServerMessage | undefined): boolean | undefined =>
    (m as { waiting?: boolean } | undefined)?.waiting;

  it('freezes the world clock until both players connect, runs it, re-freezes on drop', () => {
    const { r, tick } = lobby();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();

    // p1 alone → waiting, clock frozen at 0
    r.addPeer('p1', p1);
    expect(p1.messages[0]).toMatchObject({ type: 'welcome', waiting: true, serverTime: 0 });

    // an order WHILE waiting applies, but does NOT advance the clock
    tick(5000);
    r.submitAction('p1', action('a1', 'p1', 'Solo'), p1);
    expect(r.state.time).toBe(0);
    expect(p1.messages.at(-1)).toMatchObject({ type: 'delta', serverTime: 0, waiting: true });

    // p2 joins → the match starts; both learn the wait is over
    r.addPeer('p2', p2);
    expect(waitingOf(p2.messages[0])).toBeUndefined(); // p2 welcome: running
    expect(waitingOf(p1.messages.at(-1))).toBeUndefined(); // p1 got a flip broadcast

    // 3s pass with both connected → the clock accrues exactly that
    tick(3000);
    r.submitAction('p2', action('a2', 'p2', 'Duo'), p2);
    expect(r.state.time).toBe(3000);
    expect(p2.messages.at(-1)).toMatchObject({ type: 'delta', serverTime: 3000 });

    // p2 drops → clock re-freezes at 3000; p1 is told it's waiting again
    r.removePeer('p2', p2);
    expect(waitingOf(p1.messages.at(-1))).toBe(true);
    tick(10000);
    r.submitAction('p1', action('a3', 'p1', 'Alone'), p1);
    expect(r.state.time).toBe(3000); // still frozen — no advance past 3000
    expect(p1.messages.at(-1)).toMatchObject({ serverTime: 3000, waiting: true });
  });
});

describe('MatchRoom — singlePeerPerPlayer (1v1 slot guard)', () => {
  function guarded(): MatchRoom {
    return new MatchRoom({
      id: 'guard',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => 10,
      singlePeerPerPlayer: true,
    });
  }

  it('refuses a second live connection to an occupied side, frees it on disconnect', () => {
    const r = guarded();
    const a = new MemoryPeer();
    const b = new MemoryPeer();

    expect(r.addPeer('p1', a)).toBe(true);
    expect(a.messages[0]).toMatchObject({ type: 'welcome', playerId: 'p1' });

    // a second person taking the SAME side is refused (this is what stranded the lobby)
    expect(r.addPeer('p1', b)).toBe(false);
    expect(b.messages).toEqual([{ type: 'error', matchId: 'guard', code: 'E_SLOT_TAKEN' }]);

    // the OTHER side is still free — the way a real 1v1 must go
    expect(r.addPeer('p2', new MemoryPeer())).toBe(true);

    // a slot frees the moment its peer drops, so reconnect-after-drop still works
    r.removePeer('p1', a);
    expect(r.addPeer('p1', new MemoryPeer())).toBe(true);
  });

  it('still allows multiple peers per side when the guard is off (default)', () => {
    const r = room(); // singlePeerPerPlayer unset
    expect(r.addPeer('p1', new MemoryPeer())).toBe(true);
    expect(r.addPeer('p1', new MemoryPeer())).toBe(true); // same side, e.g. a 2nd device
  });
});

describe('MatchRoom — manualStart lobby', () => {
  type Lobby = { host: string | null; connected: string[]; started: boolean };
  const lobbyOf = (m: ServerMessage | undefined): Lobby | undefined =>
    (m as { lobby?: Lobby } | undefined)?.lobby;

  function manual(): { r: MatchRoom; tick: (ms: number) => void } {
    let real = 1000;
    const r = new MatchRoom({
      id: 'ms',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      manualStart: true,
    });
    return { r, tick: (ms) => (real += ms) };
  }

  it('freezes the clock and shows a lobby until the host presses Start', () => {
    const { r, tick } = manual();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();

    // first to join hosts; clock frozen at 0; lobby roster present
    r.addPeer('p1', p1);
    expect(p1.messages[0]).toMatchObject({ type: 'welcome', waiting: true, serverTime: 0 });
    expect(lobbyOf(p1.messages[0])).toEqual({ host: 'p1', connected: ['p1'], started: false });

    // p2 joins → p1's lobby roster updates; still not started
    r.addPeer('p2', p2);
    expect(lobbyOf(p1.messages.at(-1))).toEqual({
      host: 'p1',
      connected: ['p1', 'p2'],
      started: false,
    });

    // time passes but the clock stays frozen at 0 until Start
    tick(5000);
    r.submitAction('p1', action('a1', 'p1', 'Solo'), p1);
    expect(r.state.time).toBe(0);

    // a NON-host cannot start
    r.start('p2');
    expect(r.state.time).toBe(0);
    expect(lobbyOf(p2.messages.at(-1))?.started).toBe(false);

    // the host starts → clock runs from the press; lobby.started true; waiting clears
    r.start('p1');
    expect(lobbyOf(p1.messages.at(-1))?.started).toBe(true);
    expect((p1.messages.at(-1) as { waiting?: boolean }).waiting).toBeUndefined();

    tick(3000);
    r.submitAction('p1', action('a2', 'p1', 'Go'), p1);
    expect(r.state.time).toBe(3000); // accrues from the Start press, not from join
  });

  it('hands the host role to the remaining player if the host leaves before Start', () => {
    const { r } = manual();
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);
    expect(lobbyOf(p2.messages.at(-1))?.host).toBe('p1');

    r.removePeer('p1', p1); // host drops pre-start
    expect(lobbyOf(p2.messages.at(-1))).toEqual({ host: 'p2', connected: ['p2'], started: false });

    r.start('p2'); // the new host can now start
    expect(lobbyOf(p2.messages.at(-1))?.started).toBe(true);
  });

  it('resumes an already-started match (initiallyStarted) — no fresh lobby, clock continues', () => {
    let real = 5000;
    const resumed: GameState = { ...testState(), time: 3000 }; // 3000ms already played
    const r = new MatchRoom({
      id: 'resume',
      initialState: resumed,
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      manualStart: true,
      initiallyStarted: true,
    });
    expect(r.isStarted).toBe(true);
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    // straight into the running match: no waiting, lobby.started, clock at the saved time
    expect((p1.messages[0] as { waiting?: boolean }).waiting).toBeUndefined();
    expect(lobbyOf(p1.messages[0])?.started).toBe(true);
    expect((p1.messages[0] as { serverTime: number }).serverTime).toBe(3000);
    // the clock keeps accruing from the resume point
    real = 5500;
    r.submitAction('p1', action('a1', 'p1', 'Go'), p1);
    expect(r.state.time).toBe(3500); // 3000 + (5500 − 5000)
  });

  it('auto-start (initiallyStarted, NO manualStart): born running, anchored, scaled — no lobby on the wire', () => {
    // SES-2.1 (Iron Order model): a session's clock runs from creation. The anchor
    // matters — without it a fresh world (time 0) against a raw wall-clock `now`
    // would fast-forward decades on the first tick.
    let real = 100_000;
    const r = new MatchRoom({
      id: 'auto',
      initialState: testState(), // fresh world, time 0
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      initiallyStarted: true,
      timeScale: 10, // TIME_SCALE keeps working without a lobby gate
    });
    expect(r.isStarted).toBe(true);
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    // No lobby machinery leaks into snapshots: no roster, no waiting flag.
    expect((p1.messages[0] as { waiting?: boolean }).waiting).toBeUndefined();
    expect(lobbyOf(p1.messages[0])).toBeUndefined();
    expect((p1.messages[0] as { serverTime: number }).serverTime).toBe(0); // anchored at creation
    // 2 real seconds later the world is 20 game-seconds in — anchored AND scaled.
    real += 2000;
    r.submitAction('p1', action('a1', 'p1', 'Go'), p1);
    expect(r.state.time).toBe(20_000);
  });
});

// SRV-1: a rejected action must still flush the world-advance the room already
// committed (otherwise scheduled arrivals/battles are lost until the next accept).
const armModule: GameModule = {
  id: 'arm-test',
  version: '1.0.0',
  setup(api) {
    api.onAction('arm', (_action, h) => {
      h.schedule(h.ctx.now + 1000, 'boom', {});
    });
    api.on('boom', (_event, h) => {
      const p = h.state.players.p1;
      if (p) p.name = 'BOOMED';
      h.emit('boomed', { owner: 'p1' }); // owner so it passes the fog event filter
    });
    api.onAction('reject.me', (_action, h) => h.reject('E_NOPE'));
  },
};

describe('MatchRoom — durable idempotency (initialReceipts)', () => {
  it('a receipt seeded from a prior run dedupes a retried action (no re-apply)', () => {
    // before the "crash": apply a1 and capture its receipt
    const r1 = room();
    const p1 = new MemoryPeer();
    r1.addPeer('p1', p1);
    const first = r1.submitAction('p1', action('a1', 'p1', 'Commander'), p1);
    expect(first.ok).toBe(true);

    // after the "restart": a fresh room seeded with that receipt. We deliberately
    // start from the PRE-action state (name 'One') so a re-apply would be visible.
    const r2 = new MatchRoom({
      id: 'test-room',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => 10,
      initialReceipts: [{ actionId: 'a1', playerId: 'p1', seq: first.seq, ok: true }],
    });
    const p1b = new MemoryPeer();
    r2.addPeer('p1', p1b);
    const retry = r2.submitAction('p1', action('a1', 'p1', 'Commander'), p1b);
    expect(retry).toMatchObject({ ok: true, seq: first.seq }); // served from the receipt
    expect(r2.state.players.p1?.name).toBe('One'); // NOT re-applied
  });
});

describe('MatchRoom — SRV-1 (advance events on a rejected action)', () => {
  it('broadcasts the world-advance even when the triggering action is rejected', () => {
    let real = 1000;
    const r = new MatchRoom({
      id: 'srv1',
      initialState: testState(),
      kernel: createKernel([armModule]),
      data: testData(),
      now: () => real,
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    // arm a 'boom' for t=2000
    r.submitAction('p1', { id: 'arm1', type: 'arm', playerId: 'p1', issuedAt: 1, payload: {} }, p1);
    const mark = p1.messages.length;

    // jump past the boom, then send a KNOWINGLY-REJECTED action
    real = 3000;
    const res = r.submitAction(
      'p1',
      { id: 'rej1', type: 'reject.me', playerId: 'p1', issuedAt: 1, payload: {} },
      p1,
    );
    expect(res.ok).toBe(false);

    const after = p1.messages.slice(mark);
    // the advance fired 'boom' → a delta carrying 'boomed' was broadcast despite the reject
    const delta = after.find((m) => m.type === 'delta') as
      | { events: { type: string }[] }
      | undefined;
    expect(delta?.events.some((e) => e.type === 'boomed')).toBe(true);
    expect(r.state.players.p1?.name).toBe('BOOMED');
    // and the rejection itself was still delivered
    expect(after.some((m) => m.type === 'rejection' && (m as { code?: string }).code === 'E_NOPE')).toBe(
      true,
    );
  });
});

// PA-4.1: the world must run 24/7 — scheduled events (arrivals/battles/captures)
// fire even with no player connected. `msUntilNextEvent` tells a wakeup driver when
// to call `tick`, which advances the world and broadcasts with no action. Reuses
// `armModule`: an `arm` action schedules a `boom` 1000ms out that renames p1.
const armAction = (id: string): Action => ({
  id,
  type: 'arm',
  playerId: 'p1',
  issuedAt: 1,
  payload: {},
});

describe('MatchRoom — offline scheduler (tick / msUntilNextEvent)', () => {
  function armed(start = 1000): { r: MatchRoom; set: (ms: number) => void } {
    let real = start;
    const r = new MatchRoom({
      id: 'sched',
      initialState: testState(),
      kernel: createKernel([armModule]),
      data: testData(),
      now: () => real,
    });
    return { r, set: (ms) => (real = ms) };
  }

  it('reports no wakeup when nothing is scheduled', () => {
    expect(armed().r.msUntilNextEvent()).toBeNull();
  });

  it('reports the ms until the soonest scheduled event', () => {
    const { r } = armed(1000);
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.submitAction('p1', armAction('arm1'), p1); // schedules boom at now(1000)+1000
    expect(r.msUntilNextEvent()).toBe(1000); // 2000 − 1000
  });

  it('tick() fires a due event with no action, broadcasts it, then has nothing left', () => {
    const { r, set } = armed(1000);
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.submitAction('p1', armAction('arm1'), p1);
    expect(r.state.players.p1?.name).toBe('One'); // not yet boomed
    const mark = p1.messages.length;

    // wall-clock jumps past the boom; the driver wakes the room — no action sent
    set(2500);
    expect(r.msUntilNextEvent()).toBe(0); // overdue
    r.tick();

    expect(r.state.players.p1?.name).toBe('BOOMED'); // fired with no action
    const delta = p1.messages.slice(mark).find((m) => m.type === 'delta') as
      | { events: { type: string }[] }
      | undefined;
    expect(delta?.events.some((e) => e.type === 'boomed')).toBe(true);
    expect(r.msUntilNextEvent()).toBeNull(); // consumed → idle again
  });

  it('does not wake or advance while the lobby clock is frozen', () => {
    let real = 1000;
    const r = new MatchRoom({
      id: 'sched-lobby',
      initialState: testState(),
      kernel: createKernel([armModule]),
      data: testData(),
      now: () => real,
      manualStart: true,
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1); // host, but not started → clock frozen
    r.submitAction('p1', armAction('arm1'), p1);
    expect(r.msUntilNextEvent()).toBeNull(); // frozen → nothing to wake for
    real = 9000;
    r.tick();
    expect(r.state.players.p1?.name).toBe('One'); // tick is a no-op while frozen
  });
});

// F-03 / F-04 (audit): the in-memory receipts map must not grow without bound, and a
// flood of actions must be rate-limited — without breaking idempotency (a rate-limited
// action keeps no receipt, so a genuine retry after backoff still lands).
describe('MatchRoom — DoS bounds (receipts cap + action rate limit)', () => {
  it('evicts the oldest receipt past the cap — a retry of an evicted action re-applies', () => {
    const r = new MatchRoom({
      id: 'cap',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => 10,
      maxReceipts: 2, // tiny cap to force eviction
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    const a1 = r.submitAction('p1', action('a1', 'p1', 'A1'), p1);
    r.submitAction('p1', action('a2', 'p1', 'A2'), p1);
    r.submitAction('p1', action('a3', 'p1', 'A3'), p1); // size 3 > 2 → evicts a1
    expect(a1.seq).toBe(1);

    // a3 is still within the cap → its retry is served from the receipt (no re-apply)
    const a3retry = r.submitAction('p1', action('a3', 'p1', 'ZZ'), p1);
    expect(a3retry.seq).toBe(3);
    expect(r.state.players.p1?.name).toBe('A3'); // deduped — 'ZZ' ignored

    // a1's receipt was evicted → its retry is NOT deduped: it re-applies, fresh seq
    const a1retry = r.submitAction('p1', action('a1', 'p1', 'A1again'), p1);
    expect(a1retry.seq).toBeGreaterThan(3);
    expect(r.state.players.p1?.name).toBe('A1again'); // re-applied
  });

  it('rate-limits a flood transiently — no receipt, so the same id lands after the window', () => {
    let real = 1000;
    const r = new MatchRoom({
      id: 'rate',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      actionRateMax: 2,
      actionRateWindowMs: 1000,
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);

    expect(r.submitAction('p1', action('a1', 'p1', 'One'), p1).ok).toBe(true);
    expect(r.submitAction('p1', action('a2', 'p1', 'Two'), p1).ok).toBe(true);

    // 3rd within the window → rate-limited (transient rejection, world untouched)
    const flooded = r.submitAction('p1', action('a3', 'p1', 'Three'), p1);
    expect(flooded).toMatchObject({ ok: false, code: 'E_RATE_LIMIT' });
    expect(p1.messages.at(-1)).toMatchObject({
      type: 'rejection',
      actionId: 'a3',
      code: 'E_RATE_LIMIT',
    });
    expect(r.state.players.p1?.name).toBe('Two'); // a3 not applied

    // no receipt was kept for a3 → after the window the SAME id is accepted
    real += 1001;
    const retried = r.submitAction('p1', action('a3', 'p1', 'Three'), p1);
    expect(retried.ok).toBe(true);
    expect(r.state.players.p1?.name).toBe('Three');
  });
});

// Playtest fast-forward: the running clock advances timeScale× faster than wall-time,
// so a real minute is many game-hours and fleets/builds/economy resolve on-screen.
describe('MatchRoom — timeScale (playtest fast-forward clock)', () => {
  it('runs the world clock timeScale× faster than wall-time after Start', () => {
    let real = 1000;
    const r = new MatchRoom({
      id: 'ts',
      initialState: testState(),
      kernel: createKernel([renameModule]),
      data: testData(),
      now: () => real,
      manualStart: true,
      timeScale: 100,
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.start('p1'); // host starts the clock at wall=1000
    real = 1050; // 50 real-ms later → 50 × 100 = 5000 game-ms
    r.submitAction('p1', action('a1', 'p1', 'Go'), p1);
    expect(r.state.time).toBe(5000);
    expect((p1.messages.at(-1) as { serverTime: number }).serverTime).toBe(5000);
  });

  it('shrinks the offline-wakeup delay by timeScale (event fires sooner in wall-time)', () => {
    const real = 1000;
    const r = new MatchRoom({
      id: 'ts2',
      initialState: testState(),
      kernel: createKernel([armModule]),
      data: testData(),
      now: () => real,
      manualStart: true,
      timeScale: 100,
    });
    const p1 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.start('p1');
    r.submitAction('p1', { id: 'arm1', type: 'arm', playerId: 'p1', issuedAt: 1, payload: {} }, p1);
    // boom is scheduled at game-time 1000; at ×100 that is 1000/100 = 10 wall-ms away
    expect(r.msUntilNextEvent()).toBe(10);
  });
});

describe('MatchRoom — backpressure (drop a peer that stops draining)', () => {
  it('closes a peer whose outbound buffer exceeds the cap instead of sending', () => {
    const r = room();
    let closed: number | undefined;
    let sent = 0;
    const slow: RoomPeer = {
      bufferedAmount: 2_000_000, // over the 1 MiB cap → not draining
      send: () => {
        sent += 1;
      },
      close: (code) => {
        closed = code;
      },
    };
    r.addPeer('p1', slow); // the welcome broadcast hits the backpressure guard
    expect(closed).toBe(1013); // dropped with "try again later"
    expect(sent).toBe(0); // nothing queued onto the stuck peer
  });
});

// BF-15/BF-16: event fog. Personal and bilateral events (research, steward,
// diplomacy, market, elimination) must reach their named participants; hero
// events must stay owner-only even when an enemy identifies the node.
describe('MatchRoom — event fog (personal/bilateral audiences, hero privacy)', () => {
  const fogEventsModule: GameModule = {
    id: 'fog-events-test',
    version: '1.0.0',
    setup(api) {
      api.onAction('test.personal', (action, h) => {
        h.emit('technology.researched', { playerId: action.playerId, technology: 'lasers' });
      });
      api.onAction('test.bilateral', (action, h) => {
        const { to } = action.payload as { to: string };
        h.emit('diplomacy.offered', { from: action.playerId, to, stance: 'peace' });
      });
      api.onAction('test.hero', (action, h) => {
        const { at } = action.payload as { at: string };
        h.emit('hero.spawned', { owner: action.playerId, heroId: 'h1', fleetId: 'f1', at });
      });
    },
  };

  function fogState(): GameState {
    const base = testState();
    return {
      ...base,
      players: {
        ...base.players,
        p3: player('p3', 'Three'),
      },
      // p2 owns node1 → p2 identifies it (fog coverage floods from own worlds).
      planets: {
        node1: {
          id: 'node1',
          owner: 'p2',
          position: { x: 0, y: 0 },
          resources: {},
          buildings: [],
          garrison: [],
          traits: [],
        },
      },
    };
  }

  function fogRoom(): { r: MatchRoom; p1: MemoryPeer; p2: MemoryPeer; p3: MemoryPeer } {
    const r = new MatchRoom({
      id: 'fog-room',
      initialState: fogState(),
      kernel: createKernel([fogEventsModule]),
      data: testData(),
      now: () => 10,
    });
    const p1 = new MemoryPeer();
    const p2 = new MemoryPeer();
    const p3 = new MemoryPeer();
    r.addPeer('p1', p1);
    r.addPeer('p2', p2);
    r.addPeer('p3', p3);
    return { r, p1, p2, p3 };
  }

  function lastEvents(peer: MemoryPeer): string[] {
    const last = peer.messages.at(-1) as { type: string; events?: { type: string }[] };
    expect(last.type).toBe('delta');
    return (last.events ?? []).map((e) => e.type);
  }

  it('a personal event (payload.playerId) reaches its subject and nobody else', () => {
    const { r, p1, p2, p3 } = fogRoom();
    r.submitAction(
      'p1',
      { id: 'e1', type: 'test.personal', playerId: 'p1', issuedAt: 1, payload: {} },
      p1,
    );
    expect(lastEvents(p1)).toContain('technology.researched');
    expect(lastEvents(p2)).not.toContain('technology.researched');
    expect(lastEvents(p3)).not.toContain('technology.researched');
  });

  it('a bilateral event (from/to) reaches both participants but not a third party', () => {
    const { r, p1, p2, p3 } = fogRoom();
    r.submitAction(
      'p1',
      { id: 'e2', type: 'test.bilateral', playerId: 'p1', issuedAt: 1, payload: { to: 'p2' } },
      p1,
    );
    expect(lastEvents(p1)).toContain('diplomacy.offered');
    expect(lastEvents(p2)).toContain('diplomacy.offered');
    expect(lastEvents(p3)).not.toContain('diplomacy.offered');
  });

  it('a hero event is owner-only: an identified node must NOT reveal it to an enemy', () => {
    const { r, p1, p2, p3 } = fogRoom();
    // p1 spawns a hero at node1 — a node p2 identifies (p2 owns it).
    r.submitAction(
      'p1',
      { id: 'e3', type: 'test.hero', playerId: 'p1', issuedAt: 1, payload: { at: 'node1' } },
      p1,
    );
    expect(lastEvents(p1)).toContain('hero.spawned');
    expect(lastEvents(p2)).not.toContain('hero.spawned'); // the leak BF-16 plugged
    expect(lastEvents(p3)).not.toContain('hero.spawned');
  });
});
