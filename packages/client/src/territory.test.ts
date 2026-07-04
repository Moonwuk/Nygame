import { describe, it, expect } from 'vitest';
import {
  BOUNDARY,
  clipHalfPlane,
  clipHalfPlaneTagged,
  clampPowerWeights,
  computePowerCells,
  type TerritorySeed,
} from './territory';

// The unit square, CCW — the reusable clip fixture for the half-plane primitives.
const SQUARE: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

describe('territory — clipHalfPlane (Sutherland–Hodgman)', () => {
  it('clips the unit square to x ≤ 0.5 (keeps the left half)', () => {
    // a*x + b*y + c ≤ 0  →  x ≤ 0.5  with a=1, b=0, c=-0.5
    const out = clipHalfPlane(SQUARE, 1, 0, -0.5);
    expect(out).toEqual([
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ]);
  });

  it('drops the polygon entirely when the whole square is outside the half-plane', () => {
    // x ≤ -1 : every vertex has d > 0, nothing survives
    expect(clipHalfPlane(SQUARE, 1, 0, 1)).toEqual([]);
  });
});

describe('territory — clipHalfPlaneTagged (border provenance)', () => {
  it('tags the newly-cut edge with clipTag and keeps original edges as their tag', () => {
    const tags = SQUARE.map(() => BOUNDARY);
    const { poly, tags: outT } = clipHalfPlaneTagged(SQUARE, tags, 1, 0, -0.5, 7);
    expect(poly).toEqual([
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ]);
    // Only the cut edge (0.5,0)→(0.5,1) — poly[1]→poly[2] — belongs to neighbour 7;
    // the surviving original edges stay on the map boundary.
    expect(outT).toEqual([BOUNDARY, 7, BOUNDARY, BOUNDARY]);
  });
});

describe('territory — clampPowerWeights', () => {
  it('is a no-op for fewer than two seeds', () => {
    const one = [{ x: 0, y: 0, w: 99 }];
    clampPowerWeights(one);
    expect(one[0]!.w).toBe(99);
  });

  it('caps a close, lopsided pair below the swallow threshold while keeping order', () => {
    const seeds = [
      { x: 0, y: 0, w: 1 },
      { x: 30, y: 0, w: 9000 }, // close + huge disparity → would swallow seed 0
    ];
    clampPowerWeights(seeds);
    expect(seeds[1]!.w).toBeGreaterThan(seeds[0]!.w); // bigger world still claims more
    expect(seeds[1]!.w - seeds[0]!.w).toBeLessThanOrEqual(30 * 30); // ≤ d² → no swallow
  });
});

describe('territory — computePowerCells', () => {
  const clip: Array<[number, number]> = [
    [-100, -100],
    [100, -100],
    [100, 100],
    [-100, 100],
  ];

  it('splits two equal-weight seeds at the perpendicular bisector', () => {
    const seeds: TerritorySeed[] = [
      { x: 0, y: 0, w: 500, owner: 'p1', kind: 'planet' },
      { x: 10, y: 0, w: 500, owner: 'p2', kind: 'planet' },
    ];
    const cells = computePowerCells(seeds, clip);
    expect(cells).toHaveLength(2);
    const left = cells.find((c) => c.idx === 0)!;
    const right = cells.find((c) => c.idx === 1)!;
    // Equal weights ⇒ the border is the bisector at x = 5.
    for (const [x] of left.poly) expect(x).toBeLessThanOrEqual(5 + 1e-9);
    for (const [x] of right.poly) expect(x).toBeGreaterThanOrEqual(5 - 1e-9);
    // The shared edge of the left cell is tagged with its neighbour (seed 1).
    expect(left.tags).toContain(1);
    expect(left.owner).toBe('p1');
    expect(right.owner).toBe('p2');
  });

  it('keeps every seed a non-empty cell even with a heavy, close neighbour (no swallow)', () => {
    const seeds: TerritorySeed[] = [
      { x: 0, y: 0, w: 1, owner: 'p1', kind: 'planet' },
      { x: 12, y: 0, w: 9000, owner: 'p2', kind: 'nebula' }, // would swallow seed 0 unclamped
      { x: 0, y: 12, w: 4000, owner: null, kind: 'asteroid' },
    ];
    const cells = computePowerCells(seeds, clip);
    expect(cells).toHaveLength(3); // clamp keeps all three cells non-degenerate
    for (const c of cells) expect(c.poly.length).toBeGreaterThanOrEqual(3);
  });

  it('does not mutate the caller’s seed weights (pure)', () => {
    const seeds: TerritorySeed[] = [
      { x: 0, y: 0, w: 1, owner: 'p1', kind: 'planet' },
      { x: 12, y: 0, w: 9000, owner: 'p2', kind: 'planet' },
    ];
    computePowerCells(seeds, clip);
    expect(seeds[0]!.w).toBe(1);
    expect(seeds[1]!.w).toBe(9000);
  });
});
