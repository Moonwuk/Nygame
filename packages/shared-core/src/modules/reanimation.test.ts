import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { combatModule } from './combat';
import { reanimationModule } from './reanimation';
import {
  createInitialState,
  type Battle,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 10, hp: 10 } },
    reanimated_drone: { faction: 'x', stats: { attack: 3, defense: 3, speed: 5, hp: 12 } },
  },
  factions: {
    necro: { name: 'Necromancers', abilities: ['raise_fallen'] },
    plain: { name: 'Plain' },
  },
  buildings: {},
  events: {},
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string, faction: string): Player {
  return { id, name: id, faction, status: 'active', resources: {} };
}
function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

// p2 (attacker) vs p1's fleet F (defender). One orbital tick: p2's 8 cruisers deal 40 to
// F's 20 (hp 10) → 4 lost → 2 should rise if p1 is a raise_fallen faction. F survives.
function orbitalBattle(p1Faction: string): GameState {
  const s = createInitialState({ seed: 'rean', version: { data: '0.1.0', manifest: '1' } });
  const A: Planet = { id: 'A', owner: null, position: { x: 0, y: 0 }, resources: {}, buildings: [], garrison: [], traits: [] };
  const F: Fleet = { id: 'F', owner: 'p1', location: 'A', movement: null, units: [{ unit: 'cruiser', count: 20 }], traits: [], battleId: 'battle:0' };
  const E: Fleet = { id: 'E', owner: 'p2', location: 'A', movement: null, units: [{ unit: 'cruiser', count: 8 }], traits: [], battleId: 'battle:0' };
  const battle: Battle = {
    id: 'battle:0', location: 'A', phase: 'orbital',
    attacker: { ref: { kind: 'fleet', fleetId: 'E' }, owner: 'p2' },
    defender: { ref: { kind: 'fleet', fleetId: 'F' }, owner: 'p1' },
    round: 0,
  };
  return {
    ...s,
    players: { p1: player('p1', p1Faction), p2: player('p2', 'plain') },
    planets: { A },
    fleets: { F, E },
    battles: { 'battle:0': battle },
    battleSeq: 1,
    scheduled: [{ id: 'evt:0', at: HOUR, type: 'combat.tick', payload: { battleId: 'battle:0' }, seq: 0 }],
    scheduleSeq: 1,
  };
}

describe('reanimation module — necromancer raises the fallen (B4 / CR-1.4)', () => {
  it("a fraction of a necromancer fleet's dead rise as reanimated_drone", () => {
    const kernel = createKernel([combatModule, reanimationModule]);
    const r = okAdvance(kernel.advanceTo(orbitalBattle('necro'), ctx(HOUR)));
    const drones = r.state.fleets.F?.units.find((u) => u.unit === 'reanimated_drone');
    expect(drones?.count ?? 0).toBeGreaterThan(0);
    expect(r.events.map((e) => e.type)).toContain('unit.reanimated');
  });

  it('a non-raise_fallen faction does not reanimate (data-gated on the ability)', () => {
    const kernel = createKernel([combatModule, reanimationModule]);
    const r = okAdvance(kernel.advanceTo(orbitalBattle('plain'), ctx(HOUR)));
    expect(r.state.fleets.F?.units.some((u) => u.unit === 'reanimated_drone')).toBe(false);
    expect(r.events.map((e) => e.type)).not.toContain('unit.reanimated');
  });

  it('without the module nothing reanimates (graceful degradation)', () => {
    const kernel = createKernel([combatModule]); // no reanimation module
    const r = okAdvance(kernel.advanceTo(orbitalBattle('necro'), ctx(HOUR)));
    expect(r.events.map((e) => e.type)).not.toContain('unit.reanimated');
  });
});
