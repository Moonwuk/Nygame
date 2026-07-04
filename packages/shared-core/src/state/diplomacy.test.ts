import { describe, it, expect } from 'vitest';
import { createInitialState, type GameState } from './gameState';
import {
  DEFAULT_STANCE,
  pairKey,
  getStance,
  setStance,
  offerKey,
  offerInvolves,
  getOffer,
  setOffer,
  clearOffers,
} from './diplomacy';
import { diffState, applyDelta } from './delta';
import { deepClone, deepFreeze } from '../util/clone';

function base(): GameState {
  return createInitialState({ seed: 'dip', version: { data: '0.1.0', manifest: '1' } });
}

describe('diplomacy — pair key', () => {
  it('is canonical: order-independent', () => {
    expect(pairKey('p1', 'p2')).toBe(pairKey('p2', 'p1'));
  });

  it('distinguishes different pairs', () => {
    expect(pairKey('p1', 'p2')).not.toBe(pairKey('p1', 'p3'));
  });
});

describe('diplomacy — getStance', () => {
  it('defaults to war for an unrecorded pair', () => {
    expect(getStance(base(), 'p1', 'p2')).toBe('war');
    expect(DEFAULT_STANCE).toBe('war');
  });

  it('defaults to war even when the diplomacy map is absent', () => {
    const s = base();
    expect(s.diplomacy).toBeUndefined();
    expect(getStance(s, 'p1', 'p2')).toBe(DEFAULT_STANCE);
  });

  it('treats a player as allied with themselves', () => {
    expect(getStance(base(), 'p1', 'p1')).toBe('alliance');
  });
});

describe('diplomacy — setStance', () => {
  it('records a stance, read back symmetrically', () => {
    const s = base();
    setStance(s, 'p1', 'p2', 'alliance');
    expect(getStance(s, 'p1', 'p2')).toBe('alliance');
    expect(getStance(s, 'p2', 'p1')).toBe('alliance'); // symmetric
  });

  it('lazily creates the map and leaves other pairs at default', () => {
    const s = base();
    setStance(s, 'p1', 'p2', 'peace');
    expect(s.diplomacy).toBeDefined();
    expect(getStance(s, 'p1', 'p3')).toBe('war'); // untouched pair still default
    expect(getStance(s, 'p2', 'p3')).toBe('war');
  });

  it('overwrites an existing stance', () => {
    const s = base();
    setStance(s, 'p1', 'p2', 'pact');
    setStance(s, 'p2', 'p1', 'war'); // same pair, reversed order
    expect(getStance(s, 'p1', 'p2')).toBe('war');
  });

  it('is a no-op for a player against themselves', () => {
    const s = base();
    setStance(s, 'p1', 'p1', 'war');
    expect(s.diplomacy).toBeUndefined();
  });

  it('does not mutate a frozen input it was not given (purity of the read path)', () => {
    const s = deepFreeze(base());
    expect(() => getStance(s, 'p1', 'p2')).not.toThrow(); // getStance never writes
  });
});

describe('diplomacy — offers (D3 primitives)', () => {
  it('offer keys are DIRECTED and involvement is by either end', () => {
    expect(offerKey('p1', 'p2')).not.toBe(offerKey('p2', 'p1'));
    expect(offerInvolves(offerKey('p1', 'p2'), 'p1')).toBe(true);
    expect(offerInvolves(offerKey('p1', 'p2'), 'p2')).toBe(true);
    expect(offerInvolves(offerKey('p1', 'p2'), 'p3')).toBe(false);
  });

  it('set / get / clear round-trip, clearing both directions and dropping the empty map', () => {
    const s = base();
    expect(getOffer(s, 'p1', 'p2')).toBeNull(); // absent map reads as no offer
    setOffer(s, 'p1', 'p2', 'peace');
    setOffer(s, 'p2', 'p1', 'pact');
    expect(getOffer(s, 'p1', 'p2')).toBe('peace');
    expect(getOffer(s, 'p2', 'p1')).toBe('pact');
    clearOffers(s, 'p2', 'p1'); // order-independent: voids both directions
    expect(getOffer(s, 'p1', 'p2')).toBeNull();
    expect(s.diplomacyOffers).toBeUndefined(); // emptied map is dropped
  });

  it('a self-offer is a no-op', () => {
    const s = base();
    setOffer(s, 'p1', 'p1', 'peace');
    expect(s.diplomacyOffers).toBeUndefined();
  });

  it('an offers change is carried by the state delta', () => {
    const prev = deepFreeze(base());
    const next = deepClone(prev);
    setOffer(next, 'p1', 'p2', 'peace');
    const delta = diffState(prev, next);
    expect(delta.meta).toHaveProperty('diplomacyOffers');
    expect(applyDelta(prev, delta)).toEqual(next);
    // …and clearing the last offer removes the key on the wire (removedMeta).
    const cleared = deepClone(next);
    clearOffers(cleared, 'p1', 'p2');
    const wire = JSON.parse(JSON.stringify(diffState(next, cleared)));
    const rebuilt = applyDelta(next, wire);
    expect('diplomacyOffers' in rebuilt).toBe(false);
  });
});

describe('diplomacy — serialization & sync', () => {
  it('round-trips through JSON (state stays serializable)', () => {
    const s = base();
    setStance(s, 'p1', 'p2', 'alliance');
    const back = JSON.parse(JSON.stringify(s)) as GameState;
    expect(getStance(back, 'p1', 'p2')).toBe('alliance');
  });

  it('a diplomacy change is carried by the state delta', () => {
    const prev = deepFreeze(base());
    const next = deepClone(prev);
    setStance(next, 'p1', 'p2', 'alliance');
    const delta = diffState(prev, next);
    expect(delta.meta).toHaveProperty('diplomacy');
    expect(applyDelta(prev, delta)).toEqual(next);
  });
});
