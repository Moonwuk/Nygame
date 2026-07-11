import { describe, it, expect } from 'vitest';
import { createKernel } from './kernel';
import type { GameModule } from './module';
import { createInitialState, type GameState, type Planet } from '../state/gameState';
import { parseGameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

// ---------------------------------------------------------------------------
// Test fixtures: minimal modules that exercise the kernel's three mechanisms.
// ---------------------------------------------------------------------------

const testData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
});

function baseState(): GameState {
  return createInitialState({ seed: 'test-seed', version: { data: '0.1.0', manifest: '1' } });
}

function makePlanet(
  id: string,
  owner: string | null,
  resources: Record<string, number> = {},
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources,
    buildings: [],
    garrison: [],
    traits: [],
  };
}

function withPlanet(state: GameState, planet: Planet): GameState {
  return { ...state, planets: { ...state.planets, [planet.id]: planet } };
}

function action(type: string, payload: unknown, playerId = 'p1'): Action {
  return { id: `s:${playerId}:1`, type, playerId, payload, issuedAt: 0 };
}

const ctx = (now = 1000): Context => ({ now, data: testData });

function expectOk(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got rejection ${r.code}`);
  return r;
}
function expectErr(r: ApplyResult): Extract<ApplyResult, { ok: false }> {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r;
}

// --- hook pipeline modules (non-commutative ops to prove ordering) ---
const movementModule: GameModule = {
  id: 'movement',
  version: '1.0.0',
  setup(api) {
    api.onAction('move.computeSpeed', (a, h) => {
      const base = (a.payload as { base: number }).base;
      h.emit('speed.computed', { speed: h.hook('speed', base) });
    });
  },
};
const addFiveModule: GameModule = {
  id: 'add-five',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('speed', (cur) => cur + 5);
  },
};
const doubleModule: GameModule = {
  id: 'double',
  version: '1.0.0',
  setup(api) {
    api.hook<number>('speed', (cur) => cur * 2);
  },
};

// --- event modules (graceful degradation: docs/modulesystem.md) ---
const combatModule: GameModule = {
  id: 'combat',
  version: '1.0.0',
  setup(api) {
    api.onAction('combat.resolve', (a, h) => {
      const { planetId } = a.payload as { planetId: string };
      // Combat announces a death and does NOT care whether anyone listens.
      h.emit('unit.died', { unit: 'cruiser', planetId });
    });
  },
};
const reinforceModule: GameModule = {
  id: 'reinforce',
  version: '1.0.0',
  setup(api) {
    api.on('unit.died', (event, h) => {
      const { planetId } = event.payload as { planetId: string };
      const planet = h.state.planets[planetId];
      if (!planet) return;
      planet.garrison.push({ unit: 'reserve', count: 1 });
      h.emit('unit.reinforced', { planetId });
    });
  },
};

// --- capability modules (optional link + fallback: docs/modulesystem.md) ---
interface Diplomacy {
  getRelation(a: string, b: string): 'ally' | 'hostile';
}
const relationProbeModule: GameModule = {
  id: 'relation-probe',
  version: '1.0.0',
  setup(api) {
    api.onAction('relation.check', (_a, h) => {
      const dip = h.capability<Diplomacy>('diplomacy');
      const rel = dip?.getRelation('p1', 'p2') ?? 'hostile'; // fallback default
      h.emit('relation.result', { rel });
    });
  },
};
const diplomacyModule: GameModule = {
  id: 'diplomacy',
  version: '1.0.0',
  setup(api) {
    api.provideCapability<Diplomacy>('diplomacy', { getRelation: () => 'ally' });
  },
};

// --- security / fail-secure modules ---
const bankModule: GameModule = {
  id: 'bank',
  version: '1.0.0',
  setup(api) {
    api.onAction('bank.withdraw', (a, h) => {
      const { planetId, amount } = a.payload as { planetId: string; amount: number };
      const planet = h.state.planets[planetId];
      if (!planet || planet.owner !== a.playerId) {
        return h.reject('E_FORBIDDEN'); // access control (OWASP A01)
      }
      const have = planet.resources.credits ?? 0;
      if (have < amount) {
        return h.reject('E_INSUFFICIENT');
      }
      planet.resources.credits = have - amount;
    });
  },
};
const buggyModule: GameModule = {
  id: 'buggy',
  version: '1.0.0',
  setup(api) {
    api.onAction('buggy.boom', () => {
      throw new Error('kaboom: secret internal detail that must not leak');
    });
  },
};
const diceModule: GameModule = {
  id: 'dice',
  version: '1.0.0',
  setup(api) {
    api.onAction('dice.roll', (_a, h) => {
      h.emit('dice.rolled', { value: h.rng.nextInt(1, 1_000_000) });
    });
  },
};
const loopModule: GameModule = {
  id: 'loop',
  version: '1.0.0',
  setup(api) {
    api.onAction('loop.start', (_a, h) => h.emit('loop.tick'));
    api.on('loop.tick', (_e, h) => h.emit('loop.tick')); // intentionally infinite
  },
};

// ---------------------------------------------------------------------------

describe('kernel — manifest & dispatch', () => {
  it('records modules in order, with versions (the match manifest)', () => {
    const kernel = createKernel([movementModule, addFiveModule, doubleModule]);
    expect(kernel.manifest.modules).toEqual([
      { id: 'movement', version: '1.0.0' },
      { id: 'add-five', version: '1.0.0' },
      { id: 'double', version: '1.0.0' },
    ]);
  });

  it('rejects an unknown action type (fail-secure)', () => {
    const kernel = createKernel([movementModule]);
    const res = kernel.applyAction(baseState(), action('does.not.exist', {}), ctx());
    expect(expectErr(res).code).toBe('E_UNKNOWN_ACTION');
  });

  it('rejects a KNOWN action once the match has ended (terminal gate, BF-34)', () => {
    const kernel = createKernel([movementModule]);
    const ongoing = baseState();
    // Sanity: the same action succeeds while the match runs…
    expect(
      kernel.applyAction(ongoing, action('move.computeSpeed', { base: 10 }), ctx()).ok,
    ).toBe(true);
    // …but is frozen out once the match is decided.
    const ended: GameState = { ...ongoing, match: { ...ongoing.match, status: 'ended' } };
    const res = kernel.applyAction(ended, action('move.computeSpeed', { base: 10 }), ctx());
    expect(expectErr(res).code).toBe('E_MATCH_ENDED');
  });

  it('throws on duplicate action handlers at build time', () => {
    expect(() => createKernel([movementModule, movementModule])).toThrow(/Duplicate action/);
  });

  it('throws on duplicate capabilities at build time', () => {
    expect(() => createKernel([diplomacyModule, diplomacyModule])).toThrow(/Duplicate capability/);
  });
});

describe('kernel — hooks (value pipelines with base defaults)', () => {
  it('returns the base value when no module contributes', () => {
    const kernel = createKernel([movementModule]);
    const res = expectOk(
      kernel.applyAction(baseState(), action('move.computeSpeed', { base: 10 }), ctx()),
    );
    expect(res.events[0]?.payload).toEqual({ speed: 10 });
  });

  it('composes contributions in fixed module order — order matters', () => {
    // [add-five, double]: (10 + 5) * 2 = 30
    const k1 = createKernel([movementModule, addFiveModule, doubleModule]);
    const r1 = expectOk(
      k1.applyAction(baseState(), action('move.computeSpeed', { base: 10 }), ctx()),
    );
    expect(r1.events[0]?.payload).toEqual({ speed: 30 });

    // [double, add-five]: (10 * 2) + 5 = 25  → deterministic, manifest-ordered
    const k2 = createKernel([movementModule, doubleModule, addFiveModule]);
    const r2 = expectOk(
      k2.applyAction(baseState(), action('move.computeSpeed', { base: 10 }), ctx()),
    );
    expect(r2.events[0]?.payload).toEqual({ speed: 25 });
  });
});

describe('kernel — events & graceful degradation (docs/modulesystem.md)', () => {
  it('a listener reacts to an emitted event', () => {
    const kernel = createKernel([combatModule, reinforceModule]);
    const state = withPlanet(baseState(), makePlanet('kepler_7', 'p2'));
    const res = expectOk(
      kernel.applyAction(state, action('combat.resolve', { planetId: 'kepler_7' }), ctx()),
    );

    expect(res.state.planets.kepler_7?.garrison).toEqual([{ unit: 'reserve', count: 1 }]);
    expect(res.events.map((e) => e.type)).toEqual(['unit.died', 'unit.reinforced']);
  });

  it('the same action works with the listener absent — event simply fades', () => {
    const kernel = createKernel([combatModule]); // no reinforce
    const state = withPlanet(baseState(), makePlanet('kepler_7', 'p2'));
    const res = expectOk(
      kernel.applyAction(state, action('combat.resolve', { planetId: 'kepler_7' }), ctx()),
    );

    expect(res.state.planets.kepler_7?.garrison).toEqual([]); // unchanged
    expect(res.events.map((e) => e.type)).toEqual(['unit.died']);
  });

  it('caps runaway event chains (fail-secure, OWASP A10)', () => {
    const kernel = createKernel([loopModule]);
    const res = kernel.applyAction(baseState(), action('loop.start', {}), ctx());
    expect(expectErr(res).code).toBe('E_EVENT_OVERFLOW');
  });
});

describe('kernel — capabilities (optional links with fallback)', () => {
  it('uses the fallback default when the capability is absent', () => {
    const kernel = createKernel([relationProbeModule]); // no diplomacy
    const res = expectOk(kernel.applyAction(baseState(), action('relation.check', {}), ctx()));
    expect(res.events[0]?.payload).toEqual({ rel: 'hostile' });
  });

  it('uses the provided capability when present', () => {
    const kernel = createKernel([relationProbeModule, diplomacyModule]);
    const res = expectOk(kernel.applyAction(baseState(), action('relation.check', {}), ctx()));
    expect(res.events[0]?.payload).toEqual({ rel: 'ally' });
  });
});

describe('kernel — purity & fail-secure (docs/architecture.md §6)', () => {
  it('never mutates the input state', () => {
    const kernel = createKernel([bankModule]);
    const state = deepFreeze(withPlanet(baseState(), makePlanet('p', 'p1', { credits: 100 })));
    const res = expectOk(
      kernel.applyAction(state, action('bank.withdraw', { planetId: 'p', amount: 40 }), ctx()),
    );

    expect(res.state.planets.p?.resources.credits).toBe(60);
    expect(state.planets.p?.resources.credits).toBe(100); // input untouched (was frozen)
  });

  it('rejects on insufficient funds and commits nothing', () => {
    const kernel = createKernel([bankModule]);
    const state = withPlanet(baseState(), makePlanet('p', 'p1', { credits: 30 }));
    const res = kernel.applyAction(
      state,
      action('bank.withdraw', { planetId: 'p', amount: 40 }),
      ctx(),
    );

    expect(expectErr(res).code).toBe('E_INSUFFICIENT');
    expect(state.planets.p?.resources.credits).toBe(30); // unchanged
  });

  it('rejects access to a planet the player does not own (OWASP A01)', () => {
    const kernel = createKernel([bankModule]);
    const state = withPlanet(baseState(), makePlanet('p', 'enemy', { credits: 100 }));
    const res = kernel.applyAction(
      state,
      action('bank.withdraw', { planetId: 'p', amount: 10 }),
      ctx(),
    );
    expect(expectErr(res).code).toBe('E_FORBIDDEN');
  });

  it('converts an unexpected error into E_INTERNAL without leaking detail', () => {
    const kernel = createKernel([buggyModule]);
    const res = kernel.applyAction(baseState(), action('buggy.boom', {}), ctx());
    const err = expectErr(res);
    expect(err.code).toBe('E_INTERNAL');
    expect(JSON.stringify(err)).not.toContain('secret');
  });

  it('rejects when server time would move backwards', () => {
    const kernel = createKernel([bankModule]);
    const state = { ...baseState(), time: 5000 };
    const res = kernel.applyAction(
      state,
      action('bank.withdraw', { planetId: 'p', amount: 1 }),
      ctx(1000),
    );
    expect(expectErr(res).code).toBe('E_TIME_BACKWARDS');
  });
});

describe('kernel — RNG & time (determinism)', () => {
  it('is deterministic: same inputs → same output', () => {
    const kernel = createKernel([diceModule]);
    const state = baseState();
    const a = expectOk(kernel.applyAction(state, action('dice.roll', {}), ctx()));
    const b = expectOk(kernel.applyAction(state, action('dice.roll', {}), ctx()));
    expect(a.events[0]?.payload).toEqual(b.events[0]?.payload);
  });

  it('advances RNG state and stamps authoritative time into the new state', () => {
    const kernel = createKernel([diceModule]);
    const state = baseState();
    const res = expectOk(kernel.applyAction(state, action('dice.roll', {}), ctx(4242)));

    expect(res.state.time).toBe(4242);
    expect(res.state.rng).not.toEqual(state.rng); // stream advanced

    // Re-rolling from the *new* state yields a different draw (stream moved on).
    const next = expectOk(kernel.applyAction(res.state, action('dice.roll', {}), ctx(5000)));
    expect(next.events[0]?.payload).not.toEqual(res.events[0]?.payload);
  });
});
