import { describe, expect, it } from 'vitest';
import type { GameData, UnitDef, UnitStack } from '../../packages/shared-core/src/index';
import {
  ARCHETYPE_PATH,
  dominantUnit,
  unitArchetype,
  unitGlyphSvg,
  unitSizeClass,
} from './unitGlyphs';

// Компактные unit-def'ы под прототип-ростер: только поля, которые читает
// система силуэтов (traits/faction/stats/signature/radarRange/domain).
const U = (over: Partial<UnitDef> & { stats?: Partial<UnitDef['stats']> }): UnitDef =>
  ({
    faction: 'x',
    domain: 'space',
    line: 'front',
    traits: [],
    abilities: [],
    cost: {},
    buildTimeHours: 0,
    upkeep: {},
    signature: 3,
    radarRange: 0,
    slots: { weapon: 0, defense: 0, utility: 0 },
    ...over,
    stats: { attack: 10, defense: 8, speed: 40, hp: 50, ...(over.stats ?? {}) },
  }) as UnitDef;

describe('unitArchetype — роль из полей unit-def (постер: 6 архетипов)', () => {
  it('выводит все шесть архетипов по прототип-ростеру', () => {
    expect(unitArchetype(U({ traits: ['hero'] }))).toBe('flagship');
    expect(unitArchetype(U({ traits: ['artillery'], stats: { range: 240 } }))).toBe('artillery');
    expect(unitArchetype(U({ stats: { range: 200 } }))).toBe('artillery'); // range без трейта
    expect(unitArchetype(U({ faction: 'swarm' }))).toBe('swarm');
    expect(unitArchetype(U({ stats: { cargoCapacity: 8 } }))).toBe('transport'); // dropship
    expect(unitArchetype(U({ signature: 1, radarRange: 105, stats: { hp: 12 } }))).toBe('scout');
    expect(unitArchetype(U({ stats: { cargoCapacity: 5 } }))).toBe('combat'); // cruiser
  });

  it('приоритет: флагман бьёт остальные признаки, транспорт — скаута', () => {
    expect(unitArchetype(U({ traits: ['hero'], stats: { range: 300, cargoCapacity: 20 } }))).toBe(
      'flagship',
    );
    expect(unitArchetype(U({ signature: 1, radarRange: 105, stats: { cargoCapacity: 9 } }))).toBe(
      'transport',
    );
  });

  it('размер S/M/L по hp корабля', () => {
    expect(unitSizeClass(12)).toBe('S');
    expect(unitSizeClass(60)).toBe('M');
    expect(unitSizeClass(180)).toBe('L');
  });
});

describe('unitGlyphSvg — модификаторы поверх силуэта', () => {
  it('несёт путь архетипа, цвет стороны и гало при щите', () => {
    const svg = unitGlyphSvg(U({ stats: { shield: 15 } }), { color: '#3ad17a', shield: true });
    expect(svg).toContain(ARCHETYPE_PATH.combat);
    expect(svg).toContain('#3ad17a');
    expect(svg).toContain('stroke-dasharray');
  });

  it('флагман всегда с пунктирной орбитой, без щита гало нет', () => {
    expect(unitGlyphSvg(U({ traits: ['hero'] }), { color: '#fff' })).toContain('stroke-dasharray');
    expect(unitGlyphSvg(U({}), { color: '#fff' })).not.toContain('stroke-dasharray');
  });
});

describe('dominantUnit — доминант маркера карты', () => {
  const data = {
    units: {
      scout: U({ signature: 1, radarRange: 105, stats: { attack: 5, defense: 4, hp: 12 } }),
      cruiser: U({ stats: { attack: 16, defense: 14, hp: 60 } }),
      tank: U({ domain: 'ground', stats: { attack: 22, defense: 14, hp: 46 } }),
    },
  } as unknown as GameData;
  const st = (unit: string, count: number): UnitStack => ({ unit, count });

  it('берёт сильнейший корабль (attack+defense), земля и пустые стеки не участвуют', () => {
    expect(dominantUnit([st('scout', 9), st('cruiser', 1)], data)?.unit).toBe('cruiser');
    expect(dominantUnit([st('cruiser', 0), st('scout', 2)], data)?.unit).toBe('scout');
    expect(dominantUnit([st('tank', 5)], data)).toBeNull();
    expect(dominantUnit([], data)).toBeNull();
  });

  it('детерминирован при любом порядке стеков', () => {
    const ab = dominantUnit([st('scout', 1), st('cruiser', 1)], data);
    const ba = dominantUnit([st('cruiser', 1), st('scout', 1)], data);
    expect(ab?.unit).toBe(ba?.unit);
  });
});
