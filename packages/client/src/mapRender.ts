/**
 * Canvas2D map renderer — the consumer camera.ts was built for (CP0.2b), enriched to the
 * game's holographic look with the SHARED render kit (drawTerritory / blitSphere / blitGlow
 * from @void/client — one render implementation, not two). A side-effecting draw pass whose
 * geometry all flows through the pure camera helpers, so both surfaces can share one map.
 *
 * Reads a `GameState` (positions + lane graph live inside `state.planets`; ownership/fleets
 * in the live state) and paints, in z-order: the political territory fill (weighted Voronoi),
 * star lanes, holographic planet spheres coloured by owner with a floating type badge, and
 * fleets at their interpolated positions. Node sizes stay constant in screen px.
 */
import type { GameState, PlayerId, Fleet } from '@void/shared-core';
import { worldToScreen, inView, type Cam, type Viewport, type Bounds } from './camera';
import { blitGlow, blitSphere, rgba } from './holoDraw';
import { drawTerritory, type TerritorySeed } from './territory';
import { theme } from './theme';

/** Seat colours in join order (cyan / red / amber / violet — the prototype's palette). */
const OWNER_COLORS = ['#35d6e6', '#ff5a4d', '#ffb43a', '#b07cff'] as const;
/** Neutral (unowned) sector colour. */
const NEUTRAL = '#6f8a93';
/** Sector-kind glyphs (a floating "what kind of place" badge over each node). */
const KIND_ICON: Record<string, string> = {
  planet: '◉',
  dead_world: '⊗',
  asteroid: '⬡',
  nebula: '≋',
  dense_nebula: '❋',
  graveyard: '⊘',
  ion_storm: '⌁',
  solar_flare: '✸',
};
/** Sector-kind accent tints (the faint terrain wash under the owner fill). */
const KIND_COLOR: Record<string, string> = {
  planet: '#5fd0ff',
  dead_world: '#9fb0a8',
  asteroid: '#d6a645',
  nebula: '#8f6dff',
  dense_nebula: '#a78bff',
  graveyard: '#5a4a4a',
  ion_storm: '#6fe3ff',
  solar_flare: '#ff9f3a',
};

export interface MapRenderOpts {
  /** World time (ms) for interpolating fleets in transit. */
  now: number;
  /** Device-pixel-ratio the canvas transform was set to — the holo sprites bake at it. */
  dpr: number;
  /** Planet id to ring as the current selection (a fleet's home), if any. */
  selected?: string | null;
}

/** Map each player id → a stable seat colour by join order. */
export function ownerColors(state: GameState): Map<PlayerId, string> {
  const m = new Map<PlayerId, string>();
  let i = 0;
  for (const id of Object.keys(state.players)) {
    m.set(id, OWNER_COLORS[i % OWNER_COLORS.length] ?? theme.cyan);
    i += 1;
  }
  return m;
}

/** Compute a fleet's map-space point: at a node, interpolated along its transit leg, or
 *  parked on a lane. Returns null if its anchor planets are missing. */
function fleetPoint(state: GameState, f: Fleet, now: number): { x: number; y: number } | null {
  if (f.location) return state.planets[f.location]?.position ?? null;
  const leg = f.movement ?? (f.edge ? { from: f.edge.from, to: f.edge.to } : null);
  if (!leg) return null;
  const from = state.planets[leg.from]?.position;
  const to = state.planets[leg.to]?.position;
  if (!from || !to) return null;
  let t: number;
  if (f.movement) {
    const span = f.movement.arrivesAt - f.movement.departedAt;
    const prog = span > 0 ? Math.min(1, Math.max(0, (now - f.movement.departedAt) / span)) : 1;
    const t0 = f.movement.startT ?? 0;
    const t1 = f.movement.endT ?? 1;
    t = t0 + prog * (t1 - t0);
  } else {
    t = f.edge?.t ?? 0;
  }
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Draw the whole map onto `g` for the current camera. Clears the viewport first. */
export function renderMap(
  g: CanvasRenderingContext2D,
  state: GameState,
  cam: Cam,
  vp: Viewport,
  bounds: Bounds,
  opts: MapRenderOpts,
): void {
  const colors = ownerColors(state);
  const ownerColor = (o: PlayerId): string => colors.get(o) ?? theme.dim;
  const vw = vp.right;
  const vh = vp.bottom;
  g.clearRect(vp.left, vp.top, vw - vp.left, vh - vp.top);

  // Political territory — the weighted-Voronoi province fill (shared drawTerritory): every
  // sector is a cell coloured by its owner (neutral a faint wash), so who-holds-what reads
  // at a glance. Clipped to the map bounding box (+ padding) so it pans/zooms with the map.
  const padB = Math.max(40, (bounds.maxX - bounds.minX) * 0.05);
  const tl = worldToScreen({ x: bounds.minX - padB, y: bounds.minY - padB }, cam, vp, bounds);
  const br = worldToScreen({ x: bounds.maxX + padB, y: bounds.maxY + padB }, cam, vp, bounds);
  const clip: Array<[number, number]> = [
    [tl.x, tl.y],
    [br.x, tl.y],
    [br.x, br.y],
    [tl.x, br.y],
  ];
  const W = 9000 * cam.scale * cam.scale; // size → weight (screen px²), zoom-consistent
  const seeds: TerritorySeed[] = [];
  for (const p of Object.values(state.planets)) {
    const c = worldToScreen(p.position, cam, vp, bounds);
    seeds.push({ x: c.x, y: c.y, w: (p.size ?? 1) * W, owner: p.owner ?? null, kind: p.kind ?? 'planet' });
  }
  if (seeds.length >= 2) {
    drawTerritory(g, seeds, clip, {
      ownerColor,
      neutralFill: NEUTRAL,
      kindAccent: (kind) => KIND_COLOR[kind],
    });
  }

  // Star lanes (each undirected edge once), over the territory fill.
  g.lineWidth = 1;
  g.strokeStyle = rgba(theme.cyan, 0.22);
  const drawn = new Set<string>();
  for (const p of Object.values(state.planets)) {
    const a = worldToScreen(p.position, cam, vp, bounds);
    for (const nId of p.links ?? []) {
      const key = p.id < nId ? `${p.id}|${nId}` : `${nId}|${p.id}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const n = state.planets[nId];
      if (!n) continue;
      const b = worldToScreen(n.position, cam, vp, bounds);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }

  // Planet nodes — a holographic sphere + owner aura + a floating type badge + id label.
  const R = 8;
  for (const p of Object.values(state.planets)) {
    const c = worldToScreen(p.position, cam, vp, bounds);
    if (!inView(c, vw, vh, 44)) continue;
    const col = p.owner ? ownerColor(p.owner) : NEUTRAL;
    blitGlow(g, opts.dpr, col, c.x, c.y, R + 20, p.owner ? 0.3 : 0.12); // territory aura
    blitSphere(g, opts.dpr, col, c.x, c.y, R, 1); // lit holographic volume
    // floating type badge — the sector kind, glowing in its accent colour just above the node
    const icon = KIND_ICON[p.kind ?? ''];
    if (icon) {
      const kc = KIND_COLOR[p.kind ?? ''] ?? theme.cyan;
      g.save();
      g.font = '700 12px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = kc;
      g.shadowBlur = 5;
      g.fillStyle = rgba(kc, 0.95);
      g.fillText(icon, c.x, c.y - R - 12);
      g.restore();
    }
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = theme.ink;
    g.fillText(p.id, c.x + R + 6, c.y + 3);
  }

  // Selection reticle — a bright ring + corner brackets around the picked planet.
  if (opts.selected) {
    const sp = state.planets[opts.selected];
    if (sp) {
      const c = worldToScreen(sp.position, cam, vp, bounds);
      const rr = R + 8;
      g.save();
      g.strokeStyle = rgba('#7df0d0', 0.95);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(c.x, c.y, rr, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        g.moveTo(c.x + dx * rr, c.y + dy * (rr - 4));
        g.lineTo(c.x + dx * rr, c.y + dy * rr);
        g.lineTo(c.x + dx * (rr - 4), c.y + dy * rr);
      }
      g.stroke();
      g.restore();
    }
  }

  // Fleets — a small chevron in the owner's colour (with a soft glow) at its position.
  for (const f of Object.values(state.fleets)) {
    const pt = fleetPoint(state, f, opts.now);
    if (!pt) continue;
    const c = worldToScreen(pt, cam, vp, bounds);
    if (!inView(c, vw, vh, 24)) continue;
    const col = colors.get(f.owner) ?? theme.cyan;
    blitGlow(g, opts.dpr, col, c.x, c.y, 10, 0.5);
    g.beginPath();
    g.moveTo(c.x, c.y - 5);
    g.lineTo(c.x - 4, c.y + 4);
    g.lineTo(c.x + 4, c.y + 4);
    g.closePath();
    g.fillStyle = col;
    g.fill();
  }
}
