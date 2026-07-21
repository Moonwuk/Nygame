import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@void/shared-core';
import {
  awardMatchDrops,
  chanceForPlace,
  pickFromPool,
  salvageFromEvents,
  validateDropTables,
  type DropTables,
} from './dropRoller';
import { loadDropTables, loadShippedData } from './scenario';
import { MemoryArsenalStore, MemoryDropStore } from './store';

// ARS-4 — the F2P drop loop: place 1 out-earns place N in expectation, pity caps a
// dry streak at K matches, salvage shards go to the battle winner and only them,
// and the whole pass is exactly-once under replay. All server-side, outside the core.

const data = loadShippedData();

const tables: DropTables = {
  pityAfter: 3,
  byPlace: [
    { maxPlace: 1, chance: 0.6 },
    { maxPlace: 3, chance: 0.3 },
    { maxPlace: 999, chance: 0.1 },
  ],
  pool: [
    { kind: 'hull', defId: 'siege_lance', weight: 1 },
    { kind: 'module', defId: 'targeting_array', weight: 3 },
  ],
  salvage: { default: 1, perUnit: { cruiser: 2 } },
};

function deps(overrides?: Partial<DropTables>): {
  drops: MemoryDropStore;
  arsenal: MemoryArsenalStore;
  tables: DropTables;
  now: number;
} {
  return {
    drops: new MemoryDropStore(),
    arsenal: new MemoryArsenalStore(),
    tables: { ...tables, ...overrides },
    now: 42,
  };
}

describe('drop tables (ARS-4)', () => {
  it('the SHIPPED tables load and validate against the shipped catalogs', () => {
    const shipped = loadDropTables(data);
    expect(shipped.pool.length).toBeGreaterThan(0);
    expect(validateDropTables(shipped, data)).toEqual([]);
  });

  it('unknown content / malformed numbers refuse to validate (fail-secure)', () => {
    const bad: DropTables = {
      pityAfter: 0,
      byPlace: [{ maxPlace: 1, chance: 1.5 }],
      pool: [{ kind: 'hull', defId: 'ghost_ship', weight: 0 }],
      salvage: { default: 1, perUnit: { phantom: 1 } },
    };
    expect(validateDropTables(bad, data)).toEqual([
      'E_BAD_PITY',
      'E_BAD_CHANCE:1',
      'E_BAD_WEIGHT:ghost_ship',
      'E_UNKNOWN_DEF:hull:ghost_ship',
      'E_UNKNOWN_DEF:salvage:phantom',
    ]);
  });

  it('chance is by first matching place row; an unlisted place earns 0', () => {
    expect(chanceForPlace(tables, 1)).toBe(0.6);
    expect(chanceForPlace(tables, 2)).toBe(0.3);
    expect(chanceForPlace(tables, 7)).toBe(0.1);
    expect(chanceForPlace({ ...tables, byPlace: [{ maxPlace: 1, chance: 1 }] }, 2)).toBe(0);
  });

  it('pickFromPool respects weights across the roll range', () => {
    expect(pickFromPool(tables.pool, 0.1).defId).toBe('siege_lance'); // first quarter
    expect(pickFromPool(tables.pool, 0.5).defId).toBe('targeting_array');
    expect(pickFromPool(tables.pool, 0.999).defId).toBe('targeting_array');
  });
});

describe('awardMatchDrops (ARS-4)', () => {
  it('place 1 drops more often than a bottom place (expectation over many matches)', async () => {
    const d = deps();
    let first = 0;
    let last = 0;
    for (let i = 0; i < 300; i++) {
      // Two accounts, fresh pity irrelevant: pityAfter high so only chance speaks.
      const d2 = { ...deps({ pityAfter: 1000 }), drops: d.drops, arsenal: d.arsenal };
      const records = await awardMatchDrops(d2, `m${i}`, [
        { accountId: 'winner', reward: { place: 1, xp: 0 } },
        { accountId: 'loser', reward: { place: 9, xp: 0 } },
      ]);
      first += records[0]?.dropped ? 1 : 0;
      last += records[1]?.dropped ? 1 : 0;
    }
    expect(first).toBeGreaterThan(last * 2); // 0.6 vs 0.1 — clear даже на 300 матчах
  });

  it('pity guarantees a drop on the K-th consecutive dry match', async () => {
    const d = deps({ byPlace: [{ maxPlace: 999, chance: 0 }] }); // chance 0 → pity only
    for (const [i, expectDrop] of [false, false, true, false, false, true].entries()) {
      const [record] = await awardMatchDrops(d, `pity-m${i}`, [
        { accountId: 'acc', reward: { place: 5, xp: 0 } },
      ]);
      expect(!!record?.dropped, `match ${i}`).toBe(expectDrop);
      if (expectDrop) expect(record?.forced).toBe(true);
    }
    expect((await d.arsenal.listOf('acc')).length).toBe(2); // exactly the two pity drops
  });

  it('a replayed match end rolls nothing twice (exactly-once by claim)', async () => {
    const d = deps({ byPlace: [{ maxPlace: 999, chance: 1 }] });
    const entries = [{ accountId: 'acc', reward: { place: 1, xp: 0 } }];
    const firstPass = await awardMatchDrops(d, 'm-replay', entries);
    const secondPass = await awardMatchDrops(d, 'm-replay', entries);
    expect(firstPass).toHaveLength(1);
    expect(secondPass).toHaveLength(0); // the claim already burned
    expect(await d.arsenal.listOf('acc')).toHaveLength(1);
    expect(await d.drops.pityOf('acc')).toBe(0); // no double bump either
  });

  it('a drop is a TRADABLE blueprint with origin drop; a dry roll bumps pity', async () => {
    const d = deps({ byPlace: [{ maxPlace: 1, chance: 1 }] });
    await awardMatchDrops(d, 'm-x', [
      { accountId: 'lucky', reward: { place: 1, xp: 0 } },
      { accountId: 'dry', reward: { place: 4, xp: 0 } },
    ]);
    const [item] = await d.arsenal.listOf('lucky');
    expect(item).toMatchObject({ form: 'blueprint', origin: 'drop', soulbound: false });
    expect(await d.drops.pityOf('dry')).toBe(1);
  });
});

describe('salvageFromEvents (ARS-4)', () => {
  const ev = (type: string, payload: Record<string, unknown>): DomainEvent =>
    ({ type, payload, at: 0 }) as unknown as DomainEvent;

  it('shards go to the battle winner, priced by fallen ENEMY units at that location', () => {
    const events = [
      ev('unit.died', { unit: 'cruiser', count: 2, at: 'P1', owner: 'red' }), // enemy: 2×2
      ev('unit.died', { unit: 'militia', count: 3, at: 'P1', owner: 'red' }), // enemy: 3×1
      ev('unit.died', { unit: 'cruiser', count: 1, at: 'P1', owner: 'green' }), // winner's own — not priced
      ev('unit.died', { unit: 'cruiser', count: 5, at: 'ELSEWHERE', owner: 'red' }), // other place
      ev('battle.resolved', { battleId: 'b1', location: 'P1', winner: 'green', phase: 'orbital' }),
    ];
    expect(salvageFromEvents(events, tables)).toEqual(new Map([['green', 7]]));
  });

  it('a stalemate (winner null) and a batch without battles salvage nothing', () => {
    expect(
      salvageFromEvents(
        [
          ev('unit.died', { unit: 'cruiser', count: 2, at: 'P1', owner: 'red' }),
          ev('battle.resolved', { battleId: 'b1', location: 'P1', winner: null, phase: 'orbital' }),
        ],
        tables,
      ).size,
    ).toBe(0);
    expect(salvageFromEvents([ev('time.advanced', {})], tables).size).toBe(0);
  });
});
