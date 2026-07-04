import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { GameData } from '../data/schemas';
import { loadGameData } from '../data/loadGameData';
import { parseMatchMap, type MatchMap } from '../data/mapSchema';
import { buildStateFromMap, validateMatchMap } from './buildFromMap';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (p: string): unknown => JSON.parse(readFileSync(path.join(repoRoot, p), 'utf8'));

function shippedData(): GameData {
  return loadGameData((name) => readJson('data/' + name));
}

const data = shippedData();
const exampleMap = (): MatchMap => parseMatchMap(readJson('data/maps/skirmish-1.json'));

describe('buildStateFromMap (map-roadmap.md M1.2)', () => {
  it('builds a GameState from the example map', () => {
    const state = buildStateFromMap(exampleMap(), data);
    expect(Object.keys(state.planets).sort()).toEqual(['drift', 'home_green', 'home_red', 'nexus', 'veil']);
    expect(state.planets.home_green!.owner).toBe('green');
    expect(state.planets.nexus!.owner).toBeNull();
    expect(state.players.green!.faction).toBe('vanguard');
    expect(state.fleets.green_1!.location).toBe('home_green');
    expect(state.fleets.green_1!.units).toEqual([
      { unit: 'cruiser', count: 2 },
      { unit: 'scout_drone', count: 1 },
    ]);
  });

  it('carries a map player ai flag onto the seated player', () => {
    const map = exampleMap();
    map.players.red!.ai = true;
    const state = buildStateFromMap(map, data);
    expect(state.players.red!.ai).toBe(true);
    expect(state.players.green!.ai).toBeUndefined();
  });

  it('derives sector links from the undirected paths (sorted, symmetric)', () => {
    const state = buildStateFromMap(exampleMap(), data);
    // nexus is the hub → linked to all four spokes; a spoke links back to nexus
    expect(state.planets.nexus!.links).toEqual(['drift', 'home_green', 'home_red', 'veil']);
    expect(state.planets.home_green!.links).toEqual(['nexus']);
    expect(state.planets.drift!.links).toEqual(['nexus']);
  });

  it('sets building HP from the data and carries terrain/planetType', () => {
    const state = buildStateFromMap(exampleMap(), data);
    const mine = state.planets.home_green!.buildings.find((b) => b.type === 'mine_t1');
    expect(mine).toBeDefined();
    expect(mine!.hp).toBe(data.buildings.mine_t1!.hp);
    expect(state.planets.drift!.terrain).toBe('asteroid_field');
    expect(state.planets.veil!.planetType).toBe('barren');
  });

  it('is deterministic — same map+data → identical state', () => {
    expect(buildStateFromMap(exampleMap(), data)).toEqual(buildStateFromMap(exampleMap(), data));
  });
});

describe('validateMatchMap — neighbour-only paths + integrity (M1.3)', () => {
  it('passes the example map clean', () => {
    expect(validateMatchMap(exampleMap(), data)).toEqual([]);
  });

  it('rejects a path that is not between neighbours (a third sector lies between)', () => {
    const map = exampleMap();
    // home_green↔home_red would cross straight through nexus (which sits between)
    map.paths.push(['home_green', 'home_red']);
    const issues = validateMatchMap(map, data);
    expect(issues.some((c) => c.startsWith('E_PATH_NOT_NEIGHBOR'))).toBe(true);
    expect(() => buildStateFromMap(map, data)).toThrow(/E_INVALID_MAP/);
  });

  it('flags a disconnected sector', () => {
    const map = exampleMap();
    map.sectors.isle = { position: { x: 999, y: 999 }, kind: 'planet', size: 1, owner: null, buildings: [], garrison: [] };
    expect(validateMatchMap(map, data)).toContain('E_MAP_DISCONNECTED');
  });

  it('flags unknown owners, units and a self-loop', () => {
    const map = exampleMap();
    map.sectors.home_green!.owner = 'ghost';
    map.sectors.home_red!.garrison.push({ unit: 'nope', count: 1 });
    map.paths.push(['nexus', 'nexus']);
    const issues = validateMatchMap(map, data);
    expect(issues).toContain('E_SECTOR_UNKNOWN_OWNER:home_green');
    expect(issues).toContain('E_UNKNOWN_UNIT:nope');
    expect(issues).toContain('E_PATH_SELF_LOOP:nexus');
  });
});

describe('slot-based maps — team-aware start slots (corporation-wars.md §4)', () => {
  const avaMap = (): MatchMap => parseMatchMap(readJson('data/maps/ava-duel-1.json'));

  it('seats assigned players into slots and resolves slot owners', () => {
    const state = buildStateFromMap(avaMap(), data, {
      slots: {
        slot_a: { playerId: 'p1', name: 'Alpha' },
        slot_b: { playerId: 'p2' },
      },
    });
    // slot owners resolved to the concrete players
    expect(state.planets.home_a!.owner).toBe('p1');
    expect(state.planets.home_b!.owner).toBe('p2');
    expect(state.fleets.fleet_a!.owner).toBe('p1');
    // players created from the assignment; start kit = the slot's resources
    expect(state.players.p1!.name).toBe('Alpha');
    expect(state.players.p2!.name).toBe('p2'); // defaults to the id
    expect(state.players.p1!.resources).toEqual({ credits: 300, metal: 300 });
    expect(Object.keys(state.players).sort()).toEqual(['p1', 'p2']);
  });

  it('rejects a slot owner with no assignment (fail-secure)', () => {
    expect(() => buildStateFromMap(avaMap(), data, { slots: { slot_a: { playerId: 'p1' } } })).toThrow(
      /E_SLOT_UNASSIGNED/,
    );
  });

  it('seats a chosen scientist onto the slot player, snapshotting id + level', () => {
    const state = buildStateFromMap(avaMap(), data, {
      slots: {
        slot_a: { playerId: 'p1', scientist: 'void_admiral', scientistLevel: 3 },
        slot_b: { playerId: 'p2' },
      },
    });
    // Legacy single `scientist` input is seated as a one-leader council (`scientists`).
    expect(state.players.p1!.scientists).toEqual([{ id: 'void_admiral', level: 3 }]);
    expect(state.players.p1!.scientist).toBeUndefined(); // legacy field no longer written
    expect(state.players.p2!.scientists).toBeUndefined(); // no leader chosen
  });

  it('rejects a slot assigning an unknown scientist (fail-secure at boot)', () => {
    expect(() =>
      buildStateFromMap(avaMap(), data, {
        slots: { slot_a: { playerId: 'p1', scientist: 'ghost' }, slot_b: { playerId: 'p2' } },
      }),
    ).toThrow(/E_UNKNOWN_SCIENTIST/);
  });

  it('seats a 2-leader council; rejects a duplicate or a third leader (fail-secure)', () => {
    const state = buildStateFromMap(avaMap(), data, {
      slots: {
        slot_a: {
          playerId: 'p1',
          scientists: [{ id: 'void_admiral', level: 3 }, { id: 'ground_marshal' }],
        },
        slot_b: { playerId: 'p2' },
      },
    });
    expect(state.players.p1!.scientists).toEqual([
      { id: 'void_admiral', level: 3 },
      { id: 'ground_marshal', level: 1 }, // level defaults to 1
    ]);
    // Distinct + capped at two — fail-secure at boot.
    expect(() =>
      buildStateFromMap(avaMap(), data, {
        slots: {
          slot_a: { playerId: 'p1', scientists: [{ id: 'void_admiral' }, { id: 'void_admiral' }] },
          slot_b: { playerId: 'p2' },
        },
      }),
    ).toThrow(/E_DUPLICATE_SCIENTIST/);
    expect(() =>
      buildStateFromMap(avaMap(), data, {
        slots: {
          slot_a: {
            playerId: 'p1',
            scientists: [{ id: 'void_admiral' }, { id: 'ground_marshal' }, { id: 'polymath' }],
          },
          slot_b: { playerId: 'p2' },
        },
      }),
    ).toThrow(/E_TOO_MANY_SCIENTISTS/);
  });

  it('grants pre-match technology picks as completed research (C3)', () => {
    const state = buildStateFromMap(avaMap(), data, {
      slots: {
        // duplicates collapse — the pick lands once
        slot_a: { playerId: 'p1', technologies: ['orbital_logistics', 'orbital_logistics'] },
        slot_b: { playerId: 'p2' },
      },
    });
    expect(state.players.p1!.technologies).toEqual({ completed: ['orbital_logistics'] });
    expect(state.players.p2!.technologies).toBeUndefined(); // no picks → untouched
  });

  it('marks AI-driven seats on the player (bots are not invitable to coalitions)', () => {
    const state = buildStateFromMap(avaMap(), data, {
      slots: { slot_a: { playerId: 'p1', ai: true }, slot_b: { playerId: 'p2' } },
    });
    expect(state.players.p1!.ai).toBe(true);
    expect(state.players.p2!.ai).toBeUndefined(); // human seat stays unmarked
  });

  it('rejects a player id carrying the pair-key separator "|" (fail-secure at boot)', () => {
    // seated via a slot…
    expect(() =>
      buildStateFromMap(avaMap(), data, {
        slots: { slot_a: { playerId: 'clan|alpha' }, slot_b: { playerId: 'p2' } },
      }),
    ).toThrow(/E_BAD_PLAYER_ID/);
    // …and declared statically on the map (schema-level guard)
    const raw = readJson('data/maps/skirmish-1.json') as { players: Record<string, unknown> };
    raw.players['clan|alpha'] = { name: 'X', faction: 'vanguard' };
    expect(() => parseMatchMap(raw)).toThrow();
  });

  it('rejects a slot granting an unknown technology (fail-secure at boot)', () => {
    expect(() =>
      buildStateFromMap(avaMap(), data, {
        slots: { slot_a: { playerId: 'p1', technologies: ['ghost_tech'] }, slot_b: { playerId: 'p2' } },
      }),
    ).toThrow(/E_UNKNOWN_TECHNOLOGY/);
  });

  it('accepts slot ids as sector/fleet owners (validation clean)', () => {
    expect(validateMatchMap(avaMap(), data)).toEqual([]);
  });

  it('flags a slot id that collides with a player id', () => {
    const map = exampleMap(); // has players green/red
    map.slots.green = { team: 'A', spawn: 'fixed', resources: {} };
    expect(validateMatchMap(map, data)).toContain('E_SLOT_PLAYER_ID_CLASH:green');
  });
});
