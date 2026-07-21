import { describe, it, expect } from 'vitest';
import { newGame, netIncome, data, HOUR, advance } from './game';
import { BROWNOUT, allowedBuildings, type GameState } from '../../packages/shared-core/src/index';

describe('building economy — the prototype resource loop', () => {
  it('ships the loop-closing roster: farm / fusion plant / microelectronics fab', () => {
    for (const id of ['farm', 'power_plant', 'fabricator']) {
      expect(data.buildings[id], id).toBeDefined();
    }
    // …and they are raisable on a normal planet: its kind carries no allow-list
    // (undefined = every building), while the dead world's list still excludes them.
    const s = newGame();
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    expect(allowedBuildings(data, home)).toBeUndefined();
    expect(allowedBuildings(data, { kind: 'dead_world' })).toEqual(['metal_station']);
  });

  it('netIncome charges building upkeep (the start kit draws watch power)', () => {
    const s = newGame();
    const flow = netIncome(s, 'p1');
    // Home starts with radar (6/day) + orbital-AA (6/day) and no reactor → energy net < 0.
    expect(flow.energy ?? 0).toBeLessThan(0);
    // The seeded infantry garrison eats: food flow is negative too.
    expect(flow.food ?? 0).toBeLessThan(0);
  });

  it('netIncome mirrors the brownout: an energy arrears halves the refinery line', () => {
    const s = newGame();
    s.players.p1!.faction = 'red'; // isolate brownout from the faction production bonus (BF-35)
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    home.buildings.push({ type: 'refinery', level: 1, hp: 20 });
    const full = netIncome(s, 'p1').credits ?? 0;
    s.players.p1!.arrears = ['energy'];
    const dimmed = netIncome(s, 'p1').credits ?? 0;
    // Only the refinery's 8/h line dims (civic tax etc. stay) — flow drops by half of it.
    expect(full - dimmed).toBeCloseTo(8 * (1 - BROWNOUT), 5);
  });

  it('netIncome (the HUD flow readout) reflects a ramping reactor past the 50% mark', () => {
    const s = newGame();
    s.players.p1!.faction = 'red'; // isolate the ramp from the faction production bonus (BF-35)
    const home = Object.values(s.planets).find((p) => p.owner === 'p1')!;
    const totalMs = data.buildings.power_plant!.buildTimeHours * HOUR;
    const withScheduled = (at: number): GameState => ({
      ...s,
      scheduled: [
        ...s.scheduled,
        {
          id: 'x',
          at,
          type: 'construction.complete',
          payload: { kind: 'building', planetId: home.id, building: 'power_plant', playerId: 'p1' },
          seq: 999,
        },
      ],
    });
    const plantEnergy = data.buildings.power_plant!.produces.energy ?? 0;
    const baseline = netIncome(s, 'p1').energy ?? 0; // no in-flight reactor at all
    const below = netIncome(withScheduled(s.time + 0.7 * totalMs), 'p1').energy ?? 0; // 30% built
    const above = netIncome(withScheduled(s.time + 0.25 * totalMs), 'p1').energy ?? 0; // 75% built
    expect(below).toBeCloseTo(baseline); // still under the 50% mark → no bonus shown yet
    expect(above).toBeCloseTo(baseline + plantEnergy * 0.75); // 75% of the plant's energy/h
  });

  it('the settlement actually runs the loop: no reactor → energy stock drains to arrears', () => {
    let s = newGame();
    for (let t = HOUR; t <= 10 * 24 * HOUR; t += 12 * HOUR) s = advance(s, t).state;
    // Ten days of radar+AA watch power on a 90-energy stock with no plant → in arrears.
    expect(s.players.p1?.resources.energy).toBe(0);
    expect(s.players.p1?.arrears).toContain('energy');
  });

  it('netIncome applies the faction production bonus to the HUD flow (BF-35)', () => {
    const s = newGame();
    const p = s.players.p1!;
    const creditsWith = (faction: string): number => {
      p.faction = faction;
      return netIncome(s, 'p1').credits ?? 0;
    };
    const plain = creditsWith('red'); // Crimson Hegemony — no production passive
    const five = creditsWith('violet'); // Violet Ascendancy — +5% production
    const twelve = creditsWith('blue'); // Azure Compact — +12% production
    // Before BF-35 the HUD `+/h` ignored the faction passive → all three read identically.
    expect(twelve).toBeGreaterThan(plain);
    expect(five).toBeGreaterThan(plain);
    // Upkeep is unchanged between runs, so the boost over `plain` scales linearly with the
    // passive strength: the 12%-delta over the 5%-delta is exactly 0.12/0.05.
    expect((twelve - plain) / (five - plain)).toBeCloseTo(0.12 / 0.05, 6);
  });
});
