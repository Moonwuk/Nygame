import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FactionDefSchema } from './schemas';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../data');
const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dataDir, name), 'utf8')) as Record<string, unknown>;

describe('faction data (B1 / CR-1.1)', () => {
  const factions = readJson('factions.json');
  const unitIds = new Set(Object.keys(readJson('units.json')));
  const buildingIds = new Set(Object.keys(readJson('buildings.json')));
  const ids = Object.keys(factions);

  it('ships exactly the three factions', () => {
    expect(ids.sort()).toEqual(['necromancer', 'swarm', 'vanguard']);
  });

  it('each faction validates and carries a loadout, unique units and passives', () => {
    for (const id of ids) {
      const f = FactionDefSchema.parse(factions[id]);
      expect(f.name).toBeTruthy();
      expect(Array.isArray(f.uniqueUnits)).toBe(true);
      expect(f.startingLoadout.fleet.length).toBeGreaterThan(0); // a starting fleet
      expect(typeof f.passives.productionBonus).toBe('number'); // mirrors tech effects
    }
  });

  it('every referenced unit and building actually exists (no dangling ids)', () => {
    const missing: string[] = [];
    for (const id of ids) {
      const f = FactionDefSchema.parse(factions[id]);
      const units = [
        ...f.uniqueUnits,
        ...f.startingLoadout.fleet.map((s) => s.unit),
        ...f.startingLoadout.garrison.map((s) => s.unit),
      ];
      for (const u of units) if (!unitIds.has(u)) missing.push(`${id}: unit ${u}`);
      for (const b of f.startingLoadout.homeBuildings) {
        if (!buildingIds.has(b)) missing.push(`${id}: building ${b}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the factions are genuinely distinct (own passive + own unique unit)', () => {
    const v = FactionDefSchema.parse(factions.vanguard);
    const s = FactionDefSchema.parse(factions.swarm);
    const n = FactionDefSchema.parse(factions.necromancer);
    expect(v.passives.combatDamageBonus).toBeGreaterThan(0);
    expect(s.passives.productionBonus).toBeGreaterThan(0);
    expect(n.passives.fleetSpeedBonus).toBeGreaterThan(0);
    expect(new Set([v.uniqueUnits[0], s.uniqueUnits[0], n.uniqueUnits[0]]).size).toBe(3);
  });
});
