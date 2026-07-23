import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import type { GameState, UnitStack } from '../state/gameState';
import { sideDamage } from './combat';
import { cappedUnitStat, COMBAT_UNIT_CAP, sumUnitStat } from './stacks';

// gun out-shoots pea; howitzer is the only artillery piece; targeting is a +4
// attack module so a fitted stack sorts above a bare one of the same hull.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    gun: { faction: 'x', stats: { attack: 10, defense: 6, speed: 5, hp: 5 }, line: 'front' },
    pea: { faction: 'x', stats: { attack: 4, defense: 2, speed: 5, hp: 5 }, line: 'front' },
    howitzer: {
      faction: 'x',
      stats: { attack: 18, defense: 1, speed: 3, hp: 8, range: 200 },
      traits: ['artillery'],
    },
  },
  factions: {},
  buildings: {},
  events: {},
  modules: {
    targeting: {
      name: 'Targeting',
      slot: 'weapon',
      tag: 'vertical',
      cost: {},
      effects: { stats: { attack: 4 } },
    },
  },
});

const stack = (unit: string, count: number, extra: Partial<UnitStack> = {}): UnitStack => ({
  unit,
  count,
  ...extra,
});

describe('cappedUnitStat — the Bytro combat line cap', () => {
  it('matches sumUnitStat while the side fits under the cap', () => {
    const units = [stack('gun', 6), stack('pea', 4)];
    expect(cappedUnitStat(units, data, 'attack')).toBe(sumUnitStat(units, data, 'attack')); // 76
  });

  it(`caps the firing line at ${COMBAT_UNIT_CAP} units — extras add nothing`, () => {
    expect(cappedUnitStat([stack('gun', 12)], data, 'attack')).toBe(10 * 10);
    expect(cappedUnitStat([stack('gun', 10)], data, 'attack')).toBe(10 * 10);
    expect(cappedUnitStat([stack('gun', 200)], data, 'attack')).toBe(10 * 10);
  });

  it('fills the line strongest-first across stacks, independent of stack order', () => {
    // 6 guns (10) + 8 peas (4): the guns all fire, only 4 peas squeeze in.
    const ab = cappedUnitStat([stack('gun', 6), stack('pea', 8)], data, 'attack');
    const ba = cappedUnitStat([stack('pea', 8), stack('gun', 6)], data, 'attack');
    expect(ab).toBe(6 * 10 + 4 * 4);
    expect(ba).toBe(ab);
  });

  it('reads EFFECTIVE stats — a fitted stack outranks a bare one of the same hull', () => {
    // 3 fitted guns (14) fire first, then 7 of the 9 bare guns (10).
    const units = [stack('gun', 9), stack('gun', 3, { modules: ['targeting'] })];
    expect(cappedUnitStat(units, data, 'attack')).toBe(3 * 14 + 7 * 10);
  });

  it('the eligible filter excludes units from firing AND from spending the budget', () => {
    const units = [stack('howitzer', 2), stack('gun', 12)];
    const artilleryOnly = (def: { traits: string[] }): boolean => def.traits.includes('artillery');
    expect(cappedUnitStat(units, data, 'attack', artilleryOnly)).toBe(2 * 18);
    // Unfiltered, the howitzers head the line and the guns fill the rest.
    expect(cappedUnitStat(units, data, 'attack')).toBe(2 * 18 + 8 * 10);
  });

  it('honours a custom cap and skips empty/unknown stacks', () => {
    expect(cappedUnitStat([stack('gun', 12)], data, 'attack', undefined, 2)).toBe(2 * 10);
    expect(cappedUnitStat([stack('gun', 0), stack('nosuch', 5)], data, 'attack')).toBe(0);
    expect(cappedUnitStat([], data, 'attack')).toBe(0);
  });
});

describe('sideDamage rides the cap for every combatant kind', () => {
  it('caps a fleet, a landing force and a garrison alike', () => {
    const state = {
      fleets: { f1: { units: [stack('gun', 12)], landing: [stack('pea', 14)] } },
      planets: { P: { garrison: [stack('pea', 25)] } },
    } as unknown as GameState;
    expect(sideDamage(state, { kind: 'fleet', fleetId: 'f1' }, data, 'attack')).toBe(10 * 10);
    expect(sideDamage(state, { kind: 'landing', fleetId: 'f1' }, data, 'attack')).toBe(10 * 4);
    expect(sideDamage(state, { kind: 'garrison', planetId: 'P' }, data, 'defense')).toBe(10 * 2);
  });
});
