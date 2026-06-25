import { describe, expect, it } from 'vitest';
import { createInitialState, type GameState, type Planet, type Player } from './gameState';
import { applyDelta, diffState } from './delta';
import { hashState } from './hash';

function player(id: string): Player {
  return {
    id,
    name: `name-${id}`,
    faction: 'vanguard',
    status: 'active',
    resources: { credits: 100, metal: 50 },
  };
}

function planet(id: string, owner: string | null): Planet {
  return {
    id,
    owner,
    position: { x: 1, y: 2 },
    links: ['a', 'b'],
    resources: { ore: 3 },
    buildings: [{ type: 'mine', level: 1, hp: 10 }],
    garrison: [{ unit: 'militia', count: 2 }],
    traits: [],
  };
}

function fixtureState(): GameState {
  const base = createInitialState({ seed: 'hash-fixture', version: { data: '1', manifest: '1' } });
  return {
    ...base,
    players: { p1: player('p1'), p2: player('p2') },
    planets: { home: planet('home', 'p1'), nexus: planet('nexus', null) },
  };
}

/** Rebuild every object with its keys in reverse insertion order (arrays kept) —
 *  a logically identical state whose key order differs everywhere. */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map(reorderKeys);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).reverse()) {
      out[key] = reorderKeys(obj[key]);
    }
    return out;
  }
  return value;
}

describe('hashState', () => {
  // Golden: locks the digest algorithm + canonical serialization. If this changes
  // unintentionally, cross-version hash comparison is invalid — change on purpose.
  it('is a stable golden digest of a fixture state', () => {
    expect(hashState(fixtureState())).toBe('1fec849d941b2d');
  });

  it('is independent of object key order (server-built vs delta-reconstructed)', () => {
    const state = fixtureState();
    expect(hashState(reorderKeys(state) as GameState)).toBe(hashState(state));
  });

  it('matches across a diffState/applyDelta round-trip (the desync property)', () => {
    const prev = fixtureState();
    const next: GameState = {
      ...prev,
      players: { p1: { ...player('p1'), resources: { credits: 999, metal: 50 } }, p2: player('p2') },
    };
    const reconstructed = applyDelta(prev, diffState(prev, next));
    expect(hashState(reconstructed)).toBe(hashState(next));
  });

  it('changes when any field changes', () => {
    const a = fixtureState();
    const b: GameState = {
      ...a,
      players: { p1: { ...player('p1'), name: 'changed' }, p2: player('p2') },
    };
    expect(hashState(b)).not.toBe(hashState(a));
  });

  it('is deterministic (same input → same digest)', () => {
    expect(hashState(fixtureState())).toBe(hashState(fixtureState()));
  });
});
