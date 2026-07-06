import { describe, expect, it } from 'vitest';
import {
  newGame,
  aiOrders,
  delegateSteward,
  recallSteward,
  stewardActive,
  kernel,
  data,
  HOUR,
  START_CANDIDATES,
} from './game';
import type { GameState } from '../../packages/shared-core/src/index';

// A 2-seat skirmish: p1 human, p2 AI — both spawn with a home fleet and reachable neutral
// worlds, so the default AI has somewhere to expand to.
function game2(): GameState {
  return newGame({
    seats: [
      { id: 'p1', name: 'A', faction: 'blue', start: START_CANDIDATES[0]!, ai: false },
      { id: 'p2', name: 'B', faction: 'red', start: START_CANDIDATES[1]!, ai: true },
    ],
  });
}

describe('aiOrders — Steward «Оборона» posture (brick 2)', () => {
  it('expands by default but HOLDS fleets under defend', () => {
    const s = game2();
    const moves = (posture: 'expand' | 'defend'): number =>
      aiOrders(s, 'p2', posture).filter((a) => a.type === 'fleet.move').length;
    // The full AI sends idle fleets off to capture; the defensive Steward never does —
    // "autopilot keeps you alive; active play wins".
    expect(moves('expand')).toBeGreaterThan(0);
    expect(moves('defend')).toBe(0);
  });
});

describe('steward delegation through the prototype kernel (bricks 1+2+3a)', () => {
  it('delegating (with the tech) reports the posture via stewardActive; recall clears it', () => {
    const s = game2();
    // The seat has researched «Протокол Хранитель» (unlocks ability `steward`), so delegation
    // clears the E_STEWARD_LOCKED gate.
    s.players.p1!.technologies = { completed: ['ai_stewardship'] };

    const r1 = kernel.applyAction(s, delegateSteward('p1', s.time + 8 * HOUR), {
      now: s.time,
      data,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(stewardActive(r1.state, 'p1', s.time + 4 * HOUR)).toBe('defend');

    const r2 = kernel.applyAction(r1.state, recallSteward('p1'), { now: r1.state.time, data });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(stewardActive(r2.state, 'p1', r2.state.time + HOUR)).toBeNull();
  });

  it('is refused (E_STEWARD_LOCKED) before the Steward tech is researched', () => {
    const s = game2(); // p1 chose «Куратор» but has NOT researched the tech yet
    const r = kernel.applyAction(s, delegateSteward('p1', s.time + 8 * HOUR), { now: s.time, data });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_STEWARD_LOCKED');
  });
});
