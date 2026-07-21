import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import {
  createInitialState,
  type BuildingInstance,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';
import { isBombarded } from '../state/orbit';

// Cancel-with-partial-refund + pause/resume (construction.cancel / construction.resume).
// mine: 50 metal, 4h, produces 10 metal/h. fort: 20 metal + 5 credits, 1h, upgrades to
// level 2 for 40 metal / 2h. cruiser: 10 metal, 2h.
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 5, defense: 5, speed: 5, hp: 40 },
      cost: { metal: 10 },
      buildTimeHours: 2,
    },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', cost: { metal: 50 }, buildTimeHours: 4, produces: { metal: 10 } },
    shipyard: {
      name: 'Shipyard',
      cost: { metal: 100 },
      buildTimeHours: 4,
      hp: 20,
      enablesShipConstruction: true,
    },
    fort: {
      name: 'Fort',
      cost: { metal: 20, credits: 5 },
      buildTimeHours: 1,
      hp: 30,
      defenseBonus: 0.5,
      upgrades: [{ cost: { metal: 40 }, buildTimeHours: 2, hp: 60, defenseBonus: 0.8 }],
    },
  },
  events: {},
});

const HOUR = 3_600_000;
const ctx = (now: number, timeScale?: number): Context =>
  timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function planet(id: string, owner: string | null, buildings: BuildingInstance[] = []): Planet {
  return { id, owner, position: { x: 0, y: 0 }, resources: {}, buildings, garrison: [], traits: [] };
}
function stateWith(opts: { players?: Player[]; planets?: Planet[] }): GameState {
  const s = createInitialState({ seed: 'cc', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  return { ...s, players, planets };
}
function construct(building: string, planetId = 'A', playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type: 'building.construct', playerId, payload: { planetId, building }, issuedAt: 0 };
}
function upgrade(building: string, planetId = 'A', playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type: 'building.upgrade', playerId, payload: { planetId, building }, issuedAt: 0 };
}
function build(unit: string, count: number | undefined, planetId = 'A', playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type: 'unit.build', playerId, payload: { planetId, unit, count }, issuedAt: 0 };
}
function cancel(seq: number, planetId = 'A', playerId = 'p1'): Action {
  return { id: `s:${playerId}:cancel`, type: 'construction.cancel', playerId, payload: { planetId, seq }, issuedAt: 0 };
}
function resume(id: number, planetId = 'A', playerId = 'p1'): Action {
  return { id: `s:${playerId}:resume`, type: 'construction.resume', playerId, payload: { planetId, id }, issuedAt: 0 };
}
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
/** The `seq` of the sole in-flight `construction.complete`, for cancel/resume payloads. */
function activeSeq(s: GameState): number {
  const e = s.scheduled.find((x) => x.type === 'construction.complete');
  if (!e) throw new Error('no active construction.complete');
  return e.seq;
}

describe('construction module — cancel refunds the unbuilt share and pauses', () => {
  it('refunds exactly (100% − progress%) at the halfway point', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0))); // −50 → 50
    const seq = activeSeq(ordered.state);

    const cancelled = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(2 * HOUR))); // 50% through 4h
    expect(cancelled.state.players.p1?.resources.metal).toBe(75); // 50 + 25 (50% of 50)
    expect(cancelled.state.scheduled.some((e) => e.type === 'construction.complete')).toBe(false);
    expect(cancelled.state.planets.A?.pausedConstruction).toEqual([
      { id: seq, kind: 'building', playerId: 'p1', building: 'mine', progress: 0.5, remainingHours: 2, remainingCost: { metal: 25 } },
    ]);
    expect(cancelled.events.map((e) => e.type)).toContain('construction.cancelled');
  });

  it('refunds 99% at 1% progress and 1% at 99% progress (linear, no threshold)', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });

    const early = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seqA = activeSeq(early.state);
    const cancelledEarly = okApply(kernel.applyAction(early.state, cancel(seqA), ctx(0.01 * 4 * HOUR)));
    expect(cancelledEarly.state.players.p1?.resources.metal).toBeCloseTo(50 + 0.99 * 50); // 99% back

    const late = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seqB = activeSeq(late.state);
    const cancelledLate = okApply(kernel.applyAction(late.state, cancel(seqB), ctx(0.99 * 4 * HOUR)));
    expect(cancelledLate.state.players.p1?.resources.metal).toBeCloseTo(50 + 0.01 * 50); // 1% back
  });

  it('cancel is not blocked by bombardment (the escape valve always works)', () => {
    const kernel = createKernel([constructionModule]);
    const a = planet('A', 'p1');
    const st = stateWith({
      players: [player('p1', { metal: 100 }), player('p2', {})],
      planets: [a],
    });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seq = activeSeq(ordered.state);
    // A hostile fleet in near orbit, actively bombarding — default stance is 'war'
    // (diplomacy.ts DEFAULT_STANCE), so p2 vs p1 is hostile with no setup needed.
    const besieged: GameState = {
      ...ordered.state,
      fleets: {
        F: {
          id: 'F',
          owner: 'p2',
          location: 'A',
          movement: null,
          units: [{ unit: 'cruiser', count: 1 }],
          traits: [],
          orbit: 'near',
          bombarding: true,
        },
      },
    };
    expect(isBombarded(besieged, 'A')).toBe(true); // sanity: the siege actually froze production
    okApply(kernel.applyAction(besieged, cancel(seq), ctx(HOUR)));
  });
});

describe('construction module — resume continues from the paused progress', () => {
  it('pays exactly the refunded remainder and finishes without restarting', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(3 * HOUR))); // 75% done
    expect(paused.state.players.p1?.resources.metal).toBeCloseTo(50 + 0.25 * 50); // 62.5

    const resumed = okApply(kernel.applyAction(paused.state, resume(seq), ctx(10 * HOUR))); // long gap while paused
    expect(resumed.state.players.p1?.resources.metal).toBeCloseTo(62.5 - 0.25 * 50); // 50 again
    expect(resumed.state.planets.A?.pausedConstruction).toEqual([]);

    // Only the remaining 1h (25% of 4h), not the full 4h, is left to finish.
    const early = okAdvance(kernel.advanceTo(resumed.state, ctx(10 * HOUR + HOUR - 1)));
    expect(early.state.planets.A?.buildings).toEqual([]);
    const done = okAdvance(kernel.advanceTo(early.state, ctx(10 * HOUR + HOUR)));
    expect(done.state.planets.A?.buildings).toEqual([{ type: 'mine', level: 1, hp: 0 }]);
  });

  it('resumes an upgrade from its paused progress, landing at the target level', () => {
    const kernel = createKernel([constructionModule]);
    const a = planet('A', 'p1', [{ type: 'fort', level: 1, hp: 30 }]);
    const st = stateWith({ players: [player('p1', { metal: 100, credits: 100 })], planets: [a] });
    const ordered = okApply(kernel.applyAction(st, upgrade('fort'), ctx(0))); // −40 metal, 2h
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(HOUR))); // 50%
    expect(paused.state.players.p1?.resources.metal).toBe(80); // 60 + 20 refunded

    const resumed = okApply(kernel.applyAction(paused.state, resume(seq), ctx(HOUR)));
    expect(resumed.state.players.p1?.resources.metal).toBe(60); // 20 paid again
    const done = okAdvance(kernel.advanceTo(resumed.state, ctx(2 * HOUR))); // 1h remaining
    expect(done.state.planets.A?.buildings).toEqual([{ type: 'fort', level: 2, hp: 60 }]);
  });
});

describe('construction module — cancel/resume fail-secure validation', () => {
  it('rejects cancelling a seq that is not an active order', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    expect(errCode(kernel.applyAction(st, cancel(999), ctx(0)))).toBe('E_NOT_ACTIVE');
  });

  it("rejects cancelling someone else's order (wrong owner)", () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100 }), player('p2', { metal: 100 })],
      planets: [planet('A', 'p1'), planet('B', 'p2')],
    });
    const ordered = okApply(kernel.applyAction(st, construct('mine', 'A', 'p1'), ctx(0)));
    const seq = activeSeq(ordered.state);
    expect(errCode(kernel.applyAction(ordered.state, cancel(seq, 'B', 'p2'), ctx(HOUR)))).toBe(
      'E_FORBIDDEN',
    );
  });

  it('rejects resuming an unknown paused id', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    expect(errCode(kernel.applyAction(st, resume(999), ctx(0)))).toBe('E_NOT_PAUSED');
  });

  it('rejects resuming without enough resources', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(3 * HOUR))); // metal back up to 62.5
    // Spend it all elsewhere before resuming.
    const broke: GameState = {
      ...paused.state,
      players: { p1: { ...paused.state.players.p1!, resources: { metal: 0 } } },
    };
    expect(errCode(kernel.applyAction(broke, resume(seq), ctx(3 * HOUR)))).toBe('E_INSUFFICIENT');
  });

  it('rejects re-ordering the same building fresh while a pause exists for it', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 200 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(HOUR)));
    expect(errCode(kernel.applyAction(paused.state, { ...construct('mine'), id: 's:p1:2' }, ctx(HOUR)))).toBe(
      'E_ALREADY_PAUSED',
    );
  });

  it('rejects resuming an upgrade whose building moved on (stale)', () => {
    const kernel = createKernel([constructionModule]);
    const a = planet('A', 'p1', [{ type: 'fort', level: 1, hp: 30 }]);
    const st = stateWith({ players: [player('p1', { metal: 200, credits: 100 })], planets: [a] });
    const ordered = okApply(kernel.applyAction(st, upgrade('fort'), ctx(0)));
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(HOUR)));
    // The fort gets destroyed (or otherwise no longer at level 1) before resume.
    const wrecked: GameState = {
      ...paused.state,
      planets: { A: { ...paused.state.planets.A!, buildings: [] } },
    };
    expect(errCode(kernel.applyAction(wrecked, resume(seq), ctx(HOUR)))).toBe('E_STALE_CONSTRUCTION');
  });

  it('does not mutate the input state on cancel or resume', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0)));
    const seq = activeSeq(ordered.state);
    const frozen = deepFreeze(ordered.state);
    const cancelled = okApply(kernel.applyAction(frozen, cancel(seq), ctx(2 * HOUR)));
    expect(frozen.players.p1?.resources.metal).toBe(50); // frozen input untouched
    const frozenPaused = deepFreeze(cancelled.state);
    okApply(kernel.applyAction(frozenPaused, resume(seq), ctx(2 * HOUR)));
    expect(frozenPaused.players.p1?.resources.metal).toBe(75); // frozen input untouched
  });
});

describe('construction module — cancel/resume for units (no capacity concept)', () => {
  it('cancels a unit order for a partial refund and resumes it to completion', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100 })],
      planets: [planet('A', 'p1', [{ type: 'shipyard', level: 1, hp: 20 }])],
    });
    const ordered = okApply(kernel.applyAction(st, build('cruiser', 2, 'A', 'p1'), ctx(0))); // −20, 2h
    const seq = activeSeq(ordered.state);
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(HOUR))); // 50%
    expect(paused.state.players.p1?.resources.metal).toBe(90); // 80 + 10
    expect(paused.state.planets.A?.pausedConstruction?.[0]).toMatchObject({ kind: 'unit', unit: 'cruiser', count: 2 });

    const resumed = okApply(kernel.applyAction(paused.state, resume(seq), ctx(HOUR)));
    const done = okAdvance(kernel.advanceTo(resumed.state, ctx(2 * HOUR)));
    expect(done.state.planets.A?.garrison).toEqual([{ unit: 'cruiser', count: 2 }]);
  });
});

describe('construction module — cancel/resume under timeScale', () => {
  it('computes progress and the remaining schedule correctly at timeScale ×2', () => {
    const kernel = createKernel([constructionModule]);
    const st = stateWith({ players: [player('p1', { metal: 100 })], planets: [planet('A', 'p1')] });
    // ×2 timeScale: a 4h mine finishes in 2h of wall time.
    const ordered = okApply(kernel.applyAction(st, construct('mine'), ctx(0, 2)));
    const seq = activeSeq(ordered.state);
    // 1h wall = 2h game-time elapsed of 4h total → 50% progress.
    const paused = okApply(kernel.applyAction(ordered.state, cancel(seq), ctx(HOUR, 2)));
    expect(paused.state.players.p1?.resources.metal).toBe(75); // 50 + 25

    const resumed = okApply(kernel.applyAction(paused.state, resume(seq), ctx(HOUR, 2)));
    // Remaining 2h of game-time at ×2 = 1h of wall time.
    const done = okAdvance(kernel.advanceTo(resumed.state, ctx(2 * HOUR, 2)));
    expect(done.state.planets.A?.buildings).toEqual([{ type: 'mine', level: 1, hp: 0 }]);
  });
});
