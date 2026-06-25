import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createInitialState, type Fleet, type GameState, type Planet, type Player } from './gameState';
import { visibleState } from './visibility';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 10, defense: 8, speed: 6, hp: 40 }, signature: 4 },
    scout: { faction: 'x', stats: { attack: 2, defense: 2, speed: 9, hp: 8 }, radarRange: 350 },
  },
  factions: {},
  buildings: {
    // Radar reach is a Euclidean DISTANCE (map units), not jumps.
    radar: { name: 'Radar', radarRange: 300, upgrades: [{ radarRange: 500 }, { radarRange: 700 }] },
  },
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

/** Graph A→B→C→D→E (jumps), but radar works by physical DISTANCE (x-coords below).
 *  p1 owns A with a radar (reach 300). Identify = 1 jump (A,B). By distance from A:
 *  C(250) and E(180) are in radar reach; D(450) is not until the radar is upgraded.
 *  E is 4 jumps away yet physically close — the whole point of the new mechanic. */
function scenario(): GameState {
  const base = createInitialState({ seed: 'vis', version: { data: '0.1.0', manifest: '1' } });
  const at = (x: number): Partial<Planet> => ({ position: { x, y: 0 } });
  return {
    ...base,
    players: { p1: player('p1'), p2: { ...player('p2'), technologies: { completed: ['warp'] } } },
    planets: {
      A: planet('A', 'p1', ['B'], { ...at(0), buildings: [{ type: 'radar', level: 1, hp: 10 }] }),
      B: planet('B', null, ['A', 'C'], { ...at(100), garrison: [{ unit: 'cruiser', count: 1 }] }),
      C: planet('C', 'p2', ['B', 'D'], { ...at(250), garrison: [{ unit: 'cruiser', count: 2 }], planetType: 'radar_world' }),
      D: planet('D', 'p2', ['C', 'E'], { ...at(450), garrison: [{ unit: 'cruiser', count: 5 }], planetType: 'hidden_world' }),
      E: planet('E', 'p2', ['D'], { ...at(180), garrison: [{ unit: 'cruiser', count: 1 }] }),
    },
    fleets: {
      'mine-1': fleet('mine-1', 'p1', 'A', [['cruiser', 1]]),
      'enemy-near': fleet('enemy-near', 'p2', 'B', [['cruiser', 1]]), // at B (identified)
      'enemy-radar': fleet('enemy-radar', 'p2', 'C', [['cruiser', 4]]), // at C (radar by distance) → ◆L
      'enemy-far-close': fleet('enemy-far-close', 'p2', 'E', [['cruiser', 1]]), // 4 jumps away, but close → ◆S
      'enemy-hidden': fleet('enemy-hidden', 'p2', 'D', [['cruiser', 5]]), // at D (beyond L1 radar)
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
    expect(view.planets.D?.links).toEqual(['C', 'E']);
  });

  it('reports radar-only enemy fleets as coarse signatures, not the fleets', () => {
    const view = visibleState(scenario(), 'p1', data);
    expect(view.fleets['enemy-radar']).toBeUndefined();
    expect(view.fleets['enemy-far-close']).toBeUndefined();
    // Within radar distance 300 from A: C (4 cruisers ×4 = 16 → L) and E (1 → S).
    // Sorted by location; D (450) is beyond reach, so no contact there.
    expect(view.signatures).toEqual([
      { location: 'C', size: 'L' },
      { location: 'E', size: 'S' },
    ]);
  });

  it('radar reaches by physical distance, ignoring jump topology', () => {
    // E is 4 jumps from A (A→B→C→D→E) yet only 180 units away in space — the
    // signal reaches it even though no fleet could jump there directly.
    const view = visibleState(scenario(), 'p1', data);
    expect(view.signatures.some((s) => s.location === 'E')).toBe(true);
    expect(view.fleets['enemy-far-close']).toBeUndefined(); // detected, not identified
  });

  it('a higher-level radar array detects farther (level-scaled reach)', () => {
    const state = scenario();
    // Level 1 (reach 300): D is 450 units away → outside radar, no contact.
    expect(visibleState(state, 'p1', data).signatures.some((s) => s.location === 'D')).toBe(false);
    // Upgrade A's radar to level 2 (reach 500) → D (450) comes into radar as a
    // signature, while the fleet there is still not identified.
    state.planets.A!.buildings = [{ type: 'radar', level: 2, hp: 26 }];
    const view = visibleState(state, 'p1', data);
    expect(view.fleets['enemy-hidden']).toBeUndefined();
    expect(view.signatures.some((s) => s.location === 'D')).toBe(true);
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
