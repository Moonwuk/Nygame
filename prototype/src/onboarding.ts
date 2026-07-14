/**
 * ONB-0 — first-launch state + funnel (docs/onboarding-roadmap.md).
 *
 * A real "has this commander finished onboarding" flag, separate from the remembered
 * callsign (`void.nick` only proves you've BEEN here, not that you got past the
 * tutorial). Persisted per-nick — `onboardingKey` mirrors `metaKey` in meta.ts — so it
 * moves to the server account the same way meta-progression will (SE-1.x).
 *
 * Pure module: no DOM, no storage access — main.ts feeds it state and persists.
 */

export interface OnboardingState {
  started: boolean;
  /** Highest step index the funnel has reached (monotonic; 0 = not started). */
  stepReached: number;
  completed: boolean;
  skipped: boolean;
}

const FRESH: OnboardingState = { started: false, stepReached: 0, completed: false, skipped: false };

export function onboardingKey(nick: string): string {
  return 'void.onboarded.' + (nick.trim() || 'guest');
}

/** Parse a persisted blob (fail-secure: garbage → a fresh, not-yet-onboarded state). */
export function parseOnboardingState(raw: string | null): OnboardingState {
  if (!raw) return { ...FRESH };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof OnboardingState, unknown>>;
    const stepReached =
      typeof v.stepReached === 'number' && Number.isFinite(v.stepReached) && v.stepReached >= 0
        ? Math.floor(v.stepReached)
        : 0;
    return {
      started: v.started === true,
      stepReached,
      completed: v.completed === true,
      skipped: v.skipped === true,
    };
  } catch {
    return { ...FRESH };
  }
}

/** Brand-new commander: the funnel has never touched this nick. Drives the
 *  new-vs-returning branch at sign-in (welcomeScreen's `mode`). */
export function isNewPlayer(state: OnboardingState): boolean {
  return !state.started && !state.completed && !state.skipped;
}

/** The funnel is over (finished or explicitly skipped) — never re-launch uninvited. */
export function isOnboardingDone(state: OnboardingState): boolean {
  return state.completed || state.skipped;
}

export function markStarted(state: OnboardingState): OnboardingState {
  return state.started ? state : { ...state, started: true };
}

/** Idempotent + monotonic: a stale/replayed step never rewinds progress. */
export function markStepReached(state: OnboardingState, step: number): OnboardingState {
  if (!Number.isFinite(step) || step <= state.stepReached) return state;
  return { ...state, stepReached: Math.floor(step) };
}

export function markCompleted(state: OnboardingState): OnboardingState {
  return state.completed ? state : { ...state, completed: true };
}

export function markSkipped(state: OnboardingState): OnboardingState {
  return state.skipped ? state : { ...state, skipped: true };
}
