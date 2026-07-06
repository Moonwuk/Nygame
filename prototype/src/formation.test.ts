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
    const f = formationStats(tpl(['infantry', null, null, null, null, null]));
    expect(f.count).toBe(1);
    expect(f.byType).toEqual({ infantry: 1, tank: 0 });
    expect(f.attack).toBe(8); // single infantry, no synergy
    expect(f.defense).toBe(16);
    expect(f.hp).toBe(24);
    expect(f.cost).toEqual({ metal: 35 });
    expect(f.synergies).toHaveLength(0);
  });

  it('combined-arms (infantry + tank together) gives +15% atk/def', () => {
    const f = formationStats(tpl(['infantry', 'infantry', 'tank', null, null, null]));
    // base atk 8+8+22=38, def 16+16+14=46; combined ×1.15 both.
    expect(f.attack).toBe(44); // round(38 × 1.15)
    expect(f.defense).toBe(53); // round(46 × 1.15)
    expect(f.hp).toBe(94); // 24 + 24 + 46
    expect(f.cost).toEqual({ metal: 190, credits: 30 });
    expect(keys(f)).toEqual(['combined']);
  });

  it('pure infantry entrenches (+25% defense), no other synergy', () => {
    const f = formationStats(tpl(['infantry', 'infantry', 'infantry', 'infantry', 'infantry', 'infantry']));
    expect(f.attack).toBe(48); // 6×8, no atk synergy
    expect(f.defense).toBe(120); // round(6×16 × 1.25)
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
