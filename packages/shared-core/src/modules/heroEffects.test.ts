import { describe, it, expect } from 'vitest';
import { createKernel } from '../kernel/kernel';
import { heroModule } from './hero';
import { heroEffectsModule } from './heroEffects';
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
import type { Action, ApplyResult, Context } from '../action/types';

const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['metal'],
  units: {
    hero: { faction: 'x', stats: { attack: 0, defense: 0, speed: 5, hp: 120 }, line: 'front', traits: ['hero'] },
  },
  factions: {},
  buildings: {},
  events: {},
  sectorKinds: { planet: { scoreValue: 50, capturable: true, buildable: true, orbit: true } },
  planetTypes: { terran: { productionBonus: 0, defenseBonus: 0 } },
  heroAbilities: {
    // recall: range-0, untargeted; the 24h cooldown is the whole cost.
    recall: { name: 'Отзыв', type: 'recall', cooldownHours: 24, range: 0 },
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

/** HOME(p1) is the hero's capital; FAR(p1) is where its ship is parked. The hero (with
 *  recall equipped) commands fleet `f1` at FAR. `over` lets a case tweak the seed. */
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

describe('heroEffects — recall (the first hero.effect.<type> capability provider)', () => {
  const kernel = createKernel([heroModule, heroEffectsModule]);

  it('warps the hero ship home to its capital and follows the node memory', () => {
    const r = okApply(kernel.applyAction(world(), cast(), ctx(0)));
    expect(r.state.fleets.f1?.location).toBe('HOME'); // teleported to the capital
    expect(r.state.fleets.f1?.movement).toBeNull();
    expect(r.state.heroes!['hero:p1:1']?.location).toBe('HOME'); // HERO-2 node memory follows
    expect(r.events.map((e) => e.type)).toContain('hero.recalled');
    // range-0 custom type cools down on the `fx:<type>` ledger.
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
    const inFight = world({
      fleet: { battleId: 'b1' },
      battles: { b1: {} as Battle },
    });
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
    const stale = world({ fleet: { battleId: 'ghost' } }); // no such battle in state
    const r = okApply(kernel.applyAction(stale, cast(), ctx(0)));
    expect(r.state.fleets.f1?.location).toBe('HOME');
  });
});
