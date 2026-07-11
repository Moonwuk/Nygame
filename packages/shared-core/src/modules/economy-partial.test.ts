import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { economyModule } from './economy';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

// Partial output while a resource-generating building is still under construction
// (GDD: 0% below the 50%-progress mark, then linear 1:1 up to 100%). These drive the
// `scheduled` queue directly (no constructionModule) so the harness controls exactly
// when the in-flight order started/completes, isolating economy.ts's own math.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {
    // 4h build, 10 metal/h once complete.
    mine: { name: 'Mine', cost: { metal: 50 }, buildTimeHours: 4, produces: { metal: 10 } },
    // Level 1 → 5 metal/h; upgrade to level 2 (4h) → 15 metal/h (delta 10).
    power: {
      name: 'Power Plant',
      cost: { metal: 30 },
      buildTimeHours: 2,
      produces: { metal: 5 },
      upgrades: [{ cost: { metal: 60 }, buildTimeHours: 4, produces: { metal: 15 } }],
    },
  },
  events: {},
});

const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function planet(id: string, owner: string | null, buildings: Planet['buildings'] = []): Planet {
  return { id, owner, position: { x: 0, y: 0 }, resources: {}, buildings, garrison: [], traits: [] };
}
/** A planet with one in-flight `construction.complete` for a fresh `mine`, due at
 *  `at`, seeded via `scheduled` directly (mirrors what `building.construct` would
 *  have produced). */
function statePendingBuild(at: number): GameState {
  const s = createInitialState({ seed: 'ep', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    players: { p1: player('p1') },
    planets: { A: planet('A', 'p1') },
    scheduled: [
      { id: 'e0', at, type: 'construction.complete', payload: { kind: 'building', planetId: 'A', building: 'mine', playerId: 'p1' }, seq: 0 },
    ],
    scheduleSeq: 1,
  };
}
/** A planet with `power` already at level 1 and an in-flight upgrade to level 2. */
function statePendingUpgrade(at: number): GameState {
  const s = createInitialState({ seed: 'eu', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    players: { p1: player('p1') },
    planets: { A: planet('A', 'p1', [{ type: 'power', level: 1, hp: 0 }]) },
    scheduled: [
      { id: 'e0', at, type: 'construction.complete', payload: { kind: 'upgrade', planetId: 'A', building: 'power', level: 2, playerId: 'p1' }, seq: 0 },
    ],
    scheduleSeq: 1,
  };
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
/** Threads `state` through a sequence of small `advanceTo` steps up to `at`, so
 *  `time.advanced` never spans more than `stepHours` at once — proves the accrual
 *  total is independent of how finely the caller happens to tick. */
function advanceInSteps(state: GameState, at: number, stepHours: number): GameState {
  const kernel = createKernel([economyModule]);
  let s = state;
  const stepMs = stepHours * HOUR;
  for (let t = stepMs; t < at; t += stepMs) {
    s = okAdvance(kernel.advanceTo(s, ctx(t))).state;
  }
  return okAdvance(kernel.advanceTo(s, ctx(at))).state;
}

describe('economy module — partial output while a building is under construction', () => {
  it('produces nothing below the 50% progress mark', () => {
    const kernel = createKernel([economyModule]);
    const st = statePendingBuild(4 * HOUR); // 4h total → 50% at 2h
    const r = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR))); // exactly at the mark, in one jump
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
  });

  it('credits exactly the linear 1:1 ramp total from 50% to 100%, in one coarse jump', () => {
    const kernel = createKernel([economyModule]);
    const st = statePendingBuild(4 * HOUR);
    // One time.advanced spanning the ENTIRE 0→4h life of the order (nothing else
    // scheduled) — the coarse-jump case that motivated the trapezoid-integral fix.
    const r = okAdvance(kernel.advanceTo(st, ctx(4 * HOUR)));
    // avg ramp over [2h,4h] = (0.5+1.0)/2 = 0.75 → 0.75 × 10/h × 2h = 15.
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(15);
  });

  it('credits the identical total whether ticked in one jump or many small steps', () => {
    const coarse = okAdvance(createKernel([economyModule]).advanceTo(statePendingBuild(4 * HOUR), ctx(4 * HOUR)));
    const granular = advanceInSteps(statePendingBuild(4 * HOUR), 4 * HOUR, 0.1);
    expect(granular.players.p1?.resources.metal).toBeCloseTo(coarse.state.players.p1?.resources.metal ?? -1);
    expect(granular.players.p1?.resources.metal).toBeCloseTo(15);
  });

  it('reaches exactly the full rate at 100% and nothing beyond it', () => {
    const kernel = createKernel([economyModule]);
    // Advance PAST the nominal completion instant without the completion event firing
    // (economy is tested standalone, no constructionModule to dispatch it) — the ramp
    // must clamp at 1.0, never exceed the building's real output.
    const st = statePendingBuild(4 * HOUR);
    const r = okAdvance(kernel.advanceTo(st, ctx(4 * HOUR + 1)));
    // Same ~15 as landing exactly at completion (the extra 1ms is negligible) — the
    // ramp clamps at 1.0, it does not keep accruing past the building's full rate.
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(15);
  });
});

describe('economy module — partial output while a building is upgrading', () => {
  it('keeps producing the CURRENT level in full throughout the upgrade (no dip)', () => {
    const kernel = createKernel([economyModule]);
    const st = statePendingUpgrade(4 * HOUR); // 4h upgrade → 50% at 2h
    // Below the upgrade's own 50% mark, only the current level-1 output (5/h) — no
    // upgrade bonus yet, but also no loss versus a building that isn't upgrading.
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(5); // 1h × 5/h base, 0 bonus
  });

  it('ramps in only the DELTA to the target level, on top of the current level (no double count)', () => {
    const kernel = createKernel([economyModule]);
    const st = statePendingUpgrade(4 * HOUR);
    const r = okAdvance(kernel.advanceTo(st, ctx(4 * HOUR))); // one coarse jump over the whole upgrade
    // Base: 5/h × 4h = 20 (current level, the whole time). Delta bonus: target(15) −
    // current(5) = 10/h, ramped avg 0.75 over the [2h,4h] overlap × 2h = 15.
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(20 + 15); // 35, not 5×4 + 15×2 (=50)
  });
});

describe('economy module — a paused construction keeps its frozen share', () => {
  // Pausing halts further CONSTRUCTION, not the share of the building already
  // standing — it keeps contributing whatever it had reached, frozen (not growing,
  // since nothing is scheduled to tick it forward while paused).
  it('credits nothing for a site paused below the 50% mark', () => {
    const kernel = createKernel([economyModule]);
    const s = createInitialState({ seed: 'paused-low', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...s,
      players: { p1: player('p1') },
      planets: {
        A: {
          ...planet('A', 'p1'),
          pausedConstruction: [
            { id: 0, kind: 'building', playerId: 'p1', building: 'mine', progress: 0.3, remainingHours: 3, remainingCost: { metal: 35 } },
          ],
        },
      },
      scheduled: [],
    };
    const r = okAdvance(kernel.advanceTo(st, ctx(4 * HOUR)));
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
  });

  it('credits the FROZEN share for a site paused above the 50% mark, unchanging over time', () => {
    const kernel = createKernel([economyModule]);
    const s = createInitialState({ seed: 'paused-high', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...s,
      players: { p1: player('p1') },
      planets: {
        A: {
          ...planet('A', 'p1'),
          pausedConstruction: [
            { id: 0, kind: 'building', playerId: 'p1', building: 'mine', progress: 0.75, remainingHours: 1, remainingCost: { metal: 12.5 } },
          ],
        },
      },
      scheduled: [],
    };
    // 75% of the mine's 10/h, held flat — 2h at the frozen rate, then another 2h at
    // the SAME rate (it never ramps further while paused, unlike an active build).
    const first = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR)));
    expect(first.state.players.p1?.resources.metal).toBeCloseTo(0.75 * 10 * 2); // 15
    const second = okAdvance(kernel.advanceTo(first.state, ctx(4 * HOUR)));
    expect(second.state.players.p1?.resources.metal).toBeCloseTo(0.75 * 10 * 4); // 30, still 0.75×rate
  });

  it('keeps a paused UPGRADE at its current level plus the frozen delta share', () => {
    const kernel = createKernel([economyModule]);
    const s = createInitialState({ seed: 'paused-upgrade', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...s,
      players: { p1: player('p1') },
      planets: {
        A: {
          ...planet('A', 'p1', [{ type: 'power', level: 1, hp: 0 }]),
          pausedConstruction: [
            { id: 0, kind: 'upgrade', playerId: 'p1', building: 'power', level: 2, progress: 0.6, remainingHours: 1.6, remainingCost: { metal: 24 } },
          ],
        },
      },
      scheduled: [],
    };
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    // Base (level 1, always in `planet.buildings`): 5/h. Frozen delta: (15−5) × 0.6 = 6/h.
    expect(r.state.players.p1?.resources.metal).toBeCloseTo((5 + 6) * 1);
  });
});
