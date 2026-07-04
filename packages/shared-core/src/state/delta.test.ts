import { describe, it, expect } from 'vitest';
import { createInitialState, type GameState } from './gameState';
import { diffState, applyDelta } from './delta';
import { deepClone, deepFreeze } from '../util/clone';

function base(): GameState {
  const s = createInitialState({ seed: 'delta', version: { data: '0.1.0', manifest: '1' } });
  s.players.p1 = { id: 'p1', name: 'One', faction: 'x', status: 'active', resources: { metal: 10 } };
  s.players.p2 = { id: 'p2', name: 'Two', faction: 'x', status: 'active', resources: {} };
  s.planets.A = {
    id: 'A',
    owner: 'p1',
    position: { x: 0, y: 0 },
    resources: {},
    buildings: [],
    garrison: [],
    traits: [],
  };
  s.planets.B = { ...s.planets.A, id: 'B', owner: null };
  return s;
}

/** Mutate a clone of `prev` so `diff`/`apply` have something to reconcile. */
function mutate(prev: GameState): GameState {
  const next = deepClone(prev);
  next.time = prev.time + 3_600_000; // a scalar field changed
  next.players.p1!.resources.metal = 42; // an entity changed
  next.planets.A!.owner = 'p2'; // another entity changed
  delete next.planets.B; // an entity removed
  next.fleets.f1 = {
    id: 'f1',
    owner: 'p1',
    location: 'A',
    movement: null,
    units: [{ unit: 'cruiser', count: 1 }],
    landing: [],
    traits: [],
  }; // an entity added
  return next;
}

describe('state delta — diff/apply round-trip', () => {
  it('applyDelta(prev, diffState(prev, next)) deep-equals next', () => {
    const prev = deepFreeze(base());
    const next = mutate(prev);
    const delta = diffState(prev, next);
    expect(applyDelta(prev, delta)).toEqual(next);
  });

  it('carries only what changed — untouched entities are not in the delta', () => {
    const prev = base();
    const next = mutate(prev);
    const delta = diffState(prev, next);
    // p2 and any unchanged planet must NOT appear in changed
    expect(delta.changed.players).not.toHaveProperty('p2');
    expect(Object.keys(delta.changed.players ?? {})).toEqual(['p1']);
    expect(Object.keys(delta.changed.planets ?? {})).toEqual(['A']);
    expect(delta.changed.fleets).toHaveProperty('f1');
    expect(delta.removed.planets).toEqual(['B']);
    expect(delta.meta).toMatchObject({ time: next.time });
  });

  it('an empty diff (no changes) leaves the state unchanged', () => {
    const prev = base();
    const delta = diffState(prev, deepClone(prev));
    expect(delta.changed).toEqual({});
    expect(delta.removed).toEqual({});
    expect(delta.meta).toBeUndefined();
    expect(applyDelta(prev, delta)).toEqual(prev);
  });

  it('does not mutate the state it patches', () => {
    const prev = deepFreeze(base());
    const next = mutate(prev);
    applyDelta(prev, diffState(prev, next)); // would throw if it mutated a frozen input
    expect(prev.planets).toHaveProperty('B'); // original still intact
  });

  it('carries diplomacyOffers as a meta key (add and clear)', () => {
    const prev = base();
    const next = deepClone(prev);
    next.diplomacyOffers = { 'p1>p2': 'peace' };
    expect(diffState(prev, next).meta).toMatchObject({ diplomacyOffers: { 'p1>p2': 'peace' } });
    expect(applyDelta(prev, diffState(prev, next))).toEqual(next);
    // and clearing it removes the key on the other side
    const wire = JSON.parse(JSON.stringify(diffState(next, prev)));
    expect('diplomacyOffers' in applyDelta(next, wire)).toBe(false);
  });

  it('treats a key-reordered but logically equal entity as unchanged', () => {
    const prev = base();
    const next = deepClone(prev);
    // Same content, different key insertion order — logically the same entity.
    next.players.p1 = { name: 'One', id: 'p1', resources: { metal: 10 }, faction: 'x', status: 'active' };
    const delta = diffState(prev, next);
    expect(delta.changed).toEqual({});
    expect(delta.meta).toBeUndefined();
  });

  it('removes a meta key that went defined → undefined (survives the JSON wire)', () => {
    const prev = base();
    prev.diplomacy = { 'p1|p2': 'war' };
    const next = deepClone(prev);
    delete next.diplomacy; // the server cleared an optional meta key
    // Round-trip through JSON, exactly as MatchRoom serializes the delta to the client.
    const wire = JSON.parse(JSON.stringify(diffState(prev, next)));
    const rebuilt = applyDelta(prev, wire);
    expect('diplomacy' in rebuilt).toBe(false); // key gone, not left stale as 'war'
    expect(rebuilt).toEqual(next);
  });

  it('carries HOST-EXTENSION keys (e.g. `orders` command chains) and their removal', () => {
    type Ext = GameState & { orders?: Record<string, unknown> };
    const prev = base();
    const next = deepClone(prev) as Ext;
    // A key the core does not know about — the prototype's authoritative chains.
    next.orders = { F: [{ kind: 'move', to: 'B' }] };
    const grow = diffState(prev, next);
    expect(grow.meta).toMatchObject({ orders: { F: [{ kind: 'move', to: 'B' }] } });
    expect(applyDelta(prev, grow)).toEqual(next);
    // …and the way back: the chain emptied → the key must vanish, not go stale.
    const wire = JSON.parse(JSON.stringify(diffState(next, prev)));
    const rebuilt = applyDelta(next, wire);
    expect('orders' in rebuilt).toBe(false);
    expect(rebuilt).toEqual(prev);
  });
});
