import { describe, expect, it } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { heroModule } from './hero';
import {
  createInitialState,
  type GameState,
  type Planet,
  type Player,
  type PlayerArsenal,
} from '../state/gameState';
import { visibleState } from '../state/visibility';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, ApplyResult, Context } from '../action/types';

// ARS-3 — the ownership gate: a seat carrying an arsenal SNAPSHOT builds/fits only
// what it owns (E_NOT_OWNED, fail-secure); a seat without one is unrestricted
// (regular/dev matches unchanged — graceful degradation). The snapshot is
// owner-private in the fog projection, like the treasury.

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 5, hp: 40 }, cost: { metal: 10 }, slots: { weapon: 1 } },
    drone: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 }, cost: { metal: 3 } },
  },
  factions: {},
  buildings: {},
  events: {},
  modules: {
    railgun: { name: 'Railgun', slot: 'weapon', tag: 'horizontal', cost: { metal: 5 } },
    coilgun: { name: 'Coilgun', slot: 'weapon', tag: 'horizontal', cost: { metal: 5 } },
  },
  heroes: { commander: { name: 'Cmdr', slots: 2 } },
  heroFittings: {
    visor: { name: 'Visor', cost: {} },
    crest: { name: 'Crest', cost: {} },
  },
});

const ctx = (now = 0): Context => ({ now, data });

function player(id: string, arsenal?: PlayerArsenal): Player {
  return {
    id,
    name: id,
    faction: 'x',
    status: 'active',
    resources: { metal: 100 },
    ...(arsenal ? { arsenal } : {}),
  };
}
function planet(id: string, owner: string | null): Planet {
  return { id, owner, position: { x: 0, y: 0 }, resources: {}, buildings: [], garrison: [], traits: [] };
}
function stateWith(players: Player[]): GameState {
  const s = createInitialState({ seed: 'ars', version: { data: '0.1.0', manifest: '1' } });
  const rec: Record<string, Player> = {};
  for (const p of players) rec[p.id] = p;
  return { ...s, players: rec, planets: { A: planet('A', 'p1') } };
}
function build(unit: string, modules?: string[]): Action {
  return {
    id: 's:p1:1',
    type: 'unit.build',
    playerId: 'p1',
    payload: { planetId: 'A', unit, ...(modules ? { modules } : {}) },
    issuedAt: 0,
  };
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

const OWNED: PlayerArsenal = { hulls: ['cruiser'], modules: ['railgun'], fittings: ['visor'] };

describe('unit.build × arsenal snapshot (ARS-3)', () => {
  const kernel = createKernel([constructionModule]);

  it('an owned hull with an owned module builds; unowned are E_NOT_OWNED', () => {
    const st = (): GameState => stateWith([player('p1', OWNED)]);
    expect(okApply(kernel.applyAction(st(), build('cruiser', ['railgun']), ctx())).ok).toBe(true);
    // the hull is not in the snapshot
    expect(errCode(kernel.applyAction(st(), build('drone'), ctx()))).toBe('E_NOT_OWNED');
    // the hull is owned, but one module is not
    expect(errCode(kernel.applyAction(st(), build('cruiser', ['coilgun']), ctx()))).toBe(
      'E_NOT_OWNED',
    );
  });

  it('a seat WITHOUT a snapshot builds unrestricted (regular matches unchanged)', () => {
    const st = stateWith([player('p1')]);
    expect(okApply(kernel.applyAction(st, build('drone'), ctx())).ok).toBe(true);
  });
});

describe('hero.fit × arsenal snapshot (ARS-3)', () => {
  const kernel = createKernel([heroModule]);
  const fit = (fitting: string): Action => ({
    id: 's:p1:2',
    type: 'hero.fit',
    playerId: 'p1',
    payload: { heroId: 'hero:p1', fitting },
    issuedAt: 0,
  });
  const withHero = (arsenal?: PlayerArsenal): GameState => {
    const st = stateWith([player('p1', arsenal)]);
    return {
      ...st,
      heroes: {
        'hero:p1': { id: 'hero:p1', owner: 'p1', location: 'A', cooldowns: {}, archetype: 'commander' },
      },
    };
  };

  it('an owned fitting installs; an unowned one is E_NOT_OWNED; no snapshot = open', () => {
    expect(okApply(kernel.applyAction(withHero(OWNED), fit('visor'), ctx())).ok).toBe(true);
    expect(errCode(kernel.applyAction(withHero(OWNED), fit('crest'), ctx()))).toBe('E_NOT_OWNED');
    expect(okApply(kernel.applyAction(withHero(), fit('crest'), ctx())).ok).toBe(true);
  });
});

describe('fog: the arsenal snapshot is owner-private (ARS-3)', () => {
  it('the viewer keeps their own snapshot; an enemy’s is stripped', () => {
    const st = stateWith([player('p1', OWNED), player('p2', OWNED)]);
    const view = visibleState(st, 'p1', data);
    expect(view.players.p1?.arsenal).toEqual(OWNED);
    expect(view.players.p2?.arsenal).toBeUndefined(); // what an enemy CAN build is intel
  });
});
