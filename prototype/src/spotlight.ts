/**
 * =============================================================================
 *  ONB-1 · Guide-mark (spotlight) engine — the reusable onboarding primitive.
 * =============================================================================
 *  A data-described chain of steps that walks a player around the live HUD:
 *  dim the screen, cut a hole over one element, float a hint bubble, and wait
 *  for the step's `advance` condition — a tap («Далее/Понятно»), a real game
 *  ACTION of a given type, or a game-STATE predicate turning true.
 *
 *  This file is DOM-FREE on purpose: the state machine takes screen rects from
 *  a host and hands back a view to paint, so it runs (and is unit-tested) in
 *  plain Node. The browser adapter lives in `spotlightDom.ts`; ONB-2/3 reuse
 *  BOTH (the same engine, the same overlay) — see docs/onboarding-roadmap.md.
 *
 *  Design rules that the tests pin:
 *   - advance only on the step's own condition (a `fleet.move` step ignores
 *     other actions; a `tap` step ignores actions entirely);
 *   - «Пропустить обучение» ends the WHOLE chain, at any step;
 *   - a missing target is graceful, never a crash — a `tap` step with no target
 *     to point at either skips (`optional`) or SAFE-STOPs (required); an
 *     `action`/`state` step keeps waiting for its condition, highlight or not;
 *   - re-query the selector every `refresh()` so a panel that re-renders its
 *     nodes (and moves/recreates the target) keeps the highlight glued to it.
 */

/** A screen-space rectangle, as produced by `Element.getBoundingClientRect()`. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How a step hands control to the next one. */
export type StepAdvance =
  | { on: 'tap' } // player presses «Далее/Понятно»
  | { on: 'action'; type: string } // player issues a game action of this type
  | { on: 'state'; when: () => boolean }; // a game-state predicate becomes true

/** Which side of the target the hint bubble sits on (`auto` = host decides). */
export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

/** One guide step, described by data. */
export interface SpotlightStep {
  id: string;
  /** CSS selector of the element to highlight, or `null` for a centred bubble. */
  target: string | null;
  /** Locale key (msgid) of the bubble copy — resolved through `t()` at paint. */
  copy: string;
  advance: StepAdvance;
  placement?: Placement;
  /** For a `tap` step whose target is absent: skip it instead of safe-stopping the
   *  tour. No effect on `action`/`state` steps — those always wait for their
   *  condition (their highlight is best-effort regardless). */
  optional?: boolean;
}

/** The snapshot the host paints for the current step. */
export interface SpotlightView {
  step: SpotlightStep;
  index: number; // 0-based position in the chain
  count: number; // total steps
  target: Rect | null; // located rect, or null (no target / not in DOM)
}

/** The browser (or a fake, in tests) the engine drives. */
export interface SpotlightHost {
  /** Screen rect of the selector's element, or `null` when it is not present. */
  locate(selector: string): Rect | null;
  /** Paint the current view, or clear the overlay when passed `null`. */
  render(view: SpotlightView | null): void;
}

/** Why (and how far) a tour ended. Exactly one of the three flags is true. */
export interface TourResult {
  completed: boolean; // walked off the end of the chain
  skipped: boolean; // player pressed «Пропустить»
  stopped: boolean; // safe-stopped (a required target was missing)
  reachedStep: number; // furthest step index entered (-1 if none)
}

export type TourEnd = (result: TourResult) => void;

/**
 * The step machine. Construct with a chain + a host; `start()` it, then feed it
 * `tap()`, `notifyAction(type)` and `refresh()` (the last one also polls `state`
 * advances and re-locates the target so the highlight survives re-renders).
 */
export class SpotlightTour {
  private i = -1;
  private reached = -1;
  private running = false;

  constructor(
    private readonly steps: readonly SpotlightStep[],
    private readonly host: SpotlightHost,
    private readonly onEnd?: TourEnd,
  ) {}

  get active(): boolean {
    return this.running;
  }

  /** Current step index (0-based), or -1 before `start()` / after the end. */
  get index(): number {
    return this.running ? this.i : -1;
  }

  /** Begin at the first step. An empty chain finishes immediately. */
  start(): void {
    if (this.running) return;
    if (this.steps.length === 0) {
      this.end({ completed: true, skipped: false, stopped: false, reachedStep: -1 });
      return;
    }
    this.running = true;
    this.enter(0);
  }

  /** «Далее/Понятно» — advances a `tap` step; ignored otherwise. */
  tap(): void {
    if (this.running && this.current.advance.on === 'tap') this.next();
  }

  /** A game action fired — advances a matching `action` step. */
  notifyAction(type: string): void {
    if (!this.running) return;
    const adv = this.current.advance;
    if (adv.on === 'action' && adv.type === type) this.next();
  }

  /**
   * Re-locate the current target and repaint; also polls a `state` advance. The
   * host calls this on its animation frame / on DOM mutations / on resize, so
   * the highlight tracks a re-rendered node and state steps advance on their own.
   */
  refresh(): void {
    if (!this.running) return;
    if (this.current.advance.on === 'state' && this.current.advance.when()) {
      this.next();
      return;
    }
    this.paint();
  }

  /** «Пропустить обучение» — ends the whole chain from any step. */
  skip(): void {
    if (this.running)
      this.end({ completed: false, skipped: true, stopped: false, reachedStep: this.reached });
  }

  // --- internals -------------------------------------------------------------

  private get current(): SpotlightStep {
    return this.steps[this.i];
  }

  /** Move onto step `i`, resolving its target (or skipping/stopping if absent). */
  private enter(i: number): void {
    this.i = i;
    if (i > this.reached) this.reached = i;
    const step = this.current;
    // A step whose selector isn't in the DOM right now can't be highlighted. For a
    // `tap` step there's nothing to wait for BUT the (missing) target, so `optional`
    // slides past it and a required one safe-stops (never a hole over nothing, never
    // a throw). An `action`/`state` step must still WAIT for its condition — the
    // highlight is best-effort, so it just paints a bubble and re-queries the target
    // each refresh (a panel that renders its node a frame later is picked up then).
    if (
      step.advance.on === 'tap' &&
      step.target !== null &&
      this.host.locate(step.target) === null
    ) {
      if (step.optional) {
        this.next();
        return;
      }
      this.end({ completed: false, skipped: false, stopped: true, reachedStep: this.reached });
      return;
    }
    // A `state` step may already be satisfied on arrival — honour it at once.
    if (step.advance.on === 'state' && step.advance.when()) {
      this.next();
      return;
    }
    this.paint();
  }

  /** Advance to the next step, or finish when the chain is exhausted. */
  private next(): void {
    if (this.i + 1 >= this.steps.length) {
      this.end({ completed: true, skipped: false, stopped: false, reachedStep: this.reached });
      return;
    }
    this.enter(this.i + 1);
  }

  private paint(): void {
    const step = this.current;
    const target = step.target === null ? null : this.host.locate(step.target);
    this.host.render({ step, index: this.i, count: this.steps.length, target });
  }

  private end(result: TourResult): void {
    this.running = false;
    this.i = -1;
    this.host.render(null);
    this.onEnd?.(result);
  }
}

// --- pure geometry (shared by the DOM adapter, kept here so it's tested) ------

export interface Viewport {
  width: number;
  height: number;
}

/**
 * The four dim panels that frame a highlighted rect (padded by `pad`), in
 * order [top, bottom, left, right]. Together they cover the whole viewport
 * EXCEPT the padded target, so the element shows (and stays clickable) through
 * the gap — a cut-out built from four solid rects rather than a real hole.
 */
export function frameRects(target: Rect, vp: Viewport, pad = 6): Rect[] {
  const l = Math.max(0, target.left - pad);
  const tp = Math.max(0, target.top - pad);
  const r = Math.min(vp.width, target.left + target.width + pad);
  const b = Math.min(vp.height, target.top + target.height + pad);
  return [
    { left: 0, top: 0, width: vp.width, height: tp }, // above
    { left: 0, top: b, width: vp.width, height: Math.max(0, vp.height - b) }, // below
    { left: 0, top: tp, width: l, height: Math.max(0, b - tp) }, // left of
    { left: r, top: tp, width: Math.max(0, vp.width - r), height: Math.max(0, b - tp) }, // right of
  ];
}

export type Arrow = 'up' | 'down' | 'left' | 'right' | 'none';

export interface BubblePlacement {
  left: number;
  top: number;
  arrow: Arrow;
}

/**
 * Where to put the hint bubble and which way its arrow points. With no target
 * the bubble is centred (no arrow). `auto` picks the side with the most room
 * (below unless the target hugs the bottom); an explicit side is honoured but
 * still clamped fully on-screen.
 */
export function placeBubble(
  target: Rect | null,
  vp: Viewport,
  bubble: { width: number; height: number },
  placement: Placement = 'auto',
  gap = 14,
): BubblePlacement {
  const clampX = (x: number): number => Math.max(gap, Math.min(x, vp.width - bubble.width - gap));
  const clampY = (y: number): number => Math.max(gap, Math.min(y, vp.height - bubble.height - gap));
  if (!target) {
    return {
      left: clampX((vp.width - bubble.width) / 2),
      top: clampY((vp.height - bubble.height) / 2),
      arrow: 'none',
    };
  }
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const below = target.top + target.height;
  const side =
    placement === 'auto'
      ? below + gap + bubble.height <= vp.height
        ? 'bottom'
        : 'top'
      : placement;
  switch (side) {
    case 'top':
      return {
        left: clampX(cx - bubble.width / 2),
        top: clampY(target.top - gap - bubble.height),
        arrow: 'down',
      };
    case 'left':
      return {
        left: clampX(target.left - gap - bubble.width),
        top: clampY(cy - bubble.height / 2),
        arrow: 'right',
      };
    case 'right':
      return {
        left: clampX(target.left + target.width + gap),
        top: clampY(cy - bubble.height / 2),
        arrow: 'left',
      };
    case 'bottom':
    default:
      return { left: clampX(cx - bubble.width / 2), top: clampY(below + gap), arrow: 'up' };
  }
}
