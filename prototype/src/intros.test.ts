import { describe, expect, it } from 'vitest';
import {
  hasSeenIntro,
  INTROS,
  INTRO_BY_ID,
  markIntroSeen,
  parseSeenIntros,
  resolveIntro,
} from './intros';

describe('parseSeenIntros — fail-secure', () => {
  it('null / empty / garbage → empty set', () => {
    expect(parseSeenIntros(null)).toEqual([]);
    expect(parseSeenIntros('')).toEqual([]);
    expect(() => parseSeenIntros('{not json')).not.toThrow();
    expect(parseSeenIntros('{not json')).toEqual([]);
    expect(parseSeenIntros('"tech"')).toEqual([]); // not an array
  });

  it('keeps only known intro ids', () => {
    expect(parseSeenIntros(JSON.stringify(['tech', 'bogus', 'market', 42]))).toEqual([
      'tech',
      'market',
    ]);
  });

  it('round-trips a real seen-set', () => {
    const seen = ['tech', 'diplomacy'];
    expect(parseSeenIntros(JSON.stringify(seen))).toEqual(seen);
  });
});

describe('markIntroSeen / hasSeenIntro', () => {
  it('marks and reports membership, idempotently', () => {
    let seen: string[] = [];
    expect(hasSeenIntro(seen, 'tech')).toBe(false);
    seen = markIntroSeen(seen, 'tech');
    expect(hasSeenIntro(seen, 'tech')).toBe(true);
    expect(markIntroSeen(seen, 'tech')).toEqual(['tech']); // no duplicate
  });

  it('does not mutate its input', () => {
    const seen: string[] = [];
    markIntroSeen(seen, 'tech');
    expect(seen).toEqual([]);
  });
});

describe('resolveIntro — shown once', () => {
  it('returns the card on first contact, then never again', () => {
    const first = resolveIntro([], 'market');
    expect(first.card?.id).toBe('market');
    expect(first.seen).toContain('market');

    const second = resolveIntro(first.seen, 'market');
    expect(second.card).toBeNull(); // already seen
    expect(second.seen).toEqual(['market']);
  });

  it('is a no-op for an unknown panel id', () => {
    const r = resolveIntro([], 'nonesuch');
    expect(r.card).toBeNull();
    expect(r.seen).toEqual([]);
  });

  it('suppresses the card for a veteran but still marks it seen ("помечено сразу")', () => {
    const r = resolveIntro([], 'tech', { veteran: true });
    expect(r.card).toBeNull(); // not nagged
    expect(r.seen).toContain('tech'); // but recorded, so it stays quiet forever
  });

  it('every intro is a card with copy and a unique id', () => {
    const ids = INTROS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of INTROS) {
      expect(INTRO_BY_ID[c.id]).toBe(c);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });
});
