import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { combatModule } from './combat';
import { orbitalModule } from './orbital';
import { artilleryModule } from './artillery';
import { interceptModule } from './intercept';
import { economyModule } from './economy';
import { constructionModule } from './construction';
import {
  createInitialState,
  type Battle,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, buildingLevel, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

/** The combat family in canonical manifest order — the split of the old monolith
 *  (orbital stamps orbit before combat engages; orbital's AA/bombard span runs
 *  before artillery's standoff span), so these kernels behave exactly like the
 *  pre-split single module. */
const combatFamily = [orbitalModule, combatModule, artilleryModule, interceptModule];

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', domain: 'space', stats: { attack: 10, defense: 6, speed: 6, hp: 40 } },
    aa: {
      faction: 'x',
      domain: 'ground',
      stats: { attack: 2, defense: 10, speed: 0, hp: 30, aaDamage: 14 },
      line: 'rear',
    },
    marine: { faction: 'x', domain: 'ground', stats: { attack: 10, defense: 6, speed: 0, hp: 20 } },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', cost: { metal: 50 }, buildTimeHours: 0, produces: { metal: 10 }, hp: 20 },
    depot: { name: 'Depot', cost: { metal: 40 }, buildTimeHours: 2, hp: 30 },
    flak: { name: 'Orbital AA', cost: { metal: 60 }, buildTimeHours: 0, hp: 25, aaDamage: 28 },
  },
  events: {},
});
const HOUR = 3_600_000;
const ctx: Context = { now: 0, data };
const at = (now: number): Context => ({ now, data });

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function planet(
  id: string,
  owner: string | null,
  opts: { buildings?: Array<[string, number]>; garrison?: Array<[string, number]> } = {},
): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: (opts.buildings ?? []).map(([type, level]) => ({
      type,
      level,
      hp: buildingLevel(data.buildings[type]!, level).hp,
    })),
    garrison: (opts.garrison ?? []).map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}
function fleet(
  id: string,
  owner: string,
  location: string | null,
  units: Array<[string, number]>,
  opts: { orbit?: 'near'; bombarding?: boolean; battleId?: string } = {},
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    orbit: opts.orbit,
    bombarding: opts.bombarding,
    battleId: opts.battleId ?? null,
    traits: [],
  };
}
function stateWith(opts: {
  players?: Player[];
  planets?: Planet[];
  fleets?: Fleet[];
  battles?: Battle[];
}): GameState {
  const s = createInitialState({ seed: 'orb', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  const battles: Record<string, Battle> = {};
  for (const x of opts.battles ?? []) battles[x.id] = x;
  return { ...s, players, planets, fleets, battles, battleSeq: opts.battles?.length ?? 0 };
}
const bombard = (fleetId: string, on: boolean, playerId = 'p1'): Action => ({
  id: `o:${playerId}:1`,
  type: 'fleet.bombard',
  playerId,
  payload: { fleetId, on },
  issuedAt: 0,
});
const construct = (building: string, planetId: string, playerId = 'p1'): Action => ({
  id: `o:${playerId}:2`,
  type: 'building.construct',
  playerId,
  payload: { planetId, building },
  issuedAt: 0,
});
function okApply(r: ApplyResult) {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult) {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

describe('orbital — bombardment toggle (fleet.bombard)', () => {
  it('switches bombardment on for a hostile world from the near orbit', () => {
    const kernel = createKernel([...combatFamily]);
    const st = stateWith({
      planets: [planet('P', 'p2')],
      fleets: [fleet('F', 'p1', 'P', [['cruiser', 1]], { orbit: 'near' })],
    });
    const r = okApply(kernel.applyAction(st, bombard('F', true), ctx));
    expect(r.state.fleets.F?.bombarding).toBe(true);
    expect(r.events.map((e) => e.type)).toContain('fleet.bombard');
  });

  it('rejects bombarding when not in orbit, your own world, or with no ships', () => {
    const kernel = createKernel([...combatFamily]);
    const notInOrbit = stateWith({
      planets: [planet('P', 'p2')],
      fleets: [fleet('F', 'p1', 'P', [['cruiser', 1]], { orbit: undefined })],
    });
    expect(errCode(kernel.applyAction(notInOrbit, bombard('F', true), ctx))).toBe('E_WRONG_ORBIT');
    const own = stateWith({
      planets: [planet('P', 'p1')],
      fleets: [fleet('F', 'p1', 'P', [['cruiser', 1]], { orbit: 'near' })],
    });
    expect(errCode(kernel.applyAction(own, bombard('F', true), ctx))).toBe('E_OWN_PLANET');
    const empty = stateWith({
      planets: [planet('P', 'p2')],
      fleets: [fleet('F', 'p1', 'P', [], { orbit: 'near' })],
    });
    expect(errCode(kernel.applyAction(empty, bombard('F', true), ctx))).toBe('E_NO_SHIPS');
  });
});

describe('orbital — bombardment effects (GDD §7.4)', () => {
  it('freezes the production of the bombarded world and wears its structures', () => {
    const kernel = createKernel([economyModule, ...combatFamily, constructionModule]);
    const st = stateWith({
      players: [player('p2', { metal: 0 })],
      planets: [planet('P', 'p2', { buildings: [['mine', 1]] })],
      fleets: [fleet('F', 'p1', 'P', [['cruiser', 1]], { orbit: 'near', bombarding: true })],
    });
    const r = okAdvance(kernel.advanceTo(st, at(2 * HOUR)));
    expect(r.state.players.p2?.resources.metal ?? 0).toBe(0); // production frozen
    const mine = r.state.planets.P?.buildings.find((b) => b.type === 'mine');
    expect(mine?.hp).toBeLessThan(20); // 10 attack × 0.5 × 2h = 10 structural damage
  });

  it('lets production flow when the same fleet is not bombarding', () => {
    const kernel = createKernel([economyModule, ...combatFamily, constructionModule]);
    const st = stateWith({
      players: [player('p2', { metal: 0 })],
      planets: [planet('P', 'p2', { buildings: [['mine', 1]] })],
      fleets: [fleet('F', 'p1', 'P', [['cruiser', 1]], { orbit: 'near', bombarding: false })],
    });
    const r = okAdvance(kernel.advanceTo(st, at(2 * HOUR)));
    expect(r.state.players.p2?.resources.metal).toBe(20); // 10/h × 2h
  });

  it('blocks new construction orders on a bombarded world', () => {
    const kernel = createKernel([...combatFamily, constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100 })],
      planets: [planet('P', 'p1')],
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near', bombarding: true })],
    });
    expect(errCode(kernel.applyAction(st, construct('depot', 'P'), ctx))).toBe('E_BOMBARDED');
  });

  it('pauses an in-flight build under bombardment, resuming when it lifts', () => {
    const kernel = createKernel([...combatFamily, constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100 })],
      planets: [planet('P', 'p1')],
    });
    const ordered = okApply(kernel.applyAction(st, construct('depot', 'P'), ctx)); // done at 2h
    // A Red fleet starts bombarding before the depot finishes.
    const sieged: GameState = {
      ...ordered.state,
      fleets: {
        ...ordered.state.fleets,
        E: fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near', bombarding: true }),
      },
    };
    const stalled = okAdvance(kernel.advanceTo(sieged, at(3 * HOUR)));
    expect(stalled.state.planets.P?.buildings).toEqual([]); // build paused, not delivered

    // Lift the siege; the build completes shortly after.
    const lifted: GameState = {
      ...stalled.state,
      fleets: { ...stalled.state.fleets, E: { ...stalled.state.fleets.E!, bombarding: false } },
    };
    const done = okAdvance(kernel.advanceTo(lifted, at(5 * HOUR)));
    expect(done.state.planets.P?.buildings.map((b) => b.type)).toEqual(['depot']);
  });
});

describe('orbital — anti-air (orbital AA)', () => {
  it('fires at a hostile fleet on the near orbit and can destroy it', () => {
    const kernel = createKernel([...combatFamily]);
    const st = stateWith({
      planets: [planet('P', 'p1', { garrison: [['aa', 2]] })], // 2 × 14 = 28 aa/h
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near' })], // 40 hp
    });
    const r = okAdvance(kernel.advanceTo(st, at(2 * HOUR))); // 28 × 2 = 56 ≥ 40
    expect(r.state.fleets.E).toBeUndefined();
    expect(r.events.map((e) => e.type)).toContain('fleet.destroyed');
  });

  it('ECON-2 blackout: unpaid energy halves BOTH flak tiers until the bill clears', () => {
    const kernel = createKernel([orbitalModule]);
    const scene = (arrears?: string[]) =>
      stateWith({
        players: [{ ...player('p1'), ...(arrears ? { arrears } : {}) }],
        planets: [planet('P', 'p1', { buildings: [['flak', 1]] })], // 28 per hourly volley
        fleets: [fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near' })], // 40 hp
      });
    // Lights on: one hourly volley lands the full 28 (40 − 28 = 12).
    const lit = okAdvance(kernel.advanceTo(scene(), at(1 * HOUR)));
    expect(lit.state.fleets.E?.units[0]?.hp).toBe(12);
    // Blackout: the same volley lands 14 (40 − 14 = 26).
    const dark = okAdvance(kernel.advanceTo(scene(['energy']), at(1 * HOUR)));
    expect(dark.state.fleets.E?.units[0]?.hp).toBe(26);
    // A non-energy arrears (food) keeps the guns at full strength.
    const fed = okAdvance(kernel.advanceTo(scene(['food']), at(1 * HOUR)));
    expect(fed.state.fleets.E?.units[0]?.hp).toBe(12);
  });

  it('ORBITAL tier (buildings) volleys hourly: a sub-hour dip escapes untouched', () => {
    const kernel = createKernel([orbitalModule]);
    const st = stateWith({
      planets: [planet('P', 'p1', { buildings: [['flak', 1]] })], // 28 per hourly volley
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near' })],
    });
    // (0, 0.9h] crosses no hour boundary — the heavy flak has not volleyed yet.
    const half = okAdvance(kernel.advanceTo(st, at(0.9 * HOUR)));
    expect(half.state.fleets.E?.units[0]?.hp ?? 40).toBe(40); // unscathed
    expect(half.events.map((e) => e.type)).not.toContain('aa.fired');
    // (0.9h, 1.1h] crosses exactly ONE hour boundary → one full-strength volley (28).
    const crossed = okAdvance(kernel.advanceTo(half.state, at(1.1 * HOUR)));
    expect(crossed.events.filter((e) => e.type === 'aa.fired')).toHaveLength(1);
    expect(crossed.state.fleets.E?.units[0]?.hp).toBe(12); // 40 − 28, not 40 − 28×0.2
  });

  it('CLOSE tier (garrison) volleys every quarter-hour at a quarter of the rate', () => {
    const kernel = createKernel([orbitalModule]);
    const st = stateWith({
      planets: [planet('P', 'p1', { garrison: [['aa', 2]] })], // 28/h → 7 per 15-min volley
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 1]], { orbit: 'near' })],
    });
    // (0, 0.2h] crosses no quarter boundary — even the point defense hasn't fired.
    const dip = okAdvance(kernel.advanceTo(st, at(0.2 * HOUR)));
    expect(dip.events.map((e) => e.type)).not.toContain('aa.fired');
    // (0.2h, 0.8h] crosses 0.25h, 0.5h, 0.75h → three quarter-strength volleys.
    const r = okAdvance(kernel.advanceTo(dip.state, at(0.8 * HOUR)));
    const volleys = r.events.filter((e) => e.type === 'aa.fired');
    expect(volleys).toHaveLength(3);
    expect((volleys[0]?.payload as { damage: number }).damage).toBe(7); // 28 × 0.25
    expect(r.state.fleets.E?.units[0]?.hp).toBe(19); // 40 − 3×7
  });

  it('both tiers together: hour boundary lands the heavy volley first, then the flak', () => {
    const kernel = createKernel([orbitalModule]);
    const st = stateWith({
      planets: [planet('P', 'p1', { buildings: [['flak', 1]], garrison: [['aa', 2]] })],
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 2]], { orbit: 'near' })], // 80 hp pool
    });
    // (0.9h, 1h] crosses ONE shared boundary: orbital 28 first, then close 7.
    const st2 = okAdvance(kernel.advanceTo(st, at(0.9 * HOUR))).state;
    const r = okAdvance(kernel.advanceTo(st2, at(HOUR)));
    const volleys = r.events.filter((e) => e.type === 'aa.fired');
    expect(volleys.map((v) => (v.payload as { tier: string }).tier)).toEqual(['orbital', 'close']);
    // NB: (0, 0.9h] already dealt three close volleys (21) before this span.
    expect(r.state.fleets.E?.units[0]?.hp).toBe(80 - 21 - 28 - 7);
  });

  it('the volley grid compresses with timeScale like every other duration', () => {
    const kernel = createKernel([orbitalModule]);
    const st = stateWith({
      planets: [planet('P', 'p1', { buildings: [['flak', 1]] })],
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 2]], { orbit: 'near' })],
    });
    // ×2: a game-hour passes every 30 real minutes → (0, 1h] holds TWO hourly volleys.
    const ctx2 = { ...at(HOUR), config: { timeScale: 2 } };
    const r = kernel.advanceTo(st, ctx2);
    if (!r.ok) throw new Error(r.code);
    expect(r.events.filter((e) => e.type === 'aa.fired')).toHaveLength(2);
  });

  it('announces every volley — aa.fired carries shooter, target, damage and tier (H2)', () => {
    const kernel = createKernel([orbitalModule]);
    const st = stateWith({
      planets: [planet('P', 'p1', { buildings: [['flak', 1]] })],
      fleets: [fleet('E', 'p2', 'P', [['cruiser', 2]], { orbit: 'near' })],
    });
    const r = okAdvance(kernel.advanceTo(st, at(HOUR)));
    expect(r.events).toContainEqual({
      type: 'aa.fired',
      payload: { planetId: 'P', owner: 'p1', fleetId: 'E', by: 'p2', damage: 28, tier: 'orbital' },
    });
  });

  it('holds its fire while a ground assault keeps it busy', () => {
    const kernel = createKernel([...combatFamily]);
    const st = stateWith({
      planets: [planet('P', 'p1', { garrison: [['aa', 2]] })],
      // Attacker landing fleet G is mid-assault; bystander E sits on the near orbit.
      fleets: [
        fleet('G', 'p2', 'P', [['cruiser', 1]], { orbit: 'near', battleId: 'battle:0' }),
        fleet('E', 'p3', 'P', [['cruiser', 1]], { orbit: 'near' }),
      ],
      battles: [
        {
          id: 'battle:0',
          location: 'P',
          phase: 'ground',
          attacker: { ref: { kind: 'landing', fleetId: 'G' }, owner: 'p2' },
          defender: { ref: { kind: 'garrison', planetId: 'P' }, owner: 'p1' },
          round: 0,
        },
      ],
    });
    const r = okAdvance(kernel.advanceTo(st, at(2 * HOUR)));
    expect(r.state.fleets.E?.units[0]?.count).toBe(1); // AA busy on the ground → E untouched
  });
});
