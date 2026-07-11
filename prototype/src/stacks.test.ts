import { describe, it, expect } from 'vitest';
import { newGame, order, advance, splitFleet, mergeFleet, spawnHero, buildShip, launchFleet, HOUR } from './game';
import type { GameState, Fleet, UnitStack, Battle } from '../../packages/shared-core/src/index';

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

// BF-3 (bug-hunt CRIT): fleet.merge deleted the hero's carrier fleet WITHOUT a death,
// orphaning hero.fleetId — hero.spawn's "stale fleetId doesn't block" rule then minted
// a second free flagship (unbounded dupes, aura on the wrong fleet, wrong-hero death).
describe('BF-3 — the hero entity follows its ship through merge; no duplicate spawn', () => {
  it('merge re-points hero.fleetId to the surviving fleet', () => {
    const s = newGame(); // p1's main hero rides p1-1 (alive, fleetId 'p1-1')
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!.id;
    s.fleets['p1-x'] = { id: 'p1-x', owner: 'p1', location: home, movement: null, units: [{ unit: 'cruiser', count: 1 }], traits: [] };
    const out = order(s, mergeFleet('p1', 'p1-1', 'p1-x'), s.time); // hero's fleet merges INTO p1-x
    expect(out.error).toBeUndefined();
    const hero = Object.values(out.state.heroes!).find((h) => h.owner === 'p1' && h.grade === 'main')!;
    expect(hero.fleetId).toBe('p1-x'); // followed its unit into the merged fleet
  });

  it('hero.spawn refuses while the hero is ALIVE, even with a stale fleetId', () => {
    const s = newGame();
    const hero = Object.values(s.heroes!).find((h) => h.owner === 'p1' && h.grade === 'main')!;
    // Simulate the pre-fix orphan: carrier gone, alive still true (no death fired).
    hero.fleetId = 'fleet:gone';
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!.id;
    const out = order(s, spawnHero('p1', hero.id, home), s.time);
    expect(out.error).toBe('E_HERO_ALIVE'); // no free duplicate flagship
  });

  it('fleet.split refuses to peel the hero unit off its fleet', () => {
    const s = newGame();
    const out = order(s, splitFleet('p1', 'p1-1', [{ unit: 'hero', count: 1 }]), s.time);
    expect(out.error).toBe('E_HERO_UNIT');
  });
});

// --- fleet-batch regressions (bug-hunt 2026-07-10) ---------------------------

describe('BF-25 — fleet ids never collide (monotonic fleetSeq)', () => {
  it('split → merge → split in the same ms mints unique ids, no fleet overwritten', () => {
    const s = withFleets({ 'p1-1': { units: [{ unit: 'cruiser', count: 10 }] } as Fleet });
    // Two wings out, first wing merged back, a third wing out — all at t = s.time.
    // The old keys.length counter regenerated the second wing's id here and
    // silently overwrote it (2 cruisers vanished).
    let st = order(s, splitFleet('p1', 'p1-1', [{ unit: 'cruiser', count: 2 }]), s.time).state;
    const wing1 = Object.values(st.fleets).find((f) => f.id !== 'p1-1')!.id;
    st = order(st, splitFleet('p1', 'p1-1', [{ unit: 'cruiser', count: 2 }]), st.time).state;
    st = order(st, mergeFleet('p1', wing1, 'p1-1'), st.time).state;
    st = order(st, splitFleet('p1', 'p1-1', [{ unit: 'cruiser', count: 2 }]), st.time).state;
    const total = Object.values(st.fleets).reduce(
      (n, f) => n + (f.units.find((u) => u.unit === 'cruiser')?.count ?? 0),
      0,
    );
    expect(total).toBe(10); // nothing overwritten, every hull accounted for
    expect(Object.keys(st.fleets)).toHaveLength(3); // p1-1 + two live wings
  });
});

describe('BF-27/BF-28 — fleet.launch: assault lock + cargo cap', () => {
  it('rejects launching a garrison that is under ground assault', () => {
    const s = newGame();
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    home.garrison = [{ unit: 'cruiser', count: 1 }];
    s.battles['battle:t'] = {
      id: 'battle:t',
      location: home.id,
      phase: 'ground',
      attacker: { ref: { kind: 'landing', fleetId: 'X' }, owner: 'p2' },
      defender: { ref: { kind: 'garrison', planetId: home.id }, owner: 'p1' },
      round: 1,
    } as Battle;
    expect(order(s, launchFleet('p1', home.id), s.time).error).toBe('E_UNDER_ASSAULT');
  });

  it('lifts ground troops only up to the ships’ cargo capacity; the rest stays', () => {
    const s = newGame();
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    // cruiser capacity 5; three tanks are 3×3 = 9 cargo → only ONE tank fits.
    home.garrison = [
      { unit: 'cruiser', count: 1 },
      { unit: 'tank', count: 3 },
    ];
    const before = new Set(Object.keys(s.fleets));
    const out = order(s, launchFleet('p1', home.id), s.time);
    expect(out.error).toBeUndefined();
    const fleet = Object.values(out.state.fleets).find((f) => !before.has(f.id))!;
    expect(fleet.landing?.find((u) => u.unit === 'tank')?.count).toBe(1);
    const left = out.state.planets[home.id]!.garrison.find((u) => u.unit === 'tank');
    expect(left?.count).toBe(2); // over-cap troops stay planetside, nothing vanished
  });
});

describe('BF-29 — auto-rally keeps the paid ship loadout', () => {
  it('a fitted build rides to the rally fleet WITH its modules; a bare stack stays', () => {
    const s = newGame();
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    // A bare cruiser already sits in the garrison — the loadout-blind take used to
    // grab THIS stack and strip the paid modules from the build.
    home.garrison.push({ unit: 'cruiser', count: 1 });
    s.players.p1!.resources.metal = 5000;
    s.players.p1!.resources.credits = 5000;
    let st = order(s, buildShip('p1', home.id, 'cruiser', 1, ['targeting_array']), s.time).state;
    st = advance(st, st.time + 4 * HOUR).state; // cruiser buildTime 3h → unit.built fires
    const rally = Object.values(st.fleets).find((f) => f.traits.includes('rally'))!;
    const fitted = rally.units.find((u) => u.unit === 'cruiser');
    expect(fitted?.modules).toEqual(['targeting_array']); // «Оснащение» not stripped
    expect(fitted?.count).toBe(1);
    const bare = st.planets[home.id]!.garrison.find((u) => u.unit === 'cruiser');
    expect(bare?.count).toBe(1); // the pre-existing bare hull untouched
  });
});
