import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { combatModule } from './../modules/combat';
import { orbitalModule } from './../modules/orbital';
import { sectorModule } from './../modules/sector';
import { hullPool, previewBattle, previewLossCount } from './previewBattle';
import { createInitialState, type Fleet, type GameState, type Planet, type UnitStack } from './gameState';
import { parseGameData, type GameData } from '../data/schemas';
import { deepFreeze } from '../util/clone';
import type { AdvanceResult, Context } from '../action/types';

// Mirrors the combat.test.ts fixture roster: fighters trade blows, guardians
// out-tank with return-fire defense, aegis carries an ablative shield.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    fighter: { faction: 'x', stats: { attack: 10, defense: 0, speed: 10, hp: 20 }, line: 'front' },
    guardian: { faction: 'x', stats: { attack: 7, defense: 20, speed: 5, hp: 100 }, line: 'front' },
    aegis: { faction: 'x', stats: { attack: 6, defense: 4, speed: 5, hp: 50, shield: 15 }, line: 'front' },
    backliner: { faction: 'x', stats: { attack: 5, defense: 0, speed: 5, hp: 10 }, line: 'rear' },
    pacifist: { faction: 'x', stats: { attack: 0, defense: 0, speed: 5, hp: 30 }, line: 'front' },
    marine: { faction: 'x', stats: { attack: 10, defense: 2, speed: 1, hp: 20 }, line: 'front' },
    militia: { faction: 'x', stats: { attack: 3, defense: 1, speed: 1, hp: 10 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });
const stacks = (list: Array<[string, number]>): UnitStack[] =>
  list.map(([unit, count]) => ({ unit, count }));

// Test fixture: emits fleet.arrived so combat engages without the movement module
// (the combat.test.ts pattern) — the ARRIVING fleet becomes the battle's aggressor.
const arrivalModule: GameModule = {
  id: 'test-arrival',
  version: '0',
  setup(api) {
    api.onAction('test.arrive', (action, h) => {
      const { fleetId } = action.payload as { fleetId: string };
      h.emit('fleet.arrived', { fleetId, at: h.state.fleets[fleetId]?.location });
    });
  },
};

function fleet(id: string, owner: string, location: string, units: UnitStack[]): Fleet {
  return { id, owner, location, movement: null, units, traits: [] };
}
function world(id: string, owner: string | null): Planet {
  return { id, owner, kind: 'planet', position: { x: 0, y: 0 }, resources: {}, buildings: [], garrison: [], traits: [] };
}
function baseState(fleets: Fleet[], aOwner: string | null = null): GameState {
  const s = createInitialState({ seed: 'pv', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return {
    ...s,
    planets: { A: world('A', aOwner) },
    fleets: f,
    players: {
      p1: { id: 'p1', name: 'p1', faction: 'x', status: 'active', resources: {} },
      p2: { id: 'p2', name: 'p2', faction: 'x', status: 'active', resources: {} },
    },
  };
}
const okAdvance = (r: AdvanceResult): AdvanceResult & { ok: true } => {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
};

/** Oracle: run the REAL battle (attacker arrives at A where defender sits) to
 *  completion on a hook-free kernel; return the resolved winner/rounds/survivors. */
function realBattle(
  attacker: UnitStack[],
  defender: UnitStack[],
  extraModules: GameModule[] = [],
  aOwner: string | null = null,
): { winner: string | null; rounds: number; aSurvivors: UnitStack[]; dSurvivors: UnitStack[] } {
  const kernel = createKernel([orbitalModule, combatModule, ...extraModules, arrivalModule]);
  const state = baseState(
    [
      fleet('D', 'p2', 'A', defender.map((s) => ({ ...s }))),
      fleet('F', 'p1', 'A', attacker.map((s) => ({ ...s }))),
    ],
    aOwner,
  );
  const started = kernel.applyAction(
    state,
    { id: 'a1', type: 'test.arrive', playerId: 'p1', payload: { fleetId: 'F' }, issuedAt: 0 },
    ctx(0),
  );
  if (!started.ok) throw new Error(`engage failed: ${started.code}`);
  const done = okAdvance(kernel.advanceTo(started.state, ctx(300 * HOUR)));
  const resolved = done.events.find((e) => e.type === 'battle.resolved');
  const payload = (resolved?.payload ?? {}) as { winner?: string | null; rounds?: number };
  return {
    winner: payload.winner ?? null,
    rounds: payload.rounds ?? -1,
    aSurvivors: done.state.fleets.F?.units ?? [],
    dSurvivors: done.state.fleets.D?.units ?? [],
  };
}

describe('previewBattle — parity with the real battle on a hook-free kernel', () => {
  const CASES: Array<{ name: string; a: Array<[string, number]>; d: Array<[string, number]> }> = [
    { name: 'fighters overrun a smaller wing', a: [['fighter', 6]], d: [['fighter', 2]] },
    { name: 'guardians out-tank fighters', a: [['fighter', 3]], d: [['guardian', 4]] },
    { name: 'shields blunt the alpha strike', a: [['fighter', 4]], d: [['aegis', 3]] },
    { name: 'mixed lines fall in tier order', a: [['fighter', 5], ['backliner', 4]], d: [['guardian', 2], ['backliner', 6]] },
    // Zero-damage matchup: the live valve resolves at round 241 (the counter
    // exceeds the 240 cap before the round is fought) — parity must include it.
    { name: 'zero-damage stalemate hits the 241-round valve', a: [['pacifist', 2]], d: [['pacifist', 2]] },
  ];
  for (const c of CASES) {
    it(`matches winner, rounds and survivors: ${c.name}`, () => {
      const real = realBattle(stacks(c.a), stacks(c.d));
      const pv = previewBattle(stacks(c.a), stacks(c.d), data);
      const expected =
        real.winner === 'p1' ? 'attacker' : real.winner === 'p2' ? 'defender' : 'stalemate';
      expect(pv.outcome).toBe(expected);
      expect(pv.roundsEst).toBe(real.rounds);
      // Survivor COUNTS per unit id match the real outcome exactly (hook-free).
      const counts = (u: UnitStack[]): Record<string, number> =>
        Object.fromEntries(u.map((s) => [s.unit, s.count]));
      expect(counts(pv.attacker.survivors)).toEqual(counts(real.aSurvivors));
      expect(counts(pv.defender.survivors)).toEqual(counts(real.dSurvivors));
      // Residual HULL POOLS match too — pins the shared stackHull accounting
      // (damageFraction's numerator) to the live engine, not just headcounts.
      const pools = (u: UnitStack[]): Record<string, number | null> =>
        Object.fromEntries(u.map((s) => [s.unit, s.hp ?? null]));
      expect(pools(pv.attacker.survivors)).toEqual(pools(real.aSurvivors));
      expect(pools(pv.defender.survivors)).toEqual(pools(real.dSurvivors));
    });
  }

  it('agrees in SIGN even when a combat.damage hook skews the real fight (sector home bonus)', () => {
    // p2 OWNS node A → sector's home-ground bonus multiplies p2's return fire
    // ×1.25 (guardians actually have a defense stat, so there is a number to
    // skew). The preview does not know the bonus — a non-marginal matchup must
    // not flip, and the skew must demonstrably bite (no vacuous pass).
    const a: Array<[string, number]> = [['fighter', 12]];
    const d: Array<[string, number]> = [['guardian', 3]];
    const skewed = realBattle(stacks(a), stacks(d), [sectorModule], 'p2');
    const baseline = realBattle(stacks(a), stacks(d), [], 'p2');
    const pv = previewBattle(stacks(a), stacks(d), data);
    expect(pv.outcome).toBe('attacker');
    expect(skewed.winner).toBe('p1'); // sign agreement — the forecast holds
    // Prove the hook really skewed the fight: the boosted return fire costs the
    // attacker more ships than both the hook-free run and the forecast predict.
    const total = (u: UnitStack[]): number => u.reduce((n, s) => n + s.count, 0);
    expect(total(skewed.aSurvivors)).toBeLessThan(total(baseline.aSurvivors));
    expect(total(pv.attacker.survivors)).toBe(total(baseline.aSurvivors));
  });
});

describe('previewBattle — contract', () => {
  it('is pure: never mutates its inputs (deep-frozen stacks pass through)', () => {
    const a = deepFreeze(stacks([['fighter', 3]]));
    const d = deepFreeze(stacks([['guardian', 2]]));
    expect(() => previewBattle(a, d, data)).not.toThrow();
  });

  it('an empty attacker loses in zero rounds; an empty defender falls in zero rounds', () => {
    expect(previewBattle([], stacks([['fighter', 1]]), data).outcome).toBe('defender');
    expect(previewBattle([], stacks([['fighter', 1]]), data).roundsEst).toBe(0);
    const walkover = previewBattle(stacks([['fighter', 1]]), [], data);
    expect(walkover.outcome).toBe('attacker');
    expect(walkover.roundsEst).toBe(0);
  });

  it('a zero-damage matchup forecasts stalemate at the valve, never hangs', () => {
    const pv = previewBattle(stacks([['pacifist', 2]]), stacks([['pacifist', 2]]), data);
    expect(pv.outcome).toBe('stalemate');
    // Mirrors the live battle.resolved: the counter exceeds the 240 cap → 241.
    expect(pv.roundsEst).toBe(241);
  });

  it('reports losses per unit id and previewLossCount totals them', () => {
    const pv = previewBattle(stacks([['marine', 5]]), stacks([['militia', 8]]), data);
    expect(pv.outcome).toBe('attacker');
    const lost = previewLossCount(pv.defender);
    const kept = pv.defender.survivors.reduce((n, s) => n + s.count, 0);
    expect(lost + kept).toBe(8);
    expect(previewLossCount(pv.attacker)).toBeLessThan(5); // marines take losses but win
  });

  it('unknown unit ids degrade gracefully (deal nothing, take nothing — like live combat)', () => {
    // damageUnits skips stacks with no def: a mystery unit neither fires nor
    // absorbs, so the fight runs to the stalemate valve — same as the real engine.
    const pv = previewBattle(stacks([['mystery', 3]]), stacks([['fighter', 1]]), data);
    expect(pv.outcome).toBe('stalemate');
  });
});

describe('damageFraction — the «ответный урон» share the Steward gate reads (ST-3.1)', () => {
  it('hand-checked: 3 fighters break on 1 guardian — attacker 1.0, defender 0.6', () => {
    // fighter atk10/hp20, guardian def20/hp100. Rounds: 30→70|60−20=40 (2 left),
    // 20→50|40−20=20 (1 left), 10→40|20−20=0 → wiped. Defender keeps 40/100 hull.
    const pv = previewBattle(stacks([['fighter', 3]]), stacks([['guardian', 1]]), data);
    expect(pv.outcome).toBe('defender');
    expect(pv.attacker.damageFraction).toBe(1);
    expect(pv.defender.damageFraction).toBeCloseTo(0.6, 10);
  });

  it('an untouched side reads 0; an empty side reads 0 (nothing to lose)', () => {
    // Pacifists never fire back — the attacker walks through unscathed.
    const clean = previewBattle(stacks([['fighter', 2]]), stacks([['pacifist', 1]]), data);
    expect(clean.attacker.damageFraction).toBe(0);
    expect(clean.defender.damageFraction).toBe(1);
    const walkover = previewBattle(stacks([['fighter', 1]]), [], data);
    expect(walkover.defender.damageFraction).toBe(0);
  });

  it('measures against the RESIDUAL hull pool: a battle-worn wing has less left to lose', () => {
    // count 2, pool 30 of max 40 (a consistent mid-battle stack): the denominator
    // must be 30, so an untouched fight still reads 0 — not a phantom 25% loss.
    const worn: UnitStack[] = [{ unit: 'fighter', count: 2, hp: 30 }];
    expect(hullPool(worn, data)).toBe(30);
    const pv = previewBattle(worn, stacks([['pacifist', 1]]), data);
    expect(pv.attacker.damageFraction).toBe(0);
  });

  it('hullPool: healthy = count × effective hp; unknown units and empty stacks are skipped', () => {
    expect(hullPool(stacks([['fighter', 2]]), data)).toBe(40);
    expect(hullPool(stacks([['mystery', 5]]), data)).toBe(0);
    expect(hullPool([{ unit: 'fighter', count: 0 }], data)).toBe(0);
  });

  it('shields are excluded: losing only shield reads as 0 hull damage', () => {
    // aegis shield 15×2=30 absorbs the whole 20-dmg alpha of 2 fighters in round 1
    // while its return fire (def 4×2=8) chews fighters — hull stays intact longer
    // than shields; assert the pool ignores shieldHp entirely.
    const shielded: UnitStack[] = [{ unit: 'aegis', count: 2, shieldHp: 5 }];
    expect(hullPool(shielded, data)).toBe(100); // 2 × hp50 — shield state irrelevant
  });
});

describe('COMBAT_UNIT_CAP — only 10 units fire, the rest just soak', () => {
  it('the 11th+ attacker adds no damage: 12 fighters finish exactly like 10, 9 lag behind', () => {
    // 25 pacifists = 750 hull, zero return fire. Capped line = 10 × atk10 = 100/round.
    const wall = stacks([['pacifist', 25]]);
    const r12 = previewBattle(stacks([['fighter', 12]]), wall, data);
    const r10 = previewBattle(stacks([['fighter', 10]]), wall, data);
    const r9 = previewBattle(stacks([['fighter', 9]]), wall, data);
    expect(r12.outcome).toBe('attacker');
    expect(r12.roundsEst).toBe(Math.ceil(750 / 100)); // 8 — capped at ten guns
    expect(r10.roundsEst).toBe(r12.roundsEst); // extras added nothing
    expect(r9.roundsEst).toBeGreaterThan(r12.roundsEst); // a real gun less is slower
  });

  it('units beyond the cap still soak: a 12-strong wing loses a smaller hull share than a 10-strong one', () => {
    // 1 guardian: 100 hull dies to the capped 100-dmg alpha in one round, its 20
    // return fire lands on both wings alike — the bigger wing spreads the same
    // absolute damage over a bigger hull pool.
    const guard = stacks([['guardian', 1]]);
    const w12 = previewBattle(stacks([['fighter', 12]]), guard, data);
    const w10 = previewBattle(stacks([['fighter', 10]]), guard, data);
    expect(w12.outcome).toBe('attacker');
    expect(w12.roundsEst).toBe(1);
    expect(w10.roundsEst).toBe(1);
    expect(w12.attacker.damageFraction).toBeLessThan(w10.attacker.damageFraction);
  });
});
