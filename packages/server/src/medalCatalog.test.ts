import { describe, expect, it } from 'vitest';
import { loadMedalCatalog, parseMedalCatalog } from './medalCatalog';

// The medal catalog is DATA validated fail-secure: a bad shape or an unknown condition
// type throws rather than silently reading as eligible.

const valid = {
  medals: {
    m_win: { name: 'W', description: 'd', scope: 'corp', grant: 'manual', condition: { type: 'corp_wins', count: 3 } },
  },
};

describe('parseMedalCatalog', () => {
  it('parses a valid catalog and stamps each id', () => {
    const cat = parseMedalCatalog(valid);
    expect(cat.m_win).toMatchObject({
      id: 'm_win',
      scope: 'corp',
      grant: 'manual',
      condition: { type: 'corp_wins', count: 3 },
    });
  });

  it('rejects a missing medals object, bad scope/grant, and an unknown or non-integer condition', () => {
    expect(() => parseMedalCatalog({})).toThrow(/E_INVALID_MEDALS/);
    const bad = (over: Record<string, unknown>): unknown => ({
      medals: { x: { name: 'n', description: 'd', scope: 'corp', grant: 'manual', condition: { type: 'corp_wins', count: 1 }, ...over } },
    });
    expect(() => parseMedalCatalog(bad({ scope: 'galaxy' }))).toThrow(/E_INVALID_MEDALS/);
    expect(() => parseMedalCatalog(bad({ grant: 'wish' }))).toThrow(/E_INVALID_MEDALS/);
    expect(() => parseMedalCatalog(bad({ condition: { type: 'mind_reading', count: 1 } }))).toThrow(/E_INVALID_MEDALS/);
    expect(() => parseMedalCatalog(bad({ condition: { type: 'corp_wins', count: 0 } }))).toThrow(/E_INVALID_MEDALS/);
    expect(() => parseMedalCatalog(bad({ condition: { type: 'corp_wins', count: 1.5 } }))).toThrow(/E_INVALID_MEDALS/);
  });

  it('loads the shipped catalog — all MVP medals are manual corp medals', () => {
    const cat = loadMedalCatalog();
    expect(Object.keys(cat).length).toBeGreaterThan(0);
    for (const def of Object.values(cat)) {
      expect(def.scope).toBe('corp');
      expect(def.grant).toBe('manual');
    }
    expect(cat.ava_first_victory?.condition).toEqual({ type: 'corp_wins', count: 1 });
  });
});
