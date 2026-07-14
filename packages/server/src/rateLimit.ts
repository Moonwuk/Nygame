/**
 * The two rate-limiter shapes every server surface shares — ONE copy of the
 * semantics (which clock, when an attempt is recorded), where previously each
 * HTTP API and each room path hand-rolled its own and the clocks drifted
 * (the ping limiter once ran on the frozen lobby clock).
 */

/** Bounded per-IP sliding-window limiter for the HTTP APIs (auth / match /
 *  corp / ava). One budget per IP per window; the tracker map is bounded —
 *  when it overflows, the oldest window is evicted first (FIFO by freshest
 *  insert), so a spray of spoofed IPs can't grow memory without bound. The
 *  check RECORDS the attempt: rejected calls also consume budget. */
export function slidingWindowIpLimiter(opts: {
  now: () => number;
  max: number;
  windowMs: number;
  maxIps?: number;
}): (ip: string) => boolean {
  const maxIps = opts.maxIps ?? 10_000;
  const attempts = new Map<string, { n: number; since: number }>();
  return (ip: string): boolean => {
    const t = opts.now();
    const c = attempts.get(ip);
    if (!c || t - c.since >= opts.windowMs) {
      attempts.delete(ip); // re-insert → freshest position in the FIFO order
      attempts.set(ip, { n: 1, since: t });
      if (attempts.size > maxIps) {
        const oldest = attempts.keys().next().value;
        if (oldest !== undefined) attempts.delete(oldest);
      }
      return false;
    }
    c.n += 1;
    return c.n > opts.max;
  };
}

/** Per-key (player) sliding window for in-room budgets (actions / pings / chat).
 *  Callers pass the clock reading explicitly — in a room that must be the WALL
 *  clock, never the freezable match clock. `limited` only checks (and prunes);
 *  `record` is a separate call so a path can validate the payload first and
 *  spend budget only on accepted work. */
export class PerKeyWindow<K = string> {
  private readonly times = new Map<K, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Prunes the key's window at `now`; true when the budget is exhausted. */
  limited(key: K, now: number): boolean {
    const recent = (this.times.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.times.set(key, recent);
    return recent.length >= this.max;
  }

  /** Spends one unit of the key's budget at `now`. */
  record(key: K, now: number): void {
    const arr = this.times.get(key);
    if (arr) {
      arr.push(now);
    } else {
      this.times.set(key, [now]);
    }
  }
}
