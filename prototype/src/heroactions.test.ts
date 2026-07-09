import { describe, it, expect } from 'vitest';
import {
  newGame,
  order,
  castHeroAbility,
  spawnHero,
  unlockHeroSkill,
  fitHero,
  data,
} from './game';
import type { GameState, Hero } from '@void/shared-core';

// Integration proof: the CORE hero engine (heroModule HERO-3..9) runs end-to-end against
// the prototype's inline catalogs + seeding. Core edge-cases live in shared-core's own
// hero.test.ts — here we only pin that the prototype wiring reaches each action.

function heroesOf(s: GameState, pid: string): Hero[] {
  return Object.values(s.heroes ?? {}).filter((h) => h.owner === pid);
}
const mainOf = (s: GameState, pid: string): Hero => heroesOf(s, pid).find((h) => h.fleetId)!;
const benched = (s: GameState, pid: string): Hero[] => heroesOf(s, pid).filter((h) => !h.fleetId);

describe('hero actions — the core engine over the prototype catalogs', () => {
  it('hero.spawn raises an undeployed roster hero at an owned world', () => {
    const s = newGame();
    const bench = benched(s, 'p1');
    expect(bench.length).toBeGreaterThan(0);
    const target = bench[0]!;
    const home = target.home!;
    const r = order(s, spawnHero('p1', target.id, home), s.time);
    expect(r.error).toBeUndefined();
    const raised = r.state.heroes![target.id]!;
    expect(raised.alive).toBe(true);
    expect(raised.fleetId).toBeTruthy();
    expect(r.state.fleets[raised.fleetId!]?.units.some((u) => u.unit === 'hero')).toBe(true);
  });

  it('hero.ability casts a built-in (corridor → temp lane) and starts its cooldown', () => {
    const s = newGame();
    const main = mainOf(s, 'p1');
    expect(main.abilities).toContain('corridor');
    const origin = s.planets[s.fleets[main.fleetId!]!.location!]!;
    const near = Object.values(s.planets).find(
      (p) =>
        p.id !== origin.id &&
        Math.hypot(p.position.x - origin.position.x, p.position.y - origin.position.y) <=
          (data.heroAbilities.corridor!.range ?? 0),
    )!;
    const r = order(s, castHeroAbility('p1', main.id, 'corridor', near.id), s.time);
    expect(r.error).toBeUndefined();
    expect((r.state.tempLanes ?? []).length).toBe(1);
    expect(r.state.heroes![main.id]!.cooldowns?.path).toBeGreaterThan(s.time);
  });

  it('hero.ability on a typed-but-unwired effect fails secure (E_NO_EFFECT)', () => {
    const s = newGame();
    const main = mainOf(s, 'p1');
    expect(main.abilities).toContain('rally'); // typed `aura` in data, no engine effect yet
    const origin = s.fleets[main.fleetId!]!.location!;
    const r = order(s, castHeroAbility('p1', main.id, 'rally', origin), s.time);
    expect(r.error).toBe('E_NO_EFFECT');
  });

  it('hero.skill.unlock walks the branch tree and grants the node', () => {
    const s = newGame();
    const main = mainOf(s, 'p1'); // commander → transhuman
    const r1 = order(s, unlockHeroSkill('p1', main.id, 'neural_lace'), s.time);
    expect(r1.error).toBeUndefined();
    const h1 = r1.state.heroes![main.id]!;
    expect(h1.skills).toContain('neural_lace');
    expect(h1.passives).toContain('vanguard_impulse'); // the node's grant landed
    // wrong branch fails secure: a psionic node on a transhuman hero
    expect(order(s, unlockHeroSkill('p1', main.id, 'void_attunement'), s.time).error).toBe(
      'E_WRONG_BRANCH',
    );
  });

  it('hero.fit installs a fitting within the archetype slot budget', () => {
    const s = newGame();
    const main = mainOf(s, 'p1'); // commander: 4 slots
    const r = order(s, fitHero('p1', main.id, 'psi_amplifier'), s.time);
    expect(r.error).toBeUndefined();
    const h = r.state.heroes![main.id]!;
    expect(h.fittings).toContain('psi_amplifier');
    expect(h.abilities).toContain('scan'); // the fitting's ability grant landed
  });

  it('hero.ability recall (hero.effect.recall capability) warps a deployed ship home', () => {
    const s = newGame();
    // the ravager reserve (legendary «Разрушитель») carries recall — raise its ship first
    const rec = benched(s, 'p1').find((h) => (h.abilities ?? []).includes('recall'));
    expect(rec).toBeTruthy();
    const spawned = order(s, spawnHero('p1', rec!.id, rec!.home!), s.time);
    expect(spawned.error).toBeUndefined();
    const hero = spawned.state.heroes![rec!.id]!;
    const fleetId = hero.fleetId!;
    // pretend the ship travelled off to another node, then recall it (range-0, no target)
    const st = structuredClone(spawned.state);
    const away = Object.keys(st.planets).find((p) => p !== hero.home)!;
    st.fleets[fleetId]!.location = away;
    const r = order(st, castHeroAbility('p1', rec!.id, 'recall'), st.time);
    expect(r.error).toBeUndefined();
    expect(r.state.fleets[fleetId]?.location).toBe(hero.home); // warped back to the capital
    expect(r.state.heroes![rec!.id]?.cooldowns?.['fx:recall']).toBeGreaterThan(st.time);
  });
});
