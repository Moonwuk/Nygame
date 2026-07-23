import { describe, expect, it } from 'vitest';
import { createDevMatch, loadShippedData } from './scenario';
import { startClockDriver, HEARTBEAT_MS } from './clockDriver';
import type { MatchRoom, RoomPeer } from './matchRoom';

// NETA2-6 (one scheduler): the live-player heartbeat used to live in an inline copy of
// this driver inside the prototype host; it now lives in the shared `startClockDriver`
// so BOTH hosts get it. These tests pin the arm logic — when the beat is added, when it
// idles — against a stub room (hermetic: it controls tick()/msUntilNextEvent()/the two
// gates exactly), then prove the end-to-end fix on a real dev match.

/** The minimal room surface the driver touches. A plain object lets each test control
 *  the two heartbeat gates + what tick()/msUntilNextEvent() report, deterministically. */
interface StubRoom {
  isClockRunning: boolean;
  peerCount: number;
  next: number | null; // msUntilNextEvent() returns this
  willProgress: boolean; // tick() returns this
  ticks: number;
  tick(): boolean;
  msUntilNextEvent(): number | null;
}

function stubRoom(init: Partial<StubRoom> = {}): StubRoom {
  return {
    isClockRunning: true,
    peerCount: 1,
    next: null,
    willProgress: true,
    ticks: 0,
    tick(): boolean {
      this.ticks += 1;
      return this.willProgress;
    },
    msUntilNextEvent(): number | null {
      return this.next;
    },
    ...init,
  };
}

/** A capturing scheduler: instead of arming a real timer, record the (fn, ms) the driver
 *  would have set — `armed` is null when the driver chose to idle. */
function capturingClock(): {
  armed: () => { fn: () => void; ms: number } | null;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
} {
  let armed: { fn: () => void; ms: number } | null = null;
  return {
    armed: () => armed,
    schedule: (fn, ms) => {
      armed = { fn, ms };
      return {};
    },
    cancel: () => {
      armed = null;
    },
  };
}

const asRoom = (r: StubRoom): MatchRoom => r as unknown as MatchRoom;

describe('clock driver · live-player heartbeat (NETA2-6)', () => {
  it('arms the beat for a watched, running room with an EMPTY schedule', () => {
    const clock = capturingClock();
    const room = stubRoom({ isClockRunning: true, peerCount: 1, next: null });
    startClockDriver(asRoom(room), { heartbeatMs: 1000, schedule: clock.schedule, cancel: clock.cancel });
    // Nothing scheduled, yet the driver arms — this is the whole fix: the published clock
    // keeps moving on-screen instead of freezing on "Day 1" between actions.
    expect(clock.armed()).not.toBeNull();
    expect(clock.armed()!.ms).toBe(1000);
  });

  it('does NOT beat an unwatched room (peerCount 0) — nobody to keep on-screen', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 0, next: null });
    startClockDriver(asRoom(room), { heartbeatMs: 1000, schedule: clock.schedule, cancel: clock.cancel });
    expect(clock.armed()).toBeNull(); // idle — a hibernating room advances only on its schedule
  });

  it('does NOT beat a frozen room (clock not running) even with peers waiting', () => {
    const clock = capturingClock();
    const room = stubRoom({ isClockRunning: false, peerCount: 2, next: null });
    startClockDriver(asRoom(room), { heartbeatMs: 1000, schedule: clock.schedule, cancel: clock.cancel });
    expect(clock.armed()).toBeNull(); // a pre-start lobby has no live clock to publish
  });

  it('is opt-in: WITHOUT heartbeatMs a watched running room still idles on an empty schedule', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 1, next: null });
    startClockDriver(asRoom(room), { schedule: clock.schedule, cancel: clock.cancel });
    expect(clock.armed()).toBeNull(); // pre-heartbeat behavior preserved when the beat is off
  });

  it('arms for the SOONER of the next event and the next beat', () => {
    // Event sooner than the beat → arm for the event.
    const a = capturingClock();
    startClockDriver(asRoom(stubRoom({ peerCount: 1, next: 200 })), {
      heartbeatMs: 1000,
      schedule: a.schedule,
      cancel: a.cancel,
    });
    expect(a.armed()!.ms).toBe(200);

    // Beat sooner than a far event → arm for the beat (so the clock doesn't freeze meanwhile).
    const b = capturingClock();
    startClockDriver(asRoom(stubRoom({ peerCount: 1, next: 5000 })), {
      heartbeatMs: 1000,
      schedule: b.schedule,
      cancel: b.cancel,
    });
    expect(b.armed()!.ms).toBe(1000);
  });

  it('still arms for a scheduled event on an UNWATCHED room (the beat is additive, not required)', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 0, next: 300 });
    startClockDriver(asRoom(room), { heartbeatMs: 1000, schedule: clock.schedule, cancel: clock.cancel });
    expect(clock.armed()!.ms).toBe(300); // no beat (unwatched), but the event still wakes it
  });

  it('caps a far-future wait at maxDelayMs (a long sleep taken in hops)', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 0, next: 10_000_000 });
    startClockDriver(asRoom(room), { maxDelayMs: 3_600_000, schedule: clock.schedule, cancel: clock.cancel });
    expect(clock.armed()!.ms).toBe(3_600_000);
  });

  it('re-arms the beat after each tick and reports `progressed` to onTick', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 1, next: null, willProgress: true });
    const seen: boolean[] = [];
    startClockDriver(asRoom(room), {
      heartbeatMs: 1000,
      onTick: ({ progressed }) => seen.push(progressed),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(clock.armed()!.ms).toBe(1000);
    clock.armed()!.fn(); // fire the beat
    expect(room.ticks).toBe(1);
    expect(seen).toEqual([true]);
    expect(clock.armed()!.ms).toBe(1000); // re-armed for the next beat
  });

  it('a no-op heartbeat (nothing due) never trips the stall guard', () => {
    // willProgress false + next null models a coalesced wake where the clock did not move
    // and nothing is due. That is NOT a stall (a stall is due-but-frozen), so the beat must
    // keep re-arming rather than backing off.
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 1, next: null, willProgress: false });
    let stalled = false;
    startClockDriver(asRoom(room), {
      heartbeatMs: 1000,
      onStall: () => {
        stalled = true;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    for (let i = 0; i < 5; i += 1) clock.armed()!.fn();
    expect(stalled).toBe(false);
    expect(room.ticks).toBe(5);
    expect(clock.armed()).not.toBeNull(); // still beating
  });

  it('stops beating when the last peer leaves (reschedule with peerCount 0 → idle)', () => {
    const clock = capturingClock();
    const room = stubRoom({ peerCount: 1, next: null });
    const driver = startClockDriver(asRoom(room), {
      heartbeatMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(clock.armed()!.ms).toBe(1000); // beating while watched
    room.peerCount = 0; // last peer left
    driver.reschedule(); // observe(leave) re-evaluates
    expect(clock.armed()).toBeNull(); // idles — no one to keep on-screen
  });
});

describe('clock driver · heartbeat on a real dev match (NETA2-6 end-to-end)', () => {
  const data = loadShippedData();
  const silentPeer: RoomPeer = { send: () => {} };

  it('advances a watched fresh match with NO scheduled events and no player action', () => {
    let clock = 1000;
    const room = createDevMatch(data, { now: () => clock, time: 1000, config: { timeScale: 1 } });
    room.addPeer('green', silentPeer); // peerCount → 1

    // The plain dev match runs its clock without ever being "started" — this is exactly
    // the serverWiring case the old `isStarted` gate would have wrongly frozen.
    expect(room.isClockRunning).toBe(true);
    expect(room.isStarted).toBe(false);
    expect(room.peerCount).toBe(1);
    expect(room.msUntilNextEvent()).toBeNull(); // fresh match: empty schedule

    let armed: { fn: () => void; ms: number } | null = null;
    const driver = startClockDriver(room, {
      heartbeatMs: HEARTBEAT_MS,
      schedule: (fn, ms) => {
        armed = { fn, ms };
        return {};
      },
      cancel: () => {
        armed = null;
      },
    });
    // Armed for the beat despite an empty schedule (pre-fix this was null → frozen clock).
    expect(armed).not.toBeNull();
    expect(armed!.ms).toBe(HEARTBEAT_MS);

    const before = room.state.time;
    clock = 5000; // wall time moves on
    armed!.fn(); // the beat fires → tick() advances the world
    expect(room.state.time).toBeGreaterThan(before); // clock moved with NO player action

    driver.stop();
  });
});
