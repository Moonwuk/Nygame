import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import type { AdvanceResult, Context, MatchConfig } from '../action/types';
import { victoryModule } from './victory';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: {
      faction: 'x',
      stats: { attack: 10, defense: 8, speed: 6, hp: 40 },
      line: 'front',
    },
    infantry: {
      faction: 'x',
      domain: 'ground',
      stats: { attack: 2, defense: 3, speed: 1, hp: 5 },
      line: 'front',
    },
    // A super-unit: the only kind of unit that scores (ordinary military = 0).
    titan: {
      faction: 'x',
      superUnit: true,
      scoreValue: 3,
      stats: { attack: 30, defense: 30, speed: 4, hp: 200 },
      line: 'front',
    },
  },
  factions: {},
  buildings: {
    fort: {
      name: 'Fortress',
      hp: 35,
      defenseBonus: 0.35,
      scoreValue: 20,
      upgrades: [
        { hp: 50, defenseBonus: 0.5 },
        { hp: 65, defenseBonus: 0.65 },
      ],
    },
  },
  events: {},
  planetTypes: { terran: { scoreValue: 40 } },
});

function ctx(now: number, config?: MatchConfig): Context {
  return { now, data, config };
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function planet(id: string, owner: string | null, extra: Partial<Planet> = {}): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
    ...extra,
  };
}

function fleet(id: string, owner: string, units = 1): Fleet {
  return {
    id,
    owner,
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: units }],
    traits: [],
  };
}

function baseState(): GameState {
  return {
    ...createInitialState({ seed: 'victory', version: { data: '0.1.0', manifest: '1' } }),
    players: { p1: player('p1'), p2: player('p2') },
  };
}

function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('victory module', () => {
  it('ends by domination when a player controls the configured planet share', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p1'),
        C: planet('C', 'p2'),
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'domination',
      endedAt: HOUR,
    });
    expect(r.state.match.scores.p1?.controlledPlanets).toBe(2);
    expect(r.events).toContainEqual({
      type: 'match.ended',
      payload: expect.objectContaining({ winner: 'p1', reason: 'domination' }),
    });
  });

  it('marks empty active players defeated and ends by elimination', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: { A: planet('A', 'p1') },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.players.p2?.status).toBe('defeated');
    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'elimination',
    });
  });

  it('ends by score when the score limit is reached', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1 holds a developed terran world (10 control + 40 terran = 50),
        // p2 a bare world (10). Third planet neutral keeps p1 below domination.
        A: planet('A', 'p1', { planetType: 'terran' }),
        B: planet('B', 'p2'),
        C: planet('C', null),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 50 } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'score',
    });
    expect(r.state.match.scores.p1?.total).toBe(50);
  });

  it('ends on timeout and chooses the highest score, or no winner on a tie', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1's world carries a level-2 fortress (10 + 20×2 = 50) and outscores
        // p2's bare world (10). One planet each keeps both below domination.
        A: planet('A', 'p1', { buildings: [{ type: 'fort', level: 2, hp: 50 }] }),
        B: planet('B', 'p2'),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { endsAt: HOUR } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: 'p1',
      reason: 'timeout',
    });
    expect(r.state.match.scores.p1?.total).toBe(50);
  });

  it('leaves a tied timeout without a winner', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'),
        B: planet('B', 'p2'),
      },
      fleets: {
        F1: fleet('F1', 'p1'),
        F2: fleet('F2', 'p2'),
      },
    };

    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { endsAt: HOUR } })),
    );

    expect(r.state.match).toMatchObject({
      status: 'ended',
      winner: null,
      reason: 'timeout',
    });
  });

  it('scores territory and super-units from data, ignoring ordinary military', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1', {
          planetType: 'terran',
          buildings: [{ type: 'fort', level: 2, hp: 50 }],
          garrison: [{ unit: 'titan', count: 1 }],
        }),
        B: planet('B', 'p2'),
      },
      // A plain cruiser fleet: adds to the headcount but contributes no score.
      fleets: { F1: fleet('F1', 'p1', 3) },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    // 10 control + 40 terran + 20×2 fort + 3 titan = 93; the 3 cruisers add 0.
    expect(r.state.match.status).toBe('ongoing');
    expect(r.state.match.scores.p1?.total).toBe(93);
    expect(r.state.match.scores.p1?.units).toBe(4); // 1 titan + 3 cruisers (headcount)
    expect(r.state.match.scores.p1?.fleets).toBe(1);
  });
});
