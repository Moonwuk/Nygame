import { describe, expect, it } from 'vitest';
import { parseGameData, type GameData } from '../data/schemas';
import { createKernel } from '../kernel/kernel';
import { createInitialState, type GameState, type Planet, type Player } from '../state/gameState';
import { visibleState } from '../state/visibility';
import type { Context } from '../action/types';
import { movementModule } from './movement';
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

describe('radar — two concentric ranges (inner full-reveal, outer signatures)', () => {
  const rdata: GameData = parseGameData({
    version: '0.1.0',
    resources: ['metal'],
    units: { cruiser: { faction: 'x', stats: { attack: 4, defense: 4, speed: 6, hp: 20 }, signature: 6 } },
    factions: {},
    buildings: { radar: { name: 'Radar', radarRange: 100 } }, // reach 100 → reveal ≤50, signature ≤100
    events: {},
  });
  const enemy = (id: string, location: string) => ({
    id,
    owner: 'p2',
    location,
    movement: null,
    units: [{ unit: 'cruiser', count: 2 }],
    traits: [],
  });
  function radarState(): GameState {
    return {
      ...createInitialState({ seed: 'r', version: { data: '0.1.0', manifest: '1' } }),
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        H: planet('H', 'p1', [], { position: { x: 0, y: 0 }, buildings: [{ type: 'radar', level: 1, hp: 0 }] }),
        NEAR: planet('NEAR', null, [], { position: { x: 40, y: 0 } }), // ≤50 → full reveal
        MID: planet('MID', null, [], { position: { x: 80, y: 0 } }), //  50<d≤100 → signature
        FAR: planet('FAR', null, [], { position: { x: 200, y: 0 } }), // >100 → nothing
      },
      fleets: { fNear: enemy('fNear', 'NEAR'), fMid: enemy('fMid', 'MID'), fFar: enemy('fFar', 'FAR') },
    };
  }

  it('identifies inside the inner half, signatures the outer half, hides beyond', () => {
    const view = visibleState(radarState(), 'p1', rdata);
    // inner (≤ reach/2 = 50): NEAR at 40 → enemy fleet fully identified, stays in view
    expect(view.fleets.fNear).toBeDefined();
    expect(view.fleets.fNear?.units).toEqual([{ unit: 'cruiser', count: 2 }]);
    // outer (50 < d ≤ 100): MID at 80 → coarse signature only, the fleet is stripped
    expect(view.fleets.fMid).toBeUndefined();
    expect(view.signatures.map((s) => s.location)).toContain('MID');
    // beyond reach (> 100): FAR at 200 → no fleet, no signature
    expect(view.fleets.fFar).toBeUndefined();
    expect(view.signatures.map((s) => s.location)).not.toContain('FAR');
  });
});

describe('fleet scouting (A3) — a traveling fleet commits passed nodes to memory', () => {
  const sdata: GameData = parseGameData({
    version: '0.1.0',
    resources: ['metal'],
    units: { scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 8 } } },
    factions: {},
    buildings: {},
    events: {},
  });

  it('remembers every node the journey touched, not just the destination', () => {
    // p1 owns NO worlds — sight comes from the moving fleet alone. A(0)–B(100)–C(200),
    // scout speed 10 → 10h per leg, so the fleet stands on B at hour 10.
    const state: GameState = {
      ...createInitialState({ seed: 'scout', version: { data: '0.1.0', manifest: '1' } }),
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        A: planet('A', null, ['B'], { position: { x: 0, y: 0 } }),
        B: planet('B', 'p2', ['A', 'C'], { position: { x: 100, y: 0 }, garrison: [{ unit: 'scout', count: 2 }] }),
        C: planet('C', null, ['B'], { position: { x: 200, y: 0 } }),
      },
      fleets: {
        probe: { id: 'probe', owner: 'p1', location: 'A', movement: null, units: [{ unit: 'scout', count: 1 }], traits: [] },
      },
    };
    const kernel = createKernel([movementModule, visibilityModule]);
    const sctx = (now: number): Context => ({ now, data: sdata, config: { timeScale: 1 } });

    const move = kernel.applyAction(
      state,
      { id: 's:p1:1', type: 'fleet.move', playerId: 'p1', payload: { fleetId: 'probe', to: 'C' }, issuedAt: 0 },
      sctx(0),
    );
    if (!move.ok) throw new Error(move.code);
    const done = kernel.advanceTo(move.state, sctx(20 * HOUR));
    if (!done.ok) throw new Error(done.code);

    expect(done.state.fleets.probe?.location).toBe('C');
    // The waypoint B was identified in passing and lives on in memory — with the
    // garrison as it stood when the probe flew through.
    expect(Object.keys(done.state.fog?.p1 ?? {}).sort()).toEqual(['A', 'B', 'C']);
    expect(done.state.fog?.p1?.B?.garrison).toEqual([{ unit: 'scout', count: 2 }]);
    // ...and the projection now shows B as a greyed last-known world.
    const view = visibleState(done.state, 'p1', sdata);
    expect(view.remembered).toContain('B');
  });
});
