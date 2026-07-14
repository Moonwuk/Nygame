import { describe, expect, it } from 'vitest';
import {
  SpotlightTour,
  frameRects,
  placeBubble,
  type Rect,
  type SpotlightHost,
  type SpotlightStep,
  type SpotlightView,
  type TourResult,
} from './spotlight';

/**
 * A fake host: `present` is the set of selectors currently "in the DOM" (each
 * mapped to a rect), and every `render` is captured so tests can read the view.
 * Mutating `present` mid-tour models a panel opening / a node being recreated.
 */
function fakeHost(present: Record<string, Rect> = {}) {
  const views: (SpotlightView | null)[] = [];
  const host: SpotlightHost = {
    locate: (sel) => present[sel] ?? null,
    render: (v) => views.push(v),
  };
  const last = (): SpotlightView | null => views[views.length - 1] ?? null;
  return { host, views, last, present };
}

const RECT: Rect = { left: 100, top: 100, width: 80, height: 30 };

/** Collects the single `TourResult` a tour ends with (or null if still running). */
function ender() {
  let result: TourResult | null = null;
  return { onEnd: (r: TourResult) => (result = r), get: () => result };
}

describe('SpotlightTour — tap advance', () => {
  it('walks a data-described chain of three tap steps to completion', () => {
    const steps: SpotlightStep[] = [
      { id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 'b', target: '#b', copy: 'B', advance: { on: 'tap' } },
      { id: 'c', target: '#c', copy: 'C', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT, '#b': RECT, '#c': RECT });
    const e = ender();
    const tour = new SpotlightTour(steps, h.host, e.onEnd);

    tour.start();
    expect(tour.index).toBe(0);
    expect(h.last()?.step.id).toBe('a');
    expect(h.last()?.count).toBe(3);

    tour.tap();
    expect(tour.index).toBe(1);
    expect(h.last()?.step.id).toBe('b');

    tour.tap();
    expect(tour.index).toBe(2);

    tour.tap(); // off the end
    expect(tour.active).toBe(false);
    expect(e.get()).toEqual({ completed: true, skipped: false, stopped: false, reachedStep: 2 });
    expect(h.last()).toBeNull(); // overlay cleared on end
  });

  it('exposes a 1-of-n counter through index/count', () => {
    const steps: SpotlightStep[] = [
      { id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 'b', target: '#b', copy: 'B', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT, '#b': RECT });
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    expect(h.last()).toMatchObject({ index: 0, count: 2 });
    tour.tap();
    expect(h.last()).toMatchObject({ index: 1, count: 2 });
  });
});

describe('SpotlightTour — action advance', () => {
  it('waits for the real action and ignores others', () => {
    const steps: SpotlightStep[] = [
      { id: 'look', target: '#course', copy: 'C', advance: { on: 'action', type: 'fleet.move' } },
      { id: 'done', target: '#hud', copy: 'D', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#course': RECT, '#hud': RECT });
    const tour = new SpotlightTour(steps, h.host);
    tour.start();

    tour.notifyAction('build.unit'); // unrelated action — no advance
    expect(tour.index).toBe(0);
    tour.tap(); // a tap can't advance an action step either
    expect(tour.index).toBe(0);

    tour.notifyAction('fleet.move'); // the awaited action
    expect(tour.index).toBe(1);
    expect(h.last()?.step.id).toBe('done');
  });

  it('does not advance an action step across refreshes until the action fires (3-step e2e)', () => {
    const steps: SpotlightStep[] = [
      { id: 's1', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 's2', target: '#b', copy: 'B', advance: { on: 'action', type: 'fleet.move' } },
      { id: 's3', target: '#c', copy: 'C', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT, '#b': RECT, '#c': RECT });
    const e = ender();
    const tour = new SpotlightTour(steps, h.host, e.onEnd);
    tour.start();
    tour.tap(); // → s2 (the action gate)
    expect(tour.index).toBe(1);

    for (let f = 0; f < 20; f++) tour.refresh(); // many frames pass; still parked on s2
    expect(tour.index).toBe(1);
    expect(e.get()).toBeNull();

    tour.notifyAction('fleet.move'); // player finally issues the course order
    expect(tour.index).toBe(2);
    tour.tap();
    expect(e.get()?.completed).toBe(true);
  });
});

describe('SpotlightTour — state advance', () => {
  it('advances when the predicate turns true, polled on refresh', () => {
    let captured = false;
    const steps: SpotlightStep[] = [
      {
        id: 'cap',
        target: '#world',
        copy: 'Take it',
        advance: { on: 'state', when: () => captured },
      },
      { id: 'win', target: '#score', copy: 'Score', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#world': RECT, '#score': RECT });
    const tour = new SpotlightTour(steps, h.host);
    tour.start();

    tour.refresh(); // predicate still false
    expect(tour.index).toBe(0);

    captured = true;
    tour.refresh(); // predicate now true → advance
    expect(tour.index).toBe(1);
    expect(h.last()?.step.id).toBe('win');
  });

  it('honours a predicate already satisfied on arrival', () => {
    const steps: SpotlightStep[] = [
      { id: 'pre', target: '#x', copy: 'X', advance: { on: 'state', when: () => true } },
      { id: 'next', target: '#y', copy: 'Y', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#x': RECT, '#y': RECT });
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    expect(tour.index).toBe(1); // skipped straight past the pre-satisfied step
  });
});

describe('SpotlightTour — skip', () => {
  it('ends the whole chain from the middle', () => {
    const steps: SpotlightStep[] = [
      { id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 'b', target: '#b', copy: 'B', advance: { on: 'tap' } },
      { id: 'c', target: '#c', copy: 'C', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT, '#b': RECT, '#c': RECT });
    const e = ender();
    const tour = new SpotlightTour(steps, h.host, e.onEnd);
    tour.start();
    tour.tap(); // on step b
    tour.skip();
    expect(tour.active).toBe(false);
    expect(e.get()).toEqual({ completed: false, skipped: true, stopped: false, reachedStep: 1 });
    expect(h.last()).toBeNull();
  });
});

describe('SpotlightTour — missing target', () => {
  it('slides past an optional step whose target is absent', () => {
    const steps: SpotlightStep[] = [
      { id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 'gone', target: '#missing', copy: 'G', advance: { on: 'tap' }, optional: true },
      { id: 'c', target: '#c', copy: 'C', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT, '#c': RECT }); // #missing not present
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    tour.tap(); // leaves a → optional b auto-skips → lands on c
    expect(tour.index).toBe(2);
    expect(h.last()?.step.id).toBe('c');
  });

  it('safe-stops on a required step whose target is absent (no throw)', () => {
    const steps: SpotlightStep[] = [
      { id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } },
      { id: 'gone', target: '#missing', copy: 'G', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#a': RECT });
    const e = ender();
    const tour = new SpotlightTour(steps, h.host, e.onEnd);
    tour.start();
    expect(() => tour.tap()).not.toThrow();
    expect(tour.active).toBe(false);
    expect(e.get()).toEqual({ completed: false, skipped: false, stopped: true, reachedStep: 1 });
    expect(h.last()).toBeNull();
  });

  it('keeps an action step waiting when its highlight is not in the DOM yet, then highlights it', () => {
    const steps: SpotlightStep[] = [
      { id: 'act', target: '#panel', copy: 'Do it', advance: { on: 'action', type: 'build' } },
      { id: 'end', target: '#e', copy: 'E', advance: { on: 'tap' } },
    ];
    const h = fakeHost({ '#e': RECT }); // #panel renders a frame later
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    expect(tour.index).toBe(0); // did NOT skip/stop — it waits for the action
    expect(h.last()?.target).toBeNull(); // best-effort highlight: none yet
    h.present['#panel'] = { left: 5, top: 5, width: 60, height: 20 }; // panel appears
    tour.refresh();
    expect(h.last()?.target).toMatchObject({ left: 5, top: 5 }); // now highlighted
    tour.notifyAction('build'); // the awaited action still advances it
    expect(tour.index).toBe(1);
  });

  it('renders a centred bubble for a targetless (info) step', () => {
    const steps: SpotlightStep[] = [
      { id: 'intro', target: null, copy: 'Welcome', advance: { on: 'tap' } },
    ];
    const h = fakeHost();
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    expect(h.last()?.target).toBeNull();
    expect(h.last()?.step.id).toBe('intro');
  });
});

describe('SpotlightTour — resilience to re-render', () => {
  it('re-locates the target on every refresh (node moved by a panel repaint)', () => {
    const steps: SpotlightStep[] = [{ id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } }];
    const h = fakeHost({ '#a': { left: 10, top: 10, width: 40, height: 20 } });
    const tour = new SpotlightTour(steps, h.host);
    tour.start();
    expect(h.last()?.target).toMatchObject({ left: 10, top: 10 });

    h.present['#a'] = { left: 200, top: 300, width: 40, height: 20 }; // panel re-rendered
    tour.refresh();
    expect(h.last()?.target).toMatchObject({ left: 200, top: 300 });
  });

  it('finishes an empty chain immediately as completed', () => {
    const h = fakeHost();
    const e = ender();
    const tour = new SpotlightTour([], h.host, e.onEnd);
    tour.start();
    expect(tour.active).toBe(false);
    expect(e.get()?.completed).toBe(true);
  });

  it('ignores input before start and after end', () => {
    const steps: SpotlightStep[] = [{ id: 'a', target: '#a', copy: 'A', advance: { on: 'tap' } }];
    const h = fakeHost({ '#a': RECT });
    const tour = new SpotlightTour(steps, h.host);
    expect(() => {
      tour.tap();
      tour.notifyAction('x');
      tour.refresh();
      tour.skip();
    }).not.toThrow();
    expect(h.views.length).toBe(0);
  });
});

describe('geometry — frameRects', () => {
  it('covers the viewport except the padded target', () => {
    const vp = { width: 1000, height: 800 };
    const [top, bottom, left, right] = frameRects(
      { left: 100, top: 100, width: 80, height: 30 },
      vp,
      6,
    );
    // padded hole is x:[94,186] y:[94,136]
    expect(top).toEqual({ left: 0, top: 0, width: 1000, height: 94 });
    expect(bottom).toEqual({ left: 0, top: 136, width: 1000, height: 664 });
    expect(left).toEqual({ left: 0, top: 94, width: 94, height: 42 });
    expect(right).toEqual({ left: 186, top: 94, width: 814, height: 42 });
  });

  it('clamps the hole to the viewport edges', () => {
    const vp = { width: 500, height: 400 };
    const rects = frameRects({ left: -20, top: -20, width: 60, height: 60 }, vp, 6);
    for (const r of rects) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('geometry — placeBubble', () => {
  const vp = { width: 1000, height: 800 };
  const bubble = { width: 260, height: 120 };

  it('centres a targetless bubble with no arrow', () => {
    const p = placeBubble(null, vp, bubble);
    expect(p.arrow).toBe('none');
    expect(p.left).toBeCloseTo((1000 - 260) / 2);
    expect(p.top).toBeCloseTo((800 - 120) / 2);
  });

  it('auto-places below a top-of-screen target (arrow points up at it)', () => {
    const p = placeBubble({ left: 400, top: 40, width: 100, height: 30 }, vp, bubble, 'auto');
    expect(p.arrow).toBe('up');
    expect(p.top).toBeGreaterThan(40);
  });

  it('auto-flips above a target hugging the bottom edge', () => {
    const p = placeBubble({ left: 400, top: 760, width: 100, height: 30 }, vp, bubble, 'auto');
    expect(p.arrow).toBe('down');
    expect(p.top).toBeLessThan(760);
  });

  it('keeps the bubble on-screen when the target sits in a corner', () => {
    const p = placeBubble({ left: 980, top: 10, width: 20, height: 20 }, vp, bubble, 'right');
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + bubble.width).toBeLessThanOrEqual(vp.width);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});
