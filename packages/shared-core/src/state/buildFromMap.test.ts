import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGameData, type GameData } from '../data/schemas';
import { parseMatchMap, type MatchMap } from '../data/mapSchema';
import { buildStateFromMap, validateMatchMap } from './buildFromMap';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (p: string): unknown => JSON.parse(readFileSync(path.join(repoRoot, p), 'utf8'));

function shippedData(): GameData {
  const manifest = readJson('data/manifest.json') as { version: string };
  return parseGameData({
    version: manifest.version,
    resources: readJson('data/resources.json'),
    units: readJson('data/units.json'),
    factions: readJson('data/factions.json'),
    buildings: readJson('data/buildings.json'),
    events: readJson('data/events.json'),
    sectors: readJson('data/sectors.json'),
    planetTypes: readJson('data/planetTypes.json'),
    technologies: readJson('data/technologies.json'),
  });
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
    map.sectors.isle = { position: { x: 999, y: 999 }, kind: 'planet', owner: null, buildings: [], garrison: [] };
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
