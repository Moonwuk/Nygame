import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { economyModule } from './economy';
import { combatModule } from './combat';
import { planetTypeModule } from './planetType';
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
    cruiser: { faction: 'x', stats: { attack: 5, defense: 5, speed: 10, hp: 40 }, line: 'front' },
    drone: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
  },
  factions: {},
  buildings: {
    mine: { name: 'Mine', produces: { metal: 10 } },
  },
  events: {},
  sectors: {},
  planetTypes: {
    volcanic: { productionBonus: 0.25, defenseBonus: -0.05 },
    terran: { productionBonus: 0, defenseBonus: 0.1 },
  },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string, resources: Record<string, number> = {}): Player {
  return { id, name: id, faction: 'x', status: 'active', resources };
}
function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}

describe('planet-type module — production', () => {
  function minedWorld(planetType?: string): GameState {
    const s = createInitialState({ seed: 'pt', version: { data: '0.1.0', manifest: '1' } });
    const a: Planet = {
      id: 'A',
      owner: 'p1',
      position: { x: 0, y: 0 },
      planetType,
      resources: {},
      buildings: [{ type: 'mine', level: 1, hp: 0 }],
      garrison: [],
      traits: [],
    };
    return { ...s, players: { p1: player('p1', { metal: 0 }) }, planets: { A: a } };
  }

  it('scales a world output by its type productionBonus (+25%)', () => {
    const kernel = createKernel([economyModule, planetTypeModule]);
    const r = okAdvance(kernel.advanceTo(minedWorld('volcanic'), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(12.5); // 10/h × 1.25 × 1h
  });

  it('leaves output unchanged for a world with no type', () => {
    const kernel = createKernel([economyModule, planetTypeModule]);
    const r = okAdvance(kernel.advanceTo(minedWorld(), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(10);
  });

  it('without the module the type has no effect (graceful degradation)', () => {
    const kernel = createKernel([economyModule]); // no planet-type module
    const r = okAdvance(kernel.advanceTo(minedWorld('volcanic'), ctx(HOUR)));
    expect(r.state.players.p1?.resources.metal).toBeCloseTo(10);
  });
});

describe('planet-type module — ground defense', () => {
  // A landing of 4 cruisers (4 × attack 5 = 20) assaults A's garrison (defender).
  function groundBattle(planetType?: string): GameState {
    const s = createInitialState({ seed: 'pt-gb', version: { data: '0.1.0', manifest: '1' } });
    const a: Planet = {
      id: 'A',
      owner: 'p2',
      position: { x: 0, y: 0 },
      planetType,
      resources: {},
      buildings: [],
      garrison: [{ unit: 'drone', count: 10 }],
      traits: [],
    };
    const f: Fleet = {
      id: 'F',
      owner: 'p1',
      location: 'A',
      movement: null,
      units: [{ unit: 'cruiser', count: 1 }],
      landing: [{ unit: 'cruiser', count: 4 }],
      traits: [],
      battleId: 'battle:0',
    };
    const battle: Battle = {
      id: 'battle:0',
      location: 'A',
      phase: 'ground',
      attacker: { ref: { kind: 'landing', fleetId: 'F' }, owner: 'p1' },
      defender: { ref: { kind: 'garrison', planetId: 'A' }, owner: 'p2' },
      round: 0,
    };
    return {
      ...s,
      players: { p1: player('p1'), p2: player('p2') },
      planets: { A: a },
      fleets: { F: f },
      battles: { 'battle:0': battle },
      battleSeq: 1,
      scheduled: [
        { id: 'evt:0', at: HOUR, type: 'combat.tick', payload: { battleId: 'battle:0' }, seq: 0 },
      ],
      scheduleSeq: 1,
    };
  }
  const dmgToDefender = (r: AdvanceResult): number => {
    if (!r.ok) throw new Error(r.code);
    const ev = r.events.find((e) => e.type === 'combat.round');
    return (ev?.payload as { dmgToDefender: number }).dmgToDefender;
  };

  it('a defensible world reduces the damage its garrison takes (+10% defense)', () => {
    const kernel = createKernel([combatModule, planetTypeModule]);
    const plain = okAdvance(kernel.advanceTo(groundBattle(), ctx(HOUR)));
    const terran = okAdvance(kernel.advanceTo(groundBattle('terran'), ctx(HOUR)));
    expect(dmgToDefender(plain)).toBeCloseTo(20); // 4 × attack 5, no modifier
    expect(dmgToDefender(terran)).toBeCloseTo(20 / 1.1); // ÷ (1 + 0.1)
  });

  it('an exposed world amplifies the damage its garrison takes (negative bonus)', () => {
    const kernel = createKernel([combatModule, planetTypeModule]);
    const volcanic = okAdvance(kernel.advanceTo(groundBattle('volcanic'), ctx(HOUR)));
    expect(dmgToDefender(volcanic)).toBeCloseTo(20 / 0.95); // ÷ (1 − 0.05)
  });
});
