import { describe, expect, it } from 'vitest';
import {
  FIRST_GOALS,
  goalsComplete,
  mergeDone,
  metGoals,
  SCORE_GOAL,
  type GoalSignals,
} from './firstGoals';

const NONE: GoalSignals = {
  builtMine: false,
  launchedFleet: false,
  capturedWorld: false,
  score: 0,
};

describe('metGoals — each goal closes on its own signal', () => {
  it('is empty with no progress', () => {
    expect(metGoals(NONE).size).toBe(0);
  });

  it('closes the mine goal when a mine is built', () => {
    expect(metGoals({ ...NONE, builtMine: true })).toEqual(new Set(['mine']));
  });

  it('closes the fleet goal when a fleet is launched', () => {
    expect(metGoals({ ...NONE, launchedFleet: true })).toEqual(new Set(['fleet']));
  });

  it('closes the capture goal when a world is taken', () => {
    expect(metGoals({ ...NONE, capturedWorld: true })).toEqual(new Set(['capture']));
  });

  it('closes the score goal only at the threshold', () => {
    expect(metGoals({ ...NONE, score: SCORE_GOAL - 1 }).has('score')).toBe(false);
    expect(metGoals({ ...NONE, score: SCORE_GOAL }).has('score')).toBe(true);
  });
});

describe('mergeDone — monotonic', () => {
  it('adds newly-met goals in canonical order', () => {
    let done = mergeDone([], metGoals({ ...NONE, builtMine: true }));
    expect(done).toEqual(['mine']);
    done = mergeDone(done, metGoals({ ...NONE, capturedWorld: true }));
    expect(done).toEqual(['mine', 'capture']); // order follows FIRST_GOALS
  });

  it('never un-ticks a goal even if its signal drops', () => {
    const done = mergeDone(['mine'], metGoals(NONE)); // mine signal now false
    expect(done).toEqual(['mine']); // stays done
  });

  it('does not duplicate an already-done goal', () => {
    expect(mergeDone(['fleet'], new Set(['fleet']))).toEqual(['fleet']);
  });
});

describe('goalsComplete', () => {
  it('is true only when every goal is done', () => {
    expect(goalsComplete([])).toBe(false);
    expect(goalsComplete(['mine', 'fleet', 'capture'])).toBe(false);
    const all = FIRST_GOALS.map((g) => g.id);
    expect(goalsComplete(all)).toBe(true);
  });

  it('is reached by folding the full-progress signals', () => {
    const done = mergeDone(
      [],
      metGoals({ builtMine: true, launchedFleet: true, capturedWorld: true, score: 150 }),
    );
    expect(goalsComplete(done)).toBe(true);
  });
});
