/**
 * ONB-1 · Browser adapter for the spotlight engine (`./spotlight`).
 *
 * Turns a data-described chain into a live overlay over the HUD: four dim
 * panels frame the target (a cut-out built from solid rects — the element
 * stays visible and clickable through the gap), a ring outlines it, and a hint
 * bubble with a «шаг k из n» counter, «Далее/Понятно» and «Пропустить обучение»
 * floats beside it. A `requestAnimationFrame` loop calls `refresh()` so the
 * highlight tracks a panel that re-renders/scrolls and `state` steps advance on
 * their own. All chrome text goes through `t()` (RU/EN).
 *
 * The overlay sits ABOVE the HUD but BELOW critical modals (z-index 50; see the
 * `#spotlight` block in build.mjs). For `tap` steps the panels swallow clicks so
 * «Далее» is the only way on; for `action`/`state` steps the panels are
 * click-through so the player operates the real HUD to advance.
 */
import { t } from './i18n';
import {
  SpotlightTour,
  frameRects,
  placeBubble,
  type Rect,
  type SpotlightHost,
  type SpotlightStep,
  type SpotlightView,
  type TourEnd,
} from './spotlight';

interface Overlay {
  root: HTMLElement;
  dim: HTMLElement[]; // 4 framing panels
  ring: HTMLElement;
  bubble: HTMLElement;
  arrow: HTMLElement;
  count: HTMLElement;
  copy: HTMLElement;
  next: HTMLButtonElement;
  skip: HTMLButtonElement;
}

let overlay: Overlay | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

/** Build the overlay DOM once and cache it (hidden until a tour runs). */
function ensureOverlay(): Overlay {
  if (overlay) return overlay;
  const root = el('div', 'sl-root');
  root.id = 'spotlight';
  const dim = [0, 1, 2, 3].map(() => el('div', 'sl-dim'));
  const ring = el('div', 'sl-ring');
  const bubble = el('div', 'sl-bubble');
  const arrow = el('div', 'sl-arrow');
  const count = el('div', 'sl-count');
  const copy = el('div', 'sl-copy');
  const btns = el('div', 'sl-btns');
  const skip = el('button', 'sl-skip');
  skip.type = 'button';
  const next = el('button', 'sl-next');
  next.type = 'button';
  btns.append(skip, next);
  bubble.append(arrow, count, copy, btns);
  root.append(...dim, ring, bubble);
  document.body.appendChild(root);
  overlay = { root, dim, ring, bubble, arrow, count, copy, next, skip };
  return overlay;
}

function place(node: HTMLElement, r: Rect): void {
  node.style.left = `${r.left}px`;
  node.style.top = `${r.top}px`;
  node.style.width = `${r.width}px`;
  node.style.height = `${r.height}px`;
}

const HIDDEN: Rect = { left: 0, top: 0, width: 0, height: 0 };

function paint(o: Overlay, view: SpotlightView | null): void {
  if (!view) {
    o.root.style.display = 'none';
    return;
  }
  o.root.style.display = 'block';
  const vp = { width: window.innerWidth, height: window.innerHeight };
  const interactive = view.step.advance.on !== 'tap'; // action/state → let the HUD through
  o.root.classList.toggle('sl-passthrough', interactive);

  if (view.target) {
    const frame = frameRects(view.target, vp, 6);
    o.dim.forEach((d, i) => place(d, frame[i]));
    o.ring.style.display = 'block';
    place(o.ring, {
      left: view.target.left - 6,
      top: view.target.top - 6,
      width: view.target.width + 12,
      height: view.target.height + 12,
    });
  } else {
    // No target: one full-screen dim (panel 0), the rest collapsed, no ring.
    place(o.dim[0], { left: 0, top: 0, width: vp.width, height: vp.height });
    o.dim.slice(1).forEach((d) => place(d, HIDDEN));
    o.ring.style.display = 'none';
  }

  o.count.textContent = t('шаг {k} из {n}', { k: view.index + 1, n: view.count });
  o.copy.textContent = t(view.step.copy);
  // Action/state steps have no «Далее» — the player advances by doing the thing.
  o.next.style.display = view.step.advance.on === 'tap' ? 'inline-block' : 'none';
  o.next.textContent = view.index + 1 >= view.count ? t('Понятно') : t('Далее');
  o.skip.textContent = t('Пропустить обучение');

  // Measure the bubble, then position it (and its arrow) next to the target.
  const b = o.bubble.getBoundingClientRect();
  const pos = placeBubble(
    view.target,
    vp,
    { width: b.width || 280, height: b.height || 120 },
    view.step.placement ?? 'auto',
  );
  o.bubble.style.left = `${pos.left}px`;
  o.bubble.style.top = `${pos.top}px`;
  o.arrow.dataset.dir = pos.arrow;
  o.arrow.style.display = pos.arrow === 'none' ? 'none' : 'block';
}

/** A live handle on a running tour — feed it player actions, or stop it early. */
export interface RunningTour {
  /** Report a game action so an `action` step can advance. */
  notifyAction(type: string): void;
  /** Force-stop (as if «Пропустить»). */
  stop(): void;
  readonly active: boolean;
}

let current: SpotlightTour | null = null;

/**
 * Start a data-described tour over the live HUD. Returns a handle whose
 * `notifyAction` the host wires to its action funnel. A new tour supersedes any
 * running one. `onEnd` fires with how it finished (completed / skipped / stopped).
 */
export function startTour(steps: readonly SpotlightStep[], onEnd?: TourEnd): RunningTour {
  const o = ensureOverlay();
  current?.skip(); // one tour at a time

  const host: SpotlightHost = {
    locate: (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      // A detached / display:none node reports a zero box — treat as absent.
      return r.width === 0 && r.height === 0
        ? null
        : { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    render: (view) => paint(o, view),
  };

  let running = true;
  const tour = new SpotlightTour(steps, host, (result) => {
    running = false;
    if (current === tour) current = null;
    onEnd?.(result);
  });
  current = tour;

  o.next.onclick = () => tour.tap();
  o.skip.onclick = () => tour.skip();

  const frame = (): void => {
    if (!running) return;
    tour.refresh();
    requestAnimationFrame(frame);
  };
  tour.start();
  if (running) requestAnimationFrame(frame);

  return {
    notifyAction: (type) => tour.notifyAction(type),
    stop: () => tour.skip(),
    get active() {
      return running;
    },
  };
}
