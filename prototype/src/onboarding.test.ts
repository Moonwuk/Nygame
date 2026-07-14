import { describe, expect, it } from 'vitest';
import {
  applyTourOutcome,
  FRESH_ONBOARD,
  isOnboarded,
  markCompleted,
  markSkipped,
  markStarted,
  parseOnboardState,
  reachStep,
  welcomeMode,
  type OnboardState,
} from './onboarding';

describe('welcomeMode — new vs returning', () => {
  it('is "new" for a fresh commander and "returning" once onboarded', () => {
    expect(welcomeMode(FRESH_ONBOARD)).toBe('new');
    expect(isOnboarded(FRESH_ONBOARD)).toBe(false);
    expect(welcomeMode(markCompleted(FRESH_ONBOARD))).toBe('returning');
    expect(welcomeMode(markSkipped(FRESH_ONBOARD))).toBe('returning');
  });

  it('stays "new" while merely started but not finished/skipped', () => {
    const started = markStarted(FRESH_ONBOARD);
    expect(welcomeMode(started)).toBe('new'); // began but bailed → still offered
    expect(isOnboarded(started)).toBe(false);
  });
});

describe('completed — idempotent', () => {
  it('marking complete twice yields an equal state', () => {
    const once = markCompleted(FRESH_ONBOARD);
    const twice = markCompleted(once);
    expect(twice).toEqual(once);
    expect(isOnboarded(twice)).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = { ...FRESH_ONBOARD };
    markCompleted(input);
    expect(input).toEqual(FRESH_ONBOARD);
  });
});

describe('skip — respected', () => {
  it('a skip makes the commander onboarded and is not undone by later starts', () => {
    let st = markSkipped(FRESH_ONBOARD);
    expect(isOnboarded(st)).toBe(true);
    st = markStarted(st); // replay via «Ещё → Обучение»
    expect(isOnboarded(st)).toBe(true); // still onboarded — never nagged again
    expect(welcomeMode(st)).toBe('returning');
  });

  it('completing a skipped guide keeps both flags, still onboarded', () => {
    const st = markCompleted(markSkipped(FRESH_ONBOARD));
    expect(st.skipped).toBe(true);
    expect(st.completed).toBe(true);
    expect(isOnboarded(st)).toBe(true);
  });
});

describe('reachStep — monotonic funnel', () => {
  it('advances to the furthest step and never rewinds', () => {
    let st = reachStep(FRESH_ONBOARD, 2);
    expect(st.stepReached).toBe(2);
    expect(st.started).toBe(true);
    st = reachStep(st, 4);
    expect(st.stepReached).toBe(4);
    st = reachStep(st, 1); // an earlier step must not lower the high-water mark
    expect(st.stepReached).toBe(4);
  });

  it('clamps junk step values to 0', () => {
    expect(reachStep(FRESH_ONBOARD, -3).stepReached).toBe(0);
    expect(reachStep(FRESH_ONBOARD, Number.NaN).stepReached).toBe(0);
  });
});

describe('parseOnboardState — fail-secure', () => {
  it('null / empty → fresh', () => {
    expect(parseOnboardState(null)).toEqual(FRESH_ONBOARD);
    expect(parseOnboardState('')).toEqual(FRESH_ONBOARD);
  });

  it('malformed JSON → fresh, never throws', () => {
    expect(() => parseOnboardState('{not json')).not.toThrow();
    expect(parseOnboardState('{not json')).toEqual(FRESH_ONBOARD);
  });

  it('wrong-typed fields are sanitised', () => {
    const st = parseOnboardState(
      JSON.stringify({ started: 'yes', stepReached: '5', completed: 1, skipped: true }),
    );
    expect(st).toEqual<OnboardState>({
      started: false, // 'yes' is not the boolean true
      stepReached: 0, // '5' is a string, not a finite number
      completed: false, // 1 is not the boolean true
      skipped: true,
    });
  });

  it('round-trips a real state through JSON', () => {
    const original = markCompleted(reachStep(markStarted(FRESH_ONBOARD), 3));
    expect(parseOnboardState(JSON.stringify(original))).toEqual(original);
  });

  it('floors a fractional stepReached and rejects a negative one', () => {
    expect(parseOnboardState(JSON.stringify({ stepReached: 2.9 })).stepReached).toBe(2);
    expect(parseOnboardState(JSON.stringify({ stepReached: -1 })).stepReached).toBe(0);
  });
});

describe('applyTourOutcome — fold a finished guide run', () => {
  it('rewards the FIRST completion and marks onboarded', () => {
    const { state, rewarded } = applyTourOutcome(FRESH_ONBOARD, {
      completed: true,
      skipped: false,
      reachedStep: 7,
    });
    expect(rewarded).toBe(true);
    expect(state.completed).toBe(true);
    expect(isOnboarded(state)).toBe(true);
    expect(state.stepReached).toBe(8); // reachedStep 7 (0-based) → 8 steps deep
  });

  it('does NOT reward a replay of an already-completed guide', () => {
    const done = markCompleted(FRESH_ONBOARD);
    const { rewarded, state } = applyTourOutcome(done, {
      completed: true,
      skipped: false,
      reachedStep: 7,
    });
    expect(rewarded).toBe(false);
    expect(state.completed).toBe(true);
  });

  it('a skip marks skipped and never rewards', () => {
    const { state, rewarded } = applyTourOutcome(FRESH_ONBOARD, {
      completed: false,
      skipped: true,
      reachedStep: 2,
    });
    expect(rewarded).toBe(false);
    expect(state.skipped).toBe(true);
    expect(state.stepReached).toBe(3);
  });

  it('a safe-stop only banks progress (not onboarded, no reward)', () => {
    const { state, rewarded } = applyTourOutcome(FRESH_ONBOARD, {
      completed: false,
      skipped: false,
      reachedStep: 4,
    });
    expect(rewarded).toBe(false);
    expect(isOnboarded(state)).toBe(false);
    expect(state.started).toBe(true);
    expect(state.stepReached).toBe(5);
  });
});
