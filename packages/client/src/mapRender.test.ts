import { describe, expect, it } from 'vitest';
import { createInitialState, type GameState, type Player } from '@void/shared-core';
import { ownerColors } from './mapRender';

const player = (id: string): Player => ({
  id,
  name: id,
  faction: 'x',
  status: 'active',
  resources: {},
});

function stateWith(ids: string[]): GameState {
  const s = createInitialState({ seed: 'map', version: { data: 't', manifest: 't' } });
  for (const id of ids) s.players[id] = player(id);
  return s;
}

describe('mapRender — ownerColors (the pure seat-colour assignment)', () => {
  it('assigns stable colours by join order and cycles past the palette', () => {
    const colors = ownerColors(stateWith(['a', 'b', 'c', 'd', 'e']));
    expect(colors.size).toBe(5);
    // Join order is the assignment order; the 5th seat wraps to the 1st colour.
    expect(colors.get('e')).toBe(colors.get('a'));
    // The first four are the distinct seat palette.
    expect(new Set([colors.get('a'), colors.get('b'), colors.get('c'), colors.get('d')]).size).toBe(4);
  });

  it('an empty seat list yields an empty map (no phantom entries)', () => {
    expect(ownerColors(stateWith([])).size).toBe(0);
  });
});
