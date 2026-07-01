import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createKernel,
  parseGameData,
  type GameData,
  type GameModule,
  type GameState,
} from '@void/shared-core';
import { MatchRoom, type RoomObservation } from './matchRoom';
import { startClockDriver } from './clockDriver';

// Fault-tolerance for the advance-overflow guard (docs/infra-sizing-roadmap.md, blocker
// #3). The kernel now yields a bounded PARTIAL advance instead of discarding progress
// and wedging the room; the room catches up in chunks and detects a same-instant
// runaway (clock stalls) rather than looping forever.

// Reschedules itself at the SAME instant → the clock never progresses (a runaway bug).
const runawayModule: GameModule = {
  id: 'runaway',
  version: '1.0.0',
  setup(api) {
    api.on('inf', (_e, h) => h.schedule(h.state.time, 'inf'));
  },
};

// Reschedules 1ms later → a long but time-ADVANCING chain (a legit huge backlog).
const recurringModule: GameModule = {
  id: 'recurring',
  version: '1.0.0',
  setup(api) {
    api.on('r', (_e, h) => h.schedule(h.state.time + 1, 'r'));
  },
};

function testData(): GameData {
  return parseGameData({
    version: 'test',
    resources: ['credits'],
    units: {},
    factions: {},
    buildings: {},
    events: {},
  });
}

function stateWith(type: string, at: number): GameState {
  const base = createInitialState({ seed: 'ovf', version: { data: 'test', manifest: 'test' } });
  return { ...base, scheduled: [{ id: 'evt:0', at, type, payload: null, seq: 0 }], scheduleSeq: 1 };
}

describe('MatchRoom · advance overflow', () => {
  it('does not wedge on a same-instant runaway — surfaces a stall, stays responsive', () => {
    const obs: RoomObservation[] = [];
    const room = new MatchRoom({
      id: 'ovf',
      initialState: stateWith('inf', 1),
      kernel: createKernel([runawayModule]),
      data: testData(),
      now: () => 100_000,
      observe: (e) => obs.push(e),
    });

    // First tick accrues 0→1 (reaching the runaway instant), then can't move past it.
    room.tick();
    expect(room.state.time).toBe(1); // reached the instant, not wedged at 0 or hung
    expect(obs.find((e) => e.kind === 'advance_overflow')).toMatchObject({
      kind: 'advance_overflow',
      reason: 'stalled',
      reachedTime: 1,
      targetTime: 100_000,
    });
    // Parked at the stall instant → further ticks make no progress but never wedge/hang.
    expect(room.tick()).toBe(false);
    expect(room.tick()).toBe(false);
  });

  it('catches up a legit overflowing backlog and keeps progressing (no false stall)', () => {
    const obs: RoomObservation[] = [];
    const room = new MatchRoom({
      id: 'ovf',
      initialState: stateWith('r', 1),
      kernel: createKernel([recurringModule]),
      data: testData(),
      now: () => 55_000, // > one kernel work-bound → forces a partial, caught up in-chunk
      observe: (e) => obs.push(e),
    });

    const progressed = room.tick();
    expect(progressed).toBe(true);
    expect(room.state.time).toBe(55_000); // fully caught up, no work lost
    expect(obs.some((e) => e.kind === 'advance_overflow' && e.reason === 'stalled')).toBe(false);
  });
});

describe('clock driver · stall backoff', () => {
  it('backs off and alerts on a stalled runaway instead of busy-looping', () => {
    const room = new MatchRoom({
      id: 'ovf',
      initialState: stateWith('inf', 1),
      kernel: createKernel([runawayModule]),
      data: testData(),
      now: () => 100_000,
    });

    let stallAlerts = 0;
    let captured: (() => void) | null = null;
    const driver = startClockDriver(room, {
      onStall: () => {
        stallAlerts += 1;
      },
      schedule: (fn) => {
        captured = fn;
        return 1;
      },
      cancel: () => {
        captured = null;
      },
    });

    // Drive the injected timer until it stops re-arming (goes idle). Each fire ticks
    // the runaway (no progress); after STALL_LIMIT the driver alerts and idles.
    let guard = 0;
    while (captured && guard++ < 20) {
      const fn: () => void = captured;
      captured = null;
      fn();
    }

    expect(stallAlerts).toBe(1); // alerted exactly once
    expect(captured).toBeNull(); // went idle — no re-arm, no busy-loop
    driver.stop();
  });
});
