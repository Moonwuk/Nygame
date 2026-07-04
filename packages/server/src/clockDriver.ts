import type { MatchRoom } from './matchRoom';

/**
 * The offline heartbeat (F8): wakes a room at `msUntilNextEvent()` and calls
 * `tick()`, so scheduled events (fleet arrivals, battle rounds, captures) fire with
 * NO player action — the 24/7 world keeps running while everyone is away. Without
 * this the dev harness only advances when a player acts, and an action after a long
 * gap dumps the whole span at once (see `docs/infra-sizing-roadmap.md`, blocker #2).
 *
 * The driver is edge-triggered: it arms a single timer for the soonest due event and
 * re-arms after each tick. New events scheduled by a player action aren't visible to
 * a sleeping timer, so the action path must call `reschedule()` (main.ts wires this
 * off the `observe` stream).
 */

/** Node's setTimeout caps at ~24.8 days (2^31−1 ms); a longer wait is split — we
 *  wake early, `tick()` is a safe no-op when nothing is due yet, then re-arm. */
const MAX_DELAY = 2_147_483_647;

export interface ClockDriverHandle {
  /** Re-evaluate the next due event and (re)arm the timer. Call after an action may
   *  have scheduled new events (or to wake a driver idling with nothing pending). */
  reschedule(): void;
  /** Stop driving and cancel any pending wake. Idempotent. */
  stop(): void;
}

export interface ClockDriverOptions {
  /** Invoked after each `tick()` — the seam for persisting the advanced snapshot. */
  onTick?: () => void;
  /** Invoked once when the driver stops because the clock stalled (a same-instant
   *  runaway: work is due but `tick()` makes no forward progress, `STALL_LIMIT`
   *  times running). The driver stops re-arming to avoid a busy-loop; ops should
   *  treat this as an alert (the room also emits an `advance_overflow` observation). */
  onStall?: () => void;
  /** Timer injection for deterministic tests. Default: global setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Consecutive due-but-non-progressing ticks that trip the stall guard. Small: a
 *  runaway wastes at most this many bounded catch-up chunks before the driver stops. */
const STALL_LIMIT = 3;

export function startClockDriver(
  room: MatchRoom,
  options: ClockDriverOptions = {},
): ClockDriverHandle {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let stopped = false;
  let stalls = 0; // consecutive due-but-non-progressing ticks

  const clear = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };

  const fire = (): void => {
    handle = null;
    const progressed = room.tick(); // fires everything due up to `now`, broadcasts
    options.onTick?.();
    // Stall guard: a tick that made no forward progress while work is still due
    // (ms === 0) is a same-instant runaway. Count them; a legit throttled catch-up
    // always progresses and resets the counter. Past the limit, stop re-arming so
    // the server doesn't busy-loop on a broken match (the room already alerted).
    if (!progressed && room.msUntilNextEvent() === 0) {
      if (++stalls >= STALL_LIMIT) {
        // Go idle (do not re-arm) rather than busy-loop. Not a hard stop: a later
        // reschedule() — e.g. a new player action — resets the counter and retries.
        options.onStall?.();
        return;
      }
    } else {
      stalls = 0;
    }
    arm(); // re-arm for the next scheduled event
  };

  function arm(): void {
    clear();
    if (stopped) return;
    const ms = room.msUntilNextEvent();
    if (ms === null) return; // nothing pending — idle until reschedule()
    handle = schedule(fire, Math.min(Math.max(0, ms), MAX_DELAY));
  }

  arm();
  return {
    reschedule: (): void => {
      stalls = 0; // a new action may have changed the situation — give it a fresh chance
      arm();
    },
    stop: (): void => {
      stopped = true;
      clear();
    },
  };
}
