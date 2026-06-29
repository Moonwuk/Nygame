import { describe, it, expect } from 'vitest';
import {
  heroLoadoutInfo,
  HERO_ABILITIES,
  HERO_ABILITY_IDS,
  HERO_SLOTS,
  HERO_ROSTER_COUNT,
  DEFAULT_HEROES,
  type HeroLoadout,
} from './heroes';

const load = (abilities: (string | null)[]): HeroLoadout => ({ name: 'h', abilities });

describe('hero roster model — loadout = ability slots ("modules") + base aura', () => {
  it('resolves filled slots to abilities in order and counts them', () => {
    const info = heroLoadoutInfo(load(['corridor', 'annihilate']));
    expect(info.count).toBe(2);
    expect(info.abilities.map((a) => a.id)).toEqual(['corridor', 'annihilate']);
  });

  it('skips empty / unknown slots (graceful)', () => {
    const info = heroLoadoutInfo(load(['corridor', null]));
    expect(info.count).toBe(1);
    expect(heroLoadoutInfo(load(['nope', null])).count).toBe(0);
  });

  it('flags abilities not yet wired in the engine as planned ("скоро")', () => {
    // corridor + annihilate are live; scan is planned.
    expect(heroLoadoutInfo(load(['corridor', 'annihilate'])).planned).toBe(0);
    expect(heroLoadoutInfo(load(['corridor', 'scan'])).planned).toBe(1);
  });

  it('the live abilities are exactly the ones the core heroModule already implements', () => {
    const live = HERO_ABILITY_IDS.filter((id) => HERO_ABILITIES[id]!.live).sort();
    expect(live).toEqual(['annihilate', 'corridor']);
  });

  it('every default hero has HERO_SLOTS slots holding valid pool ids, roster of 3', () => {
    expect(DEFAULT_HEROES).toHaveLength(HERO_ROSTER_COUNT);
    for (const h of DEFAULT_HEROES) {
      expect(h.abilities).toHaveLength(HERO_SLOTS);
      for (const id of h.abilities) {
        if (id !== null) expect(HERO_ABILITIES[id]).toBeDefined();
      }
      expect(heroLoadoutInfo(h).count).toBe(HERO_SLOTS); // defaults are fully filled
    }
  });

  it('every ability in the pool carries complete, displayable metadata', () => {
    for (const id of HERO_ABILITY_IDS) {
      const a = HERO_ABILITIES[id]!;
      expect(a.id).toBe(id);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.icon.length).toBeGreaterThan(0);
      expect(a.desc.length).toBeGreaterThan(0);
      expect(a.cooldownHours).toBeGreaterThan(0);
    }
  });
});
