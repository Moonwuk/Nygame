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

describe('formationStats — combat-grounded rating (Σ roster mean) + doctrine labels', () => {
  // attack/defense = Σ over slots of the unit's MEAN per-target damage in GROUND_ROSTER
  // (the same table combat uses). heavy=5/8, tank=12/13.25, militia=2.75/3.75, sf=10/8.5.
  it('sums the slots and excludes empty ones', () => {
    const f = formationStats(tpl(['heavy_infantry', null, null, null, null, null]));
    expect(f.count).toBe(1);
    expect(f.byType).toEqual({ militia: 0, heavy_infantry: 1, special_forces: 0, tank: 0 });
    expect(f.attack).toBe(5); // heavy roster atk mean (7+5+5+3)/4
    expect(f.defense).toBe(8); // heavy roster def mean (10+8+8+6)/4
    expect(f.hp).toBe(34);
    expect(f.cost).toEqual({ metal: 55, credits: 15 });
    expect(f.synergies).toHaveLength(0);
  });

  it('combined-arms (infantry + tank together) — doctrine label, no combat bonus (BF-23)', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'tank', null, null, null]));
    // Ratings are the raw Σ of roster means — the doctrine is a label, not a multiplier.
    expect(f.attack).toBe(22); // 5+5+12
    expect(f.defense).toBe(29); // round(8+8+13.25)
    expect(f.hp).toBe(114); // 34 + 34 + 46
    expect(f.cost).toEqual({ metal: 230, credits: 60 });
    expect(keys(f)).toEqual(['combined']); // label still unlocked, just no effect
  });

  it('pure infantry entrenches — doctrine label only, no defence bonus (BF-23)', () => {
    const f = formationStats(tpl(['heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry', 'heavy_infantry']));
    expect(f.attack).toBe(30); // 6×5
    expect(f.defense).toBe(48); // 6×8, no multiplier
    expect(keys(f)).toEqual(['entrench']);
  });

  it('three or more tanks form an armoured fist — doctrine label, no attack bonus (BF-23)', () => {
    const f = formationStats(tpl(['tank', 'tank', 'tank', null, null, null]));
    expect(f.attack).toBe(36); // 12×3
    expect(f.defense).toBe(40); // round(13.25×3)
    expect(keys(f)).toEqual(['armor']);
  });

  it('fractional roster means round half-up — militia + special forces (BF-23 tail)', () => {
    const m = formationStats(tpl(['militia', null, null, null, null, null]));
    expect(m.attack).toBe(3); // round(2.75) — militia atk mean (4+3+3+1)/4
    expect(m.defense).toBe(4); // round(3.75) — militia def mean (5+4+4+2)/4
    const sf = formationStats(tpl(['special_forces', null, null, null, null, null]));
    expect(sf.attack).toBe(10); // sf atk mean (12+9+9+10)/4 = 10.0
    expect(sf.defense).toBe(9); // round(8.5) — exact half rounds up (Math.round)
    expect(keys(sf)).toEqual([]); // one spec-ops unit — no raid doctrine (needs ≥2)
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
