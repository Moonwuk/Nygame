import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadGameData } from './loadGameData';
import {
  parseArsenalItem,
  safeParseArsenalItem,
  validateArsenalItem,
  type ArsenalItem,
} from './arsenalSchema';

// ARS-1 — the arsenal item contract: the hybrid blueprint/instance model the owner
// resolved in ARS-0, validated fail-secure against the REAL shipped catalogs.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const data = loadGameData((name) =>
  JSON.parse(readFileSync(path.join(repoRoot, 'data', name), 'utf8')),
);

/** A hull/module/fitting id that actually exists in the shipped catalogs. */
const someId = (catalog: Record<string, unknown>): string => Object.keys(catalog).sort()[0]!;

describe('ArsenalItemSchema (ARS-1) — parse + the hybrid rule', () => {
  it('parses a minimal blueprint with the documented defaults', () => {
    const item = parseArsenalItem({ itemId: 'bp-1', kind: 'hull', defId: 'cruiser' });
    expect(item).toEqual({
      itemId: 'bp-1',
      kind: 'hull',
      form: 'blueprint',
      defId: 'cruiser',
      soulbound: false,
      origin: 'starter',
      acquiredAt: 0,
    });
  });

  it('parses a full instance (grade + durability + soulbound + origin)', () => {
    const item = parseArsenalItem({
      itemId: 'inst-1',
      kind: 'module',
      form: 'instance',
      defId: 'railgun',
      grade: 3,
      soulbound: true,
      durability: 5,
      origin: 'lootbox',
      acquiredAt: 123,
    });
    expect(item.form).toBe('instance');
    expect(item.grade).toBe(3);
    expect(item.durability).toBe(5);
  });

  it('the hybrid rule: a BLUEPRINT carries neither grade nor durability', () => {
    expect(
      safeParseArsenalItem({ itemId: 'x', kind: 'module', defId: 'm', grade: 1 }).success,
    ).toBe(false);
    expect(
      safeParseArsenalItem({ itemId: 'x', kind: 'module', defId: 'm', durability: 3 }).success,
    ).toBe(false);
    // the same fields on an INSTANCE are legal
    expect(
      safeParseArsenalItem({
        itemId: 'x',
        kind: 'module',
        form: 'instance',
        defId: 'm',
        grade: 1,
        durability: 3,
      }).success,
    ).toBe(true);
  });

  it('rejects malformed items fail-secure', () => {
    expect(safeParseArsenalItem({ itemId: '', kind: 'hull', defId: 'x' }).success).toBe(false);
    expect(safeParseArsenalItem({ itemId: 'a', kind: 'ship', defId: 'x' }).success).toBe(false); // unknown kind
    expect(safeParseArsenalItem({ itemId: 'a', kind: 'hull', defId: '' }).success).toBe(false);
    expect(
      safeParseArsenalItem({ itemId: 'a', kind: 'module', form: 'instance', defId: 'm', grade: 4 })
        .success,
    ).toBe(false); // grade past the EC-2.1 cap (+3)
    expect(
      safeParseArsenalItem({ itemId: 'a', kind: 'hull', defId: 'x', origin: 'gift' }).success,
    ).toBe(false); // unknown origin
  });

  it('round-trips through JSON unchanged', () => {
    const item = parseArsenalItem({
      itemId: 'rt-1',
      kind: 'hero_fitting',
      form: 'instance',
      defId: 'f',
      grade: 2,
      origin: 'craft',
      acquiredAt: 9,
    });
    expect(parseArsenalItem(JSON.parse(JSON.stringify(item)))).toEqual(item);
  });
});

describe('validateArsenalItem (ARS-1) — catalog check against the shipped bundle', () => {
  const item = (kind: ArsenalItem['kind'], defId: string): ArsenalItem =>
    parseArsenalItem({ itemId: 'i', kind, defId });

  it('accepts items whose defId exists in the right catalog', () => {
    expect(validateArsenalItem(item('hull', someId(data.units)), data)).toEqual([]);
    expect(validateArsenalItem(item('module', someId(data.modules)), data)).toEqual([]);
    expect(validateArsenalItem(item('hero_fitting', someId(data.heroFittings)), data)).toEqual([]);
  });

  it('rejects an unknown defId with a stable code — and checks the RIGHT catalog', () => {
    expect(validateArsenalItem(item('hull', 'no-such-hull'), data)).toEqual([
      'E_UNKNOWN_DEF:hull:no-such-hull',
    ]);
    // a real MODULE id is not a valid HULL — kinds don't cross-validate
    const moduleId = Object.keys(data.modules)
      .sort()
      .find((id) => !data.units[id])!;
    expect(validateArsenalItem(item('hull', moduleId), data)).toEqual([
      `E_UNKNOWN_DEF:hull:${moduleId}`,
    ]);
  });
});
