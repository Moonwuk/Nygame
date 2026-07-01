import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { constructionModule } from './construction';
import { economyModule } from './economy';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
  type UnitStack,
} from '../state/gameState';
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
// A cruiser: max hull 100 + ablative shield 30 (two separate pools). SHIELD (shieldHp)
// recharges for free anywhere out of combat at 0.06×full/hour, after a post-damage
// delay; HULL (hp) never free-regens — it mends only over a friendly world with a
// repair yard (shipyard shipRepair 0.1/h). A hospital heals troops, not hulls.
const shipData: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: { cruiser: { faction: 'x', stats: { attack: 10, defense: 10, speed: 40, hp: 100, shield: 30 } } },
  factions: {},
  buildings: {
    shipyard: { name: 'Orbital Shipyard', hp: 30, shipRepair: 0.1 },
    hospital: { name: 'Field Hospital', hp: 20, healRate: 0.15 },
  },
  events: {},
  sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
});
const shipCtx = (now: number): Context => ({ now, data: shipData });
const shipKernel = createKernel([constructionModule]);

// `base` hosts `baseBuildings` (a shipyard by default); `deep` is a bare neutral world.
function shipScene(fleet: Fleet, baseOwner: string | null = 'p1', baseBuildings: string[] = ['shipyard']): GameState {
  const base = createInitialState({ seed: 'ship-repair', version: { data: '0.1.0', manifest: '1' } });
  const structHp: Record<string, number> = { shipyard: 30, hospital: 20 };
  const mkPlanet = (id: string, owner: string | null, buildings: string[]): Planet => ({
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: buildings.map((type) => ({ type, level: 1, hp: structHp[type] ?? 20 })),
    garrison: [],
    traits: [],
  });
  return {
    ...base,
    players: { p1: player('p1') },
    planets: { base: mkPlanet('base', baseOwner, baseBuildings), deep: mkPlanet('deep', null, []) },
    fleets: { F: fleet },
  };
}
// hp `null` = full hull (pool undefined); shieldHp omitted = full shield.
const cruiser = (
  hp: number | null,
  location: string,
  extra: Partial<Fleet> = {},
  shieldHp?: number,
): Fleet => {
  const stack: UnitStack = { unit: 'cruiser', count: 1 };
  if (hp !== null) stack.hp = hp;
  if (shieldHp !== undefined) stack.shieldHp = shieldHp;
  return { id: 'F', owner: 'p1', location, movement: null, units: [stack], traits: [], ...extra };
};

describe('ship hull repair + shield recharge', () => {
  it('regenerates the shield for free anywhere between fights', () => {
    const s = shipScene(cruiser(null, 'deep', {}, 10)); // full hull, shield 10/30, neutral world
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.shieldHp).toBeCloseTo(11.8); // 10 + 0.06×30
    expect(state.fleets.F?.units[0]?.hp).toBeUndefined(); // hull untouched — no free hull regen
  });

  it('does NOT free-regen the hull away from a friendly port', () => {
    const s = shipScene(cruiser(20, 'deep'));
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(20); // hull never mends for free
  });

  it('mends the hull only over a friendly world with a repair yard', () => {
    // shipyard world: 0.1/hour → +10 hull
    const atYard = okAdvance(shipKernel.advanceTo(shipScene(cruiser(20, 'base')), shipCtx(HOUR)));
    expect(atYard.fleets.F?.units[0]?.hp).toBeCloseTo(30); // 20 + 0.1×100
    // friendly world, no repair yard: no hull repair at all
    const noYard = okAdvance(shipKernel.advanceTo(shipScene(cruiser(20, 'base'), 'p1', []), shipCtx(HOUR)));
    expect(noYard.fleets.F?.units[0]?.hp).toBeCloseTo(20);
  });

  it('a hospital heals troops but does NOT mend hulls', () => {
    const s = shipScene(cruiser(20, 'base'), 'p1', ['hospital']); // hospital only, no shipyard
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(20); // hull untouched — hospital ≠ repair yard
  });

  it('regenerates shield and repairs hull as separate pools at a yard', () => {
    const s = shipScene(cruiser(60, 'base', {}, 10)); // hull 60, shield 10/30, shipyard world
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeCloseTo(70); // hull: 60 + 0.1×100 (yard only)
    expect(state.fleets.F?.units[0]?.shieldHp).toBeCloseTo(11.8); // shield: 10 + 0.06×30 (free)
  });

  it('holds shield regen for a delay after taking damage', () => {
    const scene = () => shipScene(cruiser(null, 'deep', { lastDamagedAt: 0 }, 10));
    // Span [0, HOUR) lies inside the 1h post-damage delay → shield frozen.
    const frozen = okAdvance(shipKernel.advanceTo(scene(), shipCtx(HOUR)));
    expect(frozen.fleets.F?.units[0]?.shieldHp).toBeCloseTo(10); // no regen yet
    // By 3h the delay has passed and shields have resumed.
    const resumed = okAdvance(shipKernel.advanceTo(scene(), shipCtx(3 * HOUR)));
    expect(resumed.fleets.F?.units[0]?.shieldHp).toBeGreaterThan(10);
  });

  it('regenerates nothing while in a battle', () => {
    const s = shipScene(cruiser(60, 'base', { battleId: 'b1' }, 10));
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBe(60); // hull frozen
    expect(state.fleets.F?.units[0]?.shieldHp).toBe(10); // shield frozen mid-fight
  });

  it('clears each pool to undefined once it is full', () => {
    const s = shipScene(cruiser(96, 'base', {}, 29)); // hull 96 (+10→100), shield 29 (+1.8→30)
    const state = okAdvance(shipKernel.advanceTo(s, shipCtx(HOUR)));
    expect(state.fleets.F?.units[0]?.hp).toBeUndefined();
    expect(state.fleets.F?.units[0]?.shieldHp).toBeUndefined();
  });
});
