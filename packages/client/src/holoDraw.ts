/**
 * Holographic draw primitives — the cyan-on-void terminal look shared by every render
 * surface (the prototype's Canvas2D map and the Stage-4 client; docs/cross-platform-roadmap.md
 * CP0.2 — "one render implementation, not two"). Stateless with respect to GAME state:
 * every function takes the target canvas context + device-pixel-ratio explicitly, so any
 * renderer can call them. The only owned state is per-colour sprite caches, keyed by dpr so
 * one module serves surfaces at different pixel ratios.
 */

const TAU = Math.PI * 2;

/** hex `#rrggbb` → `rgba()` with alpha — for tinted rings, ticks and trails. */
export function rgba(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Cached radial-glow sprites: baking one soft glow disc per (colour, radius, dpr) once and
// blitting it with drawImage + globalAlpha is far cheaper than a per-node createRadialGradient
// + shadowBlur every frame, so the map glow scales to many provinces.
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(dpr: number, color: string, radius: number): HTMLCanvasElement {
  const rad = Math.max(4, Math.round(radius));
  const key = `${color}:${rad}:${dpr}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  const px = Math.ceil(rad * 2 * dpr);
  cv.width = px;
  cv.height = px;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grd = g.createRadialGradient(rad, rad, 0, rad, rad, rad);
  grd.addColorStop(0, rgba(color, 0.95));
  grd.addColorStop(0.5, rgba(color, 0.32));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, rad * 2, rad * 2);
  glowCache.set(key, cv);
  return cv;
}

/** Blit a cached glow disc of `color` centred at (x,y), radius r, at opacity `a`. */
export function blitGlow(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  color: string,
  x: number,
  y: number,
  r: number,
  a: number,
): void {
  if (a <= 0.004) return;
  const spr = glowSprite(dpr, color, r);
  const rad = Math.max(4, Math.round(r));
  ctx.globalAlpha = Math.min(1, a);
  ctx.drawImage(spr, x - rad, y - rad, rad * 2, rad * 2);
  ctx.globalAlpha = 1;
}

// Shaded holographic spheres: one lit sphere baked per (colour, dpr) — specular up-left,
// colour body, translucent Fresnel rim — blitted scaled to a node, same cache-and-blit
// trick as the glow (no per-node gradient on the hot path).
const sphereCache = new Map<string, HTMLCanvasElement>();
function sphereSprite(dpr: number, color: string): HTMLCanvasElement {
  const key = `${color}:${dpr}`;
  const hit = sphereCache.get(key);
  if (hit) return hit;
  const rad = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(rad * 2 * dpr);
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grd = g.createRadialGradient(rad - rad * 0.34, rad - rad * 0.4, rad * 0.06, rad, rad, rad);
  grd.addColorStop(0, rgba('#ffffff', 0.8));
  grd.addColorStop(0.18, rgba(color, 0.62));
  grd.addColorStop(0.55, rgba(color, 0.26));
  grd.addColorStop(0.85, rgba(color, 0.1));
  grd.addColorStop(1, rgba(color, 0.02));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(rad, rad, rad - 1, 0, TAU);
  g.fill();
  g.strokeStyle = rgba('#ffffff', 0.26); // holographic rim
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(rad, rad, rad - 1.4, 0, TAU);
  g.stroke();
  sphereCache.set(key, cv);
  return cv;
}

/** Blit the cached shaded sphere of `color` centred at (x,y) at node radius r, scaled by
 *  `a` (fade the volume out at the far/whole-map view where nodes pack together). */
export function blitSphere(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  color: string,
  x: number,
  y: number,
  r: number,
  a = 1,
): void {
  if (a <= 0.02) return;
  ctx.globalAlpha = a;
  ctx.drawImage(sphereSprite(dpr, color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}
