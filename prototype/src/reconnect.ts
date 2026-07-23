/**
 * Auto-reconnect backoff schedule (NETA2-2). On an UNGRACEFUL drop the server keeps the
 * seat until its heartbeat REAPS the dead socket: `wsServer` pings every 15s and reaps a
 * socket that missed the previous round, so the old connection lingers up to ~2×15s ≈ 30s
 * (`REAP_WINDOW_MS`). Until it is reaped, a reconnect to the SAME seat is refused
 * `E_SLOT_TAKEN` (one live peer per seat). So the client's reconnect BUDGET — the total
 * time it keeps retrying — must comfortably EXCEED that window, or it gives up right as the
 * seat frees. The old 6-attempt / ~31s budget sat exactly on the ~30s window and often lost
 * the race; this schedule keeps several attempts firing AFTER the reap closes.
 *
 * Extracted from `main.ts`'s inline `scheduleReconnect` so the budget↔reap relationship is
 * a pure function the test can pin (the prototype's hand-rolled reconnect is otherwise
 * unreachable from a unit test).
 */

/** Server socket-reap window this budget must outlast: ~2 × `wsServer` HEARTBEAT_MS (15s).
 *  The prototype has no runtime dependency on the server, so the value is mirrored here and
 *  pinned by the test — if the server's reap ever changes, that test is where they reconcile. */
export const REAP_WINDOW_MS = 30_000;

/** Longest single backoff step (the exponential ramp flattens here). */
export const RECONNECT_STEP_CAP_MS = 8_000;

/** Attempts before giving up. Chosen so the cumulative budget clears `REAP_WINDOW_MS` with
 *  margin — several attempts still fire after the seat frees (proved in reconnect.test.ts). */
export const RECONNECT_MAX_ATTEMPTS = 8;

/** Delay in ms BEFORE the given 1-based `attempt`, or `null` once the budget is spent (the
 *  caller stops retrying and surfaces «войди заново»). Capped exponential: 1,2,4,8,8,… s. */
export function reconnectDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RECONNECT_MAX_ATTEMPTS) return null;
  return Math.min(1_000 * 2 ** (attempt - 1), RECONNECT_STEP_CAP_MS);
}
