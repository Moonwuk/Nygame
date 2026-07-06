import { describe, it, expect } from 'vitest';
import {
  type Cam,
  type Viewport,
  type Bounds,
  MIN_SCALE,
  MAX_SCALE,
  clampScale,
  projectBase,
  worldToScreen,
  screenToWorld,
  zoomAt,
  clampCam,
  centerOn,
  inView,
} from './camera';

// A portrait play area and a square map — the prototype's typical shape.
const VP: Viewport = { left: 0, right: 400, top: 0, bottom: 800 };
const B: Bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('camera — projection', () => {
  it('worldToScreen ↔ screenToWorld round-trip is identity', () => {
    const cam: Cam = { scale: 2.5, x: -37, y: 91 };
    for (const p of [
      { x: 0, y: 0 },
      { x: 1000, y: 1000 },
      { x: 412, y: 733 },
      { x: 999, y: 1 },
    ]) {
      const back = screenToWorld(worldToScreen(p, cam, VP, B), cam, VP, B);
      expect(near(back.x, p.x)).toBe(true);
      expect(near(back.y, p.y)).toBe(true);
    }
  });

  it('base fit preserves aspect (uniform scale) and centres the whole map', () => {
    // A square map in a 400×800 area fits to width (400), letterboxed vertically.
    const tl = projectBase({ x: 0, y: 0 }, VP, B);
    const br = projectBase({ x: 1000, y: 1000 }, VP, B);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    expect(near(w, h)).toBe(true); // square stays square
    expect(w).toBeLessThanOrEqual(400); // fits inside the play area
    expect(near((tl.x + br.x) / 2, 200)).toBe(true); // centred on X
    expect(near((tl.y + br.y) / 2, 400)).toBe(true); // centred on Y
  });
});

describe('camera — zoom', () => {
  it('anchors the focal point: the map-space point under it stays put', () => {
    const cam0 = clampCam({ scale: 1, x: 0, y: 0 }, VP, B);
    const fx = 200;
    const fy = 400; // viewport centre → clamp won't fight the anchor
    const worldUnder = screenToWorld({ x: fx, y: fy }, cam0, VP, B);
    const cam1 = zoomAt(cam0, fx, fy, 2, VP, B);
    expect(cam1.scale).toBeCloseTo(2);
    const backOnScreen = worldToScreen(worldUnder, cam1, VP, B);
    expect(backOnScreen.x).toBeCloseTo(fx, 3);
    expect(backOnScreen.y).toBeCloseTo(fy, 3);
  });

  it('clamps scale to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(999)).toBe(MAX_SCALE);
    const zoomedOut = zoomAt({ scale: 1, x: 0, y: 0 }, 200, 400, 0.01, VP, B);
    expect(zoomedOut.scale).toBe(MIN_SCALE);
    const zoomedIn = zoomAt({ scale: 5, x: 0, y: 0 }, 200, 400, 10, VP, B);
    expect(zoomedIn.scale).toBe(MAX_SCALE);
  });
});

describe('camera — pan clamp & centring', () => {
  it('parks a smaller-than-viewport axis centred at the min-zoom floor', () => {
    const cam = clampCam({ scale: 1, x: 0, y: 0 }, VP, B);
    // At scale 1 the square map fits the 400px width → its centre sits at the play-area centre.
    const centre = worldToScreen({ x: 500, y: 500 }, cam, VP, B);
    expect(centre.x).toBeCloseTo(200, 3);
    expect(centre.y).toBeCloseTo(400, 3);
  });

  it('centerOn places a map point at the viewport centre', () => {
    const cam = centerOn({ scale: 1, x: 0, y: 0 }, { x: 250, y: 250 }, 4, VP, B);
    expect(cam.scale).toBe(4);
    const onScreen = worldToScreen({ x: 250, y: 250 }, cam, VP, B);
    expect(onScreen.x).toBeCloseTo(200, 3);
    expect(onScreen.y).toBeCloseTo(400, 3);
  });
});

describe('camera — cull', () => {
  it('inView respects the padded viewport', () => {
    expect(inView({ x: 200, y: 400 }, 400, 800, 80)).toBe(true);
    expect(inView({ x: -100, y: 400 }, 400, 800, 80)).toBe(false);
    expect(inView({ x: -20, y: 400 }, 400, 800, 80)).toBe(true); // within pad
    expect(inView({ x: 460, y: 400 }, 400, 800, 80)).toBe(true); // within pad
  });
});
