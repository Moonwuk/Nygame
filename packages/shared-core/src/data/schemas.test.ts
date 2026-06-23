import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGameData, safeParseGameData, buildingLevel } from './schemas';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataDir = path.join(repoRoot, 'data');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
}

/** Composes the shipped data fragments into one bundle, the way a loader would. */
function loadShippedBundle(): Record<string, unknown> {
  const manifest = readJson('manifest.json') as { version: string };
  return {
    version: manifest.version,
    resources: readJson('resources.json'),
    units: readJson('units.json'),
    factions: readJson('factions.json'),
    buildings: readJson('buildings.json'),
    events: readJson('events.json'),
    sectors: readJson('sectors.json'),
    planetTypes: readJson('planetTypes.json'),
    technologies: readJson('technologies.json'),
  };
}

describe('game data schema (docs/architecture.md §2)', () => {
  it('validates the shipped data bundle', () => {
    const data = parseGameData(loadShippedBundle());
    expect(data.version).toBe('0.1.0');
    expect(data.resources).toContain('dark_matter');
    expect(data.units.infected_cruiser?.stats.attack).toBe(12);
    expect(data.units.siege_lance?.stats.range).toBe(3); // artillery firing range
    expect(data.units.cruiser?.upkeep.credits).toBe(8); // daily upkeep
    // fleet ⊕ ground-army separation: domains + transport capacity.
    expect(data.units.cruiser?.domain).toBe('space'); // schema default
    expect(data.units.tank?.domain).toBe('ground');
    expect(data.units.tank?.stats.cargoSize).toBe(3); // a tank is bulky cargo
    expect(data.units.dropship?.stats.cargoCapacity).toBe(12); // dedicated lift
    expect(data.units.scout_drone?.stats.cargoCapacity).toBe(0); // default, carries nothing
    expect(data.units.orbital_aa?.stats.aaDamage).toBe(14); // anti-ship orbital AA
    expect(data.units.cruiser?.stats.aaDamage).toBe(0); // default, no AA
    expect(data.events.reanimate_on_kill?.trigger).toBe('unit_dies_in_battle');
    expect(data.sectors.asteroid_field?.speedBonus).toBeCloseTo(-0.25);
    expect(data.sectors.asteroid_field?.hpBonus).toBeCloseTo(0.1);
    // planet types: production multiplier + ground-defense edge (data-driven).
    expect(data.planetTypes.volcanic?.productionBonus).toBeCloseTo(0.25);
    expect(data.planetTypes.terran?.defenseBonus).toBeCloseTo(0.1);
    expect(data.planetTypes.barren?.defenseBonus).toBe(0); // schema default
    expect(data.technologies.orbital_logistics?.unlocks.units).toContain('dropship');
    expect(data.technologies.siege_doctrine?.prerequisites).toEqual(['orbital_logistics']);
    expect(data.technologies.industrial_automation?.effects.productionBonus).toBeCloseTo(0.1);
  });

  it('builds the fortress up to level 3 (HP and defense both grow)', () => {
    const data = parseGameData(loadShippedBundle());
    const fort = data.buildings.fort;
    expect(fort).toBeDefined();
    // "от 35 до 65 на 3 уровне" — both HP and the ground-defense bonus scale.
    expect(buildingLevel(fort!, 1).hp).toBe(35);
    expect(buildingLevel(fort!, 3).hp).toBe(65);
    expect(buildingLevel(fort!, 1).defenseBonus).toBeCloseTo(0.35);
    expect(buildingLevel(fort!, 3).defenseBonus).toBeCloseTo(0.65);
    // Every ordinary building still grants the baseline +1%.
    expect(buildingLevel(data.buildings.barracks!, 1).defenseBonus).toBeCloseTo(0.01);
  });

  it('applies defaults for omitted optional fields', () => {
    const data = parseGameData(loadShippedBundle());
    // scout_drone declares no traits in JSON → schema default [].
    expect(data.units.scout_drone?.traits).toEqual([]);
    // void_anomaly omits no chance, but reanimate uses a custom chance.
    expect(data.events.reanimate_on_kill?.chance).toBeCloseTo(0.3);
  });

  it('allows extra numeric unit stats (data-driven, open stat set)', () => {
    const bundle = loadShippedBundle();
    const res = safeParseGameData({
      ...bundle,
      units: {
        ...(bundle.units as Record<string, unknown>),
        psi_ship: {
          faction: 'vanguard',
          stats: { attack: 4, defense: 4, speed: 7, psi: 9 },
        },
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects an empty resource list (fail-closed validation)', () => {
    const res = safeParseGameData({ ...loadShippedBundle(), resources: [] });
    expect(res.success).toBe(false);
  });

  it('rejects a non-numeric unit stat', () => {
    const res = safeParseGameData({
      ...loadShippedBundle(),
      units: { broken: { faction: 'x', stats: { attack: 'lots', defense: 1, speed: 1 } } },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a chance outside [0, 1]', () => {
    const res = safeParseGameData({
      ...loadShippedBundle(),
      events: { bad: { trigger: 't', effect: 'e', chance: 2 } },
    });
    expect(res.success).toBe(false);
  });
});
