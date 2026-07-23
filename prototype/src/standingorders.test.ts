import { describe, it, expect } from 'vitest';
import { createKernel, createInitialState } from '../../packages/shared-core/src/index';
import type { GameState, Fleet, Planet, Context, ApplyResult } from '../../packages/shared-core/src/index';
import {
  standingOrdersModule,
  orderAuto,
  orderScramble,
  patrolStamp,
  serverAutoAssaultActions,
  serverPatrolActions,
  freshSortie,
  HOUR,
  data,
  type Patrol,
  type SortieState,
} from './game';

const kernel = createKernel([standingOrdersModule]);
const ctx = (now = 0): Context => ({ now, data });

// fighter_squadron (data/units.json): fuel 3, rearmRounds 2, strikeRange 180.
const WING_FUEL = 3;
const WING_REARM = 2;
const WING_RANGE = 180;

function fleet(id: string, over: Partial<Fleet> = {}): Fleet {
  return {
    id, owner: 'green', location: 'A', movement: null,
    units: [{ unit: 'cruiser', count: 1 }], landing: [], traits: [], battleId: null, ...over,
  } as unknown as Fleet;
}
function wing(id: string, over: Partial<Fleet> = {}): Fleet {
  return fleet(id, {
    units: [
      { unit: 'fighter_squadron', count: 2 },
      { unit: 'strike_carrier', count: 1 },
    ],
    ...over,
  });
}
function planet(id: string, pos: { x: number; y: number }, owner: string | null = null, links: string[] = []): Planet {
  return { id, owner, position: pos, links, garrison: [], buildings: [] } as unknown as Planet;
}
function stateWith(fleets: Fleet[], planets: Planet[] = [planet('A', { x: 0, y: 0 })]): GameState {
  const s = createInitialState({ seed: 'so', version: { data: '0.1.0', manifest: '1' } });
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
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
type SOState = GameState & {
  autoAssault?: Record<string, true>;
  patrols?: Record<string, Patrol & { rearmAt?: number }>;
};

describe('standingOrdersModule — CC-2 auto-storm stance (authoritative)', () => {
  it('order.auto toggles the flag; the emptied map leaves state entirely', () => {
    let s = ok(kernel.applyAction(stateWith([fleet('F')]), orderAuto('green', 'F', true), ctx()));
    expect((s as SOState).autoAssault).toEqual({ F: true });
    s = ok(kernel.applyAction(s, orderAuto('green', 'F', false), ctx()));
    expect('autoAssault' in (s as SOState)).toBe(false);
  });

  it('is fail-secure: unknown fleet / not yours / non-boolean payload reject', () => {
    const s = stateWith([fleet('F'), fleet('E', { owner: 'red' })]);
    expect(rej(kernel.applyAction(s, orderAuto('green', 'ghost', true), ctx()))).toBe('E_NO_FLEET');
    expect(rej(kernel.applyAction(s, orderAuto('green', 'E', true), ctx()))).toBe('E_FORBIDDEN');
    const bad = { ...orderAuto('green', 'F', true), payload: { fleetId: 'F', on: 'yes' } };
    expect(rej(kernel.applyAction(s, bad, ctx()))).toBe('E_BAD_PAYLOAD');
  });
});

describe('standingOrdersModule — CC-4 patrol (authoritative)', () => {
  it('order.scramble ON: the SERVER computes the patrol (center/radius/sortie/cadence)', () => {
    const s = ok(kernel.applyAction(stateWith([wing('W')], [planet('A', { x: 7, y: 9 })]), orderScramble('green', 'W', true), ctx(5)));
    expect((s as SOState).patrols?.W).toEqual({
      center: { x: 7, y: 9 },
      radius: WING_RANGE,
      sortie: { fuel: WING_FUEL, rearming: 0 },
      rearmAt: 5 + HOUR,
    });
  });

  it('order.scramble OFF stands the patrol down (key removed when last one goes)', () => {
    let s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    s = ok(kernel.applyAction(s, orderScramble('green', 'W', false), ctx()));
    expect('patrols' in (s as SOState)).toBe(false);
  });

  it('needs a squadron and a parked node (fail-secure)', () => {
    const noWing = stateWith([fleet('F')]);
    expect(rej(kernel.applyAction(noWing, orderScramble('green', 'F', true), ctx()))).toBe('E_NO_SHIPS');
    const adrift = stateWith([wing('W', { location: null } as Partial<Fleet>)]);
    expect(rej(kernel.applyAction(adrift, orderScramble('green', 'W', true), ctx()))).toBe('E_CONDITIONS_UNMET');
    const moving = stateWith([wing('W', { movement: { to: 'B' } as never })]);
    expect(rej(kernel.applyAction(moving, orderScramble('green', 'W', true), ctx()))).toBe('E_CONDITIONS_UNMET');
  });

  it('patrol.stamp persists the driver verdict, bounds-checked against the wing spec', () => {
    let s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    s = ok(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: 1, rearming: 0 }, 3 * HOUR), ctx()));
    expect((s as SOState).patrols?.W).toMatchObject({ sortie: { fuel: 1, rearming: 0 }, rearmAt: 3 * HOUR });
    // A forged stamp can't mint fuel, park an impossible rearm, or corrupt the cadence.
    expect(rej(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: WING_FUEL + 1, rearming: 0 }), ctx()))).toBe('E_BAD_PAYLOAD');
    expect(rej(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: 0, rearming: WING_REARM + 1 }), ctx()))).toBe('E_BAD_PAYLOAD');
    expect(rej(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: 1, rearming: 0 }, Infinity), ctx()))).toBe('E_BAD_PAYLOAD');
    // No patrol standing → nothing to stamp.
    const bare = stateWith([wing('W')]);
    expect(rej(kernel.applyAction(bare, patrolStamp('green', 'W', { fuel: 1, rearming: 0 }), ctx()))).toBe('E_NO_TARGET');
  });

  it('sweeps a dead fleet’s standing orders on advance (no immortal entries)', () => {
    let s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    s = ok(kernel.applyAction(s, orderAuto('green', 'W', true), ctx()));
    const gone = { ...s, fleets: {} } as GameState;
    const r = kernel.advanceTo(gone, ctx(HOUR));
    if (!r.ok) throw new Error('advance failed');
    expect('patrols' in (r.state as SOState)).toBe(false);
    expect('autoAssault' in (r.state as SOState)).toBe(false);
  });
});

describe('serverAutoAssaultActions — the CC-2 server driver core', () => {
  const flag = (s: GameState, id: string): GameState => {
    (s as SOState).autoAssault = { [id]: true };
    return s;
  };

  it('storms someone else’s world under a flagged, parked fleet (orbit first)', () => {
    const s = flag(stateWith([fleet('F')], [planet('A', { x: 0, y: 0 }, 'red')]), 'F');
    const out = serverAutoAssaultActions(s);
    expect(out).toHaveLength(1);
    expect(out[0]!.owner).toBe('green');
    expect(out[0]!.actions.map((a) => a.type)).toEqual(['fleet.orbit', 'fleet.assault']);
  });

  it('holds on your own world, under enemy contact, in transit — and skips unflagged fleets', () => {
    const own = flag(stateWith([fleet('F')], [planet('A', { x: 0, y: 0 }, 'green')]), 'F');
    expect(serverAutoAssaultActions(own)).toEqual([]);
    const contested = flag(
      stateWith([fleet('F'), fleet('E', { owner: 'red' })], [planet('A', { x: 0, y: 0 }, 'red')]),
      'F',
    );
    expect(serverAutoAssaultActions(contested)).toEqual([]);
    const moving = flag(stateWith([fleet('F', { movement: { to: 'B' } as never })], [planet('A', { x: 0, y: 0 }, 'red')]), 'F');
    expect(serverAutoAssaultActions(moving)).toEqual([]);
    const unflagged = stateWith([fleet('F')], [planet('A', { x: 0, y: 0 }, 'red')]);
    expect(serverAutoAssaultActions(unflagged)).toEqual([]);
  });

  it('ignores a stale flag whose fleet is gone (the sweep will drop it)', () => {
    const s = stateWith([], [planet('A', { x: 0, y: 0 }, 'red')]);
    (s as SOState).autoAssault = { GONE: true };
    expect(serverAutoAssaultActions(s)).toEqual([]);
  });
});

describe('serverPatrolActions — the CC-4 server driver core', () => {
  const patrolState = (
    fleets: Fleet[],
    planets: Planet[],
    patrol: Partial<Patrol & { rearmAt?: number }> = {},
  ): GameState => {
    const s = stateWith(fleets, planets);
    (s as SOState).patrols = {
      W: {
        center: { x: 0, y: 0 },
        radius: WING_RANGE,
        sortie: freshSortie(WING_FUEL),
        rearmAt: HOUR,
        ...patrol,
      },
    };
    return s;
  };

  it('engages a co-located identified enemy, burning one fuel (patch rides back)', () => {
    // The wing identifies its own node — a red fleet parked THERE is a legal target.
    const s = patrolState(
      [wing('W'), fleet('E', { owner: 'red' })],
      [planet('A', { x: 0, y: 0 })],
    );
    const out = serverPatrolActions(s, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.actions.map((a) => a.type)).toEqual(['fleet.engage']);
    expect(out[0]!.patch?.sortie).toEqual({ fuel: WING_FUEL - 1, rearming: 0 });
  });

  it('flies to intercept an in-radius contact identified through an owned world', () => {
    // Green's world A floods identify one hop to B; the red fleet parked at B is seen.
    const s = patrolState(
      [wing('W'), fleet('E', { owner: 'red', location: 'B' })],
      [planet('A', { x: 0, y: 0 }, 'green', ['B']), planet('B', { x: 50, y: 0 }, null, ['A'])],
    );
    const out = serverPatrolActions(s, 0);
    expect(out[0]!.actions.map((a) => a.type)).toEqual(['fleet.move']);
  });

  it('is fog-honest and war-gated: unseen or at-peace contacts are never struck', () => {
    // B is in radius but NOT identified (no owned world, no link) → hold fire.
    const unseen = patrolState(
      [wing('W'), fleet('E', { owner: 'red', location: 'B' })],
      [planet('A', { x: 0, y: 0 }), planet('B', { x: 50, y: 0 })],
    );
    expect(serverPatrolActions(unseen, 0)[0]!.actions).toEqual([]);
    // Co-located but at PEACE → hold fire (never auto-war).
    const peaceful = patrolState(
      [wing('W'), fleet('E', { owner: 'red' })],
      [planet('A', { x: 0, y: 0 })],
    );
    peaceful.diplomacy = { 'green|red': 'peace' };
    expect(serverPatrolActions(peaceful, 0)[0]!.actions).toEqual([]);
  });

  it('ticks the rearm one round per game-hour past the cadence mark', () => {
    const s = patrolState([wing('W')], [planet('A', { x: 0, y: 0 })], {
      sortie: { fuel: 0, rearming: WING_REARM } as SortieState,
      rearmAt: HOUR,
    });
    const out = serverPatrolActions(s, 2 * HOUR); // two rounds elapse → refuelled
    expect(out[0]!.patch?.sortie).toEqual({ fuel: WING_FUEL, rearming: 0 });
    expect(out[0]!.patch?.rearmAt).toBe(3 * HOUR);
  });

  it('drops a patrol whose fleet lost its wing (or is gone)', () => {
    const noWing = patrolState([fleet('W')], [planet('A', { x: 0, y: 0 })]);
    expect(serverPatrolActions(noWing, 0)[0]).toMatchObject({ fleetId: 'W', drop: true });
    const gone = patrolState([], [planet('A', { x: 0, y: 0 })]);
    expect(serverPatrolActions(gone, 0)[0]).toMatchObject({ fleetId: 'W', drop: true });
  });

  it('emits patrols in sorted fleet-id order regardless of record key order (invariant #6)', () => {
    // Insert the patrol record in REVERSE-sorted key order — the way a Postgres JSONB
    // round-trip (LazyRoomRegistry hibernate → rehydrate) can reshuffle object keys.
    // The driver must still issue in a fixed order (like serverChainActions), else which
    // of two co-located wings wins a race for the same target is host/wake dependent.
    const s = stateWith([wing('W2'), wing('W1')], [planet('A', { x: 0, y: 0 })]);
    (s as SOState).patrols = {
      W2: { center: { x: 0, y: 0 }, radius: WING_RANGE, sortie: freshSortie(WING_FUEL), rearmAt: HOUR },
      W1: { center: { x: 0, y: 0 }, radius: WING_RANGE, sortie: freshSortie(WING_FUEL), rearmAt: HOUR },
    };
    expect(serverPatrolActions(s, 0).map((o) => o.fleetId)).toEqual(['W1', 'W2']);
  });
});

// BF-26: the scramble toggle must not refuel a wing. OFF stashes the sortie
// (fuel/rearm) on the state; ON resumes it — only a never-flown wing starts full.
describe('order.scramble — OFF→ON resumes the sortie instead of refuelling (BF-26)', () => {
  type WSState = SOState & { wingSorties?: Record<string, SortieState> };

  it('a dry wing stays dry across the toggle', () => {
    let s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    // Burn the tank down to 0 and start the rearm cooldown (the driver's stamp).
    s = ok(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: 0, rearming: WING_REARM }), ctx()));
    s = ok(kernel.applyAction(s, orderScramble('green', 'W', false), ctx()));
    expect((s as WSState).patrols).toBeUndefined();
    expect((s as WSState).wingSorties?.W).toEqual({ fuel: 0, rearming: WING_REARM }); // stashed
    s = ok(kernel.applyAction(s, orderScramble('green', 'W', true), ctx()));
    // The re-enabled patrol resumes the dry sortie — no free tank.
    expect((s as WSState).patrols?.W?.sortie).toEqual({ fuel: 0, rearming: WING_REARM });
    expect((s as WSState).wingSorties).toBeUndefined(); // stash consumed
  });

  it('a never-flown wing still starts with a full tank', () => {
    const s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    expect((s as SOState).patrols?.W?.sortie).toEqual({ fuel: WING_FUEL, rearming: 0 });
  });

  it('the stash of a dead fleet is swept by housekeeping', () => {
    let s = ok(kernel.applyAction(stateWith([wing('W')]), orderScramble('green', 'W', true), ctx()));
    s = ok(kernel.applyAction(s, patrolStamp('green', 'W', { fuel: 1, rearming: 0 }), ctx()));
    s = ok(kernel.applyAction(s, orderScramble('green', 'W', false), ctx()));
    delete s.fleets.W; // the wing dies while off-patrol
    const r = kernel.advanceTo({ ...s, time: 0 }, ctx(HOUR));
    if (!r.ok) throw new Error('advance failed');
    expect((r.state as WSState).wingSorties).toBeUndefined();
  });
});
