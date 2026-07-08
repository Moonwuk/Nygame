import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGameData, safeParseGameData, buildingLevel, buildingMaxLevel } from './schemas';
import { composeGameDataBundle } from './loadGameData';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataDir = path.join(repoRoot, 'data');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
}

/** Composes the shipped data fragments into one bundle via the shared composer (CP0.3),
 *  injecting the Node file reader — the fragment list now lives in one place. */
function loadShippedBundle(): Record<string, unknown> {
  return composeGameDataBundle(readJson);
}

describe('game data schema (docs/architecture.md §2)', () => {
  it('validates the shipped data bundle', () => {
    const data = parseGameData(loadShippedBundle());
    expect(data.version).toBe('0.1.0');
    expect(data.resources).toContain('microelectronics');
    expect(data.units.siege_lance?.stats.range).toBe(300); // artillery firing radius (map units)
    expect(data.units.cruiser?.upkeep.credits).toBe(8); // daily upkeep
    // fleet ⊕ ground-army separation: domains + transport capacity.
    expect(data.units.cruiser?.domain).toBe('space'); // schema default
    expect(data.units.tank?.domain).toBe('ground');
    expect(data.units.tank?.stats.cargoSize).toBe(3); // a tank is bulky cargo
    expect(data.units.dropship?.stats.cargoCapacity).toBe(12); // dedicated lift
    expect(data.units.scout_drone?.stats.cargoCapacity).toBe(0); // default, carries nothing
    expect(data.buildings.orbital_aa?.aaDamage).toBe(14); // anti-ship orbital AA — a defensive building
    expect(data.units.cruiser?.stats.aaDamage).toBe(0); // default, no AA
    expect(data.buildings.mine_t1?.aaDamage).toBe(0); // buildings default to no AA
    // squadrons-roadmap SQ-0.1: a carrier-borne fighter squadron + the new squadron stats.
    expect(data.units.fighter_squadron?.traits).toContain('squadron');
    expect(data.units.fighter_squadron?.stats.strikeRange).toBe(180); // Euclidean reach
    expect(data.units.fighter_squadron?.stats.fuel).toBe(3); // sorties before rearm
    expect(data.units.fighter_squadron?.stats.rearmRounds).toBe(2);
    expect(data.units.strike_carrier?.stats.cargoCapacity).toBe(6); // hangar = shared cargo hold
    expect(data.units.cruiser?.stats.strikeRange).toBe(0); // schema default (not a squadron)
    // reanimate_on_kill/Necromancer cut (designer-role) → assert a surviving event instead.
    expect(data.events.infect_planet?.trigger).toBe('planet_captured');
    expect(data.sectors.asteroid_field?.speedBonus).toBeCloseTo(-0.25);
    expect(data.sectors.asteroid_field?.hpBonus).toBeCloseTo(0.1);
    // planet types: production multiplier + ground-defense edge (data-driven).
    expect(data.planetTypes.volcanic?.productionBonus).toBeCloseTo(0.25);
    expect(data.planetTypes.terran?.defenseBonus).toBeCloseTo(0.1);
    expect(data.planetTypes.barren?.defenseBonus).toBe(0); // schema default
    expect(data.technologies.orbital_logistics?.unlocks.units).toContain('dropship');
    expect(data.technologies.siege_doctrine?.prerequisites).toEqual(['orbital_logistics']);
    expect(data.technologies.industrial_automation?.effects.productionBonus).toBeCloseTo(0.1);
    // ship modules: typed hull slots + a data-driven module catalog.
    expect(data.units.cruiser?.slots).toEqual({ weapon: 1, defense: 1, utility: 1 });
    expect(data.units.scout_drone?.slots).toEqual({ weapon: 0, defense: 0, utility: 0 }); // default
    expect(data.modules.cargo_bay?.effects.stats.cargoCapacity).toBe(6);
    expect(data.modules.cargo_bay?.tag).toBe('horizontal');
    expect(data.modules.shield_booster?.slot).toBe('defense');
    expect(data.modules.targeting_array?.tag).toBe('vertical');
  });

  it('rejects a module that expands its own slot capacity (anti self-buff)', () => {
    const res = safeParseGameData({
      ...loadShippedBundle(),
      modules: {
        bad: { name: 'x', slot: 'utility', tag: 'horizontal', effects: { stats: { moduleSlots: 1 } } },
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a soulbound vertical (combat) module (anti pay-to-win)', () => {
    const res = safeParseGameData({
      ...loadShippedBundle(),
      modules: {
        bad: { name: 'x', slot: 'weapon', tag: 'vertical', soulbound: true, effects: { stats: { attack: 5 } } },
      },
    });
    expect(res.success).toBe(false);
  });

  it('ships producers for every economy resource (ECON-3: energy + microelectronics)', () => {
    const data = parseGameData(loadShippedBundle());
    // Fusion reactor feeds energy, scaling across its 3 levels.
    const power = data.buildings.power_plant;
    expect(power).toBeDefined();
    expect(buildingMaxLevel(power!)).toBe(3);
    expect(buildingLevel(power!, 1).produces.energy).toBe(25);
    expect(buildingLevel(power!, 3).produces.energy).toBe(110);
    // The fab turns energy+metal into microelectronics (premium, gated by tech).
    const fab = data.buildings.fabricator;
    expect(fab).toBeDefined();
    expect(buildingLevel(fab!, 1).produces.microelectronics).toBe(8);
    expect(buildingLevel(fab!, 1).cost.energy).toBe(60); // consumes energy to build
    expect(data.technologies.microelectronics_fabrication?.unlocks.buildings).toContain('fabricator');
    // Every economy resource now has at least one building that produces it.
    const produced = new Set<string>();
    for (const def of Object.values(data.buildings)) {
      for (let lvl = 1; lvl <= buildingMaxLevel(def); lvl++) {
        for (const res of Object.keys(buildingLevel(def, lvl).produces)) produced.add(res);
      }
    }
    for (const res of data.resources) {
      if (res === 'credits') continue; // credits are a sink/trade currency, not building-produced
      expect(produced.has(res)).toBe(true);
    }
  });

  it('every resource referenced by content exists in the resource list (referential integrity)', () => {
    const data = parseGameData(loadShippedBundle());
    const known = new Set(data.resources);
    const check = (bag: Record<string, number>, where: string) => {
      for (const res of Object.keys(bag)) {
        expect(known.has(res), `${where} references unknown resource "${res}"`).toBe(true);
      }
    };
    for (const [id, def] of Object.entries(data.buildings)) {
      for (let lvl = 1; lvl <= buildingMaxLevel(def); lvl++) {
        const level = buildingLevel(def, lvl);
        check(level.cost, `building ${id} L${lvl} cost`);
        check(level.produces, `building ${id} L${lvl} produces`);
      }
    }
    for (const [id, def] of Object.entries(data.units)) {
      check(def.cost, `unit ${id} cost`);
      check(def.upkeep, `unit ${id} upkeep`);
    }
    for (const [id, def] of Object.entries(data.modules)) {
      check(def.cost, `module ${id} cost`);
    }
    for (const [id, def] of Object.entries(data.technologies)) {
      check(def.cost, `technology ${id} cost`);
    }
    for (const [id, def] of Object.entries(data.heroAbilities)) {
      check(def.cost, `hero ability ${id} cost`);
    }
    for (const [id, def] of Object.entries(data.heroSkillTrees)) {
      check(def.cost, `skill node ${id} cost`);
    }
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

  it('the radar array widens its detection radius (distance) across its 3 levels', () => {
    const data = parseGameData(loadShippedBundle());
    const radar = data.buildings.radar;
    expect(radar).toBeDefined();
    expect(buildingMaxLevel(radar!)).toBe(3);
    // radarRange is a Euclidean distance (map units), not jumps.
    expect(buildingLevel(radar!, 1).radarRange).toBe(300);
    expect(buildingLevel(radar!, 2).radarRange).toBe(500);
    expect(buildingLevel(radar!, 3).radarRange).toBe(700);
  });

  it('applies defaults for omitted optional fields', () => {
    const data = parseGameData(loadShippedBundle());
    // scout_drone declares no traits in JSON → schema default [].
    expect(data.units.scout_drone?.traits).toEqual([]);
    // a custom `chance` is preserved, not defaulted to 1.
    expect(data.events.void_anomaly?.chance).toBeCloseTo(0.5);
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

describe('hero archetypes + abilities (HERO-1, docs/heroes.md)', () => {
  it('validates the shipped hero content and its shape', () => {
    const data = parseGameData(loadShippedBundle());
    // Archetypes carry a branch, a ship, module slots and start abilities.
    const commander = data.heroes.commander;
    expect(commander).toBeDefined();
    expect(commander!.branch).toBe('transhuman');
    expect(commander!.ship.unit).toBe('hero');
    expect(commander!.slots).toBe(4);
    expect(commander!.startAbilities).toContain('corridor');
    // A hero branch is its OWN axis (transhuman/psionic), not a tech branch.
    expect(data.heroes.ravager?.branch).toBe('psionic');
    // Abilities are data-driven effects: a dispatch type + cooldown/range/params.
    const annihilate = data.heroAbilities.annihilate;
    expect(annihilate!.type).toBe('annihilate');
    expect(annihilate!.cooldownHours).toBe(48);
    expect(annihilate!.range).toBe(500);
    expect(data.heroAbilities.rally?.params.combatBonus).toBe(0.1);
  });

  it('every hero references known abilities, passives and a known ship unit (referential integrity)', () => {
    const data = parseGameData(loadShippedBundle());
    const abilities = new Set(Object.keys(data.heroAbilities));
    const passives = new Set(Object.keys(data.heroPassives));
    const units = new Set(Object.keys(data.units));
    for (const [id, def] of Object.entries(data.heroes)) {
      for (const ab of def.startAbilities) {
        expect(abilities.has(ab), `hero ${id} references unknown ability "${ab}"`).toBe(true);
      }
      for (const pa of def.startPassives) {
        expect(passives.has(pa), `hero ${id} references unknown passive "${pa}"`).toBe(true);
      }
      if (def.ship.unit !== undefined) {
        expect(units.has(def.ship.unit), `hero ${id} references unknown unit "${def.ship.unit}"`).toBe(true);
      }
    }
  });

  it('ships hero passives wired to hooks (HERO-5) and rejects an unknown hook/scope', () => {
    const data = parseGameData(loadShippedBundle());
    // The two shipped passives: the hero-fleet impulse and the nearby-fleets war beacon.
    expect(data.heroPassives.vanguard_impulse?.hook).toBe('fleet.speed');
    expect(data.heroPassives.vanguard_impulse?.scope).toBe('heroFleet');
    expect(data.heroPassives.rally_beacon?.params.radius).toBe(300);
    expect(data.heroes.vanguard?.startPassives).toContain('vanguard_impulse');
    // Params default when omitted (bonus 0 / radius 0), and enums are fail-closed.
    const min = parseGameData({
      ...loadShippedBundle(),
      heroPassives: { bare: { name: 'X', hook: 'fleet.speed', scope: 'heroFleet' } },
    });
    expect(min.heroPassives.bare?.params).toEqual({ bonus: 0, radius: 0 });
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroPassives: { bad: { name: 'X', hook: 'economy.production', scope: 'heroFleet' } },
      }).success,
    ).toBe(false);
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroPassives: { bad: { name: 'X', hook: 'fleet.speed', scope: 'everywhere' } },
      }).success,
    ).toBe(false);
  });

  it('applies defaults for omitted optional hero fields (graceful, back-compat)', () => {
    const data = parseGameData({
      ...loadShippedBundle(),
      heroes: { minimal: { name: 'Аноним' } },
      heroAbilities: { blink: { name: 'Мигание', type: 'recall' } },
    });
    const h = data.heroes.minimal!;
    expect(h.ship).toEqual({}); // no unit / no inline stats
    expect(h.slots).toBe(0);
    expect(h.startAbilities).toEqual([]);
    expect(h.startPassives).toEqual([]);
    expect(h.branch).toBeUndefined(); // branchless is allowed
    const a = data.heroAbilities.blink!;
    expect(a.cooldownHours).toBe(0);
    expect(a.range).toBe(0);
    expect(a.cost).toEqual({});
    expect(a.params).toEqual({});
  });

  it('the two live abilities map to the engine built-in effect types', () => {
    // The prototype marks exactly corridor/annihilate as live (prototype/src/heroes.ts);
    // the core wires exactly temp_lane/annihilate. Guard the pairing so catalog↔engine
    // drift (a "live" ability with an unwired type ⇒ E_NO_EFFECT at cast) is caught here.
    const data = parseGameData(loadShippedBundle());
    expect(data.heroAbilities.corridor?.type).toBe('temp_lane');
    expect(data.heroAbilities.annihilate?.type).toBe('annihilate');
  });

  it('the shipped skill tree is internally consistent (HERO-7 referential integrity)', () => {
    const data = parseGameData(loadShippedBundle());
    const nodes = data.heroSkillTrees;
    const abilities = new Set(Object.keys(data.heroAbilities));
    const passives = new Set(Object.keys(data.heroPassives));
    for (const [id, def] of Object.entries(nodes)) {
      for (const parent of def.requires) {
        expect(nodes[parent], `node ${id} requires unknown node "${parent}"`).toBeDefined();
      }
      if (def.grants.ability !== undefined) {
        expect(abilities.has(def.grants.ability), `node ${id} grants unknown ability`).toBe(true);
      }
      if (def.grants.passive !== undefined) {
        expect(passives.has(def.grants.passive), `node ${id} grants unknown passive`).toBe(true);
      }
    }
    // Both design branches ship a root node.
    expect(nodes.neural_lace?.branch).toBe('transhuman');
    expect(nodes.void_attunement?.branch).toBe('psionic');
    // Fail-closed: an unknown branch or a negative cost never parses.
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroSkillTrees: { bad: { name: 'X', branch: 'cyborg' } },
      }).success,
    ).toBe(false);
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroSkillTrees: { bad: { name: 'X', cost: { metal: -5 } } },
      }).success,
    ).toBe(false);
  });

  it('rejects a hero ability with a negative cost (no resource minting)', () => {
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroAbilities: { mint: { name: 'X', type: 'aura', cost: { metal: -1000 } } },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown hero branch and an ability with no type (fail-closed)', () => {
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroes: { cyborg: { name: 'X', branch: 'cyborg' } },
      }).success,
    ).toBe(false);
    expect(
      safeParseGameData({
        ...loadShippedBundle(),
        heroAbilities: { void: { name: 'X' } },
      }).success,
    ).toBe(false);
  });
});
