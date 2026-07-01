import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import { createInitialState, type Fleet, type GameState, type Planet, type Player } from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { AdvanceResult, Context } from '../action/types';

const HOUR = 3_600_000;

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  units: {
    marine: {
      faction: 'x',
      stats: { attack: 10, defense: 10, speed: 30, hp: 20 },
      domain: 'ground',
      traits: ['ground'],
      cost: { metal: 20 },
      buildTimeHours: 1,
    },
  },
  factions: {},
  buildings: {
    hospital: {
      name: 'Field Hospital',
      cost: { metal: 160, credits: 60 },
      buildTimeHours: 8,
      hp: 20,
      healRate: 0.15,
    },
  },
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
});

function ctx(now: number): Context {
  return { now, data };
}

function okAdvance(r: AdvanceResult): GameState {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r.state;
}

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}

function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [{ type: 'hospital', level: 1, hp: 20 }],
    // 4 marines at half HP: full = 4 × 20 = 80, current = 40
    garrison: [{ unit: 'marine', count: 4, hp: 40 }],
    traits: [],
  };
}

function makeState(owner: string | null = 'p1'): GameState {
  const base = createInitialState({ seed: 'hospital-test', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...base,
    players: { p1: player('p1') },
    planets: { home: planet('home', owner) },
  };
}

const kernel = createKernel([economyModule, constructionModule]);

describe('hospital heal mechanic', () => {
  it('restores garrison HP over time', () => {
    const s = makeState();
    // healRate=0.15 → 0.15×80=12 HP/hour; after 4h: 40+48=88 → capped at 80 (full)
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack).toBeDefined();
    expect(stack!.hp).toBeUndefined(); // fully healed → cleared to undefined
  });

  it('does not overheal above full', () => {
    const s = makeState();
    const state = okAdvance(kernel.advanceTo(s, ctx(20 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeUndefined();
    expect(stack!.count).toBe(4); // no phantom units created
  });

  it('partially heals with less time', () => {
    const s = makeState();
    // After 1 hour: 40 + 0.15×80×1 = 52 HP
    const state = okAdvance(kernel.advanceTo(s, ctx(HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(52);
  });

  it('does not heal when building is destroyed', () => {
    const s = makeState();
    s.planets.home!.buildings[0]!.hp = 0; // hospital destroyed
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(40); // unchanged
  });

  it('does not heal neutral planets', () => {
    const s = makeState(null); // neutral owner
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(40); // unchanged
  });

  it('does not touch already-full stacks', () => {
    const s = makeState();
    s.planets.home!.garrison[0]!.hp = undefined; // already full
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeUndefined();
  });

  it('does NOT heal the garrison mid ground assault (mirrors the ship battleId guard)', () => {
    const s = makeState();
    // A live ground assault is underway on this very world.
    s.battles = {
      b1: {
        id: 'b1',
        location: 'home',
        phase: 'ground',
        attacker: { ref: { kind: 'landing', fleetId: 'F' }, owner: 'p2' },
        defender: { ref: { kind: 'garrison', planetId: 'home' }, owner: 'p1' },
        round: 1,
      },
    };
    const state = okAdvance(kernel.advanceTo(s, ctx(4 * HOUR)));
    const stack = state.planets.home?.garrison[0];
    expect(stack!.hp).toBeCloseTo(40); // unchanged — no regen while contested
  });
});

// --- ship hull repair + shield recharge --------------------------------------
// A cruiser: max hull 100. The 30% line splits "shields" (above) from "hull"
// breach (at/below). Shields recharge anywhere between fights at 0.06×full/hour;
// hull only mends over a friendly world with a hospital (healRate 0.15).
const shipData: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { cruiser: { faction: 'x', stats: { attack: 10, defense: 10, speed: 40, hp: 100 } } },
  factions: {},
  buildings: { hospital: { name: 'Hospital', hp: 20, healRate: 0.15 } },
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
});
const shipCtx = (now: number): Context => ({ now, data: shipData });
const shipKernel = createKernel([constructionModule]);

function shipScene(fleet: Fleet, baseOwner: string | null = 'p1', hospital = true): GameState {
  const base = createInitialState({ seed: 'ship-repair', version: { data: '0.1.0', manifest: '1' } });
  const mkPlanet = (id: string, owner: string | null, hasHospital: boolean): Planet => ({
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: hasHospital ? [{ type: 'hospital', level: 1, hp: 20 }] : [],
    garrison: [],
    traits: [],
  });
  return {
    ...base,
    players: { p1: player('p1') },
    planets: { base: mkPlanet('base', baseOwner, hospital), deep: mkPlanet('deep', null, false) },
    fleets: { F: fleet },
  };
}
const cruiser = (hp: number, location: string, extra: Partial<Fleet> = {}): Fleet => ({
  id: 'F',
  owner: 'p1',
  location,
  movement: null,
  units: [{ unit: 'cruiser', count: 1, hp }],
  traits: [],
  ...extra,
});

describe('ship hull repair + shield recharge', () => {
  it('recharges shields (hull above 30%) anywhere between fights', () => {
    const s = shipScene(cruiser(60, 'deep')); // deep = neutral world → no base repair
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(66); // 60 + 0.06×100
  });

  it('does NOT mend a hull breach (≤30%) away from a repair base', () => {
    const s = shipScene(cruiser(20, 'deep'));
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(20); // breach persists, shields offline
  });

  it('mends the hull at any friendly world (base rate), faster with a hospital', () => {
    // hospital world: base 0.04 + hospital 0.15 = 0.19/hour
    const withHospital = okAdvance(shipKernel.advanceTo(shipScene(cruiser(20, 'base')), shipCtx(HOUR)));
    expect(withHospital.fleets.F?.units[0]?.hp).toBeCloseTo(39); // 20 + 0.19×100
    // friendly world, no repair building: base rate only (0.04/hour)
    const noHospital = okAdvance(shipKernel.advanceTo(shipScene(cruiser(20, 'base'), 'p1', false), shipCtx(HOUR)));
    expect(noHospital.fleets.F?.units[0]?.hp).toBeCloseTo(24); // 20 + 0.04×100
  });

  it('stacks shields + hull repair at a friendly base', () => {
    const s = shipScene(cruiser(60, 'base'));
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(85); // 60 +6 (shields) +19 (hull 0.04+0.15)
  });

  it('does not repair a fleet that is in a battle', () => {
    const s = shipScene(cruiser(60, 'base', { battleId: 'b1' }));
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBe(60); // frozen mid-fight
  });

  it('clears hp to undefined once fully repaired', () => {
    const s = shipScene(cruiser(96, 'base')); // +6 shields +15 hull → capped at 100
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeUndefined();
  });
});
