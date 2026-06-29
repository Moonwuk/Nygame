import { describe, it, expect } from 'vitest';
import { newGame, capitalOf } from './game';
import { heroSlots } from './heroes';

describe('hero state seed — the commander deploys as a main-grade hero', () => {
  it('seeds one hero per seat: main grade, named, homed at the capital, on the home fleet', () => {
    const s = newGame();
    const heroes = Object.values(s.heroes ?? {});
    expect(heroes.length).toBeGreaterThan(0);
    for (const h of heroes) {
      expect(h.id).toBe(`hero:${h.owner}`); // instance-keyed
      expect(h.grade).toBe('main'); // the deployed flagship is the main hero
      expect(h.alive).toBe(true);
      expect(h.name && h.name.length).toBeTruthy(); // named by the commander's nick
      expect(h.home).toBe(capitalOf(s, h.owner)); // respawn anchor = capital (homeworld at start)
      expect(h.fleetId).toBe(`${h.owner}-1`); // rides the home fleet
      expect(s.fleets[h.fleetId!]?.units.some((u) => u.unit === 'hero')).toBe(true);
      expect((h.abilities ?? []).length).toBeLessThanOrEqual(heroSlots('main')); // ≤ 4 module slots
    }
  });
});
