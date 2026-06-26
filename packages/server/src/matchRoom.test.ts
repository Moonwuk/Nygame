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

    expect(events).toEqual([
      { kind: 'join', playerId: 'p1' },
      { kind: 'action', playerId: 'p1', type: 'player.rename', ok: true, seq: 1 },
      { kind: 'action', playerId: 'p1', type: 'player.rename', ok: false, seq: 2, code: 'E_BAD_PAYLOAD' },
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
});
