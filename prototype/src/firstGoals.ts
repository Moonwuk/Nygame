/**
 * ONB-7 · First-session goals — a light "am I playing right?" checklist for the
 * onboarding match. Four short goals close off the CORE loop (produce → build →
 * capture → score); each ticks from live game state, and finishing all four earns
 * praise + a nudge to play a real match (docs/onboarding-roadmap.md ONB-7).
 *
 * Pure module: no DOM, no game imports — main.ts derives the `GoalSignals` from
 * live state (against the match-start baseline) and this decides which goals are
 * met. Completion is monotonic (a met goal never un-ticks).
 */

export interface Goal {
  id: string;
  label: string; // canonical-Russian msgid, rendered through t()
}

/** Reach this score to close the last goal (home world alone is below it). */
export const SCORE_GOAL = 100;

/** The four first-match goals, in the order the guided match teaches them. */
export const FIRST_GOALS: Goal[] = [
  { id: 'mine', label: 'Построй шахту' },
  { id: 'fleet', label: 'Подними флот' },
  { id: 'capture', label: 'Захвати мир' },
  { id: 'score', label: 'Набери 100 очков' },
];

/** Live progress signals, measured against the onboarding match's start baseline. */
export interface GoalSignals {
  builtMine: boolean; // built a mine beyond the starting layout
  launchedFleet: boolean; // raised a mobile fleet
  capturedWorld: boolean; // owns a world beyond the start
  score: number; // current score
}

/** Which goal ids are currently satisfied by the signals. */
export function metGoals(sig: GoalSignals): Set<string> {
  const met = new Set<string>();
  if (sig.builtMine) met.add('mine');
  if (sig.launchedFleet) met.add('fleet');
  if (sig.capturedWorld) met.add('capture');
  if (sig.score >= SCORE_GOAL) met.add('score');
  return met;
}

/** Fold newly-met goals into the done-set (monotonic — order preserved). */
export function mergeDone(prev: readonly string[], met: ReadonlySet<string>): string[] {
  const out = [...prev];
  for (const g of FIRST_GOALS) if (met.has(g.id) && !out.includes(g.id)) out.push(g.id);
  return out;
}

/** All four goals achieved. */
export function goalsComplete(done: readonly string[]): boolean {
  return FIRST_GOALS.every((g) => done.includes(g.id));
}
