import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { heroModule, type HeroEffect } from './hero';
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
  // HERO-4 catalog: the two built-in effect types, a costly custom type, an unwired type,
  // and a params-tuned lane with NO range (falls back to the engine constant, never ∞).
  heroAbilities: {
    corridor: { name: 'Коридор', type: 'temp_lane', cooldownHours: 12, range: 600 },
    annihilate: { name: 'Аннигиляция', type: 'annihilate', cooldownHours: 48, range: 500 },
    burst: { name: 'Burst', type: 'test_burst', cooldownHours: 10, cost: { metal: 50 } },
    ghost: { name: 'Ghost', type: 'unwired_type' },
    // HERO-8 spawn-gate markers: carried (not cast) abilities widening hero.spawn.
    boarding: { name: 'Boarding', type: 'spawn_fleet' },
    landing: { name: 'Landing', type: 'spawn_allied' },
    warp: {
      name: 'Warp',
      type: 'temp_lane',
      cooldownHours: 1,
      params: { durationHours: 2, speedBonus: 0.25 },
    },
  },
  // HERO-3: an archetype whose ship is a concrete hull (spawn resolves the unit).
  // Its branch also anchors the HERO-7 skill-tree branch gate.
  heroes: {
    raider: { name: 'Raider', branch: 'transhuman', ship: { unit: 'warship' }, slots: 2 },
  },
  // HERO-6 fittings: a live ability grant, a live passive grant, a not-yet-live statMod.
  heroFittings: {
    psi_lens: { name: 'Psi Lens', grants: { ability: 'burst' }, cost: { metal: 20 } },
    war_drum: { name: 'War Drum', grants: { passive: 'warcry' } },
    plating: { name: 'Plating', statMods: { hp: 40 } },
  },
  // HERO-7 tree: a transhuman root + a costly child, a psionic node, a common node.
  heroSkillTrees: {
    neural_lace: { name: 'Neural Lace', branch: 'transhuman', grants: { passive: 'swift' } },
    overclock: {
      name: 'Overclock',
      branch: 'transhuman',
      requires: ['neural_lace'],
      cost: { metal: 40 },
      grants: { ability: 'burst' },
    },
    void_gift: { name: 'Void Gift', branch: 'psionic', grants: { ability: 'ghost' } },
    common_core: { name: 'Core', grants: {} },
    // Fan-in node: BOTH parents must be unlocked (multi-parent requires).
    synthesis: {
      name: 'Synthesis',
      branch: 'transhuman',
      requires: ['neural_lace', 'overclock'],
      grants: {},
    },
  },
  // HERO-5 catalog: one passive per scope for each wired hook.
  heroPassives: {
    swift: { name: 'Swift', hook: 'fleet.speed', scope: 'heroFleet', params: { bonus: 0.1 } },
    herald: {
      name: 'Herald',
      hook: 'fleet.speed',
      scope: 'ownFleetsNear',
      params: { bonus: 0.2, radius: 10 },
    },
    warcry: {
      name: 'Warcry',
      hook: 'combat.damage',
      scope: 'ownFleetsNear',
      params: { bonus: 0.5, radius: 300 },
    },
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
    // Deployed (BF-24): an undeployed reserve can no longer act from the bench.
    heroes: { 'hero:p1': { id: 'hero:p1', owner: 'p1', location: 'A', cooldowns: {}, alive: true } },
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

describe('hero — generic data-driven ability (hero.ability, HERO-4)', () => {
  const kernel = createKernel([heroModule]);
  const HERO_ID = 'hero:p1';

  /** world() + the hero carries the whole test catalog and p1 can afford `burst` once. */
  function abilityWorld(): GameState {
    const st = world();
    st.heroes![HERO_ID]!.abilities = ['corridor', 'annihilate', 'burst', 'ghost', 'warp'];
    st.players.p1!.resources = { metal: 60 };
    return st;
  }
  const cast = (abilityId: string, target?: string, seq = 1) =>
    act('hero.ability', 'p1', { heroId: HERO_ID, abilityId, ...(target ? { target } : {}) }, seq);

  it('casts a temp_lane ability from data: lane + shared `path` cooldown + used-event', () => {
    const r = okApply(kernel.applyAction(abilityWorld(), cast('corridor', 'C'), ctx(0)));
    expect(r.state.tempLanes).toHaveLength(1);
    expect(r.state.planets.A?.links).toContain('C');
    const types = r.events.map((e) => e.type);
    expect(types).toContain('hero.path.created');
    expect(types).toContain('hero.ability.used');
    // The generic route cools down under the LEGACY key, so the legacy action
    // cannot be used to double-fire the same effect…
    expect(heroOf(r.state, 'p1')?.cooldowns.path).toBeGreaterThan(0);
    expect(
      errCode(kernel.applyAction(r.state, act('hero.path.create', 'p1', { to: 'B' }, 2), ctx(HOUR))),
    ).toBe('E_COOLDOWN');
    // …and vice versa: a legacy cast blocks the generic route.
    const viaLegacy = okApply(
      kernel.applyAction(abilityWorld(), act('hero.path.create', 'p1', { to: 'C' }), ctx(0)),
    );
    expect(errCode(kernel.applyAction(viaLegacy.state, cast('corridor', 'B', 2), ctx(HOUR)))).toBe(
      'E_COOLDOWN',
    );
  });

  it('tunes the lane from ability params and never treats an omitted range as unlimited', () => {
    // `warp` overrides durationHours/speedBonus via params — the "balance = edit
    // numbers" seam. Cast at t=0 with timeScale 1: expiry = 2h, bonus = +25%.
    const r = okApply(kernel.applyAction(abilityWorld(), cast('warp', 'C'), ctx(0)));
    const lane = r.state.tempLanes?.[0];
    expect(lane?.speedBonus).toBe(0.25);
    expect(lane?.expiresAt).toBe(2 * HOUR);
    // No `range` in the catalog entry ⇒ the ENGINE constant (600), not infinity:
    // F sits at 700 and must stay unreachable (fail-secure fallback).
    expect(errCode(kernel.applyAction(abilityWorld(), cast('warp', 'F'), ctx(0)))).toBe(
      'E_OUT_OF_RANGE',
    );
  });

  it('casts annihilate from data, enforcing the data-driven range', () => {
    const r = okApply(kernel.applyAction(abilityWorld(), cast('annihilate', 'C'), ctx(0)));
    expect(r.state.planets.C?.kind).toBe('dead_world');
    expect(r.state.planets.C?.owner).toBeNull();
    // F sits at 700 > the catalog range 500.
    expect(errCode(kernel.applyAction(abilityWorld(), cast('annihilate', 'F'), ctx(0)))).toBe(
      'E_OUT_OF_RANGE',
    );
  });

  it('charges the ability cost only when the effect succeeds', () => {
    // `burst` costs 50 metal but its type is unwired → E_NO_EFFECT, and the
    // rejection discards the whole draft: nothing is charged.
    const st = abilityWorld();
    expect(errCode(kernel.applyAction(st, cast('burst'), ctx(0)))).toBe('E_NO_EFFECT');
    expect(st.players.p1?.resources.metal).toBe(60);
    // Too poor → E_INSUFFICIENT before any dispatch.
    const poor = abilityWorld();
    poor.players.p1!.resources = { metal: 10 };
    expect(errCode(kernel.applyAction(poor, cast('burst'), ctx(0)))).toBe('E_INSUFFICIENT');
  });

  it('dispatches an exotic type through the `hero.effect.<type>` capability', () => {
    const burstModule: GameModule = {
      id: 'test-burst',
      version: '1.0.0',
      setup(api) {
        const effect: HeroEffect = (args, h) => {
          h.state.players[args.owner]!.resources.burstMark = args.target ? 2 : 1;
        };
        api.provideCapability('hero.effect.test_burst', effect);
      },
    };
    const withBurst = createKernel([heroModule, burstModule]);
    const r = okApply(withBurst.applyAction(abilityWorld(), cast('burst'), ctx(0)));
    expect(r.state.players.p1?.resources.burstMark).toBe(1); // the capability ran
    expect(r.state.players.p1?.resources.metal).toBe(10); // 60 − 50 cost
    // Custom types cool down per effect TYPE (fx: ledger) — two catalog ids sharing
    // one hero.effect.<x> cannot be interleaved to double-fire.
    expect(heroOf(r.state, 'p1')?.cooldowns['fx:test_burst']).toBeGreaterThan(0);
    expect(r.events.map((e) => e.type)).toContain('hero.ability.used');
    // Second cast while cooling down → E_COOLDOWN even with a full purse.
    const rich = { ...r.state, players: { ...r.state.players, p1: { ...r.state.players.p1!, resources: { metal: 999 } } } };
    expect(errCode(withBurst.applyAction(rich, cast('burst', undefined, 2), ctx(HOUR)))).toBe(
      'E_COOLDOWN',
    );
    // A range-0 (untargeted) ability still FORWARDS a supplied target to the effect.
    const targeted = okApply(withBurst.applyAction(abilityWorld(), cast('burst', 'C'), ctx(0)));
    expect(targeted.state.players.p1?.resources.burstMark).toBe(2);
  });

  it('fail-secure gates: unknown / unequipped / foreign / dead / bad payload', () => {
    const st = abilityWorld();
    expect(errCode(kernel.applyAction(st, cast('nope'), ctx(0)))).toBe('E_NO_ABILITY');
    // world()'s hero carries no abilities list at all → nothing is equipped.
    expect(
      errCode(
        kernel.applyAction(world(), act('hero.ability', 'p1', { heroId: HERO_ID, abilityId: 'corridor', target: 'C' }), ctx(0)),
      ),
    ).toBe('E_NOT_EQUIPPED');
    expect(
      errCode(
        kernel.applyAction(st, act('hero.ability', 'p2', { heroId: HERO_ID, abilityId: 'corridor', target: 'C' }), ctx(0)),
      ),
    ).toBe('E_FORBIDDEN');
    const dead = abilityWorld();
    dead.heroes![HERO_ID]!.alive = false;
    expect(errCode(kernel.applyAction(dead, cast('corridor', 'C'), ctx(0)))).toBe('E_HERO_DEAD');
    // …and the legacy sibling actions honor the SAME liveness gate — a dead hero
    // cannot act through any route (review finding: gate must not be bypassable).
    expect(
      errCode(kernel.applyAction(dead, act('hero.path.create', 'p1', { to: 'C' }), ctx(0))),
    ).toBe('E_HERO_DEAD');
    expect(
      errCode(kernel.applyAction(dead, act('planet.annihilate', 'p1', { planetId: 'C' }), ctx(0))),
    ).toBe('E_HERO_DEAD');
    expect(errCode(kernel.applyAction(dead, act('hero.move', 'p1', { to: 'B' }), ctx(0)))).toBe(
      'E_HERO_DEAD',
    );
    expect(
      errCode(kernel.applyAction(st, act('hero.ability', 'p1', { heroId: HERO_ID }), ctx(0))),
    ).toBe('E_BAD_PAYLOAD');
    // Ranged ability without a target is malformed, not a crash.
    expect(errCode(kernel.applyAction(st, cast('corridor'), ctx(0)))).toBe('E_BAD_PAYLOAD');
  });

  it('does not mutate the input state', () => {
    const st = deepFreeze(abilityWorld());
    const r = okApply(kernel.applyAction(st, cast('corridor', 'C'), ctx(0)));
    expect(r.state).not.toBe(st);
    expect(st.tempLanes ?? []).toHaveLength(0);
  });
});

describe('hero — ship-borne position and death (HERO-2)', () => {
  const HERO_ID = 'hero:p1';
  // Fixture: replay movement/combat signals with an explicit payload.
  const signalModule: GameModule = {
    id: 'test-signal',
    version: '1.0.0',
    setup(api) {
      api.onAction('signal', (a, h) => {
        const { type, payload } = a.payload as { type: string; payload: unknown };
        h.emit(type, payload);
      });
    },
  };
  const kernel = createKernel([heroModule, signalModule]);

  /** world() + the hero commands a one-ship fleet parked at C (400,0); home = A. */
  function shipWorld(): GameState {
    const st = world();
    st.fleets.hf = {
      id: 'hf',
      owner: 'p1',
      location: 'C',
      movement: null,
      units: [{ unit: 'hero', count: 1 }],
      traits: [],
    };
    const hero = st.heroes![HERO_ID]!;
    hero.fleetId = 'hf';
    hero.home = 'A';
    hero.abilities = ['annihilate'];
    return st;
  }

  it('abilities act from the SHIP node, not the stale hero.location', () => {
    // F sits at 700: unreachable from the hero's recorded node A (700 > 500), but the
    // ship is parked at C (400,0) → C→F = 300 ≤ 500. The cast must succeed.
    const r = okApply(
      kernel.applyAction(
        shipWorld(),
        act('hero.ability', 'p1', { heroId: HERO_ID, abilityId: 'annihilate', target: 'F' }),
        ctx(0),
      ),
    );
    expect(r.state.planets.F?.kind).toBe('dead_world');
    // The legacy route measures from the ship too (same heroNode origin).
    const viaLegacy = okApply(
      kernel.applyAction(shipWorld(), act('planet.annihilate', 'p1', { planetId: 'F' }), ctx(0)),
    );
    expect(viaLegacy.state.planets.F?.kind).toBe('dead_world');
  });

  it('rejects the teleport-style hero.move while the hero is deployed on a ship', () => {
    expect(errCode(kernel.applyAction(shipWorld(), act('hero.move', 'p1', { to: 'B' }), ctx(0)))).toBe(
      'E_HERO_DEPLOYED',
    );
    // The shipless legacy hero still redeploys (unchanged behavior).
    const r = okApply(kernel.applyAction(world(), act('hero.move', 'p1', { to: 'B' }), ctx(0)));
    expect(heroOf(r.state, 'p1')?.location).toBe('B');
  });

  it("hero.location trails the ship on transit and arrival", () => {
    const viaTransit = okApply(
      kernel.applyAction(
        shipWorld(),
        act('signal', 'p1', { type: 'fleet.transit', payload: { fleetId: 'hf', at: 'B' } }),
        ctx(0),
      ),
    );
    expect(viaTransit.state.heroes?.[HERO_ID]?.location).toBe('B');
    const viaArrival = okApply(
      kernel.applyAction(
        shipWorld(),
        act('signal', 'p1', { type: 'fleet.arrived', payload: { fleetId: 'hf', at: 'F' } }),
        ctx(0),
      ),
    );
    expect(viaArrival.state.heroes?.[HERO_ID]?.location).toBe('F');
    // An unknown node or a foreign fleet changes nothing (graceful).
    const noop = okApply(
      kernel.applyAction(
        shipWorld(),
        act('signal', 'p1', { type: 'fleet.arrived', payload: { fleetId: 'other', at: 'B' } }),
        ctx(0),
      ),
    );
    expect(noop.state.heroes?.[HERO_ID]?.location).toBe('A');
  });

  it('fleet.destroyed kills the commanding hero once and the respawn still lands at home', () => {
    const dead = okApply(
      kernel.applyAction(
        shipWorld(),
        act('signal', 'p1', { type: 'fleet.destroyed', payload: { fleetId: 'hf', owner: 'p1' } }),
        ctx(0),
      ),
    );
    const hero = dead.state.heroes?.[HERO_ID];
    expect(hero?.alive).toBe(false);
    expect(hero?.fleetId).toBeUndefined();
    expect(dead.events.map((e) => e.type)).toContain('hero.died');
    // A duplicate signal (unit.died already consumed the death) stays silent.
    const dup = okApply(
      kernel.applyAction(
        dead.state,
        act('signal', 'p1', { type: 'fleet.destroyed', payload: { fleetId: 'hf', owner: 'p1' } }, 2),
        ctx(1),
      ),
    );
    expect(dup.events.map((e) => e.type)).not.toContain('hero.died');
    // 24h later the hero re-forms at its capital A with a fresh ship.
    const reborn = okAdvance(kernel.advanceTo(dead.state, ctx(24 * HOUR + 1)));
    const revived = reborn.state.heroes?.[HERO_ID];
    expect(revived?.alive).toBe(true);
    expect(revived?.location).toBe('A');
    expect(revived?.fleetId).toBeDefined();
    expect(reborn.state.fleets[revived!.fleetId!]?.location).toBe('A');
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

describe('hero — manual spawn (HERO-3)', () => {
  const kernel = createKernel([heroModule]);
  const SECOND = 'hero:p1:2';

  /** world() + a second, undeployed roster hero for p1. */
  function rosterWorld(): GameState {
    const st = world();
    st.heroes![SECOND] = { id: SECOND, owner: 'p1', location: 'A', cooldowns: {} };
    return st;
  }
  const spawn = (heroId: string, at: string, playerId = 'p1', seq = 1) =>
    act('hero.spawn', playerId, { heroId, at }, seq);

  it('raises the ship of an undeployed hero at an owned world', () => {
    const r = okApply(kernel.applyAction(rosterWorld(), spawn(SECOND, 'B'), ctx(0)));
    const hero = r.state.heroes![SECOND]!;
    expect(hero.alive).toBe(true);
    expect(hero.location).toBe('B');
    const ship = r.state.fleets[hero.fleetId!]!;
    expect(ship.location).toBe('B');
    expect(ship.owner).toBe('p1');
    expect(ship.units).toEqual([{ unit: 'hero', count: 1 }]); // default projection hull
    expect(r.events.map((e) => e.type)).toContain('hero.spawned');
  });

  it("resolves the ship's hull from the hero's archetype (data-driven)", () => {
    const st = rosterWorld();
    st.heroes![SECOND]!.archetype = 'raider'; // data.heroes.raider.ship.unit = warship
    const r = okApply(kernel.applyAction(st, spawn(SECOND, 'A'), ctx(0)));
    const hero = r.state.heroes![SECOND]!;
    expect(r.state.fleets[hero.fleetId!]?.units).toEqual([{ unit: 'warship', count: 1 }]);
  });

  it('is the rescue path: a homeless-dead hero spawns manually once the cooldown passes', () => {
    const st = rosterWorld();
    Object.assign(st.heroes![SECOND]!, { alive: false, cooldowns: { respawn: 10 * HOUR } });
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'A'), ctx(0)))).toBe(
      'E_RESPAWN_COOLDOWN',
    );
    const rescued = okApply(kernel.applyAction(st, spawn(SECOND, 'A'), ctx(10 * HOUR)));
    expect(rescued.state.heroes![SECOND]!.alive).toBe(true);
  });

  it('fail-secure gates: alive / foreign / unknown / spawn legality / payload', () => {
    const st = rosterWorld();
    const deployed = okApply(kernel.applyAction(st, spawn(SECOND, 'A'), ctx(0)));
    expect(errCode(kernel.applyAction(deployed.state, spawn(SECOND, 'B', 'p1', 2), ctx(1)))).toBe(
      'E_HERO_ALIVE',
    );
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'A', 'p2'), ctx(0)))).toBe('E_FORBIDDEN');
    expect(errCode(kernel.applyAction(st, spawn('nobody', 'A'), ctx(0)))).toBe('E_NO_HERO');
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'ZZ'), ctx(0)))).toBe('E_NO_PLANET');
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'C'), ctx(0)))).toBe('E_BAD_SPAWN'); // p2's world
    expect(
      errCode(kernel.applyAction(st, act('hero.spawn', 'p1', { heroId: SECOND }), ctx(0))),
    ).toBe('E_BAD_PAYLOAD');
  });

  it('HERO-8: the spawn_fleet marker lets the hero board an OWN fleet (and only an own one)', () => {
    const st = rosterWorld();
    st.fleets.raid = fleet('raid', 'p1', 'C'); // scout ×1, parked at p2's C
    st.fleets.foe = fleet('foe', 'p2', 'C');
    // Without the marker a fleet target is not a legal spawn class.
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'raid'), ctx(0)))).toBe('E_BAD_SPAWN');
    // With it the hero forms ABOARD: its ship joins the host's stack, the hero
    // commands the host, and heroNode now reads the host's node.
    st.heroes![SECOND]!.abilities = ['boarding'];
    const r = okApply(kernel.applyAction(st, spawn(SECOND, 'raid'), ctx(0)));
    const hero = r.state.heroes![SECOND]!;
    expect(hero.fleetId).toBe('raid');
    expect(hero.location).toBe('C');
    expect(r.state.fleets.raid?.units).toEqual([
      { unit: 'scout', count: 1 },
      { unit: 'hero', count: 1 },
    ]);
    expect(r.events.some((e) => e.type === 'hero.spawned' && (e.payload as { aboard?: boolean }).aboard)).toBe(true);
    // A foreign fleet stays off-limits even with the marker; an unknown id is E_NO_PLANET.
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'foe'), ctx(0)))).toBe('E_BAD_SPAWN');
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'nowhere'), ctx(0)))).toBe('E_NO_PLANET');
  });

  it('HERO-8: the spawn_allied marker opens ALLIED worlds — not neutral, not at-war', () => {
    const st = rosterWorld();
    st.heroes![SECOND]!.abilities = ['landing'];
    // C belongs to p2; default stance is war → still E_BAD_SPAWN.
    expect(errCode(kernel.applyAction(st, spawn(SECOND, 'C'), ctx(0)))).toBe('E_BAD_SPAWN');
    // A committed alliance makes it a legal pad.
    const allied = rosterWorld();
    allied.heroes![SECOND]!.abilities = ['landing'];
    allied.diplomacy = { 'p1|p2': 'alliance' };
    const r = okApply(kernel.applyAction(allied, spawn(SECOND, 'C'), ctx(0)));
    expect(r.state.heroes![SECOND]!.location).toBe('C');
    expect(r.state.fleets[r.state.heroes![SECOND]!.fleetId!]?.location).toBe('C');
    // Without the marker the alliance alone is not enough.
    const bare = rosterWorld();
    bare.diplomacy = { 'p1|p2': 'alliance' };
    expect(errCode(kernel.applyAction(bare, spawn(SECOND, 'C'), ctx(0)))).toBe('E_BAD_SPAWN');
  });

  it('enforces the active cap of 3 — for the manual spawn AND the auto-respawn', () => {
    const signal: GameModule = {
      id: 'test-signal-spawn',
      version: '1.0.0',
      setup(api) {
        api.onAction('signal', (a, h) => {
          const { type, payload } = a.payload as { type: string; payload: unknown };
          h.emit(type, payload);
        });
      },
    };
    const withSignal = createKernel([heroModule, signal]);
    const st = rosterWorld();
    // Three heroes already command live ships…
    for (let i = 1; i <= 3; i++) {
      st.fleets[`s${i}`] = fleet(`s${i}`, 'p1', 'A');
      st.heroes![`cap:${i}`] = { id: `cap:${i}`, owner: 'p1', location: 'A', cooldowns: {}, fleetId: `s${i}` };
    }
    // …so the fourth cannot deploy.
    expect(errCode(withSignal.applyAction(st, spawn(SECOND, 'A'), ctx(0)))).toBe('E_HERO_CAP');
    // The scheduled auto-respawn is held by the same cap: the dead hero stays dead.
    st.heroes![SECOND]!.alive = false;
    const held = okApply(
      withSignal.applyAction(
        st,
        act('signal', 'p1', { type: 'hero.respawn', payload: { heroId: SECOND } }),
        ctx(0),
      ),
    );
    expect(held.state.heroes![SECOND]!.alive).toBe(false);
    // Freeing a slot lets the manual spawn through.
    delete held.state.fleets.s3;
    const freed = okApply(withSignal.applyAction(held.state, spawn(SECOND, 'A', 'p1', 2), ctx(1)));
    expect(freed.state.heroes![SECOND]!.alive).toBe(true);
  });
});

describe('hero — skill tree (HERO-7)', () => {
  const kernel = createKernel([heroModule]);
  const HERO_ID = 'hero:p1';

  /** world() + the hero is a transhuman raider with a treasury. */
  function skillWorld(): GameState {
    const st = world();
    st.heroes![HERO_ID]!.archetype = 'raider'; // branch: transhuman
    st.players.p1!.resources = { metal: 50 };
    return st;
  }
  const unlock = (node: string, playerId = 'p1', seq = 1) =>
    act('hero.skill.unlock', playerId, { heroId: HERO_ID, node }, seq);

  it('unlocks a chain: grants land on the instance and feed the HERO-4/5 engines', () => {
    const root = okApply(kernel.applyAction(skillWorld(), unlock('neural_lace'), ctx(0)));
    const hero1 = root.state.heroes![HERO_ID]!;
    expect(hero1.skills).toEqual(['neural_lace']);
    expect(hero1.passives).toContain('swift'); // granted passive, HERO-5 picks it up
    expect(root.events.map((e) => e.type)).toContain('hero.skill.unlocked');
    // The child costs 40 metal and grants the `burst` ability.
    const child = okApply(kernel.applyAction(root.state, unlock('overclock', 'p1', 2), ctx(1)));
    const hero2 = child.state.heroes![HERO_ID]!;
    expect(hero2.skills).toEqual(['neural_lace', 'overclock']);
    expect(hero2.abilities).toContain('burst');
    expect(child.state.players.p1?.resources.metal).toBe(10); // 50 − 40
    // The granted ability passes the HERO-4 equipment gate: casting `burst` now fails
    // on the unwired effect type (E_NO_EFFECT), NOT on E_NOT_EQUIPPED.
    expect(
      errCode(
        kernel.applyAction(
          child.state,
          act('hero.ability', 'p1', { heroId: HERO_ID, abilityId: 'burst' }, 3),
          ctx(2),
        ),
      ),
    ).toBe('E_INSUFFICIENT'); // burst costs 50 metal, purse is 10 — equipment gate passed
  });

  it('fail-secure gates: requires / branch / funds / duplicates / unknown / dead / foreign', () => {
    const st = skillWorld();
    expect(errCode(kernel.applyAction(st, unlock('overclock'), ctx(0)))).toBe('E_REQUIRES');
    expect(errCode(kernel.applyAction(st, unlock('void_gift'), ctx(0)))).toBe('E_WRONG_BRANCH');
    expect(errCode(kernel.applyAction(st, unlock('nothing'), ctx(0)))).toBe('E_NO_NODE');
    expect(errCode(kernel.applyAction(st, unlock('neural_lace', 'p2'), ctx(0)))).toBe(
      'E_FORBIDDEN', // p2 tries to skill up p1's hero
    );
    expect(
      errCode(
        kernel.applyAction(
          st,
          act('hero.skill.unlock', 'p1', { heroId: 'nobody', node: 'neural_lace' }),
          ctx(0),
        ),
      ),
    ).toBe('E_NO_HERO');
    const poor = skillWorld();
    poor.players.p1!.resources = {};
    poor.heroes![HERO_ID]!.skills = ['neural_lace'];
    expect(errCode(kernel.applyAction(poor, unlock('overclock'), ctx(0)))).toBe('E_INSUFFICIENT');
    const done = skillWorld();
    done.heroes![HERO_ID]!.skills = ['neural_lace'];
    expect(errCode(kernel.applyAction(done, unlock('neural_lace'), ctx(0)))).toBe(
      'E_ALREADY_UNLOCKED',
    );
    const dead = skillWorld();
    dead.heroes![HERO_ID]!.alive = false;
    expect(errCode(kernel.applyAction(dead, unlock('neural_lace'), ctx(0)))).toBe('E_HERO_DEAD');
  });

  it('dedupes a grant the hero already carries and requires ALL parents of a fan-in node', () => {
    // The hero already carries `burst` (seeded) and has the root unlocked.
    const st = skillWorld();
    Object.assign(st.heroes![HERO_ID]!, { skills: ['neural_lace'], abilities: ['burst'] });
    const r = okApply(kernel.applyAction(st, unlock('overclock'), ctx(0)));
    const hero = r.state.heroes![HERO_ID]!;
    expect(hero.abilities?.filter((a) => a === 'burst')).toHaveLength(1); // no duplicate
    // `synthesis` needs BOTH parents: one of two unlocked → E_REQUIRES, and the
    // rejected unlock leaves the treasury untouched.
    expect(errCode(kernel.applyAction(st, unlock('synthesis'), ctx(0)))).toBe('E_REQUIRES');
    expect(st.players.p1?.resources.metal).toBe(50); // cost charged only on success
    // With both parents in place the fan-in node opens.
    const both = okApply(kernel.applyAction(r.state, unlock('synthesis', 'p1', 2), ctx(1)));
    expect(both.state.heroes![HERO_ID]!.skills).toContain('synthesis');
  });

  it('a branchless hero takes only common nodes; an archetype-less hero is branchless', () => {
    // No archetype ⇒ no branch ⇒ branch nodes are closed…
    const st = world();
    expect(
      errCode(
        kernel.applyAction(st, act('hero.skill.unlock', 'p1', { heroId: HERO_ID, node: 'neural_lace' }), ctx(0)),
      ),
    ).toBe('E_WRONG_BRANCH');
    // …but a common (branch-free) node is open to everyone.
    const r = okApply(
      kernel.applyAction(st, act('hero.skill.unlock', 'p1', { heroId: HERO_ID, node: 'common_core' }), ctx(0)),
    );
    expect(r.state.heroes![HERO_ID]!.skills).toEqual(['common_core']);
  });
});

describe('hero — ship fittings (HERO-6)', () => {
  const kernel = createKernel([heroModule]);
  const HERO_ID = 'hero:p1';

  /** world() + the hero is a raider (2 fitting slots) with a treasury. */
  function fitWorld(): GameState {
    const st = world();
    st.heroes![HERO_ID]!.archetype = 'raider';
    st.players.p1!.resources = { metal: 25 };
    return st;
  }
  const fit = (fitting: string, playerId = 'p1', seq = 1) =>
    act('hero.fit', playerId, { heroId: HERO_ID, fitting }, seq);

  it('installs a fitting: cost charged, grant lands, the loadout is live', () => {
    const r = okApply(kernel.applyAction(fitWorld(), fit('psi_lens'), ctx(0)));
    const hero = r.state.heroes![HERO_ID]!;
    expect(hero.fittings).toEqual(['psi_lens']);
    expect(hero.abilities).toContain('burst'); // granted, HERO-4 equipment gate passes
    expect(r.state.players.p1?.resources.metal).toBe(5); // 25 − 20
    expect(r.events.map((e) => e.type)).toContain('hero.fitted');
    // A statMods-only fitting installs cleanly too (data for the SHIP-3 seam).
    const plated = okApply(kernel.applyAction(r.state, fit('plating', 'p1', 2), ctx(1)));
    expect(plated.state.heroes![HERO_ID]!.fittings).toEqual(['psi_lens', 'plating']);
  });

  it('enforces the slot budget, uniqueness and the fail-secure gate set', () => {
    // Two slots filled → the third fitting has nowhere to go.
    const st = fitWorld();
    st.heroes![HERO_ID]!.fittings = ['plating', 'war_drum'];
    expect(errCode(kernel.applyAction(st, fit('psi_lens'), ctx(0)))).toBe('E_NO_SLOTS');
    // The same fitting cannot be doubled.
    const one = fitWorld();
    one.heroes![HERO_ID]!.fittings = ['psi_lens'];
    expect(errCode(kernel.applyAction(one, fit('psi_lens'), ctx(0)))).toBe('E_ALREADY_FITTED');
    // An archetype-less hero exposes no slots at all.
    const bare = world();
    expect(
      errCode(kernel.applyAction(bare, act('hero.fit', 'p1', { heroId: HERO_ID, fitting: 'war_drum' }), ctx(0))),
    ).toBe('E_NO_SLOTS');
    // Unknown fitting / poor purse / dead hero / foreign hero.
    expect(errCode(kernel.applyAction(fitWorld(), fit('warp_core'), ctx(0)))).toBe('E_NO_FITTING');
    const poor = fitWorld();
    poor.players.p1!.resources = { metal: 5 };
    expect(errCode(kernel.applyAction(poor, fit('psi_lens'), ctx(0)))).toBe('E_INSUFFICIENT');
    expect(poor.players.p1?.resources.metal).toBe(5); // nothing charged on rejection
    const dead = fitWorld();
    dead.heroes![HERO_ID]!.alive = false;
    expect(errCode(kernel.applyAction(dead, fit('war_drum'), ctx(0)))).toBe('E_HERO_DEAD');
    expect(errCode(kernel.applyAction(fitWorld(), fit('war_drum', 'p2'), ctx(0)))).toBe(
      'E_FORBIDDEN',
    );
  });
});

describe('hero — data-driven passives (HERO-5)', () => {
  it('heroFleet scope: +10% speed for the ship the hero commands, nobody else', () => {
    const kernel = createKernel([heroModule, movementModule]);
    const st = world();
    st.fleets = { F1: fleet('F1', 'p1', 'A'), E1: fleet('E1', 'p2', 'A') };
    const hero = st.heroes!['hero:p1']!;
    hero.fleetId = 'F1';
    hero.passives = ['swift'];
    // Hero's own fleet: 30 units at speed 10 × 1.1 = 11.
    const own = okApply(kernel.applyAction(st, act('fleet.move', 'p1', { fleetId: 'F1', to: 'B' }), ctx(0)));
    expect(own.state.fleets.F1?.movement?.arrivesAt).toBeCloseTo((30 / 11) * HOUR, 0);
    // A foreign fleet on the same leg is untouched: 30 / 10.
    const foe = okApply(kernel.applyAction(st, act('fleet.move', 'p2', { fleetId: 'E1', to: 'B' }), ctx(0)));
    expect(foe.state.fleets.E1?.movement?.arrivesAt).toBeCloseTo(3 * HOUR, 0);
    // A dead hero projects nothing.
    const dead = world();
    dead.fleets = { F1: fleet('F1', 'p1', 'A') };
    Object.assign(dead.heroes!['hero:p1']!, { fleetId: 'F1', passives: ['swift'], alive: false });
    const idle = okApply(kernel.applyAction(dead, act('fleet.move', 'p1', { fleetId: 'F1', to: 'B' }), ctx(0)));
    expect(idle.state.fleets.F1?.movement?.arrivesAt).toBeCloseTo(3 * HOUR, 0);
  });

  it('ownFleetsNear scope: boosts owner fleets within radius of the hero, not beyond', () => {
    const kernel = createKernel([heroModule, movementModule]);
    const st = world();
    st.fleets = { F1: fleet('F1', 'p1', 'A'), F2: fleet('F2', 'p1', 'B') };
    st.heroes!['hero:p1']!.passives = ['herald']; // +20% within 10 units of the hero (at A)
    // F1 departs from A (distance 0 ≤ 10): 30 / 12 = 2.5h.
    const near = okApply(kernel.applyAction(st, act('fleet.move', 'p1', { fleetId: 'F1', to: 'B' }), ctx(0)));
    expect(near.state.fleets.F1?.movement?.arrivesAt).toBeCloseTo(2.5 * HOUR, 0);
    // F2 departs from B (distance 30 > 10): plain 3h.
    const far = okApply(kernel.applyAction(st, act('fleet.move', 'p1', { fleetId: 'F2', to: 'A' }), ctx(0)));
    expect(far.state.fleets.F2?.movement?.arrivesAt).toBeCloseTo(3 * HOUR, 0);
    // An unknown passive id is skipped gracefully (no crash, no effect).
    const odd = world();
    odd.fleets = { F1: fleet('F1', 'p1', 'A') };
    odd.heroes!['hero:p1']!.passives = ['no_such_passive'];
    const plain = okApply(kernel.applyAction(odd, act('fleet.move', 'p1', { fleetId: 'F1', to: 'B' }), ctx(0)));
    expect(plain.state.fleets.F1?.movement?.arrivesAt).toBeCloseTo(3 * HOUR, 0);
  });

  it('ownFleetsNear combat: a battle near the hero hits harder, a distant one does not', () => {
    const kernel = createKernel([heroModule, combatModule, arriveModule]);
    const base = (heroAt: string): GameState => {
      const s = createInitialState({ seed: 'passive', version: { data: '0.1.0', manifest: '1' } });
      return {
        ...s,
        players: { p1: player('p1'), p2: player('p2') },
        planets: {
          P: planet('P', null, 0, 0, [], 'planet'),
          H: planet('H', 'p1', 200, 0, [], 'planet'), // 200 ≤ warcry radius 300
          X: planet('X', 'p1', 700, 0, [], 'planet'), // 700 > 300
        },
        fleets: {
          A: { id: 'A', owner: 'p1', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }] },
          D: { id: 'D', owner: 'p2', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }] },
        },
        heroes: {
          'hero:p1': { id: 'hero:p1', owner: 'p1', location: heroAt, cooldowns: {}, passives: ['warcry'], alive: true },
        },
      };
    };
    const round = (st: GameState) => {
      const started = okApply(kernel.applyAction(st, act('arrive', 'p1', { fleetId: 'A' }), ctx(0)));
      const r = okAdvance(kernel.advanceTo(started.state, ctx(HOUR)));
      return r.events.find((e) => e.type === 'combat.round')?.payload as {
        dmgToDefender: number;
        dmgToAttacker: number;
      };
    };
    // Hero at H (200 away): p1's side deals 20 × 1.5 = 30; p2's side stays 20.
    const near = round(base('H'));
    expect(near.dmgToDefender).toBe(30);
    expect(near.dmgToAttacker).toBe(20);
    // Hero at X (700 away): out of radius — both sides plain 20.
    const far = round(base('X'));
    expect(far.dmgToDefender).toBe(20);
    expect(far.dmgToAttacker).toBe(20);
    // BF-24: the SAME hero as an undeployed reserve (alive undefined) radiates
    // nothing, even in radius — no invulnerable bench buffer.
    const benched = base('H');
    delete benched.heroes!['hero:p1']!.alive;
    const res = round(benched);
    expect(res.dmgToDefender).toBe(20);
    expect(res.dmgToAttacker).toBe(20);
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
