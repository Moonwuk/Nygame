import { describe, it, expect } from 'vitest';
import {
  heroLoadoutInfo,
  heroSlots,
  HERO_GRADES,
  HERO_ABILITIES,
  HERO_ABILITY_IDS,
  HERO_ROSTER_COUNT,
  DEFAULT_HEROES,
  type HeroGrade,
  type HeroLoadout,
} from './heroes';

const load = (grade: HeroGrade, abilities: (string | null)[]): HeroLoadout => ({ name: 'h', grade, abilities });

describe('hero grades — module slots grow with rarity', () => {
  it('maps обычный 1 · редкий 2 · легендарный 3 · главный 4', () => {
    expect(heroSlots('common')).toBe(1);
    expect(heroSlots('rare')).toBe(2);
    expect(heroSlots('legendary')).toBe(3);
    expect(heroSlots('main')).toBe(4);
    expect(HERO_GRADES.main.slots).toBe(4);
  });
});

describe('hero roster model — loadout = grade slots ("modules") + base aura', () => {
  it('resolves filled slots to abilities in order, reporting slots from the grade', () => {
    const info = heroLoadoutInfo(load('rare', ['corridor', 'annihilate']));
    expect(info.slots).toBe(2);
    expect(info.count).toBe(2);
    expect(info.abilities.map((a) => a.id)).toEqual(['corridor', 'annihilate']);
  });

  it('never counts more modules than the grade allows (over-cap slots ignored)', () => {
    // A common hero (1 slot) carrying two ids only ever fields the first.
    const info = heroLoadoutInfo(load('common', ['corridor', 'annihilate']));
    expect(info.slots).toBe(1);
    expect(info.count).toBe(1);
    expect(info.abilities.map((a) => a.id)).toEqual(['corridor']);
  });

  it('skips empty / unknown slots (graceful)', () => {
    expect(heroLoadoutInfo(load('rare', ['corridor', null])).count).toBe(1);
    expect(heroLoadoutInfo(load('rare', ['nope', null])).count).toBe(0);
  });

  it('flags abilities not yet wired in the engine as planned ("скоро")', () => {
    expect(heroLoadoutInfo(load('rare', ['corridor', 'annihilate'])).planned).toBe(0);
    expect(heroLoadoutInfo(load('rare', ['corridor', 'scan'])).planned).toBe(1);
  });

  it('the live abilities are exactly the ones the core heroModule already implements', () => {
    const live = HERO_ABILITY_IDS.filter((id) => HERO_ABILITIES[id]!.live).sort();
    expect(live).toEqual(['annihilate', 'corridor']);
  });

  it('the default roster is the main hero + 3 others, each filled to its grade', () => {
    expect(DEFAULT_HEROES).toHaveLength(HERO_ROSTER_COUNT);
    expect(DEFAULT_HEROES.filter((h) => h.grade === 'main')).toHaveLength(1); // exactly one main
    for (const h of DEFAULT_HEROES) {
      expect(h.abilities).toHaveLength(heroSlots(h.grade)); // one entry per grade slot
      for (const id of h.abilities) if (id !== null) expect(HERO_ABILITIES[id]).toBeDefined();
      expect(heroLoadoutInfo(h).count).toBe(heroSlots(h.grade)); // defaults are fully filled
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
