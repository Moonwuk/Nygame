import { describe, it, expect } from 'vitest';
import {
  damageBuckets,
  groundTick,
  resolveGround,
  makeSide,
  GROUND_ROSTER,
  type GroundRoster,
} from './groundcombat';

// Minimal rosters that inject the exact damage numbers from the design examples.
const empty = { infantry: { hp: 24, atk: {}, def: {} }, tank: { hp: 46, atk: {}, def: {} } };

describe('ground combat — matrix damage weighted by target composition', () => {
  it('routes a unit’s atk(inf 1, tank 2) into a 2-inf+2-tank target (50/50)', () => {
    // The exact "0.25 to each infantry, 0.5 to each tank" example.
    const roster: GroundRoster = { ...empty, tank: { hp: 46, atk: { infantry: 1, tank: 2 }, def: {} } };
    const attacker = makeSide(roster, { tank: 1 });
    const defender = makeSide(roster, { infantry: 2, tank: 2 });
    const b = damageBuckets(roster, attacker, defender, 'atk');
    expect(b.infantry).toBeCloseTo(0.5); // 1 × 0.5 share
    expect(b.tank).toBeCloseTo(1.0); // 2 × 0.5 share
    expect(b.infantry! / 2).toBeCloseTo(0.25); // per infantry unit
    expect(b.tank! / 2).toBeCloseTo(0.5); // per tank unit
  });

  it('weights anti-inf 10 / anti-armour 6 by a 3-inf+3-tank target → 5 + 3 = 8 total', () => {
    const roster: GroundRoster = { ...empty, tank: { hp: 46, atk: { infantry: 10, tank: 6 }, def: {} } };
    const attacker = makeSide(roster, { tank: 1 }); // one striker carrying the army-total numbers
    const defender = makeSide(roster, { infantry: 3, tank: 3 });
    const b = damageBuckets(roster, attacker, defender, 'atk');
    expect(b.infantry).toBeCloseTo(5); // 10 × 0.5
    expect(b.tank).toBeCloseTo(3); // 6 × 0.5
    expect((b.infantry ?? 0) + (b.tank ?? 0)).toBeCloseTo(8);
  });

  it('a pure-infantry target takes ALL the anti-infantry damage, none routed to armour', () => {
    const attacker = makeSide(GROUND_ROSTER, { tank: 6 }); // 6 tanks
    const defender = makeSide(GROUND_ROSTER, { infantry: 6 }); // 100% infantry
    const b = damageBuckets(GROUND_ROSTER, attacker, defender, 'atk');
    expect(b.infantry).toBeCloseTo(6 * GROUND_ROSTER.tank!.atk.infantry!); // 6 × 14 × 1.0
    expect(b.tank).toBeUndefined(); // no tanks in the target → no anti-armour bucket
  });

  it('both sides trade each tick — the defender returns its def damage', () => {
    const attacker = makeSide(GROUND_ROSTER, { tank: 2 });
    const defender = makeSide(GROUND_ROSTER, { tank: 2 });
    const t = groundTick(GROUND_ROSTER, attacker, defender);
    expect(t.toDefender.tank).toBeCloseTo(2 * GROUND_ROSTER.tank!.atk.tank!); // attacker atk
    expect(t.toAttacker.tank).toBeCloseTo(2 * GROUND_ROSTER.tank!.def.tank!); // defender def (return fire)
  });

  it('caps firepower at 12 firing units — the rest are reserve HP', () => {
    const target = makeSide(GROUND_ROSTER, { tank: 1 });
    const out12 = damageBuckets(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 12 }), target, 'atk');
    const out13 = damageBuckets(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 13 }), target, 'atk');
    expect(out13.tank).toBeCloseTo(out12.tank!); // the 13th infantry adds no firepower
  });

  it('the 12 firing slots go to the units MOST EFFECTIVE vs the enemy (best counter fires)', () => {
    // 12 tanks + 12 infantry defend; 12 tanks attack. Only the tanks return fire — they
    // out-rank infantry against armour; the infantry sit in reserve.
    const defenders = makeSide(GROUND_ROSTER, { tank: 12, infantry: 12 });
    const enemy = makeSide(GROUND_ROSTER, { tank: 12 });
    const mixed = damageBuckets(GROUND_ROSTER, defenders, enemy, 'def').tank!;
    const tankOnly = damageBuckets(GROUND_ROSTER, makeSide(GROUND_ROSTER, { tank: 12 }), enemy, 'def').tank!;
    const infOnly = damageBuckets(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 12 }), enemy, 'def').tank!;
    expect(mixed).toBeCloseTo(tankOnly); // tanks do all the firing
    expect(mixed).not.toBeCloseTo(infOnly); // infantry (poorer vs armour) sit in reserve
  });

  it('vs an infantry enemy the best counter (tanks) fills the slots first', () => {
    // 10 infantry + 5 tanks vs an infantry target → top 12 = 5 tanks + 7 infantry.
    const out = damageBuckets(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 10, tank: 5 }), makeSide(GROUND_ROSTER, { infantry: 1 }), 'atk');
    const exp = 5 * GROUND_ROSTER.tank!.atk.infantry! + 7 * GROUND_ROSTER.infantry!.atk.infantry!;
    expect(out.infantry).toBeCloseTo(exp); // not all 10 infantry fire — 3 are bumped to reserve
  });

  it('resolves the counter web: tanks overrun infantry', () => {
    const six = (u: 'infantry' | 'tank') => makeSide(GROUND_ROSTER, { [u]: 6 });
    expect(resolveGround(GROUND_ROSTER, six('tank'), six('infantry')).winner).toBe('attacker'); // tanks crush infantry
  });

  it('kills whole units as the HP pool drops, and ends with a winner', () => {
    const out = resolveGround(GROUND_ROSTER, makeSide(GROUND_ROSTER, { tank: 6 }), makeSide(GROUND_ROSTER, { infantry: 6 }));
    expect(out.winner).toBe('attacker');
    expect(out.defender).toHaveLength(0); // infantry wiped
    expect(out.attacker[0]!.count).toBeGreaterThan(0); // some tanks survive
    expect(out.rounds).toBeGreaterThan(0);
  });
});

describe('ground combat — officer bonuses (flexible, tunable)', () => {
  const a = () => makeSide(GROUND_ROSTER, { tank: 2 });
  const d = () => makeSide(GROUND_ROSTER, { tank: 2 });

  it('an attack officer scales the division’s outgoing attack', () => {
    const base = groundTick(GROUND_ROSTER, a(), d()).toDefender.tank!;
    const buffed = groundTick(GROUND_ROSTER, a(), d(), { name: 'o', atk: 0.5 }).toDefender.tank!;
    expect(buffed).toBeCloseTo(base * 1.5);
  });

  it('a defence officer scales the defender’s return fire', () => {
    const base = groundTick(GROUND_ROSTER, a(), d()).toAttacker.tank!;
    const buffed = groundTick(GROUND_ROSTER, a(), d(), undefined, { name: 'o', def: 0.5 }).toAttacker.tank!;
    expect(buffed).toBeCloseTo(base * 1.5);
  });

  it('an HP officer makes the division tougher (bakes into hpEach)', () => {
    const side = makeSide(GROUND_ROSTER, { infantry: 2 }, { name: 'q', hp: 0.5 });
    expect(side[0]!.hpEach).toBeCloseTo(GROUND_ROSTER.infantry!.hp * 1.5);
    expect(side[0]!.hp).toBeCloseTo(2 * GROUND_ROSTER.infantry!.hp * 1.5);
  });

  it('an atkVs officer adds a flat per-type attack bonus', () => {
    const base = groundTick(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 1 }), makeSide(GROUND_ROSTER, { tank: 1 })).toDefender.tank!;
    const buffed = groundTick(GROUND_ROSTER, makeSide(GROUND_ROSTER, { infantry: 1 }), makeSide(GROUND_ROSTER, { tank: 1 }), { name: 'at', atkVs: { tank: 100 } }).toDefender.tank!;
    expect(buffed).toBeCloseTo(base + 100); // target is 100% tank → full flat bonus lands
  });

  it('a strong attack officer flips an otherwise-losing mirror match', () => {
    // tank.def(8) > tank.atk(7), so the defender wins a bare mirror...
    expect(resolveGround(GROUND_ROSTER, a(), d()).winner).toBe('defender');
    // ...but a +50% attack officer tips it to the attacker.
    expect(resolveGround(GROUND_ROSTER, a(), d(), { attackerOfficer: { name: 'x', atk: 0.5 } }).winner).toBe('attacker');
  });
});
