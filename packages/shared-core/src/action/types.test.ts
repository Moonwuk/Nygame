import { describe, it, expect } from 'vitest';
import { timeScaleOf, Rejection, parseActionId, type Context } from './types';
import { parseGameData, type GameData } from '../data/schemas';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
});

function ctx(config?: { timeScale: number }): Context {
  return { now: 0, data, config };
}

describe('timeScaleOf', () => {
  it('returns 1 when config is undefined', () => {
    expect(timeScaleOf(ctx())).toBe(1);
  });

  it('returns 1 when timeScale is zero', () => {
    expect(timeScaleOf(ctx({ timeScale: 0 }))).toBe(1);
  });

  it('returns 1 when timeScale is negative', () => {
    expect(timeScaleOf(ctx({ timeScale: -2 }))).toBe(1);
  });

  it('returns the timeScale when positive', () => {
    expect(timeScaleOf(ctx({ timeScale: 4 }))).toBe(4);
  });

  it('returns a fractional timeScale when valid', () => {
    expect(timeScaleOf(ctx({ timeScale: 0.5 }))).toBe(0.5);
  });
});

describe('Rejection', () => {
  it('has name "Rejection" and carries a stable code', () => {
    const r = new Rejection('E_FORBIDDEN');
    expect(r.name).toBe('Rejection');
    expect(r.code).toBe('E_FORBIDDEN');
    expect(r.message).toBe('E_FORBIDDEN');
  });

  it('is an instance of Error', () => {
    const r = new Rejection('E_INTERNAL');
    expect(r).toBeInstanceOf(Error);
  });
});

describe('parseActionId', () => {
  it('parses a valid id into parts', () => {
    const result = parseActionId('kepler:alice:47');
    expect(result).toEqual({ session: 'kepler', player: 'alice', sequence: 47 });
  });

  it('returns null for fewer than three parts', () => {
    expect(parseActionId('only:two')).toBeNull();
    expect(parseActionId('one')).toBeNull();
    expect(parseActionId('')).toBeNull();
  });

  it('returns null for more than three parts', () => {
    expect(parseActionId('a:b:c:d')).toBeNull();
  });

  it('returns null when session is empty', () => {
    expect(parseActionId(':player:1')).toBeNull();
  });

  it('returns null when player is empty', () => {
    expect(parseActionId('session::1')).toBeNull();
  });

  it('returns null when sequence is empty', () => {
    expect(parseActionId('session:player:')).toBeNull();
  });

  it('returns null for a non-numeric sequence', () => {
    expect(parseActionId('session:player:abc')).toBeNull();
  });

  it('returns null for a floating-point sequence', () => {
    expect(parseActionId('session:player:3.5')).toBeNull();
  });

  it('returns null for a negative sequence', () => {
    expect(parseActionId('session:player:-1')).toBeNull();
  });

  it('handles zero sequence', () => {
    expect(parseActionId('s:p:0')).toEqual({ session: 's', player: 'p', sequence: 0 });
  });

  it('returns null for a Number.MAX_SAFE_INTEGER + 1 (unsafe integer)', () => {
    const unsafe = `s:p:${Number.MAX_SAFE_INTEGER + 1}`;
    expect(parseActionId(unsafe)).toBeNull();
  });
});
