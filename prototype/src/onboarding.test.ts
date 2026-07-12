import { describe, it, expect } from 'vitest';
import {
  onboardingKey,
  parseOnboardingState,
  isNewPlayer,
  isOnboardingDone,
  markStarted,
  markStepReached,
  markCompleted,
  markSkipped,
  type OnboardingState,
} from './onboarding';

const fresh: OnboardingState = { started: false, stepReached: 0, completed: false, skipped: false };

describe('onboarding — key + fail-secure parsing', () => {
  it('keys per-nick, falling back to "guest"', () => {
    expect(onboardingKey('Nyx')).toBe('void.onboarded.Nyx');
    expect(onboardingKey('  ')).toBe('void.onboarded.guest');
  });

  it('missing/garbage persisted state parses to fresh (never onboarded)', () => {
    expect(parseOnboardingState(null)).toEqual(fresh);
    expect(parseOnboardingState('not json')).toEqual(fresh);
    expect(parseOnboardingState('{"stepReached":-5}')).toEqual(fresh);
  });

  it('parses a valid blob, clamping a non-finite stepReached', () => {
    expect(parseOnboardingState('{"started":true,"stepReached":3,"completed":false,"skipped":false}')).toEqual({
      started: true,
      stepReached: 3,
      completed: false,
      skipped: false,
    });
    expect(parseOnboardingState('{"started":true,"stepReached":"nope"}')).toEqual({
      started: true,
      stepReached: 0,
      completed: false,
      skipped: false,
    });
  });
});

describe('onboarding — new vs returning branch', () => {
  it('a untouched nick is new; started/completed/skipped all flip it to returning', () => {
    expect(isNewPlayer(fresh)).toBe(true);
    expect(isNewPlayer(markStarted(fresh))).toBe(false);
    expect(isNewPlayer(markCompleted(fresh))).toBe(false);
    expect(isNewPlayer(markSkipped(fresh))).toBe(false);
  });

  it('onboarding is "done" only once finished or skipped — mid-tutorial keeps it live', () => {
    expect(isOnboardingDone(fresh)).toBe(false);
    expect(isOnboardingDone(markStarted(fresh))).toBe(false);
    expect(isOnboardingDone(markCompleted(fresh))).toBe(true);
    expect(isOnboardingDone(markSkipped(fresh))).toBe(true);
  });
});

describe('onboarding — the guide launches exactly once and is skippable', () => {
  it('markStarted is idempotent (same reference when already started)', () => {
    const started = markStarted(fresh);
    expect(markStarted(started)).toBe(started);
  });

  it('markCompleted/markSkipped are idempotent and respected once set', () => {
    const done = markCompleted(markStarted(fresh));
    expect(markCompleted(done)).toBe(done);
    expect(isNewPlayer(done)).toBe(false);

    const skipped = markSkipped(fresh);
    expect(markSkipped(skipped)).toBe(skipped);
    expect(isOnboardingDone(skipped)).toBe(true);
  });

  it('stepReached is monotonic — a stale/replayed lower step never rewinds it', () => {
    let st = markStarted(fresh);
    st = markStepReached(st, 2);
    expect(st.stepReached).toBe(2);
    st = markStepReached(st, 1); // stale replay
    expect(st.stepReached).toBe(2);
    st = markStepReached(st, 5);
    expect(st.stepReached).toBe(5);
  });

  it('the flag survives a reload (round-trips through JSON)', () => {
    const st = markStepReached(markStarted(fresh), 2);
    const roundTripped = parseOnboardingState(JSON.stringify(st));
    expect(roundTripped).toEqual(st);
  });
});
