import { describe, expect, it } from 'vitest';
import type { Action } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { MemoryMatchStore, MemoryReceiptStore } from './store';
import { snapshotOf } from './persistence';
import { startClockDriver } from './clockDriver';
import { createMatchLoader } from './serverWiring';
import type { RoomPeer } from './matchRoom';

// F8 (docs/infra-sizing-roadmap.md): the dev harness now persists after every commit
// and resumes on restart, and a clock driver advances the world with no player action.
// These tests exercise both durable behaviours deterministically (no real timers, no DB).
// The persist calls here mirror exactly what main.ts's `observe`/`onTick` wiring does.

const data = loadShippedData();
const MATCH = 'dev';

function orbit(playerId: string, fleetId: string, to: 'near' | 'far', n: number): Action {
  return { id: `t:${playerId}:${n}`, type: 'fleet.orbit', playerId, payload: { fleetId, orbit: to }, issuedAt: 0 };
}
function move(playerId: string, fleetId: string, to: string, n: number): Action {
  return { id: `t:${playerId}:${n}`, type: 'fleet.move', playerId, payload: { fleetId, to }, issuedAt: 0 };
}

describe('F8 · persistence + resume', () => {
  it('persists a match and resumes it after a restart, with idempotent replay', async () => {
    const store = new MemoryMatchStore();
    const receiptStore = new MemoryReceiptStore();

    // --- room A: play an action, persist snapshot + receipt (as main.ts's observe does) ---
    const roomA = createDevMatch(data, { now: () => 1000, time: 1000 });
    await store.save(snapshotOf(roomA));

    const act = orbit('green', 'green_1', 'near', 1);
    const res = roomA.submitAction('green', act);
    expect(res.ok).toBe(true);
    expect(roomA.state.fleets.green_1?.orbit).toBe('near');
    await receiptStore.save(MATCH, { actionId: act.id, playerId: 'green', seq: res.seq, ok: res.ok });
    await store.save(snapshotOf(roomA));

    const snap = await store.load(MATCH);
    expect(snap?.state.fleets.green_1?.orbit).toBe('near');
    expect(snap?.seq).toBe(roomA.sequence);

    // --- room B: the "restarted" process resumes from the store ---
    const resumed = await store.load(MATCH);
    const roomB = createDevMatch(data, {
      now: () => 2000,
      time: 2000,
      initialState: resumed!.state,
      initialReceipts: await receiptStore.loadAll(MATCH),
      initialSeq: resumed!.seq,
    });
    expect(roomB.state.fleets.green_1?.orbit).toBe('near'); // state survived
    expect(roomB.sequence).toBe(resumed!.seq); // counter restored

    // a retry of the pre-restart action is deduped: same ok, no seq bump
    const seqBefore = roomB.sequence;
    expect(roomB.submitAction('green', act).ok).toBe(true);
    expect(roomB.sequence).toBe(seqBefore);
  });

  it('restores seq so post-restart saves are not dropped by the optimistic store', async () => {
    const store = new MemoryMatchStore();

    const roomA = createDevMatch(data, { now: () => 1000, time: 1000 });
    await store.save(snapshotOf(roomA));
    for (let i = 1; i <= 3; i++) {
      roomA.submitAction('green', orbit('green', 'green_1', i % 2 ? 'near' : 'far', i));
      await store.save(snapshotOf(roomA));
    }
    const stored = await store.load(MATCH);
    expect(stored!.seq).toBeGreaterThanOrEqual(3);

    // Resume WITH initialSeq; a fresh action's save must land (not be dropped as "not newer").
    const roomB = createDevMatch(data, {
      now: () => 2000,
      time: 2000,
      initialState: stored!.state,
      initialSeq: stored!.seq,
    });
    const before = stored!.seq;
    expect(roomB.submitAction('green', orbit('green', 'green_1', 'near', 9)).ok).toBe(true);
    await store.save(snapshotOf(roomB));
    const after = await store.load(MATCH);
    expect(after!.seq).toBe(before + 1); // the post-restart save was kept
    expect(roomB.sequence).toBe(before + 1);
  });

  it('would drop a post-restart save WITHOUT the seq restore (guards the fix)', async () => {
    const store = new MemoryMatchStore();
    const roomA = createDevMatch(data, { now: () => 1000, time: 1000 });
    for (let i = 1; i <= 3; i++) {
      roomA.submitAction('green', orbit('green', 'green_1', i % 2 ? 'near' : 'far', i));
      await store.save(snapshotOf(roomA));
    }
    const stored = await store.load(MATCH);

    // Resume WITHOUT initialSeq → seq restarts at 0; the optimistic store drops the save.
    const roomB = createDevMatch(data, { now: () => 2000, time: 2000, initialState: stored!.state });
    roomB.submitAction('green', orbit('green', 'green_1', 'near', 9));
    await store.save(snapshotOf(roomB));
    const after = await store.load(MATCH);
    expect(after!.seq).toBe(stored!.seq); // unchanged — the low-seq save was rejected
  });
});

describe('F8 · clock driver', () => {
  it('advances the world (fires a due event) with no player action', () => {
    let clock = 1000;
    const room = createDevMatch(data, { now: () => clock, time: 1000 });

    // Schedule an arrival: green_1 flies home_green → nexus (a linked node).
    expect(room.submitAction('green', move('green', 'green_1', 'nexus', 1)).ok).toBe(true);
    expect(room.msUntilNextEvent()).toBeGreaterThan(0);

    // Inject a scheduler that captures (fn, ms) instead of arming a real timer.
    let captured: { fn: () => void; ms: number } | null = null;
    let ticks = 0;
    const driver = startClockDriver(room, {
      onTick: () => {
        ticks += 1;
      },
      schedule: (fn, ms) => {
        captured = { fn, ms };
        return 1;
      },
      cancel: () => {
        captured = null;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.ms).toBe(room.msUntilNextEvent());

    // Jump the wall clock past the arrival and fire the wake → tick() advances.
    clock = 1000 + captured!.ms + 1;
    captured!.fn();

    expect(ticks).toBeGreaterThan(0);
    expect(room.state.fleets.green_1?.location).toBe('nexus'); // arrived, no player action
    driver.stop();
  });

  it('idles when nothing is scheduled and re-arms on reschedule()', () => {
    const clock = 1000;
    const room = createDevMatch(data, { now: () => clock, time: 1000 });
    let scheduled = 0;
    const driver = startClockDriver(room, {
      schedule: () => {
        scheduled += 1;
        return 1;
      },
      cancel: () => {},
    });
    expect(scheduled).toBe(0); // seed has no pending events → driver idles

    room.submitAction('green', move('green', 'green_1', 'nexus', 1));
    driver.reschedule(); // main.ts calls this off the observe stream
    expect(scheduled).toBe(1); // now armed for the arrival
    driver.stop();
  });
});

describe('F8 · the real loader wiring (serverWiring.createMatchLoader)', () => {
  const silentPeer: RoomPeer = { send: () => {}, close: () => {} };
  const raw = (action: Action): string => JSON.stringify({ type: 'action', action });

  it('loads a stored match, persists each committed action, and resumes after dispose', async () => {
    const store = new MemoryMatchStore();
    const receiptStore = new MemoryReceiptStore();
    // Seed the store the way main.ts's boot does.
    const seed = createDevMatch(data, { now: () => 1000, time: 1000 });
    await store.save(snapshotOf(seed));

    const load = createMatchLoader({ stores: { store, receiptStore }, data, now: () => 1000 });
    expect(await load('nope')).toBeNull(); // unknown id → no match, never a crash

    const loaded = (await load(MATCH))!;
    expect(loaded).not.toBeNull();
    // The committed path: this room persists BEFORE committing — the exact wiring
    // main.ts hands the registry, no mirroring.
    const act = orbit('green', 'green_1', 'near', 1);
    await loaded.room.receive('green', silentPeer, raw(act));
    const snap = await store.load(MATCH);
    expect(snap?.state.fleets.green_1?.orbit).toBe('near'); // snapshot landed
    expect((await receiptStore.loadAll(MATCH)).some((r) => r.actionId === act.id)).toBe(true);

    // Hibernate: dispose persists the final state and stops the driver.
    await loaded.dispose();

    // A "restarted" loader resumes the same match — with the receipt replayed.
    const resumed = (await load(MATCH))!;
    expect(resumed.room.state.fleets.green_1?.orbit).toBe('near');
    const seqBefore = resumed.room.sequence;
    await resumed.room.receive('green', silentPeer, raw(act)); // idempotent retry
    expect(resumed.room.sequence).toBe(seqBefore); // deduped by the restored receipt
    await resumed.dispose();
  });
});
