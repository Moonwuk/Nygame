import { describe, expect, it } from 'vitest';
import { grantStarterArsenal, validateStarterArsenal } from './arsenal';
import { loadShippedData, loadStarterArsenal } from './scenario';
import { MemoryArsenalStore } from './store';

// ARS-2 — the starter arsenal: a fresh account is never empty, the grant is
// idempotent end to end, and the shipped set validates against the real catalogs.

const data = loadShippedData();

describe('starter arsenal (ARS-2)', () => {
  it('the SHIPPED starter set loads and validates against the shipped catalogs', () => {
    const templates = loadStarterArsenal(data);
    expect(templates.length).toBeGreaterThan(0);
    expect(validateStarterArsenal(templates, data)).toEqual([]);
    // hulls AND modules — the first Верфь visit has something in both columns
    expect(new Set(templates.map((t) => t.kind))).toEqual(new Set(['hull', 'module']));
  });

  it('a template naming content that does not ship refuses to load (fail-secure)', () => {
    expect(validateStarterArsenal([{ kind: 'hull', defId: 'ghost_ship' }], data)).toEqual([
      'E_UNKNOWN_DEF:hull:ghost_ship',
    ]);
  });

  it('grants the full set as SOULBOUND blueprints, idempotently', async () => {
    const store = new MemoryArsenalStore();
    const templates = loadStarterArsenal(data);
    await grantStarterArsenal(store, 'acc-1', templates, 42);
    await grantStarterArsenal(store, 'acc-1', templates, 999); // replayed registration
    const items = await store.listOf('acc-1');
    expect(items).toHaveLength(templates.length); // exactly once
    for (const item of items) {
      expect(item).toMatchObject({ form: 'blueprint', soulbound: true, origin: 'starter' });
      expect(item.acquiredAt).toBe(42); // the first grant won — the replay changed nothing
    }
    // registration farming mints nothing tradable: soulbound never transfers
    const first = items[0]!;
    expect(await store.transfer(first.itemId, 'acc-1', 'acc-2')).toEqual({
      ok: false,
      code: 'E_SOULBOUND',
    });
  });

  it('two accounts get independent sets (deterministic per-account item ids)', async () => {
    const store = new MemoryArsenalStore();
    const templates = loadStarterArsenal(data);
    await grantStarterArsenal(store, 'acc-a', templates, 1);
    await grantStarterArsenal(store, 'acc-b', templates, 1);
    expect(await store.listOf('acc-a')).toHaveLength(templates.length);
    expect(await store.listOf('acc-b')).toHaveLength(templates.length);
  });
});
