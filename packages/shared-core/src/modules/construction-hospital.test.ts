import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  units: {
    marine: {
      faction: 'x',
      stats: { attack: 10, defense: 10, speed: 30, hp: 20 },
      domain: 'ground',
      traits: ['ground'],
      cost: { metal: 20 },
      buildTimeHours: 1,
    },
  },
  factions: {},
  buildings: {
    hospital: {
      name: 'Field Hospital',
      cost: { metal: 160, credits: 60 },
      buildTimeHours: 8,
      hp: 20,
      healRate: 0.15,
    },
  },
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
});

function ctx(now: number): Context {
  return { now, data };
}

function okAdvance(r: AdvanceResult): GameState {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r.state;
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [{ type: 'hospital', level: 1, hp: 20 }],
    // 4 marines at half HP: full = 4 × 20 = 80, current = 40
    garrison: [{ unit: 'marine', count: 4, hp: 40 }],
    traits: [],
  };
}

function makeState(owner: string | null = 'p1'): GameState {
  const base = createInitialState({ seed: 'hospital-test', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...base,
    players: { p1: player('p1') },
    planets: { home: planet('home', owner) },
  };
}

const kernel = createKernel([economyModule, constructionModule]);

describe('hospital heal mechanic', () => {
  it('restores garrison HP over time', () => {
    const s = makeState();
    // healRate=0.15 → 0.15×80=12 HP/hour; after 4h: 40+48=88 → capped at 80 (full)
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack).toBeDefined();
    expect(stack!.hp).toBeUndefined(); // fully healed → cleared to undefined
  });

  it('does not overheal above full', () => {
    const s = makeState();
    const state = okAdvance(kernel.advanceTo(s, ctx(20 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeUndefined();
    expect(stack!.count).toBe(4); // no phantom units created
  });

  it('partially heals with less time', () => {
    const s = makeState();
    // After 1 hour: 40 + 0.15×80×1 = 52 HP
    const state = okAdvance(kernel.advanceTo(s, ctx(HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(52);
  });

  it('does not heal when building is destroyed', () => {
    const s = makeState();
    s.planets.home!.buildings[0]!.hp = 0; // hospital destroyed
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(40); // unchanged
  });

  it('does not heal neutral planets', () => {
    const s = makeState(null); // neutral owner
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(40); // unchanged
  });

  it('does not touch already-full stacks', () => {
    const s = makeState();
    s.planets.home!.garrison[0]!.hp = undefined; // already full
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeUndefined();
  });
});
