import { describe, expect, it } from 'vitest';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import { movementModule } from './movement';
import { technologyModule } from './technology';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal', 'credits'],
  units: {
    scout: { faction: 'x', stats: { attack: 2, defense: 1, speed: 10, hp: 6 } },
    dropship: {
      faction: 'x',
      stats: { attack: 2, defense: 4, speed: 5, hp: 20, cargoCapacity: 8 },
      cost: { metal: 10 },
    },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 } },
    refinery: { name: 'Refinery', cost: { metal: 20 }, buildTimeHours: 1 },
  },
  events: {},
  technologies: {
    industry: {
      name: 'Industry',
      cost: { metal: 10 },
      researchTimeHours: 1,
      unlocks: { buildings: ['refinery'] },
      effects: { productionBonus: 0.25 },
    },
    logistics: {
      name: 'Logistics',
      cost: { credits: 10 },
      researchTimeHours: 2,
      unlocks: { units: ['dropship'] },
      effects: { fleetSpeedBonus: 0.5 },
    },
    siege: {
      name: 'Siege',
      cost: { credits: 10 },
      researchTimeHours: 3,
      prerequisites: ['logistics'],
      effects: { combatDamageBonus: 0.1 },
    },
  },
});

const ctx = (now: number, timeScale?: number): Context =>
  timeScale === undefined ? { now, data } : { now, data, config: { timeScale } };

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}

function planet(id: string, owner: string | null, links: string[] = []): Planet {
  return {
    id,
    owner,
    position: id === 'A' ? { x: 0, y: 0 } : { x: 30, y: 0 },
    links,
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}

function fleet(id: string, owner: string, location: string): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: [{ unit: 'scout', count: 1 }],
    traits: [],
  };
}

function stateWith(opts: { players?: Player[]; planets?: Planet[]; fleets?: Fleet[] }): GameState {
  const s = createInitialState({ seed: 'tech', version: { data: '0.1.0', manifest: '1' } });
  const players: Record<string, Player> = {};
  for (const x of opts.players ?? []) players[x.id] = x;
  const planets: Record<string, Planet> = {};
  for (const x of opts.planets ?? []) planets[x.id] = x;
  const fleets: Record<string, Fleet> = {};
  for (const x of opts.fleets ?? []) fleets[x.id] = x;
  return { ...s, players, planets, fleets };
}

function research(technology: string, playerId = 'p1'): Action {
  return {
    id: `s:${playerId}:1`,
    type: 'technology.research',
    playerId,
    payload: { technology },
    issuedAt: 0,
  };
}

function buildUnit(unit: string): Action {
  return {
    id: 's:p1:1',
    type: 'unit.build',
    playerId: 'p1',
    payload: { planetId: 'A', unit },
    issuedAt: 0,
  };
}

function construct(building: string): Action {
  return {
    id: 's:p1:1',
    type: 'building.construct',
    playerId: 'p1',
    payload: { planetId: 'A', building },
    issuedAt: 0,
  };
}

function move(fleetId: string, to: string): Action {
  return {
    id: 's:p1:1',
    type: 'fleet.move',
    playerId: 'p1',
    payload: { fleetId, to },
    issuedAt: 0,
  };
}

function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}

function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}

describe('technology module — session research tree', () => {
  it('pays up front, records active research, then completes on the timeline', () => {
    const kernel = createKernel([technologyModule]);
    const st = stateWith({ players: [player('p1', { metal: 30 })] });

    const started = okApply(kernel.applyAction(st, research('industry'), ctx(0)));
    expect(started.state.players.p1?.resources.metal).toBe(20);
    expect(started.state.players.p1?.technologies?.active).toEqual({
      technology: 'industry',
      startedAt: 0,
      completesAt: HOUR,
    });
    expect(started.state.players.p1?.technologies?.completed).toEqual([]);

    const early = okAdvance(kernel.advanceTo(started.state, ctx(HOUR - 1)));
    expect(early.state.players.p1?.technologies?.completed).toEqual([]);

    const done = okAdvance(kernel.advanceTo(early.state, ctx(HOUR)));
    expect(done.state.players.p1?.technologies?.active).toBeUndefined();
    expect(done.state.players.p1?.technologies?.completed).toEqual(['industry']);
    expect(done.events.some((event) => event.type === 'technology.researched')).toBe(true);
  });

  it('rejects missing prerequisites, duplicate research, busy labs and bad inputs', () => {
    const kernel = createKernel([technologyModule]);
    const st = stateWith({ players: [player('p1', { metal: 30, credits: 30 })] });

    expect(errCode(kernel.applyAction(st, research('siege'), ctx(0)))).toBe('E_PREREQUISITE');
    expect(errCode(kernel.applyAction(st, research('missing'), ctx(0)))).toBe(
      'E_UNKNOWN_TECHNOLOGY',
    );
    expect(errCode(kernel.applyAction(st, { ...research('industry'), payload: {} }, ctx(0)))).toBe(
      'E_BAD_PAYLOAD',
    );

    const started = okApply(kernel.applyAction(st, research('logistics'), ctx(0)));
    expect(errCode(kernel.applyAction(started.state, research('industry'), ctx(0)))).toBe(
      'E_RESEARCH_BUSY',
    );

    const done = okAdvance(kernel.advanceTo(started.state, ctx(2 * HOUR)));
    expect(errCode(kernel.applyAction(done.state, research('logistics'), ctx(2 * HOUR)))).toBe(
      'E_ALREADY_RESEARCHED',
    );
  });

  it('gates data-declared unlocks when present and degrades open without the module', () => {
    const lockedKernel = createKernel([technologyModule, constructionModule]);
    const openKernel = createKernel([constructionModule]);
    const st = stateWith({
      players: [player('p1', { metal: 100, credits: 20 })],
      planets: [planet('A', 'p1')],
    });

    expect(errCode(lockedKernel.applyAction(st, buildUnit('dropship'), ctx(0)))).toBe(
      'E_TECH_LOCKED',
    );
    expect(okApply(openKernel.applyAction(st, buildUnit('dropship'), ctx(0))).ok).toBe(true);

    const started = okApply(lockedKernel.applyAction(st, research('logistics'), ctx(0)));
    const done = okAdvance(lockedKernel.advanceTo(started.state, ctx(2 * HOUR)));
    expect(
      okApply(lockedKernel.applyAction(done.state, buildUnit('dropship'), ctx(2 * HOUR))).ok,
    ).toBe(true);
    expect(errCode(lockedKernel.applyAction(st, construct('refinery'), ctx(0)))).toBe(
      'E_TECH_LOCKED',
    );
  });

  it('applies completed session technologies through existing hooks', () => {
    const economyKernel = createKernel([economyModule, technologyModule]);
    const productionState = stateWith({
      players: [
        {
          ...player('p1', { metal: 0 }),
          technologies: { completed: ['industry'] },
        },
      ],
      planets: [
        {
          ...planet('A', 'p1'),
          buildings: [{ type: 'mine', level: 1, hp: 0 }],
        },
      ],
    });
    const produced = okAdvance(economyKernel.advanceTo(productionState, ctx(HOUR)));
    expect(produced.state.players.p1?.resources.metal).toBeCloseTo(12.5);

    const movementKernel = createKernel([movementModule, technologyModule]);
    const movementState = stateWith({
      players: [
        {
          ...player('p1'),
          technologies: { completed: ['logistics'] },
        },
      ],
      planets: [planet('A', 'p1', ['B']), planet('B', null, ['A'])],
      fleets: [fleet('F', 'p1', 'A')],
    });
    const moved = okApply(movementKernel.applyAction(movementState, move('F', 'B'), ctx(0)));
    expect(moved.state.fleets.F?.movement?.arrivesAt).toBeCloseTo(2 * HOUR);
  });
});
