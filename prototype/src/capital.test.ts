import { describe, it, expect } from 'vitest';
import { newGame, order, designateCapital, capitalOf, START_CANDIDATES } from './game';

const HOME = START_CANDIDATES[0]!; // p1 homeworld
const ENEMY = START_CANDIDATES[1]!; // p2 homeworld

describe('capital — designatable home, defaults to the homeworld', () => {
  it('defaults to the homeworld at match start', () => {
    expect(capitalOf(newGame(), 'p1')).toBe(HOME);
    expect(capitalOf(newGame(), 'p2')).toBe(ENEMY);
  });

  it('moves to another owned inhabited world', () => {
    const s = newGame();
    const w = Object.values(s.planets).find((p) => p.kind === 'planet' && p.owner === null)!;
    w.owner = 'p1';
    const r = order(s, designateCapital('p1', w.id), 0);
    expect(r.error).toBeUndefined();
    expect(capitalOf(r.state, 'p1')).toBe(w.id);
  });

  it('repoints the owner heroes home at the new capital (hero respawn anchor)', () => {
    const s = newGame();
    const home0 = capitalOf(s, 'p1');
    const hero0 = Object.values(s.heroes ?? {}).find((h) => h.owner === 'p1');
    expect(hero0?.home).toBe(home0); // seeded at the homeworld
    const w = Object.values(s.planets).find((p) => p.kind === 'planet' && p.owner === null)!;
    w.owner = 'p1';
    const r = order(s, designateCapital('p1', w.id), 0);
    const hero = Object.values(r.state.heroes ?? {}).find((h) => h.owner === 'p1');
    expect(hero?.home).toBe(w.id); // follows the capital
  });

  it('rejects a foreign world, a non-inhabited world, or a missing one', () => {
    const s = newGame();
    expect(order(s, designateCapital('p1', ENEMY), 0).error).toBe('E_FORBIDDEN'); // p2's world
    const rock = Object.values(s.planets).find((p) => p.kind === 'asteroid')!; // no orbital layer
    rock.owner = 'p1';
    expect(order(s, designateCapital('p1', rock.id), 0).error).toBe('E_NOT_INHABITED');
    expect(order(s, designateCapital('p1', 'NO_SUCH_WORLD'), 0).error).toBe('E_NO_PLANET');
    expect(capitalOf(s, 'p1')).toBe(HOME); // unchanged after the rejects
  });
});
