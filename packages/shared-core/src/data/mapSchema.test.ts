import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseMatchMap, safeParseMatchMap } from './mapSchema';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readMap(name: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, 'data', 'maps', name), 'utf8'));
}

describe('map schema (map-roadmap.md M1.1)', () => {
  it('parses the shipped example map and applies defaults', () => {
    const map = parseMatchMap(readMap('skirmish-1.json'));
    expect(map.id).toBe('skirmish-1');
    expect(Object.keys(map.sectors)).toContain('nexus');
    expect(map.paths.length).toBe(4);
    // defaults: a sector with no owner → null; no kind → 'planet'; empty arrays
    expect(map.sectors.nexus!.owner).toBeNull();
    expect(map.sectors.nexus!.kind).toBe('nebula');
    expect(map.sectors.drift!.kind).toBe('asteroid');
    expect(map.sectors.home_green!.buildings.length).toBe(2);
    expect(map.sectors.veil!.garrison).toEqual([]);
    // building level defaults to 1
    expect(map.sectors.home_green!.buildings[0]!.level).toBe(1);
  });

  it('rejects a malformed map (missing sectors)', () => {
    expect(safeParseMatchMap({ id: 'x', seed: 'x' }).success).toBe(false);
  });

  it('rejects a sector with a non-numeric position', () => {
    const bad = { id: 'x', seed: 'x', sectors: { a: { position: { x: 'NaN', y: 0 } } } };
    expect(safeParseMatchMap(bad).success).toBe(false);
  });

  it('rejects a garrison stack with a zero/negative count', () => {
    const bad = {
      id: 'x',
      seed: 'x',
      sectors: { a: { position: { x: 0, y: 0 }, garrison: [{ unit: 'militia', count: 0 }] } },
    };
    expect(safeParseMatchMap(bad).success).toBe(false);
  });
});
