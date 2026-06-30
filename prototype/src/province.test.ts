import { describe, it, expect } from 'vitest';
import { MAP, newGame, clampPowerWeights } from './game';

// The province map is a weighted Voronoi (power diagram) over the sector centres,
// weighted by planet `size` (main.ts buildStaticLayer, W = 9000 in base space). A site
// keeps a non-empty cell — i.e. its own visible province with a border — iff
// `|w_i - w_j| ≤ d_ij²` for every other site `j`. A pair that violates this means the
// heavier node SWALLOWS the lighter one: it gets no cell and no border (the reported bug).
function mapSeeds(W = 9000): Array<{ x: number; y: number; w: number }> {
  const s = newGame();
  const seeds: Array<{ x: number; y: number; w: number }> = [];
  for (const n of MAP) {
    const p = s.planets[n.id];
    if (!p) continue;
    seeds.push({ x: n.x, y: n.y, w: (p.size ?? 1) * W });
  }
  return seeds;
}

/** Worst swallow margin across all pairs: `max(|w_i - w_j| - d_ij²)`. > 0 ⇒ some cell
 *  is swallowed (zoom-independent: weight and distance² both scale with cam.scale²). */
function worstSwallow(seeds: Array<{ x: number; y: number; w: number }>): number {
  let worst = -Infinity;
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const dx = seeds[i]!.x - seeds[j]!.x;
      const dy = seeds[i]!.y - seeds[j]!.y;
      const d2 = dx * dx + dy * dy;
      const margin = Math.abs(seeds[i]!.w - seeds[j]!.w) - d2;
      if (margin > worst) worst = margin;
    }
  }
  return worst;
}

describe('province power-diagram weights — every node keeps its own cell', () => {
  it('the raw size→weight map swallows at least one province (reproduces the bug)', () => {
    expect(worstSwallow(mapSeeds())).toBeGreaterThan(0);
  });

  it('clampPowerWeights removes every swallow (each node keeps a non-empty cell)', () => {
    const seeds = mapSeeds();
    clampPowerWeights(seeds);
    expect(worstSwallow(seeds)).toBeLessThanOrEqual(0);
  });

  it('preserves size ordering on a close, lopsided pair without swallowing', () => {
    const seeds = [
      { x: 0, y: 0, w: 1 },
      { x: 30, y: 0, w: 9000 }, // close + huge disparity → would swallow seed 0
    ];
    clampPowerWeights(seeds);
    expect(seeds[1]!.w).toBeGreaterThan(seeds[0]!.w); // bigger world still claims more
    expect(seeds[1]!.w - seeds[0]!.w).toBeLessThanOrEqual(30 * 30); // ≤ d² → no swallow
  });

  it('is a no-op for fewer than two seeds', () => {
    const one = [{ x: 0, y: 0, w: 99 }];
    clampPowerWeights(one);
    expect(one[0]!.w).toBe(99);
  });
});
