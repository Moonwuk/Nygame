import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type Action,
  type GameModule,
  type Player,
} from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { MatchRoom, type RoomPeer } from './matchRoom';
import type { MatchSnapshot, StoredReceipt } from './store';
import type { ServerMessage } from './protocol';

// Strict commit-before-broadcast (docs/engineering-risks.md risk14). When a `persist`
// fn is configured, the action path awaits the durable write of the new snapshot +
// receipt BEFORE committing state or broadcasting — serialized per room so the async
// await can't let a second action race the reducer. These tests pin that contract.

const data = loadShippedData();

class MemoryPeer implements RoomPeer {
  readonly messages: ServerMessage[] = [];
  send(raw: string): void {
    this.messages.push(JSON.parse(raw) as ServerMessage);
  }
  deltas(): ServerMessage[] {
    return this.messages.filter((m) => m.type === 'delta');
  }
  rejections(): Extract<ServerMessage, { type: 'rejection' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'rejection' }> => m.type === 'rejection',
    );
  }
}

function orbit(fleetId: string, n: number): Action {
  return { id: `t:green:${n}`, type: 'fleet.orbit', playerId: 'green', payload: { fleetId, orbit: 'near' }, issuedAt: 0 };
}
function raw(action: Action): string {
  return JSON.stringify({ type: 'action', action });
}
/** Flush all pending microtasks (a macrotask boundary) — lets a committed submit run
 *  up to its persist await. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('MatchRoom · strict commit-before-broadcast', () => {
  it('does not commit state or broadcast until the durable write resolves', async () => {
    let resolvePersist: (() => void) | null = null;
    let captured: { snapshot: MatchSnapshot; receipt: StoredReceipt } | null = null;
    const persist = (snapshot: MatchSnapshot, receipt: StoredReceipt): Promise<void> => {
      captured = { snapshot, receipt };
      return new Promise<void>((res) => {
        resolvePersist = () => res();
      });
    };
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const done = room.receive('green', peer, raw(orbit('green_1', 1)));
    await flush(); // run the submit up to its persist await

    // The write is in flight; nothing is committed or broadcast yet.
    expect(captured).not.toBeNull();
    expect(captured!.snapshot.state.fleets.green_1?.orbit).toBe('near'); // NEW state is what we persist
    expect(captured!.receipt.seq).toBe(1);
    expect(room.state.fleets.green_1?.orbit).toBeUndefined(); // still the old committed state
    expect(peer.deltas()).toHaveLength(0); // NOT broadcast
    expect(room.sequence).toBe(0);

    resolvePersist!();
    await done;

    // Only now: state committed + delta broadcast.
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
    expect(peer.deltas().length).toBeGreaterThan(0);
  });

  it('commits nothing and stays retriable when the durable write fails', async () => {
    let fail = true;
    const persist = (): Promise<void> => (fail ? Promise.reject(new Error('db down')) : Promise.resolve());
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    await room.receive('green', peer, raw(orbit('green_1', 1)));

    // Failed write → no commit, no broadcast, a TRANSIENT reject (no receipt).
    expect(room.state.fleets.green_1?.orbit).toBeUndefined();
    expect(room.sequence).toBe(0);
    expect(peer.deltas()).toHaveLength(0);
    expect(peer.rejections().some((r) => r.code === 'E_UNAVAILABLE')).toBe(true);

    // The store recovers; retrying the SAME action id now lands (it was never receipted).
    fail = false;
    await room.receive('green', peer, raw(orbit('green_1', 1)));
    expect(room.state.fleets.green_1?.orbit).toBe('near');
    expect(room.sequence).toBe(1);
  });

  it('serializes concurrent committed submits (no interleave, ordered)', async () => {
    const persist = (): Promise<void> => Promise.resolve();
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    // Fire two without awaiting between them: they must run strictly one-at-a-time,
    // in order — `stop` only admits AFTER `move` has applied (E_FLEET_BUSY otherwise).
    const move: Action = { id: 't:green:1', type: 'fleet.move', playerId: 'green', payload: { fleetId: 'green_1', to: 'nexus' }, issuedAt: 0 };
    const stop: Action = { id: 't:green:2', type: 'fleet.stop', playerId: 'green', payload: { fleetId: 'green_1' }, issuedAt: 0 };
    const p1 = room.receive('green', peer, raw(move));
    const p2 = room.receive('green', peer, raw(stop));
    await Promise.all([p1, p2]);

    expect(room.sequence).toBe(2); // both applied, in order
    expect(peer.rejections()).toHaveLength(0); // stop admitted only because move ran first
    expect(room.state.fleets.green_1?.movement).toBeNull(); // action 2 (stop) wins: parked
  });

  it('replays a committed action idempotently (dedup, no re-apply)', async () => {
    const persist = (): Promise<void> => Promise.resolve();
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });
    const peer = new MemoryPeer();
    room.addPeer('green', peer);

    const act = orbit('green_1', 1);
    await room.receive('green', peer, raw(act));
    expect(room.sequence).toBe(1);

    await room.receive('green', peer, raw(act)); // same id → deduped
    expect(room.sequence).toBe(1); // no new seq, no re-apply
  });

  it('does not wedge the commit queue when reporting a failure throws (dead socket)', async () => {
    let fail = true;
    const persist = (): Promise<void> => (fail ? Promise.reject(new Error('down')) : Promise.resolve());
    const room = createDevMatch(data, { now: () => 1000, time: 1000, persist });

    // A peer whose send throws once armed — a socket that died mid-flight.
    let dead = false;
    const badPeer: RoomPeer = {
      send: () => {
        if (dead) throw new Error('socket dead');
      },
    };
    room.addPeer('green', badPeer);
    dead = true;

    // Action 1: persist fails → the failure report hits the dead socket. Must not wedge.
    await room.receive('green', badPeer, raw(orbit('green_1', 1)));

    // The store recovers and a healthy peer connects: a later action must still land.
    fail = false;
    const peer = new MemoryPeer();
    room.addPeer('green', peer);
    await room.receive('green', peer, raw(orbit('green_1', 2)));

    expect(room.state.fleets.green_1?.orbit).toBe('near'); // queue alive
    expect(room.sequence).toBe(1); // action 1 failed (no receipt), action 2 applied
  });

  it('never exposes the in-flight advanced world during the persist await', async () => {
    // 1) Commit a move that schedules a future arrival.
    let resolvePersist: (() => void) | null = null;
    const persist = (): Promise<void> =>
      new Promise<void>((res) => {
        resolvePersist = () => res();
      });
    let clock = 1000;
    const room = createDevMatch(data, { now: () => clock, time: 1000, persist });
    const green = new MemoryPeer();
    room.addPeer('green', green);

    const moveAct: Action = {
      id: 't:green:1',
      type: 'fleet.move',
      playerId: 'green',
      payload: { fleetId: 'green_1', to: 'nexus' },
      issuedAt: 0,
    };
    const movePromise = room.receive('green', green, raw(moveAct));
    await flush();
    resolvePersist!();
    await movePromise;
    expect(room.sequence).toBe(1);

    // 2) Jump the clock far past the arrival and hold a second committed submit mid-persist.
    clock = 10_000_000;
    const p2 = room.receive('green', green, raw(orbit('green_1', 2)));
    await flush(); // computeAdvance (arrival fires on a COPY) + applyAction, now awaiting persist

    // The committed frontier is UNCHANGED: the arrival isn't durable yet, so it isn't exposed.
    expect(room.state.fleets.green_1?.location).not.toBe('nexus');
    expect(room.sequence).toBe(1);

    resolvePersist!();
    await p2;

    // Only after the durable ack is the advanced world committed: seq moved and the
    // clock caught up past the held frontier.
    expect(room.sequence).toBe(2);
    expect(room.state.time).toBeGreaterThan(1000);
  });

  it('leaves the synchronous path untouched when no persist is configured', () => {
    // No persist ⇒ receive routes to the sync submitAction (the current behavior every
    // existing test relies on). submitAction stays fully synchronous.
    const room: MatchRoom = createDevMatch(data, { now: () => 1000, time: 1000 });
    const res = room.submitAction('green', orbit('green_1', 1));
    expect(res.ok).toBe(true);
    expect(room.state.fleets.green_1?.orbit).toBe('near'); // committed synchronously
    expect(room.sequence).toBe(1);
  });
});

// SV-0.2 mailbox: a lobby `start` shares the actor mailbox with committed actions, so
// its broadcast can't interleave with an in-flight action's persist await.
const markerModule: GameModule = {
  id: 'marker',
  version: '1.0.0',
  setup(api) {
    api.onAction('marker.set', (a, h) => {
      const p = h.state.players[a.playerId];
      if (!p) return h.reject('E_FORBIDDEN');
      p.resources.marker = (p.resources.marker ?? 0) + 1;
      h.emit('marker.set', {});
    });
  },
};
function lobbyPlayer(id: string): Player {
  return { id, name: id, faction: id, status: 'active', resources: {} };
}
function markerData() {
  return parseGameData({
    version: 'test',
    resources: ['marker'],
    units: {},
    factions: {},
    buildings: {},
    events: {},
    sectors: {},
    planetTypes: {},
  });
}

describe('MatchRoom · mailbox serializes lobby start', () => {
  it('runs a lobby start only after an in-flight committed action commits', async () => {
    let resolvePersist: (() => void) | null = null;
    const persist = (): Promise<void> =>
      new Promise<void>((res) => {
        resolvePersist = () => res();
      });
    const base = createInitialState({ seed: 'lobby', version: { data: 'test', manifest: 'test' } });
    const room = new MatchRoom({
      id: 'lobby',
      initialState: { ...base, players: { p1: lobbyPlayer('p1'), p2: lobbyPlayer('p2') } },
      kernel: createKernel([markerModule]),
      data: markerData(),
      now: () => 1000,
      manualStart: true, // clock frozen until the host presses Start
      persist,
    });
    const p1 = new MemoryPeer();
    room.addPeer('p1', p1); // first connection ⇒ host

    // A committed action, held at its persist await.
    const actAction: Action = { id: 'a1', type: 'marker.set', playerId: 'p1', payload: {}, issuedAt: 1 };
    const actP = room.receive('p1', p1, JSON.stringify({ type: 'action', action: actAction }));
    await flush();

    // Host presses Start while the action is still awaiting its durable write.
    const startP = room.receive('p1', p1, JSON.stringify({ type: 'start' }));
    await flush();
    expect(room.isStarted).toBe(false); // queued behind the held action — not run yet

    resolvePersist!();
    await Promise.all([actP, startP]);
    expect(room.isStarted).toBe(true); // ran in mailbox order, after the action committed
  });
});
