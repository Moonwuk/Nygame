import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { espionageModule } from './espionage';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { visibleState } from '../state/visibility';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';
import type { GameModule } from '../kernel/module';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits'],
  units: { cruiser: { faction: 'x', stats: { attack: 4, defense: 4, speed: 6, hp: 20 } } },
  factions: {},
  buildings: {},
  events: {},
});
const HOUR = 3_600_000;
const ctx = (now = 0): Context => ({ now, data });

/** Pin the outcome deterministically: chance 0.95 max / 0.05 min are clamps, so a
 *  hook forcing 1 / 0 lands on "always" / "never" within them for the first roll. */
const sureShot: GameModule = {
  id: 'sure-shot',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('espionage.chance', () => 1);
  },
};
const dudShot: GameModule = {
  id: 'dud-shot',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('espionage.chance', () => 0);
  },
};
// Detection pins (SPY-2): the detect clamp is [0,1], so 1/0 are exact always/never.
const alwaysDetect: GameModule = {
  id: 'always-detect',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('espionage.detect', () => 1);
  },
};
const neverDetect: GameModule = {
  id: 'never-detect',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('espionage.detect', () => 0);
  },
};

function player(id: string, credits = 500): Player {
  return { id, name: id, faction: '', status: 'active', resources: { credits } };
}
function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [{ unit: 'cruiser', count: 3 }],
    traits: [],
  };
}
function baseState(): GameState {
  const s = createInitialState({ seed: 'spy', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
    planets: { B: planet('B', 'p2') },
  };
}
function spy(playerId: string, payload: unknown): Action {
  return { id: `s:${playerId}:1`, type: 'espionage.spy', playerId, payload, issuedAt: 0 };
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected a rejection');
  return r.code;
}

describe('espionage — stealing an intel window', () => {
  const kernel = createKernel([espionageModule, sureShot]);

  it('pays the fee and grants a time-boxed window on success', () => {
    const r = okApply(kernel.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    expect(r.state.players.p1?.resources.credits).toBe(350); // 500 − 150 base fee
    expect(r.state.intel?.p1).toEqual([{ kind: 'treasury', target: 'p2', until: 24 * HOUR }]);
    expect(r.events).toContainEqual({
      type: 'intel.stolen',
      payload: { owner: 'p1', target: 'p2', kind: 'treasury', until: 24 * HOUR },
    });
  });

  it('a failed attempt burns the fee, grants nothing, and reports to the actor only', () => {
    const dud = createKernel([espionageModule, dudShot, neverDetect]);
    const r = okApply(dud.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    expect(r.state.players.p1?.resources.credits).toBe(350); // spying is a gamble
    expect(r.state.intel).toBeUndefined();
    expect(r.events).toEqual([
      { type: 'espionage.failed', payload: { owner: 'p1', target: 'p2', kind: 'treasury' } },
    ]);
  });

  it('planet theft targets one world of the victim (and only theirs)', () => {
    const ok = okApply(kernel.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'planet', planetId: 'B' }), ctx(0)));
    expect(ok.state.intel?.p1?.[0]).toMatchObject({ kind: 'planet', target: 'B' });
    // a world that is NOT the target's is refused
    const s2 = baseState();
    s2.planets.B!.owner = 'p3';
    expect(errCode(kernel.applyAction(s2, spy('p1', { target: 'p2', kind: 'planet', planetId: 'B' }), ctx(0)))).toBe('E_BAD_TARGET');
  });

  it.each([
    ['unknown kind', { target: 'p2', kind: 'pings' }, 'E_BAD_PAYLOAD'],
    ['self target', { target: 'p1', kind: 'treasury' }, 'E_BAD_TARGET'],
    ['unknown target', { target: 'ghost', kind: 'treasury' }, 'E_NO_PLAYER'],
    ['planet kind without planetId', { target: 'p2', kind: 'planet' }, 'E_BAD_PAYLOAD'],
    ['unknown planet', { target: 'p2', kind: 'planet', planetId: 'ghost' }, 'E_NO_PLANET'],
  ])('fail-secure: %s → %s', (_n, payload, code) => {
    expect(errCode(kernel.applyAction(baseState(), spy('p1', payload), ctx(0)))).toBe(code);
  });

  it('rejects an attempt the actor cannot pay for', () => {
    const s = baseState();
    s.players.p1!.resources.credits = 10;
    expect(errCode(kernel.applyAction(s, spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)))).toBe('E_INSUFFICIENT');
  });

  it('keeps at most 8 grants per beneficiary (oldest evicted)', () => {
    const s = baseState();
    s.players.p1!.resources.credits = 10_000;
    s.intel = { p1: Array.from({ length: 8 }, (_, i) => ({ kind: 'treasury' as const, target: `t${i}`, until: 999 * HOUR })) };
    const r = okApply(kernel.applyAction(s, spy('p1', { target: 'p2', kind: 'fleets' }), ctx(0)));
    expect(r.state.intel?.p1).toHaveLength(8);
    expect(r.state.intel?.p1?.[0]?.target).toBe('t1'); // t0 evicted
    expect(r.state.intel?.p1?.[7]).toMatchObject({ kind: 'fleets', target: 'p2' });
  });

  it('housekeeping drops expired windows as time advances', () => {
    const s = baseState();
    s.intel = { p1: [{ kind: 'treasury', target: 'p2', until: 1 * HOUR }] };
    s.scheduled = [{ id: 'evt:t', at: 2 * HOUR, type: 'noop', payload: {}, seq: 0 }];
    s.scheduleSeq = 1;
    const r = kernel.advanceTo(s, ctx(2 * HOUR));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.intel).toBeUndefined();
  });
});

describe('espionage — counter-intelligence (SPY-2)', () => {
  const detectedOf = (r: ApplyResult & { ok: true }) =>
    r.events.filter((e) => e.type === 'espionage.detected');

  it('a caught FAILED attempt exposes the spy to the victim', () => {
    const k = createKernel([espionageModule, dudShot, alwaysDetect]);
    const r = okApply(k.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    expect(detectedOf(r)).toEqual([
      // owner = the VICTIM — the fog filter routes this event to them, not the spy
      { type: 'espionage.detected', payload: { owner: 'p2', kind: 'treasury', spy: 'p1' } },
    ]);
  });

  it('a noticed SUCCESSFUL theft reveals the leak but not the thief', () => {
    const k = createKernel([espionageModule, sureShot, alwaysDetect]);
    const r = okApply(k.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'fleets' }), ctx(0)));
    const det = detectedOf(r);
    expect(det).toHaveLength(1);
    expect(det[0]!.payload).toEqual({ owner: 'p2', kind: 'fleets' }); // no `spy` field
    // the theft itself still went through
    expect(r.state.intel?.p1?.[0]).toMatchObject({ kind: 'fleets', target: 'p2' });
  });

  it('perfect spies are never detected (hook pinned to 0)', () => {
    const k = createKernel([espionageModule, sureShot, neverDetect]);
    const r = okApply(k.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    expect(detectedOf(r)).toHaveLength(0);
  });

  it('the detect pipeline receives the attempt outcome (defence can price them apart)', () => {
    const seen: boolean[] = [];
    const probe: GameModule = {
      id: 'probe',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('espionage.detect', (v, args) => {
          seen.push((args as { succeeded: boolean }).succeeded);
          return v;
        });
      },
    };
    const win = createKernel([espionageModule, sureShot, probe]);
    okApply(win.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    const lose = createKernel([espionageModule, dudShot, probe]);
    okApply(lose.applyAction(baseState(), spy('p1', { target: 'p2', kind: 'treasury' }), ctx(0)));
    expect(seen).toEqual([true, false]);
  });
});

describe('espionage — the projection honors live windows only', () => {
  function granted(kind: 'treasury' | 'planet' | 'fleets', target: string, until = 999 * HOUR): GameState {
    const s = baseState();
    s.players.p2!.resources = { credits: 777 };
    s.fleets = {
      F2: { id: 'F2', owner: 'p2', location: 'B', movement: null, units: [{ unit: 'cruiser', count: 2 }], traits: [] },
    };
    s.intel = { p1: [{ kind, target, until }] };
    return s;
  }

  it('treasury window: the victim resources read live — for the thief only', () => {
    const s = granted('treasury', 'p2');
    expect(visibleState(s, 'p1', data).players.p2?.resources).toEqual({ credits: 777 });
    expect(visibleState(s, 'p3', data).players.p2?.resources).toEqual({}); // not for a bystander
    expect(visibleState(s, 'p2', data).intel).toBeUndefined(); // the victim never sees the theft
  });

  it('planet window: the granted world contents read live', () => {
    const view = visibleState(granted('planet', 'B'), 'p1', data);
    expect(view.planets.B?.owner).toBe('p2');
    expect(view.planets.B?.garrison).toEqual([{ unit: 'cruiser', count: 3 }]);
  });

  it('fleets window: the victim fleets stay in view', () => {
    const view = visibleState(granted('fleets', 'p2'), 'p1', data);
    expect(view.fleets.F2?.units).toEqual([{ unit: 'cruiser', count: 2 }]);
  });

  it('an EXPIRED window opens nothing (enforced at the boundary, not only by cleanup)', () => {
    const s = granted('treasury', 'p2', 1 * HOUR);
    s.time = 2 * HOUR; // the clock has passed the window
    expect(visibleState(s, 'p1', data).players.p2?.resources).toEqual({});
  });

  it('anti-leak: the serialized third-party view carries no trace of the theft', () => {
    const json = JSON.stringify(visibleState(granted('treasury', 'p2'), 'p3', data));
    expect(json).not.toContain('intel');
    expect(json).not.toContain('777');
  });
});
