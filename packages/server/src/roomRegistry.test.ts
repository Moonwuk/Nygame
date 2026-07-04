import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type GameData,
  type GameModule,
  type GameState,
  type Player,
} from '@void/shared-core';
import { MatchRoom, type RoomPeer } from './matchRoom';
import { InMemoryRoomRegistry, LazyRoomRegistry } from './roomRegistry';
import { MemoryMatchStore } from './store';
import { snapshotOf } from './persistence';
import { createMultiplayerServer } from './wsServer';
import type { ServerMessage } from './protocol';

/** A deterministic stand-in for the idle timer: captures the scheduled callback so a
 *  test can fire the hibernation window on demand. */
function idleHarness() {
  let captured: { fn: () => void; ms: number } | null = null;
  return {
    schedule: (fn: () => void, ms: number) => {
      captured = { fn, ms };
      return { fn };
    },
    cancel: () => {
      captured = null;
    },
    get pending() {
      return captured;
    },
    fire() {
      const c = captured;
      captured = null;
      c?.fn();
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const fakePeer = (): RoomPeer => ({ send() {} });

// SV-0.2: one server process hosting N isolated match-actors, routed by match id.

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

function makeRoom(id: string): MatchRoom {
  const base = createInitialState({ seed: id, version: { data: 'test', manifest: 'test' } });
  return new MatchRoom({
    id,
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

function markerAction(id: string) {
  return { type: 'action', action: { id, type: 'marker.set', playerId: 'p1', payload: {}, issuedAt: 1 } };
}

describe('InMemoryRoomRegistry', () => {
  it('registers and resolves matches by id, and reports unknown as undefined', () => {
    const a = makeRoom('a');
    const b = makeRoom('b');
    const registry = new InMemoryRoomRegistry([a, b]);
    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.ids().sort()).toEqual(['a', 'b']);
    const c = makeRoom('c');
    registry.add(c);
    expect(registry.get('c')).toBe(c);
  });
});

describe('createMultiplayerServer · multi-match registry', () => {
  it('routes each connection to its match and keeps matches isolated', async () => {
    const roomA = makeRoom('match-a');
    const roomB = makeRoom('match-b');
    const server = createMultiplayerServer({
      registry: new InMemoryRoomRegistry([roomA, roomB]),
    });
    const base = await server.listen(); // multi ⇒ base prefix; client appends /<id>
    try {
      const aWs = new WebSocket(`${base}/match-a?player=p1`);
      const aWelcome = nextMessage(aWs);
      await once(aWs, 'open');
      await aWelcome;
      const aDelta = nextMessage(aWs);
      aWs.send(JSON.stringify(markerAction('x1')));
      await aDelta;

      // The action landed on match-a only — the matches share no state.
      expect(roomA.state.players.p1?.resources.marker).toBe(1);
      expect(roomB.state.players.p1?.resources.marker ?? 0).toBe(0);
      aWs.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed match-id path with a 404, not a 500', async () => {
    const server = createMultiplayerServer({
      registry: new InMemoryRoomRegistry([makeRoom('a'), makeRoom('b')]),
    });
    const base = await server.listen(); // multi ⇒ base prefix, so we can craft a bad segment
    try {
      const ws = new WebSocket(`${base}/%zz?player=p1`); // %zz is a malformed %-escape
      const [err] = (await once(ws, 'error')) as [Error];
      expect(String(err)).toContain('404'); // a bad request path, not a server error
      ws.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a connection to a match this process is not hosting', async () => {
    const server = createMultiplayerServer({
      registry: new InMemoryRoomRegistry([makeRoom('known')]),
    });
    const base = await server.listen();
    try {
      const ws = new WebSocket(`${base}/nope?player=p1`);
      let opened = false;
      ws.on('open', () => {
        opened = true;
      });
      const [err] = (await once(ws, 'error')) as [Error];
      expect(opened).toBe(false);
      expect(String(err)).toContain('404');
      ws.close();
    } finally {
      await server.close();
    }
  });
});

describe('LazyRoomRegistry · load on demand + idle hibernation', () => {
  it('loads a match once on demand and caches it live', async () => {
    let loads = 0;
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async (id) => {
        loads += 1;
        return id === 'm' ? { room, dispose: () => {} } : null;
      },
    });
    expect(registry.get('m')).toBeUndefined(); // nothing live yet
    expect(await registry.resolve('m')).toBe(room);
    expect(registry.get('m')).toBe(room);
    expect(await registry.resolve('m')).toBe(room);
    expect(loads).toBe(1); // cached, not reloaded
    expect(await registry.resolve('missing')).toBeUndefined();
  });

  it('de-dupes concurrent loads of the same match', async () => {
    let loads = 0;
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async () => {
        loads += 1;
        await Promise.resolve();
        return { room, dispose: () => {} };
      },
    });
    const [a, b] = await Promise.all([registry.resolve('m'), registry.resolve('m')]);
    expect(a).toBe(room);
    expect(b).toBe(room);
    expect(loads).toBe(1); // one in-flight load served both callers
  });

  it('hibernates an unwatched match after the idle window, then reloads it', async () => {
    const idle = idleHarness();
    let loads = 0;
    let disposed = 0;
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async () => {
        loads += 1;
        return { room, dispose: () => void (disposed += 1) };
      },
      idleMs: 1000,
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    await registry.resolve('m');

    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    expect(idle.pending).toBeNull(); // watched → no countdown

    room.removePeer('p1', peer);
    registry.release('m');
    expect(idle.pending?.ms).toBe(1000); // unwatched → hibernation armed

    idle.fire();
    await flush();
    expect(disposed).toBe(1);
    expect(registry.get('m')).toBeUndefined(); // evicted from live memory

    expect(await registry.resolve('m')).toBe(room); // a reconnection reloads it
    expect(loads).toBe(2);
  });

  it('a reconnect during hibernation waits for the persist before reloading', async () => {
    const idle = idleHarness();
    let loads = 0;
    let resolveDispose: (() => void) | null = null;
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async () => {
        loads += 1;
        return {
          room,
          dispose: () =>
            new Promise<void>((res) => {
              resolveDispose = () => res();
            }),
        };
      },
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    await registry.resolve('m');
    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');

    idle.fire(); // hibernation begins; its dispose (persist) is held open
    await flush();
    expect(resolveDispose).not.toBeNull();

    // A reconnection lands mid-hibernation — it must block until the persist finishes.
    let done = false;
    const reconnect = registry.resolve('m').then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false); // waiting on the in-flight dispose
    expect(loads).toBe(1); // not reloaded yet

    resolveDispose!(); // the persist completes
    await reconnect;
    expect(done).toBe(true);
    expect(loads).toBe(2); // only now does it reload — from the freshly-persisted snapshot
  });

  it('cancels hibernation when a socket reconnects within the window', async () => {
    const idle = idleHarness();
    let disposed = 0;
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async () => ({ room, dispose: () => void (disposed += 1) }),
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    await registry.resolve('m');

    const p1 = fakePeer();
    room.addPeer('p1', p1);
    registry.retain('m');
    room.removePeer('p1', p1);
    registry.release('m'); // armed

    const p2 = fakePeer();
    room.addPeer('p2', p2);
    registry.retain('m'); // reconnect before it fires
    expect(idle.pending).toBeNull(); // disarmed
    expect(disposed).toBe(0);
  });

  it('does not hibernate while another socket is still connected', async () => {
    const idle = idleHarness();
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      load: async () => ({ room, dispose: () => {} }),
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    await registry.resolve('m');

    const p1 = fakePeer();
    const p2 = fakePeer();
    room.addPeer('p1', p1);
    registry.retain('m');
    room.addPeer('p2', p2);
    registry.retain('m');
    room.removePeer('p1', p1);
    registry.release('m'); // one socket still connected
    expect(idle.pending).toBeNull(); // peerCount > 0 → no countdown
  });

  it('contains a failing hibernation persist (no crash) and still evicts the match', async () => {
    const idle = idleHarness();
    const room = makeRoom('m');
    const registry = new LazyRoomRegistry({
      // dispose rejects (store outage) — must not become an unhandled rejection.
      load: async () => ({ room, dispose: () => Promise.reject(new Error('store down')) }),
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    await registry.resolve('m');
    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');

    idle.fire(); // hibernate with a rejecting dispose
    await flush();
    // No unhandled rejection (vitest would fail the run); the match is evicted and
    // reloads from its last durable snapshot on reconnect.
    expect(registry.get('m')).toBeUndefined();
  });

  it('shutdown resolves even when a match dispose rejects', async () => {
    let disposedHealthy = false;
    const roomA = makeRoom('a');
    const roomB = makeRoom('b');
    const registry = new LazyRoomRegistry({
      load: async (id) =>
        id === 'a'
          ? { room: roomA, dispose: () => void (disposedHealthy = true) }
          : { room: roomB, dispose: () => Promise.reject(new Error('down')) },
    });
    await registry.resolve('a');
    await registry.resolve('b');
    await expect(registry.shutdown()).resolves.toBeUndefined(); // does not reject or hang
    expect(disposedHealthy).toBe(true); // the healthy match still persisted
    expect(registry.ids()).toEqual([]);
  });

  it('shutdown persists + tears down every live match', async () => {
    let disposed = 0;
    const roomA = makeRoom('a');
    const roomB = makeRoom('b');
    const registry = new LazyRoomRegistry({
      load: async (id) => ({ room: id === 'a' ? roomA : roomB, dispose: () => void (disposed += 1) }),
    });
    await registry.resolve('a');
    await registry.resolve('b');
    await registry.shutdown();
    expect(disposed).toBe(2);
    expect(registry.ids()).toEqual([]);
  });

  it('wsServer loads a match on connect and hibernates it after an idle disconnect', async () => {
    const idle = idleHarness();
    let loads = 0;
    let disposed = 0;
    const registry = new LazyRoomRegistry({
      load: async (id) => {
        loads += 1;
        return { room: makeRoom(id), dispose: () => void (disposed += 1) };
      },
      idleMs: 1000,
      schedule: idle.schedule,
      cancel: idle.cancel,
    });
    const server = createMultiplayerServer({ registry });
    const base = await server.listen(); // no live matches ⇒ base prefix
    try {
      const ws = new WebSocket(`${base}/m?player=p1`);
      const welcome = nextMessage(ws);
      await once(ws, 'open');
      await welcome;
      expect(loads).toBe(1); // resolved-on-connect

      const closed = once(ws, 'close');
      ws.close();
      await closed;
      await flush(); // let the server's 'close' handler run removePeer + release
      expect(idle.pending?.ms).toBe(1000); // unwatched → hibernation armed

      idle.fire();
      await flush();
      expect(disposed).toBe(1); // hibernated
      expect(registry.get('m')).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

// The 24/7 world keeps running for a fully-offline match: a hibernated match wakes at
// its next scheduled event, processes + persists it, and re-sleeps armed for the next.
const beatModule: GameModule = {
  id: 'beat',
  version: '1.0.0',
  setup(api) {
    api.on('beat', (_e, h) => {
      const p = h.state.players.p1;
      if (p) p.resources.beats = (p.resources.beats ?? 0) + 1;
      h.schedule(h.state.time + 100, 'beat'); // schedule the next beat
    });
  },
};
function beatData(): GameData {
  return parseGameData({
    version: 'test',
    resources: ['beats'],
    units: {},
    factions: {},
    buildings: {},
    events: {},
    sectors: {},
    planetTypes: {},
  });
}
function beatState(at: number): GameState {
  const base = createInitialState({ seed: 'beat', version: { data: 'test', manifest: 'test' } });
  return {
    ...base,
    players: { p1: player('p1'), p2: player('p2') },
    scheduled: [{ id: 'evt:0', at, type: 'beat', payload: null, seq: 0 }],
    scheduleSeq: 1,
  };
}

describe('LazyRoomRegistry · wake scheduler (24/7 offline world)', () => {
  function beatHarness() {
    const clock = { now: 0 };
    const timer = idleHarness();
    const store = new MemoryMatchStore();
    void store.save({ matchId: 'm', dataVersion: 'test', seq: 0, status: 'ongoing', state: beatState(100) });
    const data = beatData();
    const kernel = createKernel([beatModule]);
    const registry = new LazyRoomRegistry({
      load: async (id) => {
        const snap = await store.load(id);
        if (!snap) return null;
        const room = new MatchRoom({ id, initialState: snap.state, kernel, data, now: () => clock.now });
        return { room, dispose: () => void store.save(snapshotOf(room)) };
      },
      idleMs: 1000,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });
    return { clock, timer, store, registry };
  }

  it('wakes a hibernated match at its next event, processes + persists it, re-arms the next', async () => {
    const { clock, timer, store, registry } = beatHarness();

    // Load, then a socket connects and leaves → idle countdown.
    await registry.resolve('m');
    const peer = fakePeer();
    const room = registry.get('m')!;
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');

    timer.fire(); // idle elapsed → hibernate
    await flush();
    expect(registry.get('m')).toBeUndefined(); // asleep
    expect(timer.pending?.ms).toBe(100); // wake armed for the beat at t=100

    // The beat's wall-clock time arrives while nobody is connected.
    clock.now = 150;
    timer.fire(); // wake
    await flush();

    const snap = await store.load('m');
    expect(snap?.state.players.p1?.resources.beats).toBe(1); // the beat fired + was persisted
    expect(registry.get('m')).toBeUndefined(); // re-hibernated (still unwatched)
    expect(timer.pending?.ms).toBe(50); // re-armed for the NEXT beat (t=200, now=150)
  });

  it('does not re-arm the wake for a stalled runaway match (no spin)', async () => {
    // A module that reschedules itself at its own instant → the clock can never progress
    // past it (a same-instant runaway). The registry's wake must NOT spin on it.
    const runawayModule: GameModule = {
      id: 'runaway',
      version: '1.0.0',
      setup(api) {
        api.on('inf', (_e, h) => h.schedule(h.state.time, 'inf'));
      },
    };
    const clock = { now: 1 };
    const timer = idleHarness();
    const store = new MemoryMatchStore();
    const runawayState: GameState = {
      ...createInitialState({ seed: 'r', version: { data: 'test', manifest: 'test' } }),
      players: { p1: player('p1'), p2: player('p2') },
      scheduled: [{ id: 'evt:0', at: 0, type: 'inf', payload: null, seq: 0 }],
      scheduleSeq: 1,
    };
    void store.save({ matchId: 'm', dataVersion: 'test', seq: 0, status: 'ongoing', state: runawayState });
    const kernel = createKernel([runawayModule]);
    const registry = new LazyRoomRegistry({
      load: async (id) => {
        const snap = await store.load(id);
        if (!snap) return null;
        const room = new MatchRoom({ id, initialState: snap.state, kernel, data: beatData(), now: () => clock.now });
        return { room, dispose: () => void store.save(snapshotOf(room)) };
      },
      idleMs: 1000,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    await registry.resolve('m');
    const room = registry.get('m')!;
    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');

    timer.fire(); // idle → hibernate → wake armed at 0 (event overdue)
    await flush();
    expect(timer.pending?.ms).toBe(0);

    timer.fire(); // wake → tick makes no progress (runaway stall) → re-hibernate
    await flush();
    expect(timer.pending).toBeNull(); // NOT re-armed — the spin is broken
  });

  it('cancels a pending wake when a player reconnects', async () => {
    const { registry, timer } = beatHarness();
    await registry.resolve('m');
    const room = registry.get('m')!;
    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');
    timer.fire(); // hibernate → wake armed
    await flush();
    expect(timer.pending?.ms).toBe(100);

    await registry.resolve('m'); // a reconnection loads it live
    expect(timer.pending).toBeNull(); // the wake was disarmed (the live driver takes over)
    expect(registry.get('m')).toBeDefined();
  });

  it('shutdown disarms pending wakes', async () => {
    const { registry, timer } = beatHarness();
    await registry.resolve('m');
    const room = registry.get('m')!;
    const peer = fakePeer();
    room.addPeer('p1', peer);
    registry.retain('m');
    room.removePeer('p1', peer);
    registry.release('m');
    timer.fire(); // hibernate → wake armed
    await flush();
    expect(timer.pending?.ms).toBe(100);

    await registry.shutdown();
    expect(timer.pending).toBeNull(); // wake cancelled
  });
});
