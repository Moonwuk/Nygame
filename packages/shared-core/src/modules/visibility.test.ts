import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { visibleState } from '../state/visibility';
import type { Context } from '../action/types';
import { visibilityModule } from './visibility';

const HOUR = 3_600_000;
const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { cruiser: { faction: 'x', stats: { attack: 4, defense: 4, speed: 6, hp: 20 } } },
  factions: {},
  buildings: {},
  events: {},
});
const ctx = (now: number): Context => ({ now, data, config: { timeScale: 1 } });

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function planet(id: string, owner: string | null, links: string[], extra: Partial<Planet> = {}): Planet {
  return { id, owner, position: { x: 0, y: 0 }, links, resources: {}, buildings: [], garrison: [], traits: [], ...extra };
}

/** A(p1) — B(p2, garrisoned) — C(p2, unlinked-from-A, never seen). */
function baseState(): GameState {
  return {
    ...createInitialState({ seed: 'fog', version: { data: '0.1.0', manifest: '1' } }),
    players: { p1: player('p1'), p2: player('p2') },
    planets: {
      A: planet('A', 'p1', ['B']),
      B: planet('B', 'p2', ['A'], { garrison: [{ unit: 'cruiser', count: 3 }], planetType: 'terran' }),
      C: planet('C', 'p2', [], { garrison: [{ unit: 'cruiser', count: 9 }] }),
    },
  };
}

describe('visibilityModule (fog-of-war memory, variant B)', () => {
  it('snapshots identified worlds into per-player memory', () => {
    const kernel = createKernel([visibilityModule]);
    const r = kernel.advanceTo(baseState(), ctx(HOUR));
    if (!r.ok) throw new Error(r.code);

    const memP1 = r.state.fog?.p1 ?? {};
    expect(Object.keys(memP1).sort()).toEqual(['A', 'B']); // A owned, B is 1 jump away
    expect(memP1.B?.owner).toBe('p2');
    expect(memP1.B?.garrison).toEqual([{ unit: 'cruiser', count: 3 }]);
    expect(memP1.C).toBeUndefined(); // never identified (unlinked)
  });

  it('feeds visibleState a greyed last-known world once sight lifts', () => {
    const kernel = createKernel([visibilityModule]);
    const seen = kernel.advanceTo(baseState(), ctx(HOUR));
    if (!seen.ok) throw new Error(seen.code);

    // p1 loses the world that gave sight of B (A becomes neutral) but keeps memory.
    const lost: GameState = { ...seen.state, planets: { ...seen.state.planets, A: { ...seen.state.planets.A!, owner: null } } };
    const view = visibleState(lost, 'p1', data);

    expect(view.remembered).toContain('B');
    expect(view.planets.B?.owner).toBe('p2'); // shown from memory, not stripped
    expect(view.planets.B?.garrison).toEqual([{ unit: 'cruiser', count: 3 }]);
    expect(view.fog).toBeUndefined(); // raw memory never shipped
  });

  it('degrades gracefully — no module ⇒ no memory, unseen worlds read unknown', () => {
    const view = visibleState(baseState(), 'p1', data); // no fog populated
    expect(view.remembered).toEqual([]);
    expect(view.planets.C?.owner).toBeNull(); // unseen, no memory → stripped
  });
});
