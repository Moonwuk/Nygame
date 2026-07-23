import { describe, expect, it } from 'vitest';
import { PLANET_NAMES, planetName } from './planetName';

describe('planetName — детерминированное имя мира из координаты', () => {
  it('один id → одно и то же имя (стабильно между вызовами/клиентами)', () => {
    expect(planetName('C2R1')).toBe(planetName('C2R1'));
    expect(planetName('C8R9')).toBe(planetName('C8R9'));
  });

  it('формат «{ИМЯ из пула}-{N=1..9}»', () => {
    for (const id of ['C2R1', 'C5R1', 'C1R7', 'x', 'cell-42']) {
      const nm = planetName(id);
      const m = /^([A-Z]+)-([1-9])$/.exec(nm);
      expect(m, `bad name ${nm}`).not.toBeNull();
      expect(PLANET_NAMES).toContain(m![1]);
    }
  });

  it('разные координаты дают разброс имён (не все одинаковые)', () => {
    const names = new Set(
      Array.from({ length: 50 }, (_, i) => planetName(`C${i % 9}R${Math.floor(i / 9)}`)),
    );
    expect(names.size).toBeGreaterThan(12);
  });
});
