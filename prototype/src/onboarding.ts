/**
 * ONB-0 · First-run state + funnel — the "did this commander pass onboarding?"
 * signal, kept SEPARATE from the saved callsign (a returning device may still be
 * brand-new to the tutorial). Per-callsign, persisted by main.ts in localStorage
 * (key `vd.onboard.<nick>`, alongside `vd.meta.<nick>`); the server account
 * (SE-1.x) takes it over later.
 *
 * Pure module: no DOM, no storage access — main.ts feeds it a raw string and
 * persists the result, exactly like `meta.ts`. Every transition is idempotent so
 * replaying the guide («Ещё → Обучение») never corrupts the flag, and the parser
 * is fail-secure (garbage → a fresh, un-onboarded state, never a throw).
 */

export interface OnboardState {
  /** The guide was offered and begun at least once. */
  started: boolean;
  /** Furthest funnel step reached (1-based, monotonic) — "докуда дошёл". */
  stepReached: number;
  /** Walked the guide to the end. */
  completed: boolean;
  /** Chose to skip (respected forever — never nagged again). */
  skipped: boolean;
}

export const FRESH_ONBOARD: OnboardState = {
  started: false,
  stepReached: 0,
  completed: false,
  skipped: false,
};

/** Passed onboarding = finished it OR chose to skip. The real "признак". */
export function isOnboarded(st: OnboardState): boolean {
  return st.completed || st.skipped;
}

export type WelcomeMode = 'new' | 'returning';

/** Brand-new (offer the guide) vs returning (already onboarded) branching. */
export function welcomeMode(st: OnboardState): WelcomeMode {
  return isOnboarded(st) ? 'returning' : 'new';
}

/** Fail-secure parse of persisted JSON — any malformed value yields FRESH. */
export function parseOnboardState(raw: string | null): OnboardState {
  if (!raw) return { ...FRESH_ONBOARD };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof OnboardState, unknown>>;
    const step =
      typeof v.stepReached === 'number' && Number.isFinite(v.stepReached) && v.stepReached >= 0
        ? Math.floor(v.stepReached)
        : 0;
    return {
      started: v.started === true,
      stepReached: step,
      completed: v.completed === true,
      skipped: v.skipped === true,
    };
  } catch {
    return { ...FRESH_ONBOARD };
  }
}

/** Mark the guide begun (idempotent). */
export function markStarted(st: OnboardState): OnboardState {
  return { ...st, started: true };
}

/** Record the furthest funnel step (monotonic — never rewinds). */
export function reachStep(st: OnboardState, step: number): OnboardState {
  const n = Number.isFinite(step) && step > 0 ? Math.floor(step) : 0;
  return { ...st, started: true, stepReached: Math.max(st.stepReached, n) };
}

/** Finished the guide (idempotent; leaves an earlier `skipped` untouched). */
export function markCompleted(st: OnboardState): OnboardState {
  return { ...st, started: true, completed: true };
}

/** Skipped the guide — respected forever (idempotent). */
export function markSkipped(st: OnboardState): OnboardState {
  return { ...st, started: true, skipped: true };
}

/** How a guide run ended — the fields `TourResult` (spotlight.ts) already carries. */
export interface TourOutcome {
  completed: boolean;
  skipped: boolean;
  reachedStep: number; // 0-based furthest step index, or -1
}

/**
 * Fold a finished guide run into the persisted state, and say whether THIS run
 * earns the onboarding reward — granted exactly once, on the first completion
 * (a replay of an already-completed guide returns `rewarded: false`). A skip
 * marks skipped; a safe-stop (neither completed nor skipped) only banks progress.
 */
export function applyTourOutcome(
  st: OnboardState,
  r: TourOutcome,
): { state: OnboardState; rewarded: boolean } {
  let next = reachStep(st, r.reachedStep + 1); // -1 → 0 (no progress)
  const rewarded = r.completed && !st.completed;
  if (r.completed) next = markCompleted(next);
  else if (r.skipped) next = markSkipped(next);
  return { state: next, rewarded };
}
