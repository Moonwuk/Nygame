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
 *
 * NETA2-6 (one scheduler): a `heartbeatMs` keeps a WATCHED, started room ticking at
 * least that often even with an empty schedule — otherwise the published clock/economy/
 * in-flight fleets freeze on-screen between actions (a fresh match starts with NO
 * scheduled events, so the first thing a joined player would see is a frozen
 * "Day 1 00:00"). This lets both hosts share ONE driver: the prototype host used to
 * carry a near-identical inline copy of this arm/fire/stall loop just to add the beat.
 */

/** Node's setTimeout caps at ~24.8 days (2^31−1 ms); a longer wait is split — we
 *  wake early, `tick()` is a safe no-op when nothing is due yet, then re-arm. */
const MAX_DELAY = 2_147_483_647;

/** The live-player heartbeat interval (NETA2-6): while a room is watched (≥1 peer) and
 *  its clock is running, tick at least this often even when the schedule is momentarily
 *  empty — otherwise the world only advances when someone issues an order, so the
 *  published clock/economy/in-flight fleets freeze on-screen between actions. A fresh
 *  match starts with NO scheduled events, so without this the first thing players see
 *  after joining is a frozen "Day 1 00:00". 1s is smooth enough for the HUD clock
 *  without flooding idle rooms; both hosts pass it as `heartbeatMs`. */
export const HEARTBEAT_MS = 1_000;

export interface ClockDriverHandle {
  /** Re-evaluate the next due event and (re)arm the timer. Call after an action may
   *  have scheduled new events (or to wake a driver idling with nothing pending). */
  reschedule(): void;
  /** Stop driving and cancel any pending wake. Idempotent. */
  stop(): void;
}

export interface ClockDriverOptions {
  /** Invoked after each `tick()` — the seam for persisting the advanced snapshot.
   *  `progressed` is whether the world clock actually moved forward this tick (false on
   *  a same-instant stall or a coalesced no-op wake); the prototype host reads it to
   *  SKIP its AI/standing-order drivers on a stalled tick — running them would emit
   *  `action` observations that reset the stall guard into a 0 ms spin. */
  onTick?: (info: { progressed: boolean }) => void;
  /** Invoked once when the driver stops because the clock stalled (a same-instant
   *  runaway: work is due but `tick()` makes no forward progress, `STALL_LIMIT`
   *  times running). The driver stops re-arming to avoid a busy-loop; ops should
   *  treat this as an alert (the room also emits an `advance_overflow` observation). */
  onStall?: () => void;
  /** Timer injection for deterministic tests. Default: global setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** NETA2-6: while the room is started AND watched (≥1 connected peer), tick at least
   *  this often even when the schedule is momentarily empty, so the published world
   *  doesn't freeze on-screen between actions. Undefined ⇒ the driver idles when nothing
   *  is pending (the pre-heartbeat behavior — right for an unwatched/hibernated room). */
  heartbeatMs?: number;
  /** Longest single timer. `setTimeout` overflows past ~24.8 days (the default,
   *  `MAX_DELAY`); a tighter cap also periodically re-syncs a long sleep against
   *  wall-clock drift (the prototype host pins 1h). */
  maxDelayMs?: number;
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
  const maxDelay = options.maxDelayMs ?? MAX_DELAY;
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
    options.onTick?.({ progressed });
    // Stall guard: a tick that made no forward progress while work is still due
    // (ms === 0) is a same-instant runaway. Count them; a legit throttled catch-up
    // always progresses and resets the counter. Past the limit, stop re-arming so
    // the server doesn't busy-loop on a broken match (the room already alerted). A
    // heartbeat wake on an empty schedule reports msUntilNextEvent() === null (nothing
    // due), so it never trips this — and if wall-time elapsed the tick progressed anyway.
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
    const ev = room.msUntilNextEvent(); // wall-ms to the next scheduled event, or null
    // Heartbeat only while the room is watched (≥1 peer) AND its clock is running: an
    // unwatched/hibernated room has nobody to freeze on-screen, and a frozen pre-start
    // lobby has no live clock — both idle on their schedule alone. (isClockRunning, not
    // isStarted: a plain dev match runs its clock without ever being "started".)
    const beat =
      options.heartbeatMs !== undefined && room.isClockRunning && room.peerCount > 0
        ? options.heartbeatMs
        : null;
    if (ev === null && beat === null) return; // nothing pending, nobody watching → idle
    // Soonest of {next event, next beat}, capped at maxDelay (a long sleep taken in hops).
    const ms = Math.min(ev ?? Infinity, beat ?? Infinity, maxDelay);
    handle = schedule(fire, Math.max(0, ms));
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
