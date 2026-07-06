/**
 * Political territory layer — the weighted-Voronoi (power-diagram) province map shared by
 * every render surface (the prototype's Canvas2D map and the Stage-4 client;
 * docs/cross-platform-roadmap.md CP0.2 — "one render implementation, not two"). This is
 * the CPU-heavy, purely-geometric core of the map: given the sector centres as weighted
 * seeds and a clip polygon, it tiles the plane into province cells (a bigger `w` claims
 * more land, adjacent cells share a border), fills each cell in its owner's colour, and
 * draws same-owner borders as faint inner hairlines vs owner frontiers as a bright glow.
 *
 * Stateless with respect to GAME state and fog: the caller builds the seeds (already
 * projected to screen space, owner resolved as the viewer may know it) and injects the
 * colour palette, so any renderer can call it. `computePowerCells` is pure and touches no
 * canvas (unit-testable); `drawTerritory` paints those cells into a provided 2D context.
 */
import { rgba } from './holoDraw';

/** A sector centre as a power-diagram site: screen-space centre, weight (px²), the owner
 *  as the viewer may know it (`null` = neutral), and the sector kind (for the terrain tint). */
export interface TerritorySeed {
  x: number;
  y: number;
  w: number;
  owner: string | null;
  kind: string;
}

/** A tessellated province cell: its clipped polygon, a per-edge neighbour tag (a seed
 *  index ≥ 0, or {@link BOUNDARY} for the map edge), plus the owner/kind/seed-index. */
export interface TerritoryCell {
  poly: Array<[number, number]>;
  tags: number[];
  owner: string | null;
  kind: string;
  idx: number;
}

/** Resolves the colours the political fill/borders use — injected so the palette stays a
 *  renderer concern (the prototype's owner-relative hues, a future client's own scheme). */
export interface TerritoryPalette {
  /** Fill/border colour for an owned province (hex `#rrggbb`). */
  ownerColor: (owner: string) => string;
  /** Fill colour for a neutral (unowned) province (hex `#rrggbb`). */
  neutralFill: string;
  /** Optional terrain accent tint for a sector kind (hex `#rrggbb`), or `undefined`. */
  kindAccent: (kind: string) => string | undefined;
}

/** Sentinel edge-tag: this province edge sits on the map boundary, not a neighbour. */
export const BOUNDARY = -1;

/** Clamp the spread of power-diagram (weighted-Voronoi) weights so no province cell is
 *  ever swallowed by a heavier neighbour. In a power diagram a site keeps a non-empty
 *  cell iff `w_j - w_i ≤ d_ij²` for every other site `j`; the binding case is the
 *  closest pair, so capping the total weight RANGE strictly below the minimum squared
 *  inter-seed distance keeps EVERY cell non-empty. Size ordering is preserved (a bigger
 *  world still claims a little more land) — just never enough to erase a close neighbour
 *  (which left that neighbour with no cell and no border). Mutates `w` in place; a no-op
 *  for <2 seeds or coincident points. */
export function clampPowerWeights(seeds: Array<{ x: number; y: number; w: number }>): void {
  const n = seeds.length;
  if (n < 2) return;
  let minD2 = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = seeds[i]!.x - seeds[j]!.x;
      const dy = seeds[i]!.y - seeds[j]!.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
    }
  }
  if (!Number.isFinite(minD2) || minD2 <= 0) return;
  let wmin = Infinity;
  let wmax = -Infinity;
  for (const s of seeds) {
    if (s.w < wmin) wmin = s.w;
    if (s.w > wmax) wmax = s.w;
  }
  const range = wmax - wmin;
  const cap = minD2 * 0.9; // strictly below the swallow threshold (d_ij² ≥ minD2 for all pairs)
  if (range <= cap || range <= 0) return;
  const k = cap / range;
  for (const s of seeds) s.w = wmin + (s.w - wmin) * k;
}

/** Clip a convex polygon to the half-plane a*x + b*y + c ≤ 0 (Sutherland–Hodgman).
 *  Used to carve the weighted-Voronoi (power-diagram) province cells. */
export function clipHalfPlane(
  poly: Array<[number, number]>,
  a: number,
  b: number,
  c: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % poly.length]!;
    const dc = a * cur[0] + b * cur[1] + c;
    const dn = a * nxt[0] + b * nxt[1] + c;
    if (dc <= 0) out.push(cur);
    if (dc < 0 !== dn < 0) {
      const t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

/** Like {@link clipHalfPlane}, but carries a per-edge tag so the political map can
 *  colour each border by what lies across it. `tags[k]` is what borders the edge
 *  `poly[k]→poly[k+1]`: a neighbour seed index (≥0) or {@link BOUNDARY}. The newly-cut
 *  edge (along the clip line) is tagged `clipTag` (the seed we clipped against); surviving
 *  original edges keep their tag. Lets same-owner borders draw as faint hairlines (the
 *  empire reads as one field) and owner-vs-owner borders as a bright frontier. */
export function clipHalfPlaneTagged(
  poly: Array<[number, number]>,
  tags: number[],
  a: number,
  b: number,
  c: number,
  clipTag: number,
): { poly: Array<[number, number]>; tags: number[] } {
  const out: Array<[number, number]> = [];
  const outT: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % n]!;
    const tag = tags[i]!;
    const dc = a * cur[0] + b * cur[1] + c;
    const dn = a * nxt[0] + b * nxt[1] + c;
    const cross = dc < 0 !== dn < 0;
    if (dc <= 0) {
      out.push(cur);
      if (cross) {
        const t = dc / (dc - dn);
        out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
        outT.push(tag); // cur → intersection: surviving part of the original edge
        outT.push(clipTag); // intersection → next: along the new clip line (this neighbour)
      } else {
        outT.push(tag); // wholly-inside original edge keeps its tag
      }
    } else if (cross) {
      const t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
      outT.push(tag); // intersection → nxt: re-entering part of the original edge
    }
  }
  return { poly: out, tags: outT };
}

/** Tessellate the seeds into power-diagram province cells clipped to `clip` (a convex
 *  polygon, e.g. the map-boundary rectangle). Weights are clamped internally so no cell is
 *  swallowed; the caller's seed array is NOT mutated (pure — no canvas touched). Cells with
 *  a degenerate (<3-vertex) polygon are dropped. `tags`/`idx` index into `seeds`. */
export function computePowerCells(
  seeds: TerritorySeed[],
  clip: Array<[number, number]>,
): TerritoryCell[] {
  // Work on a copy of the weights so the caller keeps its seeds (and this stays pure).
  const work = seeds.map((s) => ({ x: s.x, y: s.y, w: s.w }));
  clampPowerWeights(work);
  const cells: TerritoryCell[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const si = work[i]!;
    let poly: Array<[number, number]> = clip.map((q) => [q[0], q[1]]);
    let tags: number[] = clip.map(() => BOUNDARY);
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (i === j) continue;
      const sj = work[j]!;
      // power-diagram half-plane: keep |x-ci|² - wi ≤ |x-cj|² - wj
      const a = 2 * (sj.x - si.x);
      const b = 2 * (sj.y - si.y);
      const cc = si.x * si.x + si.y * si.y - si.w - (sj.x * sj.x + sj.y * sj.y - sj.w);
      ({ poly, tags } = clipHalfPlaneTagged(poly, tags, a, b, cc, j));
    }
    if (poly.length < 3) continue;
    cells.push({ poly, tags, owner: seeds[i]!.owner, kind: seeds[i]!.kind, idx: i });
  }
  return cells;
}

/** Paint the political territory map into `g`: filled province cells (owner colour, or a
 *  faint neutral wash) with a terrain accent, then classified borders — same-owner inner
 *  hairlines, neutral divisions, and glowing owner frontiers. Fog is the caller's concern
 *  (it bakes `owner` as last-known); this just draws what the seeds say. Owned land is
 *  painted strongly so who-holds-what reads at a glance; a captured cluster of one owner
 *  paints as ONE political field with only faint inner province divisions. */
export function drawTerritory(
  g: CanvasRenderingContext2D,
  seeds: TerritorySeed[],
  clip: Array<[number, number]>,
  palette: TerritoryPalette,
): void {
  const cells = computePowerCells(seeds, clip);
  const trace = (poly: Array<[number, number]>): void => {
    g.beginPath();
    g.moveTo(poly[0]![0], poly[0]![1]);
    for (let k = 1; k < poly.length; k++) g.lineTo(poly[k]![0], poly[k]![1]);
    g.closePath();
  };

  // Pass 1 — fill every province cell. Same owner ⇒ same colour, so a captured cluster
  // paints as one political field; a faint terrain tint reads through the owner fill.
  for (const cell of cells) {
    trace(cell.poly);
    g.fillStyle = rgba(
      cell.owner ? palette.ownerColor(cell.owner) : palette.neutralFill,
      cell.owner ? 0.58 : 0.1,
    );
    g.fill();
    const accent = palette.kindAccent(cell.kind);
    if (accent) {
      trace(cell.poly);
      g.fillStyle = rgba(accent, 0.16); // province-type tint reads through the owner fill
      g.fill();
    }
  }

  // Pass 2 — classify every cell edge by what's across it. Same-owner borders are thin
  // INNER hairlines (so an empire stays one colour field with subtle province divisions);
  // owner-vs-(other owner / neutral / void) borders are a glowing FRONTIER in the owner's
  // colour. That contrast is the "merged territory, thinly outlined provinces" look.
  type Seg = [number, number, number, number];
  const ownedFront = new Map<string, Seg[]>();
  const ownedInner = new Map<string, Seg[]>();
  const neutralEdge: Seg[] = [];
  const bucket = (m: Map<string, Seg[]>, key: string): Seg[] => {
    let arr = m.get(key);
    if (!arr) m.set(key, (arr = []));
    return arr;
  };
  for (const cell of cells) {
    const { poly, tags, owner, idx } = cell;
    const m = poly.length;
    for (let k = 0; k < m; k++) {
      const t = tags[k]!;
      const p0 = poly[k]!;
      const p1 = poly[(k + 1) % m]!;
      const seg: Seg = [p0[0], p0[1], p1[0], p1[1]];
      const neigh = t >= 0 ? seeds[t]!.owner : undefined; // undefined ⇒ map boundary
      if (t >= 0 && owner !== null && neigh === owner) {
        if (idx < t) bucket(ownedInner, palette.ownerColor(owner)).push(seg); // same empire, draw once
      } else if (owner !== null) {
        bucket(ownedFront, palette.ownerColor(owner)).push(seg); // empire frontier (each side glows)
      } else if (t === BOUNDARY || idx < t) {
        neutralEdge.push(seg); // neutral province division (faint, drawn once)
      }
    }
  }
  const strokeSegs = (segs: Seg[], style: string, width: number): void => {
    if (segs.length === 0) return;
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    for (const sg of segs) {
      g.moveTo(sg[0], sg[1]);
      g.lineTo(sg[2], sg[3]);
    }
    g.stroke();
  };
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const [col, segs] of ownedInner) strokeSegs(segs, rgba(col, 0.18), 0.65); // inner hairlines
  strokeSegs(neutralEdge, 'rgba(67,98,110,0.34)', 1); // neutral divisions
  for (const [col, segs] of ownedFront) strokeSegs(segs, rgba(col, 0.14), 5.5); // frontier glow
  for (const [col, segs] of ownedFront) strokeSegs(segs, rgba(col, 0.9), 1.6); // frontier crisp
  g.restore();
}
