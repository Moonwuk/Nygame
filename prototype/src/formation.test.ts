import { describe, it, expect } from 'vitest';
import {
  formationStats,
  DEFAULT_TEMPLATES,
  FORMATION_SLOTS,
  type FormationStats,
  type FormationTemplate,
  type FormationUnit,
} from './game';

const tpl = (slots: (FormationUnit | null)[]): FormationTemplate => ({ name: 't', slots });
const keys = (f: FormationStats): string[] => f.synergies.map((x) => x.key).sort();

describe('formationStats — division template = Σ slots × composition synergy', () => {
  it('sums the slots and excludes empty ones', () => {
    const f = formationStats(tpl(['heavy_infantry', null, null, null, null, null]));
    expect(f.count).toBe(1);
    expect(f.byType).toEqual({ militia: 0, heavy_infantry: 1, special_forces: 0, tank: 0 });
    expect(f.attack).toBe(8); // single heavy infantry, no synergy
    expect(f.defense).toBe(20);
    expect(f.hp).toBe(34);
    expect(f.cost).toEqual({ metal: 55, credits: 15 });
    expect(f.synergies).toHaveLength(0);
  });

  it('combined-arms (infantry + tank together) gives +15% atk/def', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'tank', null, null, null]));
    // base atk 8+8+22=38, def 16+16+14=46; combined ×1.15 both.
    expect(f.attack).toBe(44); // round(38 × 1.15)
    expect(f.defense).toBe(62); // round(54 × 1.15)
    expect(f.hp).toBe(114); // 34 + 34 + 46
    expect(f.cost).toEqual({ metal: 230, credits: 60 });
    expect(keys(f)).toEqual(['combined']);
  });

  it('pure infantry entrenches (+25% defense), no other synergy', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry']));
    expect(f.attack).toBe(48); // 6×8, no atk synergy
    expect(f.defense).toBe(150); // round(6×20 × 1.25)
    expect(keys(f)).toEqual(['entrench']);
  });

  it('three or more tanks form an armoured fist (+20% attack)', () => {
    const f = formationStats(tpl(['tank', 'tank', 'tank', null, null, null]));
    expect(f.attack).toBe(79); // round(22×3 × 1.20)
    expect(f.defense).toBe(42); // 14×3, no def synergy (pure armour, no combined)
    expect(keys(f)).toEqual(['armor']);
  });

  it('every default template has 6 slots and is internally consistent', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.slots).toHaveLength(FORMATION_SLOTS);
      const f = formationStats(t);
      expect(f.count).toBe(t.slots.filter(Boolean).length);
      expect(f.attack).toBeGreaterThan(0);
    }
  });
});
