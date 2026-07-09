import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import type { GameModule } from '../kernel/module';
import { heroModule } from './hero';
import { heroEffectsModule } from './heroEffects';
import { combatModule } from './combat';
import {
  createInitialState,
  type Battle,
  type Fleet,
  type GameState,
  type Hero,
  type Planet,
  type Player,
} from '../state/gameState';
import { parseGameData, type GameData } from '../data/schemas';
import type { Action, AdvanceResult, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    hero: { faction: 'x', stats: { attack: 0, defense: 0, speed: 5, hp: 120 }, line: 'front', traits: ['hero'] },
    warship: { faction: 'x', stats: { attack: 20, defense: 20, speed: 5, hp: 200 }, line: 'front' },
  },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: { planet: { scoreValue: 50, capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
  heroAbilities: {
    // recall: range-0, untargeted; the 24h cooldown is the whole cost.
    recall: { name: 'Отзыв', type: 'recall', cooldownHours: 24, range: 0 },
    // rally: a time-boxed self-aura — +10% combat.damage to own fleets within 300 for 2h.
    rally: {
      name: 'Сбор',
      type: 'aura',
      cooldownHours: 18,
      range: 0,
      params: { combatBonus: 0.1, durationHours: 2, radius: 300 },
    },
    // a malformed aura (no bonus / no duration) — the provider must reject it.
    dud: { name: 'Dud', type: 'aura', cooldownHours: 5, range: 0, params: {} },
  },
});
const HOUR = 3_600_000;
const ctx = (now: number): Context => ({ now, data });

function player(id: string): Player {
  return { id, name: id, faction: 'x', status: 'active', resources: {} };
}
function planet(id: string, owner: string | null, x: number): Planet {
  return {
    id,
    owner,
    position: { x, y: 0 },
    links: [],
    kind: 'planet',
    planetType: 'terran',
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}
function act(type: string, playerId: string, payload: unknown, seq = 1): Action {
  return { id: `s:${playerId}:${seq}`, type, playerId, payload, issuedAt: 0 };
}
function errCode(r: ApplyResult): string {
  if (r.ok) throw new Error('expected rejection, got ok');
  return r.code;
}
function okApply(r: ApplyResult): ApplyResult & { ok: true } {
  if (!r.ok) throw new Error(`apply failed: ${r.code}`);
  return r;
}
function okAdvance(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`advance failed: ${r.code}`);
  return r;
}
// Trigger a battle: emit fleet.arrived for a fleet parked over a hostile one.
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

describe('heroEffects — recall (the first hero.effect.<type> capability provider)', () => {
  const kernel = createKernel([heroModule, heroEffectsModule]);

  /** HOME(p1) is the hero's capital; FAR(p1) is where its ship is parked. */
  function world(over?: {
    fleet?: Partial<Fleet>;
    hero?: Partial<Hero>;
    battles?: Record<string, Battle>;
  }): GameState {
    const s = createInitialState({ seed: 'fx', version: { data: '0.1.0', manifest: '1' } });
    const f1: Fleet = {
      id: 'f1',
      owner: 'p1',
      location: 'FAR',
      movement: null,
      units: [{ unit: 'hero', count: 1 }],
      traits: [],
      ...over?.fleet,
    };
    const hero: Hero = {
      id: 'hero:p1:1',
      owner: 'p1',
      location: 'FAR',
      home: 'HOME',
      cooldowns: {},
      alive: true,
      fleetId: 'f1',
      abilities: ['recall'],
      ...over?.hero,
    };
    return {
      ...s,
      players: { p1: player('p1') },
      planets: { HOME: planet('HOME', 'p1', 0), FAR: planet('FAR', 'p1', 500) },
      fleets: { f1 },
      heroes: { 'hero:p1:1': hero },
      ...(over?.battles ? { battles: over.battles } : {}),
    };
  }
  const cast = (seq = 1) => act('hero.ability', 'p1', { heroId: 'hero:p1:1', abilityId: 'recall' }, seq);

  it('warps the hero ship home to its capital and follows the node memory', () => {
    const r = okApply(kernel.applyAction(world(), cast(), ctx(0)));
    expect(r.state.fleets.f1?.location).toBe('HOME');
    expect(r.state.fleets.f1?.movement).toBeNull();
    expect(r.state.heroes!['hero:p1:1']?.location).toBe('HOME');
    expect(r.events.map((e) => e.type)).toContain('hero.recalled');
    expect(r.state.heroes!['hero:p1:1']?.cooldowns['fx:recall']).toBeGreaterThan(0);
  });

  it('snaps a mid-flight ship home (clears movement + any parked edge)', () => {
    const flying = world({
      fleet: { location: null, movement: { to: 'HOME', from: 'FAR', departedAt: 0, arrivesAt: HOUR }, edge: { from: 'FAR', to: 'HOME', t: 0.5 } },
    });
    const r = okApply(kernel.applyAction(flying, cast(), ctx(0)));
    expect(r.state.fleets.f1?.location).toBe('HOME');
    expect(r.state.fleets.f1?.movement).toBeNull();
    expect(r.state.fleets.f1?.edge).toBeNull();
  });

  it('cools down: a second recall inside 24h is E_COOLDOWN', () => {
    const r = okApply(kernel.applyAction(world(), cast(1), ctx(0)));
    expect(errCode(kernel.applyAction(r.state, cast(2), ctx(HOUR)))).toBe('E_COOLDOWN');
  });

  it('rejects a reserve (undeployed) hero — nothing to recall', () => {
    const reserve = world({ hero: { alive: undefined, fleetId: undefined } });
    delete reserve.fleets.f1;
    expect(errCode(kernel.applyAction(reserve, cast(), ctx(0)))).toBe('E_HERO_NOT_DEPLOYED');
  });

  it('refuses to warp a ship out of an active battle (E_FLEET_BUSY)', () => {
    const inFight = world({ fleet: { battleId: 'b1' }, battles: { b1: {} as Battle } });
    expect(errCode(kernel.applyAction(inFight, cast(), ctx(0)))).toBe('E_FLEET_BUSY');
  });

  it('rejects when the hero has no capital anchor (E_NO_CAPITAL)', () => {
    const homeless = world({ hero: { home: undefined } });
    expect(errCode(kernel.applyAction(homeless, cast(), ctx(0)))).toBe('E_NO_CAPITAL');
  });

  it('rejects a no-op recall when already parked idle at the capital (E_SAME_LOCATION)', () => {
    const atHome = world({ fleet: { location: 'HOME' }, hero: { location: 'HOME' } });
    expect(errCode(kernel.applyAction(atHome, cast(), ctx(0)))).toBe('E_SAME_LOCATION');
  });

  it('a stale battleId (battle already gone) does NOT block the recall', () => {
    const stale = world({ fleet: { battleId: 'ghost' } });
    const r = okApply(kernel.applyAction(stale, cast(), ctx(0)));
    expect(r.state.fleets.f1?.location).toBe('HOME');
  });
});

describe('heroEffects — aura (rally/bulwark → time-boxed combat.damage)', () => {
  const kernel = createKernel([heroModule, heroEffectsModule]);
  const rally = act('hero.ability', 'p1', { heroId: 'hero:p1:1', abilityId: 'rally' });

  /** A shipless hero at its capital, carrying rally (aura fires from `Hero.location`). */
  function auraWorld(): GameState {
    const s = createInitialState({ seed: 'aura', version: { data: '0.1.0', manifest: '1' } });
    return {
      ...s,
      players: { p1: player('p1') },
      planets: { HOME: planet('HOME', 'p1', 0) },
      heroes: {
        'hero:p1:1': { id: 'hero:p1:1', owner: 'p1', location: 'HOME', home: 'HOME', cooldowns: {}, alive: true, abilities: ['rally'] },
      },
    };
  }

  it('casting rally stores a live aura on the hero + starts the fx:aura cooldown', () => {
    const r = okApply(kernel.applyAction(auraWorld(), rally, ctx(0)));
    const auras = r.state.heroes!['hero:p1:1']?.activeAuras;
    expect(auras).toEqual([{ bonus: 0.1, radius: 300, until: 2 * HOUR }]);
    expect(r.state.heroes!['hero:p1:1']?.cooldowns['fx:aura']).toBeGreaterThan(0);
    expect(r.events.map((e) => e.type)).toContain('hero.aura');
  });

  it('rejects a malformed (no-bonus / no-duration) aura, charging nothing', () => {
    const st = auraWorld();
    st.heroes!['hero:p1:1']!.abilities = ['dud'];
    const dud = act('hero.ability', 'p1', { heroId: 'hero:p1:1', abilityId: 'dud' });
    expect(errCode(kernel.applyAction(st, dud, ctx(0)))).toBe('E_BAD_EFFECT');
  });

  it('recasting prunes an expired aura — the list never grows unbounded', () => {
    const st = auraWorld();
    st.heroes!['hero:p1:1']!.activeAuras = [{ bonus: 0.1, radius: 300, until: 1 }]; // long expired
    const r = okApply(kernel.applyAction(st, rally, ctx(HOUR)));
    const auras = r.state.heroes!['hero:p1:1']?.activeAuras;
    expect(auras).toEqual([{ bonus: 0.1, radius: 300, until: HOUR + 2 * HOUR }]); // only the fresh one
  });

  // --- the aura actually reaching combat.damage ------------------------------
  const battleKernel = createKernel([heroModule, heroEffectsModule, combatModule, arriveModule]);
  /** p1's fleet A fights p2's D over P(0,0); the hero sits at `heroAt` with `auras`. */
  function battleBase(heroAt: number, auras: Hero['activeAuras']): GameState {
    const s = createInitialState({ seed: 'ab', version: { data: '0.1.0', manifest: '1' } });
    return {
      ...s,
      players: { p1: player('p1'), p2: player('p2') },
      planets: { P: planet('P', null, 0), H: planet('H', 'p1', heroAt) },
      fleets: {
        A: { id: 'A', owner: 'p1', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }] },
        D: { id: 'D', owner: 'p2', location: 'P', movement: null, traits: [], units: [{ unit: 'warship', count: 1 }] },
      },
      heroes: { 'hero:p1:1': { id: 'hero:p1:1', owner: 'p1', location: 'H', home: 'H', cooldowns: {}, alive: true, abilities: ['rally'], ...(auras ? { activeAuras: auras } : {}) } },
    };
  }
  function round(st: GameState): { dmgToDefender: number; dmgToAttacker: number } {
    const started = okApply(battleKernel.applyAction(st, act('arrive', 'p1', { fleetId: 'A' }), ctx(0)));
    const r = okAdvance(battleKernel.advanceTo(started.state, ctx(HOUR)));
    return r.events.find((e) => e.type === 'combat.round')?.payload as {
      dmgToDefender: number;
      dmgToAttacker: number;
    };
  }
  const LIVE = [{ bonus: 0.1, radius: 300, until: 10 * HOUR }];

  it('a live aura near the hero buffs its fleet damage (×1.1); a distant battle does not', () => {
    const near = round(battleBase(200, LIVE)); // 200 ≤ radius 300
    expect(near.dmgToDefender).toBe(22); // 20 × 1.1 — p1 attacks harder
    expect(near.dmgToAttacker).toBe(20); // p2's return fire unbuffed
    const far = round(battleBase(700, LIVE)); // 700 > 300
    expect(far.dmgToDefender).toBe(20);
    expect(far.dmgToAttacker).toBe(20);
  });

  it('an EXPIRED aura contributes nothing (filtered by `until` at read time)', () => {
    const expired = round(battleBase(200, [{ bonus: 0.1, radius: 300, until: 0 }])); // until ≤ now
    expect(expired.dmgToDefender).toBe(20);
  });
});
