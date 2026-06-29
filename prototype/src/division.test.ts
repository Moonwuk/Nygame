import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  advance,
  mobilizeDivision,
  divisionsOf,
  DAY,
  START_CANDIDATES,
} from './game';
import { GROUND_ROSTER } from './groundcombat';

const HOME = START_CANDIDATES[0]!; // p1's homeworld in the default setup
const ENEMY = START_CANDIDATES[1]!; // p2's homeworld

/** A fresh game with p1's treasury topped up so mobilisation is affordable. */
function richGame() {
  const s = newGame();
  s.players.p1!.resources.metal = 5000;
  s.players.p1!.resources.credits = 5000;
  return s;
}
const total = (units: { count: number }[]) => units.reduce((n, u) => n + u.count, 0);

describe('divisions — mobilisation', () => {
  it('mobilises a full-strength division on an owned world and charges the cost', () => {
    const s = richGame();
    const before = s.players.p1!.resources.metal;
    const r = order(s, mobilizeDivision('p1', HOME, 0), s.time); // template 0 = Линия (6 units)
    expect(r.error).toBeUndefined();
    const divs = divisionsOf(r.state);
    const ids = Object.keys(divs);
    expect(ids).toHaveLength(1);
    const d = divs[ids[0]!]!;
    expect(d.owner).toBe('p1');
    expect(d.location).toBe(HOME);
    expect(total(d.units)).toBe(6);
    expect(r.state.players.p1!.resources.metal).toBeLessThan(before); // paid up front
  });

  it('rejects mobilisation on a non-owned world, a bad template, or when broke', () => {
    expect(order(richGame(), mobilizeDivision('p1', ENEMY, 0), 0).error).toBe('E_FORBIDDEN');
    expect(order(richGame(), mobilizeDivision('p1', HOME, 9), 0).error).toBe('E_NO_TEMPLATE');
    expect(order(newGame(), mobilizeDivision('p1', HOME, 0), 0).error).toBe('E_NO_FUNDS'); // 320 metal < cost
  });
});

describe('divisions — daily restoration on a friendly planet', () => {
  it('heals survivors and regrows fully-dead types toward the template', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    // Damage it: one battered infantryman left, tank + bomber wiped.
    divisionsOf(st)[id]!.units = [{ type: 'infantry', count: 1, hp: 5, hpEach: GROUND_ROSTER.infantry!.hp }];
    const after = divisionsOf(advance(st, st.time + 10 * DAY).state)[id]!;
    expect(total(after.units)).toBeGreaterThan(1); // healed + regrew
    expect(after.units.some((u) => u.type === 'tank' && u.count > 0)).toBe(true); // tank rebuilt
  });

  it('does NOT heal a division standing on a non-friendly world', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    divisionsOf(st)[id]!.location = ENEMY; // p2's world — not friendly
    divisionsOf(st)[id]!.units = [{ type: 'infantry', count: 1, hp: 5, hpEach: GROUND_ROSTER.infantry!.hp }];
    const after = divisionsOf(advance(st, st.time + 10 * DAY).state)[id]!;
    expect(total(after.units)).toBe(1); // no healing off home soil
    expect(after.units[0]!.hp).toBe(5);
  });

  it('never resurrects a fully-wiped division', () => {
    const r = order(richGame(), mobilizeDivision('p1', HOME, 0), 0);
    const st = r.state;
    const id = Object.keys(divisionsOf(st))[0]!;
    divisionsOf(st)[id]!.units = []; // wiped
    const after = divisionsOf(advance(st, st.time + 30 * DAY).state)[id]!;
    expect(total(after.units)).toBe(0); // stays dead
  });
});
