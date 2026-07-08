/**
 * Map camera — the view transform shared by every render surface (the prototype's
 * Canvas2D map and the Stage-4 web client; docs/cross-platform-roadmap.md CP0.2 —
 * "one render implementation, not two"). Pure math: a node-graph style zoom where node
 * and label sizes stay constant in screen pixels and only positions transform.
 *
 * Framework-agnostic and side-effect-free — every function takes the viewport + map
 * bounds explicitly and returns a value (the camera is a plain `{ scale, x, y }`),
 * so it is trivially unit-tested and reused by any renderer. No DOM, no globals.
 */

/** Pan offset (screen px) over a zoom factor above the whole-map fit. */
export interface Cam {
  scale: number;
  x: number;
  y: number;
}

/** The on-screen play area (screen px): where the map is allowed to draw. */
export interface Viewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The map's extent in map space. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Extra pan slack per screen edge (screen px) ON TOP of PAN_SLACK — lets the camera
 *  overshoot the map border where an overlay (e.g. the open bottom-sheet panel) covers
 *  the play area, so content hidden behind it can be dragged into the clear part.
 *  `bottom` widens the UP-drag range, `right` the LEFT-drag range, etc. */
export interface EdgeSlack {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Breathing room around the whole-map (scale-1) view so it reads as a framed board. */
export const FIT_MARGIN = 0.94;
/** 1 = the whole-map fit (can't zoom out past it into empty void). */
export const MIN_SCALE = 1;
/** Close enough to read one province + its neighbours on a phone. */
export const MAX_SCALE = 6;
/** Fraction of the play area you may pan past each content edge (easy edge navigation). */
export const PAN_SLACK = 0.16;

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
/** Clamp a zoom factor into the allowed range. */
export const clampScale = (s: number): number => clamp(s, MIN_SCALE, MAX_SCALE);

/** The whole-map fit (map space → screen at scale 1): a UNIFORM scale (aspect preserved,
 *  so a circle stays a circle) that fits the whole map inside the play area and centres it
 *  (the spare axis gets symmetric letterbox margins). */
export function fitTransform(
  vp: Viewport,
  b: Bounds,
  margin = FIT_MARGIN,
): { scale: number; offX: number; offY: number } {
  const aw = Math.max(60, vp.right - vp.left);
  const ah = Math.max(60, vp.bottom - vp.top);
  const mapW = b.maxX - b.minX || 1;
  const mapH = b.maxY - b.minY || 1;
  const scale = Math.min(aw / mapW, ah / mapH) * margin;
  const offX = vp.left + (aw - mapW * scale) / 2;
  const offY = vp.top + (ah - mapH * scale) / 2;
  return { scale, offX, offY };
}

/** Map point → its base (scale-1) screen position, before the camera zoom/pan. */
export function projectBase(
  p: { x: number; y: number },
  vp: Viewport,
  b: Bounds,
  margin = FIT_MARGIN,
): { x: number; y: number } {
  const { scale, offX, offY } = fitTransform(vp, b, margin);
  return { x: offX + (p.x - b.minX) * scale, y: offY + (p.y - b.minY) * scale };
}

/** Map point → screen point at the current camera. */
export function worldToScreen(
  p: { x: number; y: number },
  cam: Cam,
  vp: Viewport,
  b: Bounds,
): { x: number; y: number } {
  const base = projectBase(p, vp, b);
  return { x: base.x * cam.scale + cam.x, y: base.y * cam.scale + cam.y };
}

/** Screen point → map point (inverse of `worldToScreen`). */
export function screenToWorld(
  pt: { x: number; y: number },
  cam: Cam,
  vp: Viewport,
  b: Bounds,
): { x: number; y: number } {
  const { scale, offX, offY } = fitTransform(vp, b);
  const baseX = (pt.x - cam.x) / cam.scale;
  const baseY = (pt.y - cam.y) / cam.scale;
  return { x: b.minX + (baseX - offX) / scale, y: b.minY + (baseY - offY) / scale };
}

/** Keep the map filling the play area with SLACK at the edges (an edge can sit a margin
 *  inside); at the whole-map floor a smaller-than-viewport axis parks centred. Optional
 *  `extra` (EdgeSlack) widens the range past a given edge — the "panel open" overshoot —
 *  including from the parked centre, so the map can be pulled out from under an overlay
 *  even at the min-zoom fit. Returns a new camera with `scale` unchanged, `x`/`y` bounded. */
export function clampCam(cam: Cam, vp: Viewport, b: Bounds, extra: EdgeSlack = {}): Cam {
  const tl = projectBase({ x: b.minX, y: b.minY }, vp, b);
  const br = projectBase({ x: b.maxX, y: b.maxY }, vp, b);
  const pL = tl.x * cam.scale;
  const pR = br.x * cam.scale;
  const pT = tl.y * cam.scale;
  const pB = br.y * cam.scale;
  const mx = (vp.right - vp.left) * PAN_SLACK;
  const my = (vp.bottom - vp.top) * PAN_SLACK;
  const eL = extra.left ?? 0;
  const eR = extra.right ?? 0;
  const eT = extra.top ?? 0;
  const eB = extra.bottom ?? 0;
  // A covered right edge lets you drag further LEFT (lower x bound); a covered bottom
  // edge further UP (lower y bound) — and symmetrically for left/top overlays.
  const parkedX = (vp.left + vp.right - pL - pR) / 2;
  const x =
    pR - pL >= vp.right - vp.left
      ? clamp(cam.x, vp.right - pR - mx - eR, vp.left - pL + mx + eL)
      : clamp(cam.x, parkedX - eR, parkedX + eL);
  const parkedY = (vp.top + vp.bottom - pT - pB) / 2;
  const y =
    pB - pT >= vp.bottom - vp.top
      ? clamp(cam.y, vp.bottom - pB - my - eB, vp.top - pT + my + eT)
      : clamp(cam.y, parkedY - eB, parkedY + eT);
  return { scale: cam.scale, x, y };
}

/** Zoom by `factor` anchored on the focal point (cursor / pinch centre): the map-space
 *  point under it stays put, so zoom grows toward where you're looking. Returns a new
 *  clamped camera. */
export function zoomAt(
  cam: Cam,
  fx: number,
  fy: number,
  factor: number,
  vp: Viewport,
  b: Bounds,
  extra: EdgeSlack = {},
): Cam {
  const bx = (fx - cam.x) / cam.scale;
  const by = (fy - cam.y) / cam.scale;
  const scale = clampScale(cam.scale * factor);
  return clampCam({ scale, x: fx - bx * scale, y: fy - by * scale }, vp, b, extra);
}

/** Put map-point `p` at the centre of the play area at `scale` (clamped + bounded). */
export function centerOn(
  cam: Cam,
  p: { x: number; y: number },
  scale: number,
  vp: Viewport,
  b: Bounds,
  extra: EdgeSlack = {},
): Cam {
  const s = clampScale(scale);
  const base = projectBase(p, vp, b);
  return clampCam(
    { scale: s, x: (vp.left + vp.right) / 2 - base.x * s, y: (vp.top + vp.bottom) / 2 - base.y * s },
    vp,
    b,
    extra,
  );
}

/** Is a screen point within (padded) view bounds `vw`×`vh`? Cheap viewport cull. */
export function inView(c: { x: number; y: number }, vw: number, vh: number, pad = 80): boolean {
  return c.x >= -pad && c.x <= vw + pad && c.y >= -pad && c.y <= vh + pad;
}
