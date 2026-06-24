import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createInitialState, type Fleet, type GameState, type Planet, type Player } from './gameState';
import { visibleState } from './visibility';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 10, defense: 8, speed: 6, hp: 40 }, signature: 4 },
    scout: { faction: 'x', stats: { attack: 2, defense: 2, speed: 9, hp: 8 }, radarRange: 2 },
  },
  factions: {},
  buildings: { radar: { name: 'Radar', radarRange: 2 } },
  events: {},
});

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: { metal: 99 } };
}
function planet(id: string, owner: string | null, links: string[], extra: Partial<Planet> = {}): Planet {
  return { id, owner, position: { x: 0, y: 0 }, links, resources: {}, buildings: [], garrison: [], traits: [], ...extra };
}
function fleet(id: string, owner: string, location: string, units: Array<[string, number]>): Fleet {
  return { id, owner, location, movement: null, units: units.map(([unit, count]) => ({ unit, count })), traits: [] };
}

/** A→B→C→D line. p1 owns A (with a radarRange-2 array); B neutral, C/D enemy. */
function scenario(): GameState {
  const base = createInitialState({ seed: 'vis', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...base,
    players: { p1: player('p1'), p2: { ...player('p2'), technologies: { completed: ['warp'] } } },
    planets: {
      A: planet('A', 'p1', ['B'], { buildings: [{ type: 'radar', level: 1, hp: 10 }] }),
      B: planet('B', null, ['A', 'C'], { garrison: [{ unit: 'cruiser', count: 1 }] }),
      C: planet('C', 'p2', ['B', 'D'], { garrison: [{ unit: 'cruiser', count: 2 }], planetType: 'radar_world' }),
      D: planet('D', 'p2', ['C'], { garrison: [{ unit: 'cruiser', count: 5 }], planetType: 'hidden_world' }),
    },
    fleets: {
      'mine-1': fleet('mine-1', 'p1', 'A', [['cruiser', 1]]),
      'enemy-near': fleet('enemy-near', 'p2', 'B', [['cruiser', 1]]), // at B (identified)
      'enemy-radar': fleet('enemy-radar', 'p2', 'C', [['cruiser', 4]]), // at C (radar only) → ◆L
      'enemy-hidden': fleet('enemy-hidden', 'p2', 'D', [['cruiser', 5]]), // at D (unseen)
    },
    scheduled: [{ id: 'evt:1', at: 5, type: 'fleet.arrived', payload: {}, seq: 0 }],
  };
}

describe('visibleState (fog of war as a security boundary)', () => {
  it('keeps own and identified objects, hides the rest', () => {
    const view = visibleState(scenario(), 'p1', data);
    // identified fleets: own + the enemy sitting at the identified neutral world.
    expect(Object.keys(view.fleets).sort()).toEqual(['enemy-near', 'mine-1']);
    // identified planet contents stay; radar-only (C) and unseen (D) are stripped.
    expect(view.planets.B?.garrison).toHaveLength(1);
    expect(view.planets.C?.owner).toBeNull();
    expect(view.planets.C?.garrison).toEqual([]);
    expect(view.planets.D?.owner).toBeNull();
    expect(view.planets.D?.planetType).toBeUndefined();
    // topology (the node + its links) is preserved so the map stays navigable.
    expect(view.planets.D?.links).toEqual(['C']);
  });

  it('reports a radar-only enemy fleet as a coarse signature, not the fleet', () => {
    const view = visibleState(scenario(), 'p1', data);
    expect(view.fleets['enemy-radar']).toBeUndefined();
    // 4 cruisers × signature 4 = 16 → bucket L.
    expect(view.signatures).toEqual([{ location: 'C', size: 'L' }]);
  });

  it('strips other players private data but keeps identity', () => {
    const view = visibleState(scenario(), 'p1', data);
    expect(view.players.p1?.resources).toEqual({ metal: 99 }); // own treasury intact
    expect(view.players.p2?.resources).toEqual({}); // enemy treasury hidden
    expect(view.players.p2?.technologies).toBeUndefined();
    expect(view.players.p2?.name).toBe('p2'); // identity kept (scoreboard)
  });

  it('drops the schedule and unseen battles (no future-intent leak)', () => {
    const view = visibleState(scenario(), 'p1', data);
    expect(view.scheduled).toEqual([]);
  });

  it('serialized view never contains hidden data (the real anti-leak test)', () => {
    const json = JSON.stringify(visibleState(scenario(), 'p1', data));
    expect(json).not.toContain('enemy-hidden'); // unseen fleet id
    expect(json).not.toContain('hidden_world'); // unseen planet content
  });

  it('is pure — the input state is untouched', () => {
    const state = scenario();
    visibleState(state, 'p1', data);
    expect(state.fleets['enemy-hidden']).toBeDefined();
    expect(state.planets.D?.planetType).toBe('hidden_world');
    expect(state.scheduled).toHaveLength(1);
    expect(state.players.p2?.resources).toEqual({ metal: 99 });
  });

  it('the enemy sees their own side (symmetry, graceful)', () => {
    const view = visibleState(scenario(), 'p2', data);
    expect(view.planets.C?.owner).toBe('p2');
    expect(view.planets.D?.owner).toBe('p2');
    expect(view.players.p2?.resources).toEqual({ metal: 99 });
  });
});
