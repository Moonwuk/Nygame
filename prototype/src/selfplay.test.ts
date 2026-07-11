// M4 self-play prerequisite: the match seed must actually vary the RNG stream —
// with the historical fixed seed an identical setup plays out identically, so a
// 1000-match batch would be one match measured 1000 times.
import { describe, expect, it } from 'vitest';
import { newGame, DEFAULT_SETUP } from './game';

describe('newGame seed (M4 self-play)', () => {
  it('same seed → identical state (the determinism the core guarantees)', () => {
    const a = newGame({ ...DEFAULT_SETUP, seed: 'sp-1' });
    const b = newGame({ ...DEFAULT_SETUP, seed: 'sp-1' });
    expect(a).toEqual(b);
  });

  it('different seeds → different RNG streams', () => {
    const a = newGame({ ...DEFAULT_SETUP, seed: 'sp-1' });
    const b = newGame({ ...DEFAULT_SETUP, seed: 'sp-2' });
    expect(a.rng).not.toEqual(b.rng);
  });

  it('no seed → the historical fixed stream (back-compat for saves/replays)', () => {
    const legacy = newGame(DEFAULT_SETUP);
    const explicit = newGame({ ...DEFAULT_SETUP, seed: 'prototype-1' });
    expect(legacy.rng).toEqual(explicit.rng);
  });
});
