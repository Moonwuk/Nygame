import { describe, expect, it } from 'vitest';
import type { Action } from '@void/shared-core';
import { createDevMatch, loadShippedData } from './scenario';
import { startClockDriver, type ClockDriverHandle } from './clockDriver';
import type { RoomPeer } from './matchRoom';

// Regression (review §3): on the committed path, a player action that schedules a future
// event must leave the clock driver ARMED for it. The bug was that the `action` observation
// (which triggers driver.reschedule) fired while `committing` was still true — and
// msUntilNextEvent reports null while committing — so the driver ended up un-armed and the
// 24/7 world stalled for connected players until their next action. The fix emits the
// observation only after `committing` clears.

const data = loadShippedData();
const silentPeer: RoomPeer = { send: () => {} };

function move(fleetId: string, to: string): Action {
  return { id: 'a1', type: 'fleet.move', playerId: 'green', payload: { fleetId, to }, issuedAt: 0 };
}

describe('clock driver · re-arm after a committed action (review §3)', () => {
  it('arms a timer for an event a committed action schedules', async () => {
    let armed: { ms: number } | null = null;
    const schedule = (_fn: () => void, ms: number): unknown => {
      armed = { ms };
      return {};
    };
    const cancel = (): void => {
      armed = null;
    };

    let driver: ClockDriverHandle | null = null;
    const room = createDevMatch(data, {
      now: () => 1000,
      time: 1000,
      persist: () => Promise.resolve(), // committed path
      observe: (e) => {
        if (e.kind === 'action') driver?.reschedule();
      },
    });
    driver = startClockDriver(room, { schedule, cancel });

    // Fresh dev match has nothing scheduled → the initial arm leaves no timer.
    expect(armed).toBeNull();

    // A committed fleet.move schedules a future arrival.
    await room.receive('green', silentPeer, JSON.stringify({ type: 'action', action: move('green_1', 'nexus') }));

    // The driver must now be armed for that arrival (this was null before the fix).
    expect(armed).not.toBeNull();
    expect(armed!.ms).toBeGreaterThan(0);

    driver?.stop();
  });
});
