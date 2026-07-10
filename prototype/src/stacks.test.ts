import { describe, it, expect } from 'vitest';
import { newGame, order, splitFleet, mergeFleet } from './game';
import type { GameState, Fleet, UnitStack } from '../../packages/shared-core/src/index';

// BF-4 / BF-5 (bug-hunt 2026-07-10): fleet.split/merge mishandled per-stack POOLS
// (hp/shieldHp are whole-stack pools) and ignored loadout identity — a split copied
// the whole hp pool onto both halves (combat then minted extra ships), and a merge
// coalesced stacks by (unit, hp) only, smearing or destroying paid modules. These
// pin the corrected apportion-and-loadout-aware helpers through the real builders.

/** Put a single fleet under p1's sole homeworld so split/merge preconditions pass
 *  (co-located, idle, not in transit). Returns the mutated state. */
function withFleets(fleets: Record<string, Fleet>): GameState {
  const s = newGame();
  const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
  s.fleets = {};
  for (const [id, f] of Object.entries(fleets)) {
    s.fleets[id] = { ...f, id, owner: 'p1', location: home.id, movement: null };
  }
  return s;
}
const stackOf = (units: UnitStack[], unit: string): UnitStack | undefined =>
  units.find((u) => u.unit === unit);
const poolOf = (units: UnitStack[], unit: string): number | undefined => stackOf(units, unit)?.hp;

describe('BF-4 — fleet.split apportions the HP pool (no duplication)', () => {
  it('splits a damaged stack pro-rata: the two halves sum to the original pool', () => {
    // 10 cruisers, hull pool 300 (of a full 600) — battle-damaged.
    const s = withFleets({ 'p1-1': { units: [{ unit: 'cruiser', count: 10, hp: 300 }] } as Fleet });
    const out = order(s, splitFleet('p1', 'p1-1', [{ unit: 'cruiser', count: 4 }]), s.time);
    expect(out.error).toBeUndefined();
    const src = out.state.fleets['p1-1']!;
    const wing = Object.values(out.state.fleets).find((f) => f.id !== 'p1-1')!;
    const srcPool = poolOf(src.units, 'cruiser')!;
    const wingPool = poolOf(wing.units, 'cruiser')!;
    // 4/10 of 300 leaves with the wing (120), 6/10 stays (180) — total conserved, not 600.
    expect(wingPool).toBeCloseTo(120, 6);
    expect(srcPool).toBeCloseTo(180, 6);
    expect(srcPool + wingPool).toBeCloseTo(300, 6);
  });
});

describe('BF-5 — split/merge honor ship-module loadout identity', () => {
  it('split carries the loadout onto the taken ships', () => {
    const s = withFleets({
      'p1-1': { units: [{ unit: 'cruiser', count: 6, modules: ['targeting_array'] }] } as Fleet,
    });
    const out = order(s, splitFleet('p1', 'p1-1', [{ unit: 'cruiser', count: 2 }]), s.time);
    expect(out.error).toBeUndefined();
    const wing = Object.values(out.state.fleets).find((f) => f.id !== 'p1-1')!;
    expect(stackOf(wing.units, 'cruiser')?.modules).toEqual(['targeting_array']); // not stripped
    expect(stackOf(out.state.fleets['p1-1']!.units, 'cruiser')?.modules).toEqual(['targeting_array']);
  });

  it('merge keeps a fitted stack separate from a bare one (no smear / no theft)', () => {
    const s = withFleets({
      'p1-1': { units: [{ unit: 'cruiser', count: 3 }] } as Fleet, // bare
      'p1-2': { units: [{ unit: 'cruiser', count: 2, modules: ['targeting_array'] }] } as Fleet, // fitted
    });
    const out = order(s, mergeFleet('p1', 'p1-2', 'p1-1'), s.time);
    expect(out.error).toBeUndefined();
    const merged = out.state.fleets['p1-1']!;
    const bare = merged.units.find((u) => u.unit === 'cruiser' && !u.modules);
    const fitted = merged.units.find((u) => u.unit === 'cruiser' && u.modules?.length);
    expect(bare?.count).toBe(3); // 3 bare hulls, unchanged
    expect(fitted?.count).toBe(2); // 2 fitted hulls, modules intact
    expect(fitted?.modules).toEqual(['targeting_array']);
  });

  it('merge coalesces two full-health, same-loadout stacks into one', () => {
    const s = withFleets({
      'p1-1': { units: [{ unit: 'cruiser', count: 3 }] } as Fleet,
      'p1-2': { units: [{ unit: 'cruiser', count: 2 }] } as Fleet,
    });
    const out = order(s, mergeFleet('p1', 'p1-2', 'p1-1'), s.time);
    const stacks = out.state.fleets['p1-1']!.units.filter((u) => u.unit === 'cruiser');
    expect(stacks).toHaveLength(1); // healthy + same loadout → one stack
    expect(stacks[0]!.count).toBe(5);
  });

  it('merge does NOT fuse two damaged stacks into one halved pool', () => {
    const s = withFleets({
      'p1-1': { units: [{ unit: 'cruiser', count: 2, hp: 100 }] } as Fleet,
      'p1-2': { units: [{ unit: 'cruiser', count: 3, hp: 100 }] } as Fleet, // same hp value
    });
    const out = order(s, mergeFleet('p1', 'p1-2', 'p1-1'), s.time);
    const stacks = out.state.fleets['p1-1']!.units.filter((u) => u.unit === 'cruiser');
    // Old code merged on hp equality → one {count:5, hp:100} (halved hull). Now separate.
    expect(stacks).toHaveLength(2);
    expect(stacks.reduce((a, s2) => a + (s2.hp ?? 0), 0)).toBe(200); // total pool preserved
  });
});
