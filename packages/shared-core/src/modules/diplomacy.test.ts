import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { diplomacyModule, stanceToRelation, type DiplomacyCapability } from './diplomacy';
import { getStance, pairKey, setStance } from '../state/diplomacy';
import { createInitialState, type GameState, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';
import type { GameModule } from '../kernel/module';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
});
const ctx: Context = { now: 0, data };

function player(id: string, status: Player['status'] = 'active'): Player {
  return { id, name: id, faction: '', status, resources: {} };
}
function baseState(): GameState {
  const s = createInitialState({ seed: 'dip', version: { data: '0.1.0', manifest: '1' } });
  return { ...s, players: { p1: player('p1'), p2: player('p2'), p3: player('p3') } };
}
function act(type: string, playerId: string, payload: unknown): Action {
  return { id: `s:${playerId}:1`, type, playerId, payload, issuedAt: 0 };
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected a rejection');
  return r.code;
}

const kernel = createKernel([diplomacyModule]);

describe('diplomacy module — declare (unilateral downgrade)', () => {
  it('declares war from peace and announces it', () => {
    const s = baseState();
    setStance(s, 'p1', 'p2', 'peace');
    const r = okApply(kernel.applyAction(s, act('diplomacy.declare', 'p1', { target: 'p2', stance: 'war' }), ctx));
    expect(getStance(r.state, 'p1', 'p2')).toBe('war');
    expect(r.events).toEqual([
      { type: 'diplomacy.changed', payload: { a: 'p1', b: 'p2', stance: 'war' } },
    ]);
  });

  it('dissolves an alliance down to peace without consent', () => {
    const s = baseState();
    setStance(s, 'p1', 'p2', 'alliance');
    const r = okApply(kernel.applyAction(s, act('diplomacy.declare', 'p1', { target: 'p2', stance: 'peace' }), ctx));
    expect(getStance(r.state, 'p1', 'p2')).toBe('peace');
  });

  it('rejects an upgrade smuggled through declare (peace → pact)', () => {
    const s = baseState();
    setStance(s, 'p1', 'p2', 'peace');
    const r = kernel.applyAction(s, act('diplomacy.declare', 'p1', { target: 'p2', stance: 'pact' }), ctx);
    expect(errCode(r)).toBe('E_BAD_STANCE');
  });

  it('rejects re-declaring the current stance (war → war on an unrecorded pair)', () => {
    const r = kernel.applyAction(baseState(), act('diplomacy.declare', 'p1', { target: 'p2', stance: 'war' }), ctx);
    expect(errCode(r)).toBe('E_BAD_STANCE');
  });

  it('voids the pair pending offer when the stance changes', () => {
    const s = baseState();
    setStance(s, 'p1', 'p2', 'peace');
    s.diplomacyOffers = { [pairKey('p1', 'p2')]: { from: 'p2', stance: 'alliance' } };
    const r = okApply(kernel.applyAction(s, act('diplomacy.declare', 'p1', { target: 'p2', stance: 'war' }), ctx));
    expect(r.state.diplomacyOffers?.[pairKey('p1', 'p2')]).toBeUndefined();
  });

  it.each([
    ['self target', { target: 'p1', stance: 'war' }, 'E_BAD_TARGET'],
    ['unknown target', { target: 'ghost', stance: 'war' }, 'E_NO_PLAYER'],
    ['malformed stance', { target: 'p2', stance: 'frenemy' }, 'E_BAD_PAYLOAD'],
  ])('fail-secure: %s → %s', (_name, payload, code) => {
    const r = kernel.applyAction(baseState(), act('diplomacy.declare', 'p1', payload), ctx);
    expect(errCode(r)).toBe(code);
  });

  it('refuses dealings with a defeated player (both directions)', () => {
    const s = baseState();
    s.players.p2 = player('p2', 'defeated');
    setStance(s, 'p1', 'p2', 'peace');
    const toDefeated = kernel.applyAction(s, act('diplomacy.declare', 'p1', { target: 'p2', stance: 'war' }), ctx);
    expect(errCode(toDefeated)).toBe('E_NO_PLAYER');
    const fromDefeated = kernel.applyAction(s, act('diplomacy.declare', 'p2', { target: 'p1', stance: 'war' }), ctx);
    expect(errCode(fromDefeated)).toBe('E_FORBIDDEN');
  });
});

describe('diplomacy module — propose / accept / reject (consensual upgrade)', () => {
  it('stores the offer and announces the proposal (no stance change yet)', () => {
    const r = okApply(kernel.applyAction(baseState(), act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx));
    expect(r.state.diplomacyOffers).toEqual({ [pairKey('p1', 'p2')]: { from: 'p1', stance: 'peace' } });
    expect(getStance(r.state, 'p1', 'p2')).toBe('war'); // unchanged until accepted
    expect(r.events).toEqual([
      { type: 'diplomacy.proposed', payload: { from: 'p1', to: 'p2', stance: 'peace' } },
    ]);
  });

  it('rejects a proposal that is not an upgrade (pact pair offered peace)', () => {
    const s = baseState();
    setStance(s, 'p1', 'p2', 'pact');
    const r = kernel.applyAction(s, act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx);
    expect(errCode(r)).toBe('E_BAD_STANCE');
  });

  it('lets a counter-proposal (from either side) replace the standing offer', () => {
    const s = baseState();
    const first = okApply(kernel.applyAction(s, act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx));
    const second = okApply(kernel.applyAction(first.state, act('diplomacy.propose', 'p2', { target: 'p1', stance: 'pact' }), ctx));
    expect(second.state.diplomacyOffers).toEqual({ [pairKey('p1', 'p2')]: { from: 'p2', stance: 'pact' } });
  });

  it('accept applies the offered stance, clears the offer and announces the change', () => {
    const s = okApply(kernel.applyAction(baseState(), act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx)).state;
    const r = okApply(kernel.applyAction(s, act('diplomacy.accept', 'p2', { from: 'p1' }), ctx));
    expect(getStance(r.state, 'p1', 'p2')).toBe('peace');
    expect(r.state.diplomacyOffers?.[pairKey('p1', 'p2')]).toBeUndefined();
    expect(r.events).toEqual([
      { type: 'diplomacy.changed', payload: { a: 'p1', b: 'p2', stance: 'peace' } },
    ]);
  });

  it('cannot accept an offer that does not exist, or your own offer', () => {
    expect(errCode(kernel.applyAction(baseState(), act('diplomacy.accept', 'p2', { from: 'p1' }), ctx))).toBe('E_NO_OFFER');
    const s = okApply(kernel.applyAction(baseState(), act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx)).state;
    // p1 tries to "accept" the offer they made themselves (from: p2 has no offer)
    expect(errCode(kernel.applyAction(s, act('diplomacy.accept', 'p1', { from: 'p2' }), ctx))).toBe('E_NO_OFFER');
  });

  it('reject clears the offer without touching the stance', () => {
    const s = okApply(kernel.applyAction(baseState(), act('diplomacy.propose', 'p1', { target: 'p2', stance: 'alliance' }), ctx)).state;
    const r = okApply(kernel.applyAction(s, act('diplomacy.reject', 'p2', { from: 'p1' }), ctx));
    expect(r.state.diplomacyOffers?.[pairKey('p1', 'p2')]).toBeUndefined();
    expect(getStance(r.state, 'p1', 'p2')).toBe('war');
    expect(r.events).toEqual([
      { type: 'diplomacy.rejected', payload: { from: 'p1', to: 'p2', stance: 'alliance' } },
    ]);
  });

  it('offers are per-pair: a third party sees no cross-talk', () => {
    const s = okApply(kernel.applyAction(baseState(), act('diplomacy.propose', 'p1', { target: 'p2', stance: 'peace' }), ctx)).state;
    // p3 has no offer from p1 even though p1 proposed to p2
    expect(errCode(kernel.applyAction(s, act('diplomacy.accept', 'p3', { from: 'p1' }), ctx))).toBe('E_NO_OFFER');
  });
});

describe('diplomacy module — a coalition is between humans only (no bots)', () => {
  function withBot(): GameState {
    const s = baseState();
    s.players.bot = { ...player('bot'), ai: true };
    return s;
  }

  it('rejects proposing an alliance to a bot — and from one', () => {
    const toBot = kernel.applyAction(withBot(), act('diplomacy.propose', 'p1', { target: 'bot', stance: 'alliance' }), ctx);
    expect(errCode(toBot)).toBe('E_BOT_ALLIANCE');
    const fromBot = kernel.applyAction(withBot(), act('diplomacy.propose', 'bot', { target: 'p1', stance: 'alliance' }), ctx);
    expect(errCode(fromBot)).toBe('E_BOT_ALLIANCE');
  });

  it('still allows peace and a pact with a bot', () => {
    const r = okApply(kernel.applyAction(withBot(), act('diplomacy.propose', 'p1', { target: 'bot', stance: 'pact' }), ctx));
    expect(r.state.diplomacyOffers).toEqual({ [pairKey('bot', 'p1')]: { from: 'p1', stance: 'pact' } });
  });

  it('accept re-validates: a hand-seeded bot-alliance offer cannot be accepted', () => {
    const s = withBot();
    s.diplomacyOffers = { [pairKey('p1', 'bot')]: { from: 'bot', stance: 'alliance' } };
    const r = kernel.applyAction(s, act('diplomacy.accept', 'p1', { from: 'bot' }), ctx);
    expect(errCode(r)).toBe('E_BOT_ALLIANCE');
  });
});

describe('diplomacy module — capability (stance → relation)', () => {
  it('maps every stance onto the coarse relation', () => {
    expect(stanceToRelation('war')).toBe('hostile');
    expect(stanceToRelation('peace')).toBe('neutral');
    expect(stanceToRelation('pact')).toBe('neutral');
    expect(stanceToRelation('alliance')).toBe('ally');
  });

  it('exposes getStance/getRelation through the capability registry', () => {
    const probe: GameModule = {
      id: 'probe',
      version: '1.0.0',
      setup(api) {
        api.onAction('probe.relation', (_a, h) => {
          const dip = h.capability<DiplomacyCapability>('diplomacy');
          const rel = dip?.getRelation(h.state, 'p1', 'p2') ?? 'hostile';
          h.emit('probe.result', { rel, stance: dip?.getStance(h.state, 'p1', 'p2') });
        });
      },
    };
    const s = baseState();
    setStance(s, 'p1', 'p2', 'alliance');
    const withDip = createKernel([probe, diplomacyModule]);
    const r = okApply(withDip.applyAction(s, act('probe.relation', 'p1', {}), ctx));
    expect(r.events[0]?.payload).toEqual({ rel: 'ally', stance: 'alliance' });
    // graceful degradation: without the module the probe falls back to hostile
    const without = createKernel([probe]);
    const r2 = okApply(without.applyAction(s, act('probe.relation', 'p1', {}), ctx));
    expect(r2.events[0]?.payload).toEqual({ rel: 'hostile', stance: undefined });
  });
});
