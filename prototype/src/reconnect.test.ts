import { describe, expect, it } from 'vitest';
import {
  reconnectDelayMs,
  REAP_WINDOW_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_STEP_CAP_MS,
} from './reconnect';

describe('auto-reconnect backoff budget (NETA2-2)', () => {
  it('is capped exponential backoff, then gives up past the max', () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
    expect(reconnectDelayMs(5)).toBe(RECONNECT_STEP_CAP_MS); // flat at the cap from here
    expect(reconnectDelayMs(RECONNECT_MAX_ATTEMPTS)).toBe(RECONNECT_STEP_CAP_MS);
    expect(reconnectDelayMs(RECONNECT_MAX_ATTEMPTS + 1)).toBeNull(); // budget spent → give up
    expect(reconnectDelayMs(0)).toBeNull(); // out of range
    expect(reconnectDelayMs(1.5)).toBeNull(); // non-integer
  });

  it('keeps retrying PAST the server socket-reap window (the bug: it used to give up ON it)', () => {
    // Cumulative wall-time at which each attempt DIALS, relative to the drop.
    const fireTimes: number[] = [];
    let total = 0;
    for (let a = 1; a <= RECONNECT_MAX_ATTEMPTS; a += 1) {
      total += reconnectDelayMs(a)!;
      fireTimes.push(total);
    }
    // The whole point: after the seat frees (~REAP_WINDOW_MS) there must still be attempts
    // left to claim it — with margin, not a boundary coin-flip like the old 6-attempt budget
    // whose only post-reap attempt landed at ~31s, right on the ~30s window.
    const postReap = fireTimes.filter((t) => t > REAP_WINDOW_MS);
    expect(postReap.length).toBeGreaterThanOrEqual(2);
    // …and the whole budget clears the window comfortably.
    expect(total).toBeGreaterThan(REAP_WINDOW_MS + 10_000);
  });
});
