import { describe, expect, it } from 'vitest';
import { buildCodexIndex, searchCodex, GLOSSARY, type CodexEntry } from './codexIndex';

// A tiny stand-in for the loaded game data (real shape, few members).
const DATA = {
  units: {
    scout: { domain: 'space', line: 'front', traits: [] },
    strike_carrier: { domain: 'space', line: 'rear', traits: ['carrier'] },
    heavy_infantry: { domain: 'ground', line: 'front', traits: ['ground'] },
  },
  buildings: {
    mine: { name: 'Metal Mine', produces: { metal: 10 } },
    radar: { name: 'Radar Array', produces: {} },
  },
};

describe('buildCodexIndex', () => {
  it('indexes every unit, building and glossary term with deep-link keys', () => {
    const idx = buildCodexIndex(DATA, GLOSSARY);
    expect(idx.filter((e) => e.category === 'unit')).toHaveLength(3);
    expect(idx.filter((e) => e.category === 'building')).toHaveLength(2);
    expect(idx.filter((e) => e.category === 'mechanic')).toHaveLength(GLOSSARY.length);
    expect(idx.find((e) => e.key === 'u:scout')).toBeTruthy();
    expect(idx.find((e) => e.key === 'b:mine')?.title).toBe('Metal Mine');
    expect(idx.find((e) => e.key === 'm:fog')).toBeTruthy();
  });

  it('turns an underscored unit id into a readable title and tags it', () => {
    const e = buildCodexIndex(DATA).find((x) => x.key === 'u:strike_carrier')!;
    expect(e.title).toBe('strike carrier');
    expect(e.tags).toContain('carrier');
    expect(e.tags).toContain('space');
  });
});

describe('searchCodex', () => {
  const idx = buildCodexIndex(DATA, GLOSSARY);

  it('finds a unit by its title', () => {
    const hits = searchCodex(idx, 'scout');
    expect(hits.map((e) => e.key)).toContain('u:scout');
  });

  it('finds a building by its title, case-insensitively', () => {
    expect(searchCodex(idx, 'metal').map((e) => e.key)).toContain('b:mine');
    expect(searchCodex(idx, 'RADAR').map((e) => e.key)).toContain('b:radar');
  });

  it('finds entries by tag when the title does not match', () => {
    // 'ground' is a tag on heavy_infantry, not in its title
    const hits = searchCodex(idx, 'ground');
    expect(hits.map((e) => e.key)).toContain('u:heavy_infantry');
  });

  it('finds a glossary term by an English alias tag', () => {
    expect(searchCodex(idx, 'fog').map((e) => e.key)).toContain('m:fog');
    expect(searchCodex(idx, 'upkeep').map((e) => e.key)).toContain('m:upkeep');
  });

  it('ranks title matches ahead of tag-only matches', () => {
    // 'radar' is the Radar building's title AND a tag on the fog glossary term
    const hits = searchCodex(idx, 'radar');
    expect(hits[0].key).toBe('b:radar'); // title hit first
    expect(hits.map((e) => e.key)).toContain('m:fog'); // tag hit still present
  });

  it('returns every entry for an empty or blank query (category browse)', () => {
    expect(searchCodex(idx, '')).toHaveLength(idx.length);
    expect(searchCodex(idx, '   ')).toHaveLength(idx.length);
  });

  it('honours a custom textOf so a localised name is searchable', () => {
    const ru: Record<string, string> = { 'u:scout': 'разведчик' };
    const textOf = (e: CodexEntry) => (ru[e.key] ?? '').toLowerCase();
    expect(searchCodex(idx, 'развед', textOf).map((e) => e.key)).toContain('u:scout');
  });
});
