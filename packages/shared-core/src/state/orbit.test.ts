import { describe, it, expect } from 'vitest';
import { bombardedPlanets, isBombarded } from './orbit';
import { setStance } from './diplomacy';
import { createInitialState, type Fleet, type GameState, type Planet } from './gameState';

function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
}

function fleet(
  id: string,
  owner: string,
  location: string,
  orbit?: 'near',
  bombarding?: boolean,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: [{ unit: 'cruiser', count: 1 }],
    traits: [],
    orbit,
    bombarding,
  };
}

function stateWith(planets: Planet[], fleets: Fleet[]): GameState {
  const s = createInitialState({ seed: 'orb', version: { data: '0.1.0', manifest: '1' } });
  const p: Record<string, Planet> = {};
  for (const x of planets) p[x.id] = x;
  const f: Record<string, Fleet> = {};
  for (const x of fleets) f[x.id] = x;
  return { ...s, planets: p, fleets: f };
}

describe('isBombarded', () => {
  it('returns false for a non-existent planet', () => {
    const st = stateWith([], []);
    expect(isBombarded(st, 'nonexistent')).toBe(false);
  });

  it('returns false when no fleets are present', () => {
    const st = stateWith([planet('P', 'p1')], []);
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('returns false when a fleet is present but not bombarding', () => {
    const st = stateWith([planet('P', 'p1')], [fleet('F', 'p2', 'P', 'near', false)]);
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('returns false when the bombarding fleet is in transit (not in orbit)', () => {
    const st = stateWith([planet('P', 'p1')], [fleet('F', 'p2', 'P', undefined, true)]);
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('returns false when the bombarding fleet belongs to the planet owner', () => {
    const st = stateWith([planet('P', 'p1')], [fleet('F', 'p1', 'P', 'near', true)]);
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('returns false when the fleet is at a different location', () => {
    const st = stateWith(
      [planet('P', 'p1'), planet('Q', 'p2')],
      [fleet('F', 'p2', 'Q', 'near', true)],
    );
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('returns true when a hostile fleet is bombarding from the near orbit', () => {
    const st = stateWith([planet('P', 'p1')], [fleet('F', 'p2', 'P', 'near', true)]);
    expect(isBombarded(st, 'P')).toBe(true);
  });

  it('returns true if any one of multiple fleets satisfies bombardment conditions', () => {
    const st = stateWith(
      [planet('P', 'p1')],
      [
        fleet('F1', 'p2', 'P', undefined, true), // in transit — not in orbit
        fleet('F2', 'p2', 'P', 'near', true), // hostile, stationed in orbit, bombarding
      ],
    );
    expect(isBombarded(st, 'P')).toBe(true);
  });

  it('a fleet PINNED in a melee (battleId) does not freeze the planet — it is not shelling', () => {
    // Same rule the orbital module applies to the damage side (bug-hunt MAJOR):
    // damage and freeze read one shared predicate, so they cannot disagree.
    const pinned = { ...fleet('F', 'p2', 'P', 'near', true), battleId: 'B1' };
    const st = stateWith([planet('P', 'p1')], [pinned]);
    expect(isBombarded(st, 'P')).toBe(false);
  });

  it('only an at-WAR pair bombards: peace/pact/alliance freeze nothing', () => {
    for (const stance of ['peace', 'pact', 'alliance'] as const) {
      const st = stateWith([planet('P', 'p1')], [fleet('F', 'p2', 'P', 'near', true)]);
      setStance(st, 'p1', 'p2', stance);
      expect(isBombarded(st, 'P'), stance).toBe(false);
    }
  });

  it('bombardedPlanets collects every shelled world in one pass', () => {
    const st = stateWith(
      [planet('P', 'p1'), planet('Q', 'p1'), planet('R', 'p1')],
      [
        fleet('F1', 'p2', 'P', 'near', true), // shelling P
        fleet('F2', 'p2', 'Q', 'near', false), // parked, guns cold
        fleet('F3', 'p2', 'R', 'near', true), // shelling R
      ],
    );
    expect(bombardedPlanets(st)).toEqual(new Set(['P', 'R']));
  });
});
