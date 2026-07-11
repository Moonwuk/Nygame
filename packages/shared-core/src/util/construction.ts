/**
 * Construction-progress math shared by the `construction` and `economy` modules
 * (modules never import each other — this neutral util layer is how they agree on
 * the same numbers without coupling). Pure, no state.
 */

/** Fraction (0..1) of a build/upgrade/unit order already elapsed, given the wall
 *  the kernel scheduled its `construction.complete` at and the order's total game-ms
 *  duration. Clamped — a stale/zero-duration order reads as fully done. */
export function buildProgress(now: number, completesAt: number, totalDurationMs: number): number {
  if (totalDurationMs <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - (completesAt - now) / totalDurationMs));
}

/** The 50%-threshold ramp (GDD: a building starts contributing at the halfway mark,
 *  1:1 with progress from there to completion — nothing before it). An INSTANTANEOUS
 *  reading (e.g. for a client "producing at X%" display) — `economy.ts`'s actual
 *  resource accrual integrates this over a span rather than sampling one instant, so a
 *  span that jumps straight past the threshold (a long-offline catch-up, a backgrounded
 *  tab at high speed) still credits exactly the right amount. */
export function thresholdRamp(progress: number): number {
  return progress < 0.5 ? 0 : progress;
}
