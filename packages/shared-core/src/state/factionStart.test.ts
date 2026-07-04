import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadGameData } from '../data/loadGameData';
import { factionStart } from './factionStart';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../data');
const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
const data = loadGameData(readJson);

describe('factionStart — match-start assembly by faction (B3 / CR-1.3)', () => {
  it('resolves the vanguard loadout into concrete pieces (building hp from data)', () => {
    const start = factionStart(data, 'vanguard');
    expect(start.resources).toEqual({ credits: 300, metal: 300 });
    expect(start.fleet).toEqual([
      { unit: 'cruiser', count: 2 },
      { unit: 'scout_drone', count: 1 },
    ]);
    expect(start.garrison).toEqual([{ unit: 'militia', count: 2 }]);
    expect(start.buildings).toEqual([{ type: 'mine_t1', level: 1, hp: 15 }]); // hp resolved from data
  });

  it('is deterministic and returns a fresh clone (no shared refs with game data)', () => {
    expect(factionStart(data, 'swarm')).toEqual(factionStart(data, 'swarm'));
    const start = factionStart(data, 'swarm');
    start.resources.metal = 999; // mutating the result must not leak into data
    expect(factionStart(data, 'swarm').resources.metal).toBe(200);
  });

  it('both factions bring a non-empty starting fleet', () => {
    for (const id of ['vanguard', 'swarm']) {
      expect(factionStart(data, id).fleet.length).toBeGreaterThan(0);
    }
  });

  it('an unknown faction yields empty pieces (graceful)', () => {
    expect(factionStart(data, 'nope')).toEqual({
      resources: {},
      garrison: [],
      buildings: [],
      fleet: [],
    });
  });
});
