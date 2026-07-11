import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { economyModule } from './economy';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 1, defense: 1, speed: 1 }, upkeep: { credits: 8 } },
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 1 }, upkeep: { credits: 2 } },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 },
  },
  events: {},
});
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function planet(
  id: string,
  owner: string | null,
  buildings: string[] = [],
  garrison: Array<[string, number]> = [],
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: buildings.map((type) => ({ type, level: 1, hp: 0 })),
    garrison: garrison.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function fleet(id: string, owner: string, units: Array<[string, number]>): Fleet {
  return {
    id,
    owner,
    location: 'X',
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function stateWith(opts: { players?: Player[]; planets?: Planet[]; fleets?: Fleet[] }): GameState {
  const s = createInitialState({ seed: 'eco', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  return { ...s, players, planets, fleets };
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('economy module — production into the player treasury', () => {
  it('accrues production into the owner player treasury, not the planet', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({ players: [player('p1')], planets: [planet('a', 'p1', ['mine'])] });
    const r = okAdvance(kernel.advanceTo(st, ctx(2 * HOUR)));
    expect(r.state.players.p1?.resources.metal).toBe(20); // 10/h × 2h
    expect(r.state.planets.a?.resources.metal ?? 0).toBe(0);
  });

  it('does not produce for neutral planets', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({ players: [player('p1')], planets: [planet('a', null, ['mine'])] });
    const r = okAdvance(kernel.advanceTo(st, ctx(5 * HOUR)));
    expect(r.state.players.p1?.resources.metal ?? 0).toBe(0);
  });

  it('skips an owner with no player record (graceful degradation)', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({ planets: [planet('a', 'ghost', ['mine'])] }); // no players
    const r = okAdvance(kernel.advanceTo(st, ctx(5 * HOUR)));
    expect(Object.keys(r.state.players)).toHaveLength(0); // nothing created, no crash
  });

  it('credits any resource a building produces (energy / microelectronics)', () => {
    const data2 = parseGameData({
      version: '0.1.0',
      resources: ['energy', 'microelectronics'],
      units: {},
      factions: {},
      buildings: {
        reactor: { name: 'Reactor', produces: { energy: 25 }, buildTimeHours: 0 },
        fab: { name: 'Fab', produces: { microelectronics: 8 }, buildTimeHours: 0 },
      },
      events: {},
    });
    const kernel = createKernel([economyModule]);
    const st = stateWith({ players: [player('p1')], planets: [planet('a', 'p1', ['reactor', 'fab'])] });
    const r = okAdvance(kernel.advanceTo(st, { now: 2 * HOUR, data: data2 }));
    expect(r.state.players.p1?.resources.energy).toBe(50); // 25/h × 2h
    expect(r.state.players.p1?.resources.microelectronics).toBe(16); // 8/h × 2h
  });

  it('lets a module scale production through the economy.production hook', () => {
    const rich: GameModule = {
      id: 'rich-deposits',
      version: '1.0.0',
      setup(api) {
        api.hook<Record<string, number>>('economy.production', (cur) => {
          const out = { ...cur };
          if (out.metal) out.metal *= 2;
          return out;
        });
      },
    };
    const kernel = createKernel([economyModule, rich]);
    const st = stateWith({ players: [player('p1')], planets: [planet('a', 'p1', ['mine'])] });
    const r = okAdvance(kernel.advanceTo(st, ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBe(20); // 10 × 2
  });
});

describe('economy module — daily upkeep', () => {
  it('drains a fleet upkeep from the treasury per day', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      fleets: [fleet('f', 'p1', [['cruiser', 1]])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY))); // one day
    expect(r.state.players.p1?.resources.credits).toBe(92); // 100 − 8/day
  });

  it('counts planet garrisons in upkeep too', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 100 })],
      planets: [planet('a', 'p1', [], [['scout', 3]])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY)));
    expect(r.state.players.p1?.resources.credits).toBe(94); // 100 − 3 × 2/day
  });

  it('clamps upkeep at zero (a deficit just empties the treasury)', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 5 })],
      fleets: [fleet('f', 'p1', [['cruiser', 1]])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx(DAY)));
    expect(r.state.players.p1?.resources.credits).toBe(0); // max(0, 5 − 8)
  });
});

describe('economy module — building upkeep + arrears brownout (building economy)', () => {
  const data3 = parseGameData({
    version: '0.1.0',
    resources: ['metal', 'credits', 'energy'],
    units: {},
    factions: {},
    buildings: {
      mine: { name: 'Mine', produces: { metal: 10 }, buildTimeHours: 0 },
      // A powered producer: consumes energy daily, halves under an energy arrears.
      refinery: { name: 'Refinery', produces: { credits: 8 }, upkeep: { energy: 24 }, buildTimeHours: 0 },
      reactor: { name: 'Reactor', produces: { energy: 5 }, upkeep: { credits: 24 }, buildTimeHours: 0 },
    },
    events: {},
  });
  const ctx3 = (now: number): Context => ({ now, data: data3 });

  it('bills standing buildings daily, drained like unit upkeep', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { energy: 100 })],
      planets: [planet('a', 'p1', ['refinery'])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx3(DAY)));
    // 24 energy/day drained; 8 credits/h × 24h produced at FULL rate (bills covered).
    expect(r.state.players.p1?.resources.energy).toBeCloseTo(76, 5);
    expect(r.state.players.p1?.resources.credits).toBeCloseTo(192, 5);
    expect(r.state.players.p1?.arrears).toBeUndefined();
  });

  it('an unpayable bill pins the treasury at zero and records the arrears', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { energy: 10 })], // owes 24/day — cannot cover it
      planets: [planet('a', 'p1', ['refinery'])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx3(DAY)));
    expect(r.state.players.p1?.resources.energy).toBe(0);
    expect(r.state.players.p1?.arrears).toEqual(['energy']);
  });

  it('arrears brown out ONLY the consumers of the short resource, at half output', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { energy: 0 })],
      planets: [planet('a', 'p1', ['refinery', 'mine'])],
    });
    st.players.p1!.arrears = ['energy']; // carried from the last settlement
    const r = okAdvance(kernel.advanceTo(st, ctx3(2 * HOUR)));
    expect(r.state.players.p1?.resources.credits).toBeCloseTo(8, 5); // 8/h × 2h × 0.5
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(20, 5); // the mine is untouched
  });

  it('the brownout lifts once the bill is paid in full again', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { energy: 500 })],
      planets: [planet('a', 'p1', ['refinery'])],
    });
    st.players.p1!.arrears = ['energy'];
    const r = okAdvance(kernel.advanceTo(st, ctx3(DAY)));
    expect(r.state.players.p1?.arrears).toBeUndefined(); // debt cleared → flag gone
  });

  it('a production chain settles both sides: the reactor pays credits, feeds the fab', () => {
    const kernel = createKernel([economyModule]);
    const st = stateWith({
      players: [player('p1', { credits: 100, energy: 0 })],
      planets: [planet('a', 'p1', ['reactor', 'refinery'])],
    });
    const r = okAdvance(kernel.advanceTo(st, ctx3(DAY)));
    // reactor made 120 energy, refinery burned 24 → net 96; both bills covered.
    expect(r.state.players.p1?.resources.energy).toBeCloseTo(96, 5);
    expect(r.state.players.p1?.arrears).toBeUndefined();
  });
});

// BF-13: a Postgres JSONB round-trip (hibernation) re-orders object keys, so an
// insertion-order walk sums floats in a different order than the replay — the
// settlement must be key-order independent (sorted walks).
describe('economy module — key-order independence (BF-13)', () => {
  it('the same planets in a different insertion order settle to the BIT-identical treasury', () => {
    const floaty: GameData = parseGameData({
      version: '0.1.0',
      resources: ['metal'],
      units: {},
      factions: {},
      buildings: {
        // 0.1 + 0.2 + 0.3 summed left-to-right ≠ right-to-left in IEEE 754 —
        // exactly the divergence a JSONB re-order used to smuggle in.
        m1: { name: 'M1', produces: { metal: 0.1 }, buildTimeHours: 0 },
        m2: { name: 'M2', produces: { metal: 0.2 }, buildTimeHours: 0 },
        m3: { name: 'M3', produces: { metal: 0.3 }, buildTimeHours: 0 },
      },
      events: {},
    });
    const kernel = createKernel([economyModule]);
    const mk = (order: string[]): GameState => {
      const planets: Record<string, Planet> = {};
      const spec: Record<string, string> = { A: 'm1', B: 'm2', C: 'm3' };
      for (const id of order) planets[id] = planet(id, 'p1', [spec[id]!]);
      const s = stateWith({ players: [player('p1')] });
      return { ...s, planets };
    };
    const abc = okAdvance(kernel.advanceTo(mk(['A', 'B', 'C']), { now: HOUR, data: floaty }));
    const cba = okAdvance(kernel.advanceTo(mk(['C', 'B', 'A']), { now: HOUR, data: floaty }));
    expect(cba.state.players.p1!.resources.metal).toBe(abc.state.players.p1!.resources.metal);
  });
});
