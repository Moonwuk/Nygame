import { describe, it, expect } from 'vitest';
import { filterArsenal, gradesOf, originOf, ownedDefIds, parseArsenalItems } from './arsenal';
import type { ArsenalItem } from '../../packages/shared-core/src/index';

const hull: ArsenalItem = {
  itemId: 'starter:acc:hull:cruiser',
  kind: 'hull',
  form: 'blueprint',
  defId: 'cruiser',
  soulbound: true,
  origin: 'starter',
  acquiredAt: 0,
};
const module1: ArsenalItem = {
  itemId: 'drop:acc:module:laser',
  kind: 'module',
  form: 'instance',
  defId: 'laser',
  grade: 2,
  soulbound: false,
  durability: 10,
  origin: 'drop',
  acquiredAt: 5,
};
const fitting: ArsenalItem = {
  itemId: 'starter:acc:hero_fitting:command',
  kind: 'hero_fitting',
  form: 'blueprint',
  defId: 'command',
  soulbound: true,
  origin: 'starter',
  acquiredAt: 0,
};
const all = [hull, module1, fitting];

describe('arsenal witryna — filter/group', () => {
  it('filters by kind', () => {
    expect(filterArsenal(all, { kind: 'module' })).toEqual([module1]);
    expect(filterArsenal(all, {})).toEqual(all);
  });

  it('filters by grade (blueprints without a grade never match a grade filter)', () => {
    expect(filterArsenal(all, { grade: 2 })).toEqual([module1]);
    expect(filterArsenal(all, { grade: 1 })).toEqual([]);
  });

  it('gradesOf collects only the graded instances, sorted', () => {
    expect(gradesOf(all)).toEqual([2]);
    expect(gradesOf([hull, fitting])).toEqual([]);
  });

  it('ownedDefIds narrows to one kind, deduped', () => {
    expect(ownedDefIds(all, 'hull')).toEqual(new Set(['cruiser']));
    expect(ownedDefIds(all, 'module')).toEqual(new Set(['laser']));
    expect(ownedDefIds(all, 'hero_fitting')).toEqual(new Set(['command']));
  });
});

describe('arsenal witryna — origin lookup (LARS-4)', () => {
  it('finds the origin of a defId the cache has', () => {
    expect(originOf(all, 'laser')).toBe('drop');
    expect(originOf(all, 'cruiser')).toBe('starter');
  });

  it('an unknown defId (empty/stale cache) is undefined, never a guess', () => {
    expect(originOf(all, 'nope')).toBeUndefined();
    expect(originOf([], 'cruiser')).toBeUndefined();
  });

  it('picks the MOST RECENTLY acquired instance when several share a defId', () => {
    const older: ArsenalItem = { ...module1, itemId: 'starter:acc:module:laser', origin: 'starter', acquiredAt: 1 };
    expect(originOf([older, module1], 'laser')).toBe('drop'); // module1.acquiredAt=5 wins
  });
});

describe('arsenal witryna — fail-secure parse', () => {
  it('parses a well-formed array', () => {
    expect(parseArsenalItems(all)).toEqual(all);
  });

  it('drops malformed entries instead of throwing', () => {
    expect(parseArsenalItems([hull, { garbage: true }, 42, null])).toEqual([hull]);
  });

  it('degrades non-array input to an empty arsenal', () => {
    expect(parseArsenalItems(null)).toEqual([]);
    expect(parseArsenalItems('nope')).toEqual([]);
    expect(parseArsenalItems(undefined)).toEqual([]);
  });
});
