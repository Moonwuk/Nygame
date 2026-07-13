import { describe, it, expect } from 'vitest';
import { MAP, START_CANDIDATES, newGame } from './game';
import { clampPowerWeights } from '../../packages/client/src/territory';

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
  it('a raw size→weight disparity can swallow a province (the bug, synthetic pair)', () => {
    // The original repro read the LIVE map, whose old asymmetric jitter packed two
    // sites close enough to swallow. The symmetric field (M4 fairness) happens to
    // keep every pair far enough apart, so the reproduction is a synthetic close,
    // lopsided pair now — the geometry the clamp exists to defuse.
    expect(
      worstSwallow([
        { x: 0, y: 0, w: 1 * 9000 },
        { x: 30, y: 0, w: 1.5 * 9000 },
      ]),
    ).toBeGreaterThan(0);
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

describe('10-seat skirmish field', () => {
  it('keeps the old per-seat density on an 11×11 board', () => {
    expect(MAP).toHaveLength(121);
    expect(START_CANDIDATES).toHaveLength(10);
    expect(new Set(START_CANDIDATES).size).toBe(10);
    expect(MAP.filter((node) => node.sector === 'planet')).toHaveLength(30);
  });

  it('is one connected province graph', () => {
    const seen = new Set<string>();
    const queue = [MAP[0]!.id];
    const byId = new Map(MAP.map((node) => [node.id, node]));
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of byId.get(id)?.links ?? []) if (!seen.has(next)) queue.push(next);
    }
    expect(seen.size).toBe(MAP.length);
  });

  it('keeps every start within 10 nearby base points over three hops', () => {
    const byId = new Map(MAP.map((node) => [node.id, node]));
    const nearbyScores = START_CANDIDATES.map((start) => {
      const distance = new Map([[start, 0]]);
      const queue = [start];
      while (queue.length) {
        const id = queue.shift()!;
        const hops = distance.get(id)!;
        if (hops === 3) continue;
        for (const next of byId.get(id)?.links ?? []) {
          if (distance.has(next)) continue;
          distance.set(next, hops + 1);
          queue.push(next);
        }
      }
      return [...distance.keys()].reduce(
        (score, id) => score + (byId.get(id)?.sector === 'planet' ? 50 : 10),
        0,
      );
    });
    expect(Math.max(...nearbyScores) - Math.min(...nearbyScores)).toBeLessThanOrEqual(10);
  });

  it('spawns ten distinct players, homeworlds and starting fleets', () => {
    const factions = ['blue', 'red', 'amber', 'violet'];
    const seats = START_CANDIDATES.map((start, i) => ({
      id: `p${i + 1}`,
      name: `Player ${i + 1}`,
      faction: factions[i % factions.length]!,
      start,
      ai: i > 0,
    }));
    const state = newGame({ seats });
    expect(Object.keys(state.players)).toHaveLength(10);
    expect(Object.keys(state.fleets)).toHaveLength(10);
    for (const seat of seats) {
      expect(state.planets[seat.start]?.owner).toBe(seat.id);
      expect(state.fleets[`${seat.id}-1`]?.location).toBe(seat.start);
    }
  });
});
