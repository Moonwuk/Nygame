/**
 * SV-2.5 — the match factory. Keeps a target number of OPEN (ongoing, not-yet-full)
 * matches available at all times, so the match feed is never empty and a player can
 * always drop into a fresh game: when one fills up or ends, the keeper seeds another.
 *
 * Restart-safe by design — the count of open matches is read from the durable store
 * (`ongoingMatchIds` + seat occupancy), NOT an in-process counter, so a restart resumes
 * against the real world instead of over-creating. It never throws: a failed seed is
 * reported and retried on the next tick, and overlapping ticks are guarded so a slow
 * store can't double-create.
 */

export interface MatchKeeperOptions {
  /** How many OPEN matches (ongoing with ≥1 free seat) to keep available. */
  target: number;
  /** Hard cap on CONCURRENT ongoing matches — the keeper never pushes past it, so a
   *  full feed plus churn can't grow the process without bound. */
  max: number;
  /** Seats per match: a match with this many occupied seats is FULL (no longer open). */
  capacity: number;
  /** Every currently-ongoing match id (from the store — durable, not just live rooms). */
  listOngoing: () => Promise<string[]>;
  /** Occupied seat count for a match (0 for a fresh one). */
  occupiedSeats: (matchId: string) => Promise<number>;
  /** Seed + persist one fresh match. */
  create: () => Promise<void>;
  /** Sink for a create failure — the keeper contains it and retries next tick. */
  onError?: (err: unknown) => void;
  /** Timer injection for deterministic tests (defaults to global setInterval/clear). */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class MatchKeeper {
  private handle: unknown = null;
  private ticking = false;

  constructor(private readonly o: MatchKeeperOptions) {}

  /** How many matches to seed given the current open/total counts — the pure decision,
   *  split out so it is trivially testable. Clamped ≥0, and never past the `max` cap. */
  private need(open: number, totalOngoing: number): number {
    const toTarget = this.o.target - open;
    const toCap = this.o.max - totalOngoing;
    return Math.max(0, Math.min(toTarget, toCap));
  }

  /** One reconciliation pass: seed enough fresh matches to reach `target` open, bounded
   *  by `max` concurrent. Returns how many it created. Never throws; reentrancy-guarded. */
  async tick(): Promise<number> {
    if (this.ticking) return 0; // a prior tick is still running — skip, don't stack
    this.ticking = true;
    try {
      const ids = await this.o.listOngoing();
      let open = 0;
      for (const id of ids) {
        if ((await this.o.occupiedSeats(id)) < this.o.capacity) open += 1;
      }
      const need = this.need(open, ids.length);
      let made = 0;
      for (let i = 0; i < need; i += 1) {
        try {
          await this.o.create();
          made += 1;
        } catch (err) {
          this.o.onError?.(err); // e.g. the hard MAX_MATCHES backstop tripped
          break; // stop this burst; the next tick retries from a fresh count
        }
      }
      return made;
    } catch (err) {
      this.o.onError?.(err); // a store read failed — swallow, retry next tick
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** Start reconciling now and every `intervalMs`. The timer is unref'd so it never keeps
   *  the process alive on its own. Idempotent-ish: call `stop()` before re-starting. */
  start(intervalMs: number): void {
    const schedule = this.o.schedule ?? ((fn, ms): unknown => setInterval(fn, ms));
    const handle = schedule(() => void this.tick(), intervalMs);
    (handle as { unref?: () => void })?.unref?.();
    this.handle = handle;
    void this.tick(); // seed immediately, don't wait a full interval for an empty feed
  }

  stop(): void {
    if (this.handle === null) return;
    const cancel = this.o.cancel ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));
    cancel(this.handle);
    this.handle = null;
  }
}
