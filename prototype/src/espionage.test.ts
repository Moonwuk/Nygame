import { describe, it, expect } from 'vitest';
import { newGame, order, spyOn, advance, botFavour, FAVOUR_SPY_CAUGHT_HIT, HOUR, DAY } from './game';
import type { GameState } from '../../packages/shared-core/src/index';

// The core espionageModule (SPY-1) wired into the prototype kernel: `espionage.spy`
// burns a fee, rolls the seeded RNG and on success grants a live intel window in
// `state.intel[actor]`. These tests drive it через the prototype's own order() path —
// the same path the UI buttons use.

/** A rich actor so repeated attempts never trip E_INSUFFICIENT. */
function funded(): GameState {
  const s = newGame();
  s.players['p1']!.resources.credits = 100_000;
  return s;
}

/** Retry until the seeded roll lands a success (each attempt advances the RNG
 *  deterministically — with chance 0.6 a handful of tries always suffices). */
function spyUntilSuccess(
  s: GameState,
  target: string,
  kind: 'treasury' | 'planet' | 'fleets',
  planetId?: string,
): GameState {
  let st = s;
  for (let i = 0; i < 12; i++) {
    const out = order(st, spyOn('p1', target, kind, planetId), st.time);
    expect(out.error).toBeUndefined();
    st = out.state;
    if (st.intel?.['p1']?.some((g) => g.kind === kind)) return st;
  }
  throw new Error('no success in 12 seeded attempts — chance pipeline broken?');
}

describe('espionage in the prototype kernel (SPY-1 playable)', () => {
  it('spy on a treasury grants a live intel window and burns the fee', () => {
    const before = funded();
    const start = before.players['p1']!.resources.credits!;
    const st = spyUntilSuccess(before, 'p2', 'treasury');
    const grants = st.intel!['p1']!;
    expect(grants.some((g) => g.kind === 'treasury' && g.target === 'p2')).toBe(true);
    expect(st.players['p1']!.resources.credits!).toBeLessThan(start); // fee burned
  });

  it('planet kind demands the world actually belongs to the target', () => {
    const st = funded();
    const mine = Object.values(st.planets).find((p) => p.owner === 'p1')!;
    const out = order(st, spyOn('p1', 'p2', 'planet', mine.id), st.time);
    expect(out.error).toBe('E_BAD_TARGET'); // that world is not p2's
  });

  it('self-spying is rejected', () => {
    const out = order(funded(), spyOn('p1', 'p1', 'treasury'), 0);
    expect(out.error).toBe('E_BAD_TARGET');
  });

  it('windows expire: time.advanced prunes a stale grant', () => {
    const st = spyUntilSuccess(funded(), 'p2', 'fleets');
    expect(st.intel?.['p1']?.length).toBeGreaterThan(0);
    // 24h base window (timeScale-compressed) — two full days later it must be gone.
    const later = advance(st, st.time + 2 * DAY + HOUR).state;
    expect(later.intel?.['p1'] ?? []).toHaveLength(0);
  });

  it('SPY-2: a bot that catches your spy red-handed sours its favour toward you', () => {
    // Keep spying until an attempt is DETECTED with the spy identified (failed
    // attempt, base 0.4 × detect 0.5 → a couple dozen seeded tries always land one).
    let st = funded();
    for (let i = 0; i < 40; i++) {
      const before = botFavour(st, 'p2', 'p1');
      const out = order(st, spyOn('p1', 'p2', 'treasury'), st.time);
      expect(out.error).toBeUndefined();
      st = out.state;
      const caught = out.events.find(
        (e) => e.type === 'espionage.detected' && (e.payload as { spy?: string }).spy === 'p1',
      );
      if (caught) {
        expect((caught.payload as { owner: string }).owner).toBe('p2'); // addressed to the victim
        expect(botFavour(st, 'p2', 'p1')).toBe(Math.max(0, before - FAVOUR_SPY_CAUGHT_HIT));
        return;
      }
    }
    throw new Error('no red-handed detection in 40 seeded attempts');
  });
});
