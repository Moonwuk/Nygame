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
import type { GameModule } from '../kernel/module';
import { setStance } from '../state/diplomacy';
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
    // A strong, expensive unit — but military never scores (only territory does).
    titan: {
      faction: 'x',
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
  // planetType drives economy/defense; it no longer feeds the victory score.
  planetTypes: { terran: { productionBonus: 0 }, capital: { productionBonus: 0 } },
  // Province KIND now carries the territory score base: a `planet` is the prize (50),
  // a rare `capital` worth more (200), a depleted `dead_world` the flat 10, and every
  // other/absent kind the flat default (10). `empty` is a non-capturable void — it must
  // NOT count toward the domination denominator.
  sectorKinds: {
    empty: { capturable: false, buildable: false, orbit: false },
    planet: { scoreValue: 50 },
    capital: { scoreValue: 200 },
    dead_world: { scoreValue: 10 },
  },
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

  it('a dead-equal share at a ≤50% threshold crowns nobody; a strict leader wins', () => {
    const kernel = createKernel([victoryModule]);
    const config = { timeScale: 1, victory: { dominationPercent: 0.5, scoreLimit: 0 } };
    // 50/50: both qualify, neither leads — the match keeps running (no alphabetical
    // coronation of p1).
    const tied: GameState = {
      ...baseState(),
      planets: { A: planet('A', 'p1'), B: planet('B', 'p2') },
    };
    const r1 = okAdvance(kernel.advanceTo(tied, ctx(HOUR, config)));
    expect(r1.state.match.status).toBe('ongoing');
    // 3/5 vs 2/5 (with the threshold at 0.4 BOTH qualify): the strict leader wins.
    const led: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p2'),
        B: planet('B', 'p2'),
        C: planet('C', 'p2'),
        D: planet('D', 'p1'),
        E: planet('E', 'p1'),
      },
    };
    const cfg2 = { timeScale: 1, victory: { dominationPercent: 0.4, scoreLimit: 0 } };
    const r2 = okAdvance(kernel.advanceTo(led, ctx(HOUR, cfg2)));
    expect(r2.state.match).toMatchObject({ status: 'ended', winner: 'p2', reason: 'domination' });
  });

  it('domination counts only CAPTURABLE provinces (void is ignored in the share)', () => {
    const kernel = createKernel([victoryModule]);
    const voids: Record<string, Planet> = {};
    for (let i = 0; i < 7; i += 1) voids[`V${i}`] = planet(`V${i}`, null, { kind: 'empty' });
    const state: GameState = {
      ...baseState(),
      planets: {
        // 3 capturable provinces (p1 holds 2 → 66% ≥ 60%) among 7 void nodes: only
        // 2/10 of ALL nodes, but 2/3 of the capturable map ⇒ domination still fires.
        A: planet('A', 'p1'),
        B: planet('B', 'p1'),
        C: planet('C', 'p2'),
        ...voids,
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'domination' });
  });

  it('ends by score at the default 600 limit with no victory config', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1's three capital worlds total 3×200=600 ≥ 600, yet hold only 3/8 of the
        // capturable map (< 60%) — so the SCORE trigger, not domination, ends it.
        A: planet('A', 'p1', { kind: 'capital' }),
        B: planet('B', 'p1', { kind: 'capital' }),
        C: planet('C', 'p1', { kind: 'capital' }),
        D: planet('D', 'p2'),
        E: planet('E', 'p2'),
        F: planet('F', null),
        G: planet('G', null),
        H: planet('H', null),
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR))); // no victory config at all

    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'score' });
    expect(r.state.match.scores.p1?.total).toBe(600);
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

  it('eliminates a player who loses every province and disbands their fleets', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: { A: planet('A', 'p1') }, // p2 holds NO province…
      fleets: { F1: fleet('F1', 'p1'), F2: fleet('F2', 'p2') }, // …but still has a fleet
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    // No territory ⇒ eliminated, even with a fleet; the fleet vanishes; p1 wins.
    expect(r.state.players.p2?.status).toBe('defeated');
    expect(r.state.fleets.F2).toBeUndefined();
    expect(r.state.fleets.F1).toBeDefined();
    expect(r.state.match).toMatchObject({ status: 'ended', winner: 'p1', reason: 'elimination' });
    expect(r.events).toContainEqual({
      type: 'player.eliminated',
      payload: expect.objectContaining({ playerId: 'p2', reason: 'no-territory' }),
    });
  });

  it('ends by score when the score limit is reached', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        // p1 holds one full planet (50 base), p2 a bare world (the flat 10). A third
        // neutral province keeps p1 below the domination share.
        A: planet('A', 'p1', { kind: 'planet' }),
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

  it('coalition (alliance) wins TOGETHER at the sub-linear threshold (GDD §3.3)', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
      planets: {
        A: planet('A', 'p1', { kind: 'planet' }), // 50
        B: planet('B', 'p1', { kind: 'planet' }), // 50 → p1 = 100
        C: planet('C', 'p2', { kind: 'planet' }), // 50 → p2 = 50
        D: planet('D', 'p3', { kind: 'planet' }),
        E: planet('E', null, { kind: 'planet' }), // p1 holds 2/5 — below domination
      },
    };
    setStance(state, 'p1', 'p2', 'alliance');

    // scoreLimit 100 → coalition of 2 needs 100 × 2 × 0.7 = 140; combined 150 wins.
    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 100 } })),
    );

    expect(r.state.match).toMatchObject({ status: 'ended', reason: 'score', winner: 'p1' });
    expect(r.state.match.winners).toEqual(['p1', 'p2']); // the whole coalition wins
    expect(r.events).toContainEqual({
      type: 'match.ended',
      payload: expect.objectContaining({ winners: ['p1', 'p2'] }),
    });
  });

  it('a coalition is a CLIQUE, not a chain: A–B, B–C with A–C at war do not win together', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
      planets: {
        A: planet('A', 'p1', { kind: 'planet' }), // 50
        B: planet('B', 'p2', { kind: 'planet' }), // 50
        C: planet('C', 'p3', { kind: 'planet' }), // 50
        D: planet('D', null, { kind: 'planet' }),
        E: planet('E', null, { kind: 'planet' }),
      },
    };
    setStance(state, 'p1', 'p2', 'alliance');
    setStance(state, 'p2', 'p3', 'alliance');
    setStance(state, 'p1', 'p3', 'war'); // p1 and p3 are NOT allies — belligerents

    // The chain {p1,p2,p3}=150 would clear a 3-way threshold (100×3×0.5=150), but they
    // are not a clique. The valid cliques are {p1,p2}=100 and {p2,p3}=100, each below
    // the 2-way threshold 100×2×0.5=100? — exactly 100 ≥ 100, so a 2-clique CAN win;
    // pick a factor that leaves the pairs short to prove the trio never sums.
    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 100, coalitionFactor: 0.7 } })),
    );

    // 2-way threshold = 140; every clique (pairs at 100, singletons at 100-solo) is short.
    expect(r.state.match.status).toBe('ongoing');
    expect(r.state.match.winners).toBeUndefined();
  });

  it('the coalition threshold REPLACES the solo one for members', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
      planets: {
        A: planet('A', 'p1', { kind: 'planet' }), // 50
        B: planet('B', 'p1', { kind: 'planet' }), // 50 → p1 = 100 = solo limit
        C: planet('C', 'p2'), // flat 10 → combined 110 < 140
        D: planet('D', 'p3'),
        E: planet('E', null, { kind: 'planet' }),
      },
    };
    setStance(state, 'p1', 'p2', 'alliance');

    // Solo p1 WOULD win at 100 — but an allied player races as the coalition, and
    // 110 < 100 × 2 × 0.7 = 140, so the match keeps going (allying is a commitment).
    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 100 } })),
    );

    expect(r.state.match.status).toBe('ongoing');
    expect(r.state.match.winners).toBeUndefined();
  });

  it('honors a custom victory.coalitionFactor', () => {
    const kernel = createKernel([victoryModule]);
    const make = (): GameState => {
      const state: GameState = {
        ...baseState(),
        players: { p1: player('p1'), p2: player('p2'), p3: player('p3') },
        planets: {
          A: planet('A', 'p1', { kind: 'planet' }),
          B: planet('B', 'p1', { kind: 'planet' }),
          C: planet('C', 'p2', { kind: 'planet' }), // combined p1+p2 = 150
          D: planet('D', 'p3', { kind: 'planet' }),
          E: planet('E', null, { kind: 'planet' }),
        },
      };
      setStance(state, 'p1', 'p2', 'alliance');
      return state;
    };

    // factor 1.0 → need 200: 150 is not enough, the race continues.
    const strict = okAdvance(
      kernel.advanceTo(
        make(),
        ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 100, coalitionFactor: 1 } }),
      ),
    );
    expect(strict.state.match.status).toBe('ongoing');

    // factor 0.5 → need 100: 150 wins.
    const loose = okAdvance(
      kernel.advanceTo(
        make(),
        ctx(HOUR, { timeScale: 1, victory: { scoreLimit: 100, coalitionFactor: 0.5 } }),
      ),
    );
    expect(loose.state.match).toMatchObject({ status: 'ended', reason: 'score' });
    expect(loose.state.match.winners).toEqual(['p1', 'p2']);
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

  it('scores territory + structures only; military is headcount, never points', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1', {
          kind: 'planet',
          buildings: [{ type: 'fort', level: 2, hp: 50 }],
          garrison: [{ unit: 'titan', count: 1 }], // a strong unit — still 0 points
        }),
        B: planet('B', 'p2'),
      },
      // A plain cruiser fleet: adds to the headcount but contributes no score.
      fleets: { F1: fleet('F1', 'p1', 3) },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR)));

    // 50 planet + 20×2 fort = 90; the titan and 3 cruisers add 0.
    expect(r.state.match.status).toBe('ongoing');
    expect(r.state.match.scores.p1?.total).toBe(90);
    expect(r.state.match.scores.p1?.units).toBe(4); // 1 titan + 3 cruisers (headcount only)
    expect(r.state.match.scores.p1?.fleets).toBe(1);
  });

  it('lets a module add per-province score through the victory.score hook', () => {
    // A faction/tech-style contributor: +25 score for every province p1 holds.
    const bonusModule: GameModule = {
      id: 'score-bonus',
      version: '1.0.0',
      setup(api) {
        api.hook<number>('victory.score', (base, args) => {
          const { owner } = args as { owner: string };
          return owner === 'p1' ? base + 25 : base;
        });
      },
    };
    const kernel = createKernel([victoryModule, bonusModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1'), // base 10 + 25 hook = 35
        B: planet('B', 'p1'), // base 10 + 25 hook = 35
        C: planet('C', 'p2'), // base 10, no bonus
      },
    };

    const r = okAdvance(kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { dominationPercent: 0 } })));

    expect(r.state.match.scores.p1?.total).toBe(70); // 2×(10+25)
    expect(r.state.match.scores.p2?.total).toBe(10); // base only
  });

  it('scores a province by its KIND: planet 50, dead world and other kinds the flat 10', () => {
    const kernel = createKernel([victoryModule]);
    const state: GameState = {
      ...baseState(),
      planets: {
        A: planet('A', 'p1', { kind: 'planet' }), // 50 — the prize
        B: planet('B', 'p1', { kind: 'dead_world' }), // 10 — a depleted planet is worth far less
        C: planet('C', 'p1'), // kind-less ⇒ the flat default 10
        D: planet('D', 'p2'),
      },
    };

    // dominationPercent 0 disables the share win so we can read the raw scoreboard.
    const r = okAdvance(
      kernel.advanceTo(state, ctx(HOUR, { timeScale: 1, victory: { dominationPercent: 0 } })),
    );

    expect(r.state.match.scores.p1?.total).toBe(70); // 50 + 10 + 10
    expect(r.state.match.scores.p2?.total).toBe(10);
  });
});
