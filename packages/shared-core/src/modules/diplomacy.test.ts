import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule, HandlerContext } from '../kernel/module';
import { diplomacyModule } from './diplomacy';
import { combatModule } from './combat';
import { createInitialState, type Fleet, type GameState, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import {
  getOffer,
  getStance,
  setStance,
  stanceToRelation,
  type DiplomacyCapability,
} from '../state/diplomacy';
import type { Action, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    fighter: { faction: 'x', stats: { attack: 10, defense: 0, speed: 10, hp: 20 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
});

const ctx = (now = 0): Context => ({ now, data });

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function fleet(id: string, owner: string, location: string): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: [{ unit: 'fighter', count: 1 }],
    traits: [],
  };
}
function baseState(): GameState {
  const s = createInitialState({ seed: 'dip', version: { data: '0.1.0', manifest: '1' } });
  s.players.p1 = player('p1');
  s.players.p2 = player('p2');
  return s;
}
function declare(playerId: string, target: string, stance: unknown, seq = 1): Action {
  return {
    id: `s:${playerId}:${seq}`,
    type: 'diplomacy.declare',
    playerId,
    payload: { target, stance },
    issuedAt: 0,
  };
}
function okApply(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

describe('diplomacyModule — declarations (D2)', () => {
  const kernel = createKernel([diplomacyModule]);

  it('declaring war on a peaceful neighbour flips the stance and announces it', () => {
    const state = baseState();
    setStance(state, 'p1', 'p2', 'peace');
    const r = okApply(kernel.applyAction(deepFreeze(state), declare('p1', 'p2', 'war'), ctx()));
    expect(getStance(r.state, 'p1', 'p2')).toBe('war');
    expect(r.events).toContainEqual({
      type: 'diplomacy.changed',
      payload: { a: 'p1', b: 'p2', stance: 'war', from: 'peace' },
    });
  });

  it('escalation is unilateral at every step (alliance → peace, pact → war)', () => {
    const state = baseState();
    setStance(state, 'p1', 'p2', 'alliance');
    const r1 = okApply(kernel.applyAction(state, declare('p1', 'p2', 'peace'), ctx()));
    expect(getStance(r1.state, 'p1', 'p2')).toBe('peace');

    const state2 = baseState();
    setStance(state2, 'p1', 'p2', 'pact');
    const r2 = okApply(kernel.applyAction(state2, declare('p2', 'p1', 'war', 2), ctx()));
    expect(getStance(r2.state, 'p1', 'p2')).toBe('war');
  });

  it('a friendly declaration records an OFFER — the stance does not move (consent, D3)', () => {
    const state = baseState(); // default stance: war
    const r = okApply(kernel.applyAction(deepFreeze(state), declare('p1', 'p2', 'peace'), ctx()));
    expect(getStance(r.state, 'p1', 'p2')).toBe('war'); // a lone declaration changes nothing
    expect(getOffer(r.state, 'p1', 'p2')).toBe('peace'); // …but the offer now stands
    expect(r.events).toContainEqual({
      type: 'diplomacy.offered',
      payload: { from: 'p1', to: 'p2', stance: 'peace' },
    });
    expect(r.events.some((e) => e.type === 'diplomacy.changed')).toBe(false);
  });

  it('a matching counter-declaration commits the friendlier stance and clears the offers', () => {
    const state = baseState();
    const offered = okApply(kernel.applyAction(state, declare('p1', 'p2', 'peace'), ctx()));
    const r = okApply(kernel.applyAction(offered.state, declare('p2', 'p1', 'peace', 2), ctx()));
    expect(getStance(r.state, 'p1', 'p2')).toBe('peace'); // mutual — committed
    expect(getOffer(r.state, 'p1', 'p2')).toBeNull();
    expect(getOffer(r.state, 'p2', 'p1')).toBeNull();
    expect(r.state.diplomacyOffers).toBeUndefined(); // emptied map is dropped
    expect(r.events).toContainEqual({
      type: 'diplomacy.changed',
      payload: { a: 'p2', b: 'p1', stance: 'peace', from: 'war' },
    });
  });

  it('mismatched offers coexist until one side matches the other', () => {
    const state = baseState(); // war
    const s1 = okApply(kernel.applyAction(state, declare('p1', 'p2', 'pact'), ctx())).state;
    const s2 = okApply(kernel.applyAction(s1, declare('p2', 'p1', 'alliance', 2), ctx())).state;
    expect(getStance(s2, 'p1', 'p2')).toBe('war'); // pact ≠ alliance — no deal yet
    // p1 comes around to the alliance — that matches p2's standing offer.
    const done = okApply(kernel.applyAction(s2, declare('p1', 'p2', 'alliance', 3), ctx())).state;
    expect(getStance(done, 'p1', 'p2')).toBe('alliance');
    expect(done.diplomacyOffers).toBeUndefined(); // p1's stale pact offer cleared too
  });

  it('an escalation voids the pair’s standing offers (war ends the negotiation)', () => {
    const state = baseState();
    setStance(state, 'p1', 'p2', 'peace');
    const offered = okApply(kernel.applyAction(state, declare('p1', 'p2', 'pact'), ctx())).state;
    expect(getOffer(offered, 'p1', 'p2')).toBe('pact');
    const warred = okApply(kernel.applyAction(offered, declare('p2', 'p1', 'war', 2), ctx())).state;
    expect(getStance(warred, 'p1', 'p2')).toBe('war');
    expect(warred.diplomacyOffers).toBeUndefined(); // the pact offer did not survive
  });

  it('re-declaring an identical standing offer is rejected', () => {
    const state = baseState();
    const offered = okApply(kernel.applyAction(state, declare('p1', 'p2', 'peace'), ctx())).state;
    expect(errCode(kernel.applyAction(offered, declare('p1', 'p2', 'peace', 2), ctx()))).toBe(
      'E_ALREADY_OFFERED',
    );
    // …but replacing it with a DIFFERENT friendly stance is fine.
    const replaced = okApply(kernel.applyAction(offered, declare('p1', 'p2', 'pact', 3), ctx()));
    expect(getOffer(replaced.state, 'p1', 'p2')).toBe('pact');
  });

  it('re-declaring the current stance is rejected (no-op declaration)', () => {
    const state = baseState(); // default: war
    expect(errCode(kernel.applyAction(state, declare('p1', 'p2', 'war'), ctx()))).toBe(
      'E_SAME_STANCE',
    );
  });

  it('fail-secure payload guards: bad stance / self-target / unknown player', () => {
    const state = baseState();
    expect(errCode(kernel.applyAction(state, declare('p1', 'p2', 'frenemy'), ctx()))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(state, declare('p1', 'p1', 'war'), ctx()))).toBe(
      'E_BAD_PAYLOAD',
    );
    expect(errCode(kernel.applyAction(state, declare('p1', 'ghost', 'war'), ctx()))).toBe(
      'E_NO_PLAYER',
    );
  });
});

describe('diplomacyModule — the `diplomacy` capability', () => {
  it('projects stances to relations (war→hostile, peace/pact→neutral, alliance→ally, self→ally)', () => {
    // Probe module: reads the capability the way a consumer (combat) would.
    let seen: string[] = [];
    const probe: GameModule = {
      id: 'probe',
      version: '1.0.0',
      setup(api) {
        api.onAction('probe', (_a, h: HandlerContext) => {
          const cap = h.capability<DiplomacyCapability>('diplomacy');
          if (!cap) return h.reject('E_NO_CAPABILITY');
          seen = [
            cap.getRelation(h.state, 'p1', 'p2'), // war (default)
            cap.getRelation(h.state, 'p1', 'p3'), // peace
            cap.getRelation(h.state, 'p2', 'p3'), // alliance
            cap.getRelation(h.state, 'p1', 'p1'), // self
          ];
        });
      },
    };
    const kernel = createKernel([diplomacyModule, probe]);
    const state = baseState();
    state.players.p3 = player('p3');
    setStance(state, 'p1', 'p3', 'peace');
    setStance(state, 'p2', 'p3', 'alliance');
    okApply(
      kernel.applyAction(
        state,
        { id: 's:p1:9', type: 'probe', playerId: 'p1', payload: null, issuedAt: 0 },
        ctx(),
      ),
    );
    expect(seen).toEqual(['hostile', 'neutral', 'ally', 'ally']);
  });

  it('stanceToRelation covers every stance', () => {
    expect(stanceToRelation('war')).toBe('hostile');
    expect(stanceToRelation('peace')).toBe('neutral');
    expect(stanceToRelation('pact')).toBe('neutral');
    expect(stanceToRelation('alliance')).toBe('ally');
  });
});

describe('diplomacy × combat — the capability drives isHostile end-to-end', () => {
  // Fixture: emit `fleet.arrived` without going through movement (combat.test.ts pattern).
  const arrivalModule: GameModule = {
    id: 'test-arrival',
    version: '1.0.0',
    setup(api) {
      api.onAction('arrive', (a, h) => {
        const fleetId = (a.payload as { fleetId: string }).fleetId;
        h.emit('fleet.arrived', { fleetId, at: h.state.fleets[fleetId]?.location });
      });
    },
  };
  const arrive = (fleetId: string): Action => ({
    id: 's:p1:5',
    type: 'arrive',
    playerId: 'p1',
    payload: { fleetId },
    issuedAt: 0,
  });

  function contested(): GameState {
    const s = baseState();
    s.fleets.f1 = fleet('f1', 'p1', 'A');
    s.fleets.f2 = fleet('f2', 'p2', 'A');
    return s;
  }

  it('at peace two co-located fleets do not engage; after a war declaration they do', () => {
    const kernel = createKernel([diplomacyModule, combatModule, arrivalModule]);
    const peaceful = contested();
    setStance(peaceful, 'p1', 'p2', 'peace');

    const calm = okApply(kernel.applyAction(peaceful, arrive('f1'), ctx()));
    expect(Object.keys(calm.state.battles)).toHaveLength(0); // neutral — no auto-combat

    const declared = okApply(kernel.applyAction(calm.state, declare('p1', 'p2', 'war'), ctx()));
    const engaged = okApply(kernel.applyAction(declared.state, arrive('f1'), ctx()));
    expect(Object.keys(engaged.state.battles)).toHaveLength(1); // hostile — battle starts
  });
});

describe('diplomacy — humans-only coalition (боты не приглашаются)', () => {
  const kernel = createKernel([diplomacyModule]);
  function withBot(): GameState {
    const s = baseState();
    s.players.bot = { ...player('bot'), ai: true };
    return s;
  }

  it('an alliance-ward declaration involving a bot is refused, never recorded', () => {
    const toBot = kernel.applyAction(withBot(), declare('p1', 'bot', 'alliance'), ctx());
    expect(errCode(toBot)).toBe('E_BOT_ALLIANCE');
    const fromBot = kernel.applyAction(withBot(), declare('bot', 'p1', 'alliance'), ctx());
    expect(errCode(fromBot)).toBe('E_BOT_ALLIANCE');
  });

  it('peace and a pact with a bot stay legal (only the coalition is barred)', () => {
    const r = okApply(kernel.applyAction(withBot(), declare('p1', 'bot', 'peace'), ctx()));
    expect(r.state.diplomacyOffers).toEqual({ 'p1>bot': 'peace' });
  });
});

describe('diplomacy — an eliminated player leaves no zombie offers', () => {
  const kernel = createKernel([diplomacyModule]);

  it('sweeps offers the fallen player sent and received', () => {
    const offered = okApply(
      kernel.applyAction(baseState(), declare('p2', 'p1', 'peace'), ctx()),
    ).state;
    offered.players.p2 = { ...offered.players.p2!, status: 'defeated' };
    offered.scheduled = [
      { id: 'evt:d', at: 1, type: 'player.eliminated', payload: { playerId: 'p2' }, seq: 0 },
    ];
    offered.scheduleSeq = 1;
    const r = kernel.advanceTo(offered, ctx(1));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.diplomacyOffers).toBeUndefined(); // the dead letter is gone
  });
});

// BF-32: elimination removes a seat from the political game too. Without these
// gates a defeated player stayed a full diplomatic actor (declaring wars,
// receiving offers that then hang forever against a seat that can never answer).
describe('diplomacyModule — eliminated seats are out of the game (BF-32)', () => {
  const kernel = createKernel([diplomacyModule]);

  it('a defeated actor cannot declare', () => {
    const state = baseState();
    setStance(state, 'p1', 'p2', 'peace');
    state.players.p1!.status = 'defeated';
    expect(errCode(kernel.applyAction(state, declare('p1', 'p2', 'war'), ctx()))).toBe(
      'E_FORBIDDEN',
    );
  });

  it('a defeated target can be neither declared upon nor offered to', () => {
    const state = baseState();
    setStance(state, 'p1', 'p2', 'war');
    state.players.p2!.status = 'defeated';
    expect(errCode(kernel.applyAction(state, declare('p1', 'p2', 'peace'), ctx()))).toBe(
      'E_NO_PLAYER',
    );
  });
});
