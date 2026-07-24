import { describe, it, expect } from 'vitest';
import {
  createKernel,
  createInitialState,
  movementModule,
} from '../../packages/shared-core/src/index';
import type {
  Action,
  ApplyResult,
  Context,
  Fleet,
  GameState,
  Hero,
  Planet,
} from '../../packages/shared-core/src/index';
import {
  standingOrdersModule,
  serverChainActions,
  orderChain,
  chainStamp,
  validateChainSteps,
  MAX_CHAIN_STEPS,
  MAX_CHAIN_WAIT_HOURS,
  HOUR,
  data,
  type ChainStep,
} from './game';

// CC-1: fleet order chains — Задержка (wait), Точка+ (waypoint moves) and queued
// abilities («прийти и открыть огонь» = move+barrage) on one authoritative rail.
// The module stores/advances the chain fail-secure; the pure driver core decides the
// next step; the integration test runs a real march through movementModule.

const kernel = createKernel([standingOrdersModule]);
const kernelI = createKernel([standingOrdersModule, movementModule]);
const ctx = (now = 0): Context => ({ now, data });

type ChState = GameState & {
  orders?: Record<string, { steps: ChainStep[]; waitUntil?: number }>;
};

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id,
    owner: 'green',
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: 1 }],
    landing: [],
    traits: [],
    battleId: null,
    ...over,
  } as unknown as Fleet;
}
function planet(id: string, pos: { x: number; y: number }, links: string[] = []): Planet {
  return {
    id,
    owner: null,
    position: pos,
    links,
    garrison: [],
    buildings: [],
  } as unknown as Planet;
}
function stateWith(fleets: Fleet[], planets?: Planet[]): GameState {
  const s = createInitialState({ seed: 'cc1', version: { data: '0.1.0', manifest: '1' } });
  const ps = planets ?? [planet('A', { x: 0, y: 0 }, ['B']), planet('B', { x: 120, y: 0 }, ['A'])];
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const p: Record<string, Planet> = {};
  for (const x of ps) p[x.id] = x;
  return { ...s, fleets: f, planets: p };
}
function ok(r: ApplyResult): GameState {
  if (!r.ok) throw new Error('apply failed: ' + r.code);
  return r.state;
}
function rej(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
const chainOf = (s: GameState, fid: string) => (s as ChState).orders?.[fid];

describe('order.chain — setting the plan (fail-secure)', () => {
  it('stores a normalized chain and [] cancels it (empty map leaves state entirely)', () => {
    let s = stateWith([fleet('F')]);
    s = ok(
      kernel.applyAction(
        s,
        orderChain('green', 'F', [
          { kind: 'wait', hours: 2 },
          { kind: 'move', to: 'B' },
        ]),
        ctx(),
      ),
    );
    expect(chainOf(s, 'F')).toEqual({
      steps: [
        { kind: 'wait', hours: 2 },
        { kind: 'move', to: 'B' },
      ],
    });
    s = ok(kernel.applyAction(s, orderChain('green', 'F', []), ctx()));
    expect((s as ChState).orders).toBeUndefined();
  });

  it('rejects foreign and unknown fleets with opaque codes', () => {
    const s = stateWith([fleet('F', { owner: 'red' })]);
    expect(rej(kernel.applyAction(s, orderChain('green', 'F', []), ctx()))).toBe('E_FORBIDDEN');
    expect(rej(kernel.applyAction(s, orderChain('green', 'NOPE', []), ctx()))).toBe('E_NO_FLEET');
  });

  it('rejects garbage steps: bad shapes, unknown worlds, out-of-range waits, oversize chains', () => {
    const s = stateWith([fleet('F')]);
    const bad: unknown[] = [
      'nope',
      [{ kind: 'move', to: 'GHOST' }],
      [{ kind: 'wait', hours: 0 }],
      [{ kind: 'wait', hours: -3 }],
      [{ kind: 'wait', hours: Number.NaN }],
      [{ kind: 'wait', hours: MAX_CHAIN_WAIT_HOURS + 1 }],
      [{ kind: 'barrage', target: 42 }],
      [{ kind: 'strike', target: null, hours: 0 }],
      [{ kind: 'strike', target: 42, hours: 2 }],
      [{ kind: 'ability', abilityId: 42 }],
      [{ kind: 'ability', abilityId: 'no_such_ability' }],
      [{ kind: 'ability', abilityId: 'corridor', target: 42 }],
      [{ kind: 'selfdestruct' }],
      Array.from({ length: MAX_CHAIN_STEPS + 1 }, () => ({ kind: 'assault' })),
    ];
    for (const steps of bad) {
      expect(
        rej(kernel.applyAction(s, orderChain('green', 'F', steps as ChainStep[]), ctx())),
      ).toBe('E_BAD_PAYLOAD');
    }
  });

  it('rebuilds steps — smuggled extra keys never reach state (A08)', () => {
    const s = ok(
      kernel.applyAction(
        stateWith([fleet('F')]),
        orderChain('green', 'F', [{ kind: 'move', to: 'B', hack: true } as unknown as ChainStep]),
        ctx(),
      ),
    );
    expect(chainOf(s, 'F')).toEqual({ steps: [{ kind: 'move', to: 'B' }] });
  });

  it('a fresh plan drops an armed wait deadline', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, orderChain('green', 'F', [{ kind: 'wait', hours: 2 }]), ctx()));
    s = ok(
      kernel.applyAction(
        s,
        chainStamp('green', 'F', [{ kind: 'wait', hours: 2 }], 2 * HOUR),
        ctx(),
      ),
    );
    expect(chainOf(s, 'F')?.waitUntil).toBe(2 * HOUR);
    s = ok(kernel.applyAction(s, orderChain('green', 'F', [{ kind: 'wait', hours: 5 }]), ctx()));
    expect(chainOf(s, 'F')).toEqual({ steps: [{ kind: 'wait', hours: 5 }] });
  });
});

describe('chain.stamp — the driver-trust surface', () => {
  it('refuses to advance a fleet with no chain, and bounds-checks the payload', () => {
    let s = stateWith([fleet('F')]);
    expect(rej(kernel.applyAction(s, chainStamp('green', 'F', []), ctx()))).toBe('E_NO_TARGET');
    s = ok(kernel.applyAction(s, orderChain('green', 'F', [{ kind: 'assault' }]), ctx()));
    expect(
      rej(kernel.applyAction(s, chainStamp('green', 'F', [{ kind: 'move', to: 'GHOST' }]), ctx())),
    ).toBe('E_BAD_PAYLOAD');
    expect(rej(kernel.applyAction(s, chainStamp('green', 'F', [], Number.NaN), ctx()))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(rej(kernel.applyAction(s, chainStamp('green', 'F', [], -1), ctx()))).toBe(
      'E_BAD_PAYLOAD',
    );
  });

  it('consuming down to [] clears the chain', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, orderChain('green', 'F', [{ kind: 'assault' }]), ctx()));
    s = ok(kernel.applyAction(s, chainStamp('green', 'F', []), ctx()));
    expect((s as ChState).orders).toBeUndefined();
  });

  it('housekeeping: chains of dead fleets are swept on advance', () => {
    let s = stateWith([fleet('F')]);
    s = ok(kernel.applyAction(s, orderChain('green', 'F', [{ kind: 'assault' }]), ctx()));
    delete s.fleets.F;
    const r = kernel.advanceTo(s, ctx(HOUR));
    if (!r.ok) throw new Error(r.code);
    expect((r.state as ChState).orders).toBeUndefined();
  });
});

describe('serverChainActions — the pure driver core', () => {
  const chained = (f: Fleet, steps: ChainStep[], waitUntil?: number): GameState => {
    const s = stateWith([f]) as ChState;
    s.orders = { [f.id]: waitUntil === undefined ? { steps } : { steps, waitUntil } };
    return s;
  };

  it('wait: arms the deadline once, holds while ticking, consumes when elapsed', () => {
    const steps: ChainStep[] = [{ kind: 'wait', hours: 2 }, { kind: 'assault' }];
    const armed = serverChainActions(chained(fleet('F'), steps), 0);
    expect(armed).toEqual([
      { fleetId: 'F', owner: 'green', actions: [], patch: { steps, waitUntil: 2 * HOUR } },
    ]);
    expect(serverChainActions(chained(fleet('F'), steps, 2 * HOUR), HOUR)).toEqual([]);
    const done = serverChainActions(chained(fleet('F'), steps, 2 * HOUR), 2 * HOUR);
    expect(done[0]?.patch).toEqual({ steps: [{ kind: 'assault' }] });
    expect(done[0]?.actions).toEqual([]);
  });

  it('move: issues the order and consumes; already-there consumes without an order', () => {
    const go = serverChainActions(chained(fleet('F'), [{ kind: 'move', to: 'B' }]), 0);
    expect(go[0]?.actions.map((a) => a.type)).toEqual(['fleet.move']);
    expect(go[0]?.patch).toEqual({ steps: [] });
    const parked = serverChainActions(
      chained(fleet('F', { location: 'B' }), [{ kind: 'move', to: 'B' }]),
      0,
    );
    expect(parked[0]?.actions).toEqual([]);
    expect(parked[0]?.patch).toEqual({ steps: [] });
  });

  it('strike: opens the fire window (focus + deadline), holds, then ceases fire and moves on', () => {
    const steps: ChainStep[] = [
      { kind: 'strike', target: 'X', hours: 3 },
      { kind: 'move', to: 'B' },
    ];
    const open = serverChainActions(chained(fleet('F'), steps), 0);
    expect(open[0]?.actions.map((a) => a.type)).toEqual(['fleet.barrage']);
    expect(open[0]?.actions[0]?.payload).toEqual({ fleetId: 'F', targetId: 'X' });
    expect(open[0]?.patch).toEqual({ steps, waitUntil: 3 * HOUR });
    // mid-window: guns stay hot, the driver stays silent
    expect(serverChainActions(chained(fleet('F'), steps, 3 * HOUR), HOUR)).toEqual([]);
    // window elapsed: cease fire (clear focus) and consume the step
    const done = serverChainActions(chained(fleet('F'), steps, 3 * HOUR), 3 * HOUR);
    expect(done[0]?.actions[0]?.payload).toEqual({ fleetId: 'F', targetId: null });
    expect(done[0]?.patch).toEqual({ steps: [{ kind: 'move', to: 'B' }] });
  });

  it('assault enters orbit first when needed; barrage carries its focus target', () => {
    const far = serverChainActions(chained(fleet('F'), [{ kind: 'assault' }]), 0);
    expect(far[0]?.actions.map((a) => a.type)).toEqual(['fleet.orbit', 'fleet.assault']);
    const near = serverChainActions(
      chained(fleet('F', { orbit: 'near' } as Partial<Fleet>), [{ kind: 'assault' }]),
      0,
    );
    expect(near[0]?.actions.map((a) => a.type)).toEqual(['fleet.assault']);
    const fire = serverChainActions(chained(fleet('F'), [{ kind: 'barrage', target: 'X' }]), 0);
    expect(fire[0]?.actions[0]?.payload).toEqual({ fleetId: 'F', targetId: 'X' });
  });

  it('a busy fleet (in transit / in battle) is left alone until free', () => {
    const moving = fleet('F', {
      movement: { from: 'A', to: 'B', departedAt: 0, arrivesAt: HOUR } as Fleet['movement'],
    });
    expect(serverChainActions(chained(moving, [{ kind: 'assault' }]), 0)).toEqual([]);
    const fighting = fleet('F', { battleId: 'b1' });
    expect(serverChainActions(chained(fighting, [{ kind: 'assault' }]), 0)).toEqual([]);
  });

  it('iterates fleets in sorted id order (JSONB scrambles key order between hosts)', () => {
    const s = stateWith([fleet('Z'), fleet('Q')]) as ChState;
    s.orders = { Z: { steps: [{ kind: 'assault' }] }, Q: { steps: [{ kind: 'assault' }] } };
    expect(serverChainActions(s, 0).map((c) => c.fleetId)).toEqual(['Q', 'Z']);
  });

  it('ability: the fleet hero casts when free, holds on cooldown, drops when heroless', () => {
    const heroFleet = (over: Partial<Hero> = {}): ChState => {
      const s = stateWith([fleet('F')]) as ChState;
      s.heroes = {
        h1: { id: 'h1', owner: 'green', fleetId: 'F', alive: true, location: 'A', ...over } as Hero,
      };
      s.orders = { F: { steps: [{ kind: 'ability', abilityId: 'corridor', target: 'B' }] } };
      return s;
    };
    // free + off cooldown → the commanding hero casts, step consumed
    const cast = serverChainActions(heroFleet(), 0);
    expect(cast[0]?.actions.map((a) => a.type)).toEqual(['hero.ability']);
    expect(cast[0]?.actions[0]?.payload).toEqual({
      heroId: 'h1',
      abilityId: 'corridor',
      target: 'B',
    });
    expect(cast[0]?.patch).toEqual({ steps: [] });
    // on cooldown (temp_lane → the 'path' ledger slot) → held, fleet omitted this tick
    expect(serverChainActions(heroFleet({ cooldowns: { path: 5 * HOUR } }), 0)).toEqual([]);
    // no living hero commands the fleet → drop the stale step, issue nothing
    const heroless = stateWith([fleet('F')]) as ChState;
    heroless.orders = { F: { steps: [{ kind: 'ability', abilityId: 'corridor', target: 'B' }] } };
    const dropped = serverChainActions(heroless, 0);
    expect(dropped[0]?.actions).toEqual([]);
    expect(dropped[0]?.patch).toEqual({ steps: [] });
  });

  it('validateChainSteps is the single gate both actions share', () => {
    const s = stateWith([fleet('F')]);
    expect(validateChainSteps([{ kind: 'move', to: 'B' }], s)).toEqual([{ kind: 'move', to: 'B' }]);
    expect(validateChainSteps([{ kind: 'move', to: 'GHOST' }], s)).toBeNull();
    // ability: a catalog id is kept (+ optional target, smuggled keys stripped);
    // an unknown ability id is garbage — the same gate as an unknown world.
    expect(validateChainSteps([{ kind: 'ability', abilityId: 'corridor' }], s)).toEqual([
      { kind: 'ability', abilityId: 'corridor' },
    ]);
    expect(
      validateChainSteps([{ kind: 'ability', abilityId: 'corridor', target: 'B', hack: 1 }], s),
    ).toEqual([{ kind: 'ability', abilityId: 'corridor', target: 'B' }]);
    expect(validateChainSteps([{ kind: 'ability', abilityId: 'ghost_skill' }], s)).toBeNull();
  });
});

describe('CC-1 integration: the iron-order scenario over real movement', () => {
  /** One host tick: stamp the chain forward, then apply the head step's orders —
   *  exactly what netserver.runServerStanding / main.driveChains do. */
  function driveTick(state: GameState, now: number): GameState {
    let s = state;
    for (const c of serverChainActions(s, now)) {
      if (c.patch) {
        const r = kernelI.applyAction(
          s,
          chainStamp(c.owner, c.fleetId, c.patch.steps, c.patch.waitUntil),
          ctx(now),
        );
        if (r.ok) s = r.state;
      }
      for (const a of c.actions as Action[]) {
        const r = kernelI.applyAction(s, a, ctx(now));
        if (r.ok) s = r.state;
      }
    }
    return s;
  }

  it('wait 2h → march to B → march home: the whole plan runs without a live player', () => {
    let s = stateWith([fleet('F')]);
    s = ok(
      kernelI.applyAction(
        s,
        orderChain('green', 'F', [
          { kind: 'wait', hours: 2 },
          { kind: 'move', to: 'B' },
          { kind: 'move', to: 'A' },
        ]),
        ctx(0),
      ),
    );
    let departed = 0; // fleet.move must not fire before the Задержка elapses
    // Run until the plan is consumed AND the final march lands.
    for (let hour = 0; hour <= 400 && (chainOf(s, 'F') || s.fleets.F?.movement); hour++) {
      const now = hour * HOUR;
      const adv = kernelI.advanceTo(s, ctx(now));
      if (!adv.ok) throw new Error(adv.code);
      s = adv.state;
      const before = s.fleets.F?.movement;
      // Live hosts re-run the driver on every wake/frame — chains advance through
      // consecutive ready steps without waiting an hour. Mirror that: drive to
      // fixpoint (bounded) within the tick.
      for (let pass = 0; pass < 4 && serverChainActions(s, now).length > 0; pass++) {
        s = driveTick(s, now);
      }
      if (!before && s.fleets.F?.movement && departed === 0) departed = now;
    }
    expect(departed).toBe(2 * HOUR); // held exactly the Задержка, then marched
    expect(chainOf(s, 'F')).toBeUndefined(); // plan fully consumed
    expect(s.fleets.F?.location).toBe('A'); // out and back — via B
    expect(s.fleets.F?.movement).toBeNull();
  });
});
