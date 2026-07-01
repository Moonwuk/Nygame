import { describe, expect, it } from 'vitest';
import type { Action, ApplyResult, Context } from '../action/types';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import { createInitialState, type GameState, type Player } from '../state/gameState';
import { scientistModule } from './scientist';
import { technologyModule } from './technology';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {},
  factions: {},
  buildings: {},
  events: {},
  technologies: {
    a: { name: 'A', cost: { metal: 1 }, researchTimeHours: 1 },
    b: { name: 'B', cost: { metal: 1 }, researchTimeHours: 1 },
    c: { name: 'C', cost: { metal: 1 }, researchTimeHours: 1 },
  },
  scientists: {
    polymath: { name: 'Polymath', slotBonus: 1 },
    admiral: { name: 'Admiral', branch: 'space' },
  },
});

const ctx = (now: number): Context => ({ now, data });

function stateWith(scientist?: { id: string; level: number }): GameState {
  const base = createInitialState({ seed: 'sci', version: { data: '0.1.0', manifest: '1' } });
  const p1: Player = {
    id: 'p1',
    name: 'p1',
    faction: 'x',
    status: 'active',
    resources: { metal: 10 },
  };
  if (scientist) p1.scientist = scientist;
  return { ...base, players: { p1 } };
}

const research = (technology: string): Action => ({
  id: 's:p1:1',
  type: 'technology.research',
  playerId: 'p1',
  payload: { technology },
  issuedAt: 0,
});
const ok = (r: ApplyResult): ApplyResult & { ok: true } => {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
};
const err = (r: ApplyResult): string => {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
};

describe('scientist module — research leader', () => {
  it('a +slot leader raises research slots via the research.slots hook', () => {
    const kernel = createKernel([technologyModule, scientistModule]);

    // No leader → base 2 slots: the third research is rejected.
    let none = ok(kernel.applyAction(stateWith(), research('a'), ctx(0))).state;
    none = ok(kernel.applyAction(none, research('b'), ctx(0))).state;
    expect(err(kernel.applyAction(none, research('c'), ctx(0)))).toBe('E_RESEARCH_SLOTS_FULL');

    // Polymath (slotBonus 1) → 3 slots: the third now fits.
    let poly = ok(kernel.applyAction(stateWith({ id: 'polymath', level: 1 }), research('a'), ctx(0)))
      .state;
    poly = ok(kernel.applyAction(poly, research('b'), ctx(0))).state;
    poly = ok(kernel.applyAction(poly, research('c'), ctx(0))).state;
    expect(poly.players.p1?.technologies?.active?.length).toBe(3);

    // A focus leader (no slotBonus) does not add slots.
    let adm = ok(kernel.applyAction(stateWith({ id: 'admiral', level: 1 }), research('a'), ctx(0)))
      .state;
    adm = ok(kernel.applyAction(adm, research('b'), ctx(0))).state;
    expect(err(kernel.applyAction(adm, research('c'), ctx(0)))).toBe('E_RESEARCH_SLOTS_FULL');

    // An unknown scientist id degrades gracefully (no bonus, no throw).
    let bad = ok(kernel.applyAction(stateWith({ id: 'ghost', level: 9 }), research('a'), ctx(0)))
      .state;
    bad = ok(kernel.applyAction(bad, research('b'), ctx(0))).state;
    expect(err(kernel.applyAction(bad, research('c'), ctx(0)))).toBe('E_RESEARCH_SLOTS_FULL');
  });
});
