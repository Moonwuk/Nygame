import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { heroModule } from './hero';
import { movementModule } from './movement';
import { combatModule } from './combat';
import {
  createInitialState,
  type Fleet,
  type GameState,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';
import { deepFreeze } from '../util/clone';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    scout: { faction: 'x', stats: { attack: 1, defense: 1, speed: 10, hp: 6 } },
    warship: { faction: 'x', stats: { attack: 20, defense: 20, speed: 5, hp: 200 }, line: 'front' },
    // The projection hero: tanky, no offence of its own — its value is the fleet aura.
    hero: {
      faction: 'x',
      stats: { attack: 0, defense: 0, speed: 5, hp: 120 },
      line: 'front',
      traits: ['hero'],
    },
  },
  factions: {},
  buildings: { mine: { name: 'Mine', produces: { metal: 10 } } },
  events: {},
  sectorKinds: {
    planet: { scoreValue: 50, capturable: true, buildable: true, orbit: true },
    // A depleted planet is re-claimable and metal-rich, but worth only the flat 10.
    dead_world: { scoreValue: 10, capturable: true, buildable: true, orbit: true },
  },
  planetTypes: {
    terran: { productionBonus: 0, defenseBonus: 0.1 },
    dead_world: { productionBonus: 0, productionByResource: { metal: 0.3 }, defenseBonus: 0 },
  },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function planet(
  id: string,
  owner: string | null,
  x: number,
  y: number,
  links: string[],
  kind: string,
): Planet {
  return {
    id,
    owner,
    position: { x, y },
    links,
    kind,
    planetType: kind === 'dead_world' ? 'dead_world' : 'terran',
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
function act(type: string, playerId: string, payload: unknown, seq = 1): Action {
  return { id: `s:${playerId}:${seq}`, type, playerId, payload, issuedAt: 0 };
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
/** state.heroes is instance-keyed; tests read a player's hero by owner. */
function heroOf(s: GameState, owner: string) {
  return Object.values(s.heroes ?? {}).find((h) => h.owner === owner);
}

/**
 * A→B is a real 30-unit lane (both p1's). C(400,0) is p2's, unlinked, within
 * path range (600) and annihilate range (500). F(700,0) is p2's, out of both.
 * Only p1 has a hero, parked at A.
 */
function world(): GameState {
  const s = createInitialState({ seed: 'hero', version: { data: '0.1.0', manifest: '1' } });
  return {
    ...s,
    players: { p1: player('p1'), p2: player('p2') },
    planets: {
      A: planet('A', 'p1', 0, 0, ['B'], 'planet'),
      B: planet('B', 'p1', 30, 0, ['A'], 'planet'),
      C: planet('C', 'p2', 400, 0, [], 'planet'),
      F: planet('F', 'p2', 700, 0, [], 'planet'),
    },
    heroes: { 'hero:p1': { id: 'hero:p1', owner: 'p1', location: 'A', cooldowns: {} } },
  };
}

describe('hero — move (redeploy)', () => {
  const kernel = createKernel([heroModule]);

  it('redeploys the hero to a world the player owns', () => {
    const r = okApply(kernel.applyAction(world(), act('hero.move', 'p1', { to: 'B' }), ctx(0)));
    expect(heroOf(r.state, 'p1')?.location).toBe('B');
    expect(r.events.map((e) => e.type)).toContain('hero.moved');
  });

  it('rejects bad, heroless, unknown and unowned targets', () => {
    const st = world();
    expect(errCode(kernel.applyAction(st, act('hero.move', 'p1', {}), ctx(0)))).toBe('E_BAD_PAYLOAD');
    expect(errCode(kernel.applyAction(st, act('hero.move', 'p2', { to: 'C' }), ctx(0)))).toBe(
      'E_NO_HERO', // p2 has no hero
    );
    expect(errCode(kernel.applyAction(st, act('hero.move', 'p1', { to: 'ZZ' }), ctx(0)))).toBe(
      'E_NO_PLANET',
    );
    expect(errCode(kernel.applyAction(st, act('hero.move', 'p1', { to: 'C' }), ctx(0)))).toBe(
      'E_FORBIDDEN', // C belongs to p2
    );
  });

  it('does not mutate the input state', () => {
    const st = deepFreeze(world());
    okApply(kernel.applyAction(st, act('hero.move', 'p1', { to: 'B' }), ctx(0)));
    expect(heroOf(st, 'p1')?.location).toBe('A');
  });
});

describe('hero — temp public lane (path.create / expire)', () => {
  const kernel = createKernel([heroModule]);

  it('opens a routable lane: links both ways, bumps topology, schedules expiry', () => {
    const r = okApply(kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'C' }), ctx(0)));
    const s = r.state;
    expect(s.planets.A?.links).toContain('C');
    expect(s.planets.C?.links).toContain('A');
    expect(s.topology).toBe(1); // bumped from undefined→0→1
    expect(s.tempLanes).toHaveLength(1);
    const lane = s.tempLanes![0]!;
    expect(lane).toMatchObject({ owner: 'p1', from: 'A', to: 'C', addedLink: true });
    expect(lane.expiresAt).toBe(6 * HOUR); // PATH_DURATION_HOURS, timeScale 1
    expect(heroOf(s, 'p1')?.cooldowns.path).toBe(12 * HOUR); // PATH_COOLDOWN_HOURS
    expect(s.scheduled.some((e) => e.type === 'hero.path.expire')).toBe(true);
    expect(r.events.map((e) => e.type)).toContain('hero.path.created');
  });

  it('rejects same-location, out-of-range and cooldown', () => {
    // Same location: hero is at A, target A.
    expect(
      errCode(kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'A' }), ctx(0))),
    ).toBe('E_SAME_LOCATION');
    // F is 700 units away (> 600).
    expect(
      errCode(kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'F' }), ctx(0))),
    ).toBe('E_OUT_OF_RANGE');
    // A second lane while still on cooldown.
    const first = okApply(
      kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'C' }), ctx(0)),
    );
    expect(
      errCode(kernel.applyAction(first.state, act('hero.path.create', 'p1', { to: 'B' }, 2), ctx(0))),
    ).toBe('E_COOLDOWN');
  });

  it('expires on schedule: removes the lane and the link it added, bumps topology', () => {
    const created = okApply(
      kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'C' }), ctx(0)),
    );
    const expired = okAdvance(kernel.advanceTo(created.state, ctx(6 * HOUR)));
    expect(expired.state.tempLanes).toHaveLength(0);
    expect(expired.state.planets.A?.links).not.toContain('C'); // added link withdrawn
    expect(expired.state.planets.C?.links).not.toContain('A');
    expect(expired.state.topology).toBe(2); // create (1) + expire (2)
    expect(expired.events.map((e) => e.type)).toContain('hero.path.expired');
  });

  it('on a pre-existing lane the link survives expiry (only owner-added links are withdrawn)', () => {
    // A↔B are already linked: the lane grants a bonus but adds no edge.
    const created = okApply(
      kernel.applyAction(world(), act('hero.path.create', 'p1', { to: 'B' }), ctx(0)),
    );
    expect(created.state.tempLanes![0]!.addedLink).toBe(false);
    const expired = okAdvance(kernel.advanceTo(created.state, ctx(6 * HOUR)));
    expect(expired.state.tempLanes).toHaveLength(0);
    expect(expired.state.planets.A?.links).toContain('B'); // original lane untouched
  });
});

describe('hero — temp lane speed bonus (fleet.speed hook)', () => {
  it("speeds the owner's fleet along the lane (+50%), but not an enemy's", () => {
    const kernel = createKernel([heroModule, movementModule]);
    const base = world();
    base.fleets = { F1: fleet('F1', 'p1', 'A'), E1: fleet('E1', 'p2', 'A') };
    const laned = okApply(kernel.applyAction(base, act('hero.path.create', 'p1', { to: 'C' }), ctx(0)));

    // Owner's fleet: 400 units at speed 10 × 1.5 = 15 → 96 000 000 ms.
    const own = okApply(kernel.applyAction(laned.state, act('fleet.move', 'p1', { fleetId: 'F1', to: 'C' }), ctx(0)));
    expect(own.state.fleets.F1?.movement?.arrivesAt).toBeCloseTo((400 / 15) * HOUR, 0);

    // Enemy uses the public lane too, but with no bonus: 400 / 10 → 144 000 000 ms.
    const enemy = okApply(kernel.applyAction(laned.state, act('fleet.move', 'p2', { fleetId: 'E1', to: 'C' }), ctx(0)));
    expect(enemy.state.fleets.E1?.movement?.arrivesAt).toBeCloseTo((400 / 10) * HOUR, 0);
  });
});

describe('hero — planet annihilation', () => {
  const kernel = createKernel([heroModule]);

  it('turns a world into a re-claimable, metal-rich dead world, cleared and ownerless', () => {
    const st = world();
    st.planets.C!.buildings = [{ type: 'mine', level: 1, hp: 0 }];
    st.planets.C!.garrison = [{ unit: 'scout', count: 3 }];
    const r = okApply(kernel.applyAction(st, act('planet.annihilate', 'p1', { planetId: 'C' }), ctx(0)));
    const c = r.state.planets.C!;
    expect(c.owner).toBe(null);
    expect(c.kind).toBe('dead_world');
    expect(c.planetType).toBe('dead_world');
    expect(c.buildings).toHaveLength(0);
    expect(c.garrison).toHaveLength(0);
    expect(heroOf(r.state, 'p1')?.cooldowns.annihilate).toBe(48 * HOUR); // ANNIHILATE_COOLDOWN_HOURS
    expect(r.events.map((e) => e.type)).toContain('planet.destroyed');
    // The node remains routable — annihilation does not delete it from the map.
    expect(r.state.planets.C).toBeDefined();
  });

  it('rejects heroless, unknown, out-of-range and already-dead targets', () => {
    const st = world();
    expect(
      errCode(kernel.applyAction(st, act('planet.annihilate', 'p2', { planetId: 'C' }), ctx(0))),
    ).toBe('E_NO_HERO');
    expect(
      errCode(kernel.applyAction(st, act('planet.annihilate', 'p1', { planetId: 'ZZ' }), ctx(0))),
    ).toBe('E_NO_PLANET');
    // F is 700 units away (> 500).
    expect(
      errCode(kernel.applyAction(st, act('planet.annihilate', 'p1', { planetId: 'F' }), ctx(0))),
    ).toBe('E_OUT_OF_RANGE');
    // A dead world can't be destroyed again — the kind guard rejects it even though
    // a dead world is now re-capturable (you can re-claim and mine it, not re-kill it).
    const dead = okApply(kernel.applyAction(st, act('planet.annihilate', 'p1', { planetId: 'C' }), ctx(0)));
    expect(
      errCode(
        kernel.applyAction(dead.state, act('planet.annihilate', 'p1', { planetId: 'C' }, 2), ctx(0)),
      ),
    ).toBe('E_NOT_DESTRUCTIBLE');
  });

  it('rejects a second annihilation while on cooldown', () => {
    const st = world();
    const first = okApply(
      kernel.applyAction(st, act('planet.annihilate', 'p1', { planetId: 'C' }), ctx(0)),
    );
    // B is in range and still capturable, but the ability is on cooldown.
    expect(
      errCode(
        kernel.applyAction(first.state, act('planet.annihilate', 'p1', { planetId: 'B' }, 2), ctx(HOUR)),
      ),
    ).toBe('E_COOLDOWN');
  });
});

// Fixture: emit `fleet.arrived` so combat's engageFleets starts an orbital battle.
const arriveModule: GameModule = {
  id: 'test-arrive',
  version: '1.0.0',
  setup(api) {
    api.onAction('arrive', (a, h) => {
      const fleetId = (a.payload as { fleetId: string }).fleetId;
      h.emit('fleet.arrived', { fleetId, at: h.state.fleets[fleetId]?.location });
    });
  },
};

describe('hero — fleet combat aura (+5%)', () => {
  it('a hero-carrying fleet hits 5% harder; a heroless fleet does not', () => {
    const kernel = createKernel([heroModule, combatModule, arriveModule]);
    const s = createInitialState({ seed: 'aura', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...s,
      players: { p1: player('p1'), p2: player('p2') },
      planets: { P: planet('P', null, 0, 0, [], 'planet') },
      fleets: {
        A: { id: 'A', owner: 'p1', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }, { unit: 'hero', count: 1 }] },
        D: { id: 'D', owner: 'p2', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }] },
      },
    };
    const started = okApply(kernel.applyAction(st, act('arrive', 'p1', { fleetId: 'A' }), ctx(0)));
    const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR))); // one round
    const round = r.events.find((e) => e.type === 'combat.round');
    const p = round?.payload as { dmgToDefender: number; dmgToAttacker: number };
    expect(p.dmgToDefender).toBe(21); // A (attacker, has hero): 20 attack × 1.05
    expect(p.dmgToAttacker).toBe(20); // D (defender, no hero): 20 defense, unbuffed
  });
});

describe('hero — death and respawn', () => {
  // A one-shot enemy: defense 150 return-fire flattens the hero's 120 hp in round 1.
  const killerData: GameData = parseGameData({
    version: '0.1.0',
    resources: ['metal'],
    units: {
      hero: { faction: 'x', stats: { attack: 0, defense: 0, speed: 5, hp: 120 }, line: 'front', traits: ['hero'] },
      killer: { faction: 'x', stats: { attack: 150, defense: 150, speed: 5, hp: 300 }, line: 'front' },
    },
    factions: {},
    buildings: {},
    events: {},
    sectorKinds: { planet: { capturable: true, buildable: true, orbit: true } },
    planetTypes: { terran: { scoreValue: 0 } },
  });
  const kctx = (now: number): Context => ({ now, data: killerData });
  const kernel = createKernel([heroModule, combatModule, arriveModule]);
  const heroUnit = (f: Fleet) => f.units.some((u) => u.unit === 'hero' && u.count > 0);

  function arena(): GameState {
    const s = createInitialState({ seed: 'respawn', version: { data: '0.1.0', manifest: '1' } });
    return {
      ...s,
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        P: planet('P', null, 0, 0, [], 'planet'), // the battlefield
        HOME: planet('HOME', 'p1', 50, 0, [], 'planet'), // p1's home → respawn point
      },
      fleets: {
        // p1's lone hero ship meets a far stronger enemy and is destroyed.
        F: { id: 'F', owner: 'p1', location: 'P', movement: null, traits: [], units: [{ unit: 'hero', count: 1 }] },
        D: { id: 'D', owner: 'p2', location: 'P', movement: null, traits: [], units: [{ unit: 'killer', count: 1 }] },
      },
      heroes: {
        'hero:p1': { id: 'hero:p1', owner: 'p1', name: 'Ada', location: 'HOME', home: 'HOME', fleetId: 'F', cooldowns: {}, alive: true },
      },
    };
  }

  it('kills the hero, schedules a respawn, then re-forms it at home', () => {
    const started = okApply(kernel.applyAction(arena(), act('arrive', 'p1', { fleetId: 'F' }), kctx(0)));
    const dead = okAdvance(kernel.advanceTo(started.state, kctx(2 * HOUR)));

    // The hero died: entity flagged dead, its ship link cleared, a respawn scheduled, no hero unit remains.
    expect(heroOf(dead.state, 'p1')?.alive).toBe(false);
    expect(heroOf(dead.state, 'p1')?.fleetId).toBeUndefined();
    expect(dead.state.scheduled.some((e) => e.type === 'hero.respawn')).toBe(true);
    expect(Object.values(dead.state.fleets).some(heroUnit)).toBe(false);
    expect(dead.events.map((e) => e.type)).toContain('hero.died');

    // After the 24h cooldown the hero re-forms as a fresh fleet at HOME, re-linked to it.
    const reborn = okAdvance(kernel.advanceTo(dead.state, kctx(30 * HOUR)));
    const hero = heroOf(reborn.state, 'p1');
    expect(hero?.alive).toBe(true);
    const heroFleet = Object.values(reborn.state.fleets).find((f) => f.owner === 'p1' && heroUnit(f));
    expect(heroFleet?.location).toBe('HOME');
    expect(hero?.fleetId).toBe(heroFleet?.id); // re-linked to its new ship
    expect(reborn.events.map((e) => e.type)).toContain('hero.respawned');
  });

  it('respawns at the capital (home) even when another owned world sorts first', () => {
    const s = createInitialState({ seed: 'cap-respawn', version: { data: '0.1.0', manifest: '1' } });
    const st: GameState = {
      ...s,
      players: { p1: player('p1'), p2: player('p2') },
      planets: {
        P: planet('P', null, 0, 0, [], 'planet'), // battlefield (unowned)
        AAA: planet('AAA', 'p1', 50, 0, [], 'planet'), // owned, sorts first alphabetically
        ZED: planet('ZED', 'p1', 60, 0, [], 'planet'), // owned, the designated capital
      },
      fleets: {
        F: { id: 'F', owner: 'p1', location: 'P', movement: null, traits: [], units: [{ unit: 'hero', count: 1 }] },
        D: { id: 'D', owner: 'p2', location: 'P', movement: null, traits: [], units: [{ unit: 'killer', count: 1 }] },
      },
      heroes: {
        'hero:p1': { id: 'hero:p1', owner: 'p1', location: 'P', home: 'ZED', fleetId: 'F', cooldowns: {}, alive: true },
      },
    };
    const started = okApply(kernel.applyAction(st, act('arrive', 'p1', { fleetId: 'F' }), kctx(0)));
    const dead = okAdvance(kernel.advanceTo(started.state, kctx(2 * HOUR)));
    const reborn = okAdvance(kernel.advanceTo(dead.state, kctx(30 * HOUR)));
    // home ('ZED') wins over the alphabetically-first owned world ('AAA').
    const heroFleet = Object.values(reborn.state.fleets).find((f) => f.owner === 'p1' && heroUnit(f));
    expect(heroFleet?.location).toBe('ZED');
    expect(heroOf(reborn.state, 'p1')?.location).toBe('ZED');
  });
});
