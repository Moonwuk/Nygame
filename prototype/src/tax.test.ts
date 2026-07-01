import { describe, it, expect } from 'vitest';
import { TAX_PER_HOUR, TAX_DIMINISH, civicTax, SCORE_LIMIT } from './game';

describe('civic tax (anti-snowball diminishing returns)', () => {
  it('a lone world pays the full base rate', () => {
    expect(civicTax(1)).toBe(TAX_PER_HOUR);
    expect(civicTax(0)).toBe(TAX_PER_HOUR); // guard: never divides below 1
  });

  it('per-world tax strictly decreases as the empire grows', () => {
    expect(civicTax(2)).toBeLessThan(civicTax(1));
    expect(civicTax(10)).toBeLessThan(civicTax(2));
    expect(civicTax(20)).toBeLessThan(civicTax(10));
    expect(civicTax(5)).toBeCloseTo(TAX_PER_HOUR / (1 + TAX_DIMINISH * 4));
  });

  it('total civic income still rises with territory, but sub-linearly (no runaway)', () => {
    const total = (n: number): number => n * civicTax(n);
    // more worlds ⇒ more total income (expansion still pays)
    expect(total(10)).toBeGreaterThan(total(5));
    expect(total(20)).toBeGreaterThan(total(10));
    // ...but far below the old flat-100 linear line (which was n × 100)
    expect(total(20)).toBeLessThan(20 * TAX_PER_HOUR * 0.6); // < 60% of the old 2000/h
  });
});

describe('victory score limit', () => {
  it('sits below the ~60% domination line so the score race can resolve first', () => {
    expect(SCORE_LIMIT).toBe(450);
    expect(SCORE_LIMIT).toBeLessThan(0.6 * 970); // 970 = board base points
  });
});
