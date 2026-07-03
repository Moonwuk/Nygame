/**
 * Void Dominion — playable prototype, game setup.
 *
 * This file is pure game wiring (no DOM): it builds the data-driven content,
 * the map and the kernel out of the REAL `@void/shared-core` simulation, so the
 * browser UI and a Node smoke-test drive exactly the same deterministic core.
 */
import {
  createKernel,
  createInitialState,
  parseGameData,
  buildingLevel,
  hasOrbit,
  allowedBuildings,
  isCapturable,
  isBombarded,
  economyModule,
  movementModule,
  heroModule,
  combatModule,
  orbitalModule,
  artilleryModule,
  interceptModule,
  captureOnArrivalModule,
  sectorModule,
  planetTypeModule,
  constructionModule,
  armyModule,
  victoryModule,
  technologyModule,
  espionageModule,
  getStance,
  isBotPair,
  setStance,
  pairKey,
  timeScaleOf,
  type DiplomaticStance,
  type GameData,
  type GameModule,
  type GameState,
  type ResourceBag,
  type Hero,
  type Planet,
  type Fleet,
  type UnitStack,
  type Player,
  type Action,
  type Context,
  type DomainEvent,
  type Battle,
} from '../../packages/shared-core/src/index';
import { canAfford, payCost } from '../../packages/shared-core/src/util/treasury';
import { sumUnitStat } from '../../packages/shared-core/src/util/stacks';
import { requireOwnedIdleFleet } from '../../packages/shared-core/src/util/fleet';
import type { HandlerContext } from '../../packages/shared-core/src/kernel/module';
import {
  GROUND_ROSTER,
  makeSide,
  damageBuckets,
  OFFICERS,
  type GroundStack,
  type DamageTable,
  type Officer,
} from './groundcombat';
import { DEFAULT_HEROES, type HeroLoadout } from './heroes';
import { DEFAULT_SHIP_LOADOUTS, type ShipLoadout } from './ships';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// --- data-driven content -----------------------------------------------------

export const data: GameData = parseGameData({
  version: '0.1.0',
  resources: ['credits', 'metal'],
  // Session tech tree (technologyModule). Effect bonuses only in the prototype — no
  // `unlocks`, so researching never locks the content you can already build. Branch /
  // tier / prerequisite / day-gating all apply. Costs use the prototype's 2 resources.
  technologies: {
    industrial_automation: {
      name: 'Industrial Automation',
      description: 'Апгрейд планетарной логистики: +10% к производству.',
      branch: 'space',
      tier: 1,
      cost: { credits: 120, metal: 80 },
      researchTimeHours: 4,
      effects: { productionBonus: 0.1 },
    },
    orbital_logistics: {
      name: 'Orbital Logistics',
      description: 'Стандартизация перевозок: +12% к скорости флотов.',
      branch: 'space',
      tier: 1,
      cost: { credits: 160, metal: 120 },
      researchTimeHours: 6,
      effects: { fleetSpeedBonus: 0.12 },
    },
    siege_doctrine: {
      name: 'Siege Doctrine',
      description: 'Осадные расчёты дальнего боя: +8% к урону.',
      branch: 'space',
      tier: 2,
      cost: { credits: 260, metal: 220 },
      researchTimeHours: 10,
      prerequisites: ['orbital_logistics'],
      effects: { combatDamageBonus: 0.08 },
    },
    fortified_infrastructure: {
      name: 'Fortified Infrastructure',
      description: 'Доктрина укреплённых миров — крепости фронтира.',
      branch: 'ground',
      tier: 2,
      cost: { credits: 180, metal: 240 },
      researchTimeHours: 8,
      prerequisites: ['industrial_automation'],
    },
    microelectronics_fabrication: {
      name: 'Microelectronics Fabrication',
      description: 'Орбитальные фабрики: +5% к производству.',
      branch: 'space',
      tier: 2,
      cost: { credits: 220, metal: 180 },
      researchTimeHours: 10,
      prerequisites: ['industrial_automation'],
      effects: { productionBonus: 0.05 },
    },
  },
  units: {
    scout: {
      faction: 'blue',
      stats: { attack: 5, defense: 4, speed: 64, hp: 12, cargoCapacity: 1 },
      signature: 1, // quiet recon hull
      radarRange: 350, // projects fleet radar — read by both the core fog and the prototype view
      cost: { metal: 20 },
      buildTimeHours: 1,
      upkeep: { credits: 1 },
    },
    cruiser: {
      faction: 'blue',
      stats: { attack: 16, defense: 14, speed: 40, hp: 60, cargoCapacity: 5 },
      line: 'front',
      signature: 4, // big warship — broadcasts
      cost: { metal: 60, credits: 20 },
      buildTimeHours: 3,
      upkeep: { credits: 4 },
    },
    siege: {
      // Artillery: a backline platform that fires from range at one target —
      // a pure standoff (no return fire) within `range` map units (combat
      // runArtillery). Reaches ~one neighbouring world (~205 apart), no further.
      faction: 'blue',
      stats: { attack: 30, defense: 6, speed: 30, hp: 40, range: 240 },
      traits: ['artillery'],
      signature: 5, // huge siege platform — loudest
      cost: { metal: 90, credits: 40 },
      buildTimeHours: 5,
      upkeep: { credits: 6 },
    },
    dropship: {
      // Carrier hull (GDD §6.1 / backlog SHIP): the biggest hold in the fleet but almost
      // no guns — it hauls divisions (and, later, squadrons) and wants an escort.
      faction: 'blue',
      stats: { attack: 2, defense: 6, speed: 44, hp: 50, cargoCapacity: 8 },
      signature: 3, // a fat hauler — easy to spot
      cost: { metal: 70, credits: 20 },
      buildTimeHours: 4,
      upkeep: { credits: 3 },
    },
    fighter_squadron: {
      // Carrier-borne strike wing (squadrons-roadmap SQ-0.1): very fast + hard-hitting
      // but paper-thin — launch it ahead to strike, orbital AA (orbital_aa) is its counter.
      faction: 'blue',
      stats: {
        attack: 14,
        defense: 3,
        speed: 92,
        hp: 10,
        strikeRange: 180,
        fuel: 3,
        rearmRounds: 2,
      },
      traits: ['squadron'],
      signature: 2,
      cost: { metal: 90, credits: 40 },
      buildTimeHours: 2,
      upkeep: { credits: 4 },
    },
    strike_carrier: {
      // A slow, tanky flat-top with few guns of its own — its punch is the squadrons it carries.
      faction: 'blue',
      stats: { attack: 4, defense: 10, speed: 40, hp: 70, cargoCapacity: 6 },
      traits: ['carrier'],
      signature: 6,
      cost: { metal: 320, credits: 160 },
      buildTimeHours: 6,
      upkeep: { credits: 12 },
    },
    // (marine retired — mobile ground troops now come only from the division/formation
    //  system. Orbital AA is no longer a unit either: it's a defensive *building* now
    //  (see `orbital_aa` under buildings) — anti-ship, immobile, player-built.)
    // --- formation roster: the ground units that fill a division template's 6 slots
    // (formation.ts). Each has a distinct role; the template's SUM + composition
    // synergies (combined-arms / entrenched / armour / air) set the division's stats.
    // Пехота — cheap, defensive front line; the backbone that holds ground.
    infantry: {
      faction: 'blue',
      stats: { attack: 8, defense: 16, speed: 48, hp: 24, cargoSize: 1 },
      domain: 'ground',
      traits: ['ground'],
      signature: 1,
      cost: { metal: 35 },
      buildTimeHours: 2,
      upkeep: { credits: 2 },
    },
    // Танк — heavy front line: high attack and hull, but pricey and bulky to lift.
    tank: {
      faction: 'blue',
      stats: { attack: 22, defense: 14, speed: 40, hp: 46, cargoSize: 3 },
      domain: 'ground',
      traits: ['ground'],
      signature: 2,
      cost: { metal: 120, credits: 30 },
      buildTimeHours: 4,
      upkeep: { credits: 4 },
    },
    // Бомбардировщик — rear-line striker: big attack, paper armour; hits structures.
    bomber: {
      faction: 'blue',
      stats: { attack: 26, defense: 4, speed: 60, hp: 18, cargoSize: 2 },
      domain: 'ground',
      traits: ['ground'],
      signature: 3,
      cost: { metal: 90, credits: 50 },
      buildTimeHours: 3,
      upkeep: { credits: 5 },
    },
    // ПВО — anti-air specialist: shreds bombers, weak on the ground. (Flat stats here
    // are the designer's rough preview; the per-type matrix in groundcombat is combat law.)
    aa: {
      faction: 'blue',
      stats: { attack: 6, defense: 9, speed: 44, hp: 20, cargoSize: 2 },
      domain: 'ground',
      traits: ['ground'],
      signature: 2,
      cost: { metal: 80, credits: 40 },
      buildTimeHours: 3,
      upkeep: { credits: 4 },
    },
    // The player's projection hero — cruiser-tier guns but TRIPLE the hull, and the
    // +5% attack/defense aura it grants its fleet (heroModule). Seeded, not built.
    hero: {
      faction: 'blue',
      stats: { attack: 16, defense: 14, speed: 40, hp: 180 },
      line: 'front',
      traits: ['hero'],
      signature: 6, // a flagship — loud on radar
      cost: { metal: 400, credits: 200 },
      buildTimeHours: 10,
      upkeep: { credits: 8 },
    },
  },
  factions: {},
  buildings: {
    // Every building is worth victory points by TIER — the score module multiplies
    // `scoreValue` by the instance's level, so investing in upgrades (and losing them)
    // moves the scoreboard. Modest next to a planet's 50 base; tune in this data.
    // metal mine — the economy's backbone; each level digs into denser ore and
    // lifts output by +50% (12 → 18 → 27 metal/h), at a steeper cost in kind.
    mine: {
      name: 'Metal Mine',
      cost: { metal: 80 },
      buildTimeHours: 3,
      produces: { metal: 12 },
      hp: 20,
      scoreValue: 4,
      upgrades: [
        { cost: { metal: 140 }, buildTimeHours: 4, produces: { metal: 18 }, hp: 26 },
        { cost: { metal: 230, credits: 50 }, buildTimeHours: 5, produces: { metal: 27 }, hp: 32 },
      ],
    },
    refinery: {
      name: 'Credit Refinery',
      cost: { metal: 110 },
      buildTimeHours: 4,
      produces: { credits: 8 },
      hp: 20,
      scoreValue: 3,
    },
    // tax office — a one-time civic upgrade (no levels): lifts the whole credit take
    // of the inhabited world it sits on by +25% (taxModule). Cannot stack.
    tax_office: {
      name: 'Tax Office',
      cost: { metal: 120, credits: 60 },
      buildTimeHours: 4,
      hp: 16,
      scoreValue: 3,
    },
    // salvage metal rig — the ONLY thing raisable on a dead world (sectorKinds roster);
    // mines the corpse for metal, boosted +30% by the dead world's metal bonus.
    metal_station: {
      name: 'Salvage Metal Rig',
      cost: { metal: 80, credits: 30 },
      buildTimeHours: 4,
      produces: { metal: 30 },
      hp: 20,
      scoreValue: 5,
      upgrades: [
        { cost: { metal: 220, credits: 90 }, buildTimeHours: 6, produces: { metal: 60 }, hp: 30 },
        { cost: { metal: 380, credits: 170 }, buildTimeHours: 8, produces: { metal: 100 }, hp: 40 },
      ],
    },
    barracks: { name: 'Barracks', cost: { metal: 70 }, buildTimeHours: 3, hp: 25, scoreValue: 2 },
    // radar array — projects a detection radius (in jumps) that grows with its
    // level; enemy fleets inside it show up as coarse signatures (not identified).
    radar: {
      name: 'Radar Array',
      cost: { metal: 90, credits: 40 },
      buildTimeHours: 3,
      hp: 18,
      // Detection radius (map units) per level — the single source read by BOTH the
      // core fog (`visibility.ts`, networked view) and the prototype's own vision, so
      // they agree by construction. A radar only paints a SIGNATURE for a node in its
      // outer band that is not already identified, so the reach must clear your own
      // border to the next ring of worlds — on the current map neighbours sit ~205 out
      // (auto-identified, 1 hop) and the next ring ~349, so L1 (400) reaches past 349.
      radarRange: 400,
      scoreValue: 2,
      upgrades: [
        { cost: { metal: 180, credits: 80 }, buildTimeHours: 5, hp: 28, radarRange: 550 },
        { cost: { metal: 300, credits: 140 }, buildTimeHours: 7, hp: 38, radarRange: 700 },
      ],
    },
    // space fortress — only built in an asteroid field; turns the junction into a
    // defended, assaultable strongpoint (it comes with a fixed orbital-AA by default)
    starfort: {
      name: 'Void Fortress',
      cost: { metal: 180, credits: 60 },
      buildTimeHours: 6,
      hp: 70,
      defenseBonus: 0.4,
      scoreValue: 6,
    },
    // Orbital-AA emplacement — a fixed anti-ship battery. It fires on hostile fleets on
    // the near orbit (core `aaStrengthAt` now sums building AA too). Immobile and costly;
    // the player builds it like a fort. It does NOT block ground capture — only ground
    // troops do that — it just bleeds a fleet trying to sit over (or bombard) the world.
    orbital_aa: {
      name: 'Orbital AA',
      cost: { metal: 140, credits: 50 },
      buildTimeHours: 5,
      hp: 30,
      aaDamage: 12,
      scoreValue: 3,
    },
    fort: {
      name: 'Fort',
      cost: { metal: 100 },
      buildTimeHours: 4,
      hp: 40,
      defenseBonus: 0.3,
      scoreValue: 5,
      upgrades: [
        { cost: { metal: 200, credits: 80 }, buildTimeHours: 6, hp: 60, defenseBonus: 0.45 },
        { cost: { metal: 340, credits: 160 }, buildTimeHours: 8, hp: 85, defenseBonus: 0.6 },
      ],
    },
  },
  events: {},
  sectors: {
    empty_space: { name: 'Open space', speedBonus: 0.15, hpBonus: 0 },
    asteroid_field: { name: 'Asteroid field', speedBonus: -0.25, hpBonus: 0.1 },
    nebula: { name: 'Nebula', speedBonus: -0.1, hpBonus: 0.05 },
    ion_storm: { name: 'Ion Storm', speedBonus: -0.35, hpBonus: -0.15 },
    dense_nebula: { name: 'Dense Nebula', speedBonus: -0.2, hpBonus: 0.2 },
    solar_flare_zone: { name: 'Solar Flare Zone', speedBonus: 0.05, hpBonus: -0.25 },
    derelict_graveyard: { name: 'Derelict Graveyard', speedBonus: -0.15, hpBonus: 0.05 },
    deep_void: { name: 'Deep Void', speedBonus: 0.3, hpBonus: -0.1 },
  },
  // Sector kinds (capturable/buildable/orbit) — mirrors SECTOR_TYPES so the kernel's
  // capture-on-arrival treats empty void as uncapturable (matches data/sectorKinds.json).
  sectorKinds: {
    // The province KIND carries the territory score: a `planet` is the prize (50), every
    // other capturable kind the flat 10 (the schema default — so asteroid/nebula/… and the
    // KEY's terrain kinds all score 10 without listing it here).
    planet: { name: 'Planet', scoreValue: 50, capturable: true, buildable: true, orbit: true },
    asteroid: { name: 'Asteroid Field', capturable: true, buildable: true, orbit: false },
    nebula: { name: 'Nebula', capturable: true, buildable: true, orbit: true },
    // Listed only to pin orbit:false — a wreck field is salvageable but not a colony (no
    // orbital layer, so not taxed as an inhabited world), matching SECTOR_TYPES. Without
    // this it fell through to the permissive default (orbit:true) and was wrongly taxed.
    graveyard: { name: 'Derelict Graveyard', capturable: true, buildable: true, orbit: false },
    empty: { name: 'Empty Space', capturable: false, buildable: false, orbit: false },
    debris_field: { name: 'Debris Field', capturable: false, buildable: false, orbit: false },
    // a destroyed planet — re-claimable + metal-rich, but worth only the flat 10; the
    // salvage rig is the one thing buildable there. (Annihilation = a future hero.)
    dead_world: {
      name: 'Dead World',
      scoreValue: 10,
      capturable: true,
      buildable: true,
      orbit: true,
      allowedBuildings: ['metal_station'],
    },
  },
  planetTypes: {
    terran: { name: 'Terran', productionBonus: 0, defenseBonus: 0.1 },
    barren: { name: 'Barren', productionBonus: -0.25, defenseBonus: 0 },
    oceanic: { name: 'Oceanic', productionBonus: 0.15, defenseBonus: 0.05 },
    volcanic: { name: 'Volcanic', productionBonus: 0.25, defenseBonus: -0.05 },
    gas_giant: { name: 'Gas Giant', productionBonus: 0.35, defenseBonus: -0.15 },
    crystalline: { name: 'Crystalline', productionBonus: 0.45, defenseBonus: -0.25 },
    fortress_world: { name: 'Fortress World', productionBonus: -0.15, defenseBonus: 0.4 },
    relic_world: { name: 'Relic World', productionBonus: 0.05, defenseBonus: 0 },
    irradiated: { name: 'Irradiated', productionBonus: 0.2, defenseBonus: 0.15 },
    ringworld: { name: 'Ringworld', productionBonus: 0.3, defenseBonus: 0.1 },
    dead_world: {
      name: 'Dead World',
      productionBonus: 0,
      productionByResource: { metal: 0.3 },
      defenseBonus: 0,
    },
  },
});

// --- sectors -----------------------------------------------------------------

/**
 * Sector-type registry — the whole map is a graph of sectors, each of exactly one
 * type. Types are pure data: add/remove them freely; every type carries its own
 * properties, and rendering + behaviour read from here (no hard-coded sector logic).
 *   core       — terrain key in `data.sectors` (speed/HP bonuses) this type maps to
 *   capturable — can be owned/taken (empty space can't — only traversed)
 *   buildable  — structures can be raised here
 *   orbit      — has the orbital layer; fleets can station in orbit (cities, fortresses)
 *   color      — map accent for the type
 */
export interface SectorType {
  name: string;
  core: string;
  capturable: boolean;
  buildable: boolean;
  orbit: boolean;
  color: string;
  /** Province-centric build roster (the buildings raisable here). Absent = the
   *  default `BUILDABLE` set. Mirrors core `sectorKinds.allowedBuildings`. */
  allowedBuildings?: string[];
}
export const SECTOR_TYPES: Record<string, SectorType> = {
  planet: {
    name: 'Planet',
    core: 'empty_space',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#5fd0ff',
  },
  nebula: {
    name: 'Nebula',
    core: 'nebula',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#8f6dff',
  },
  asteroid: {
    name: 'Asteroid Field',
    core: 'asteroid_field',
    capturable: true,
    buildable: true,
    orbit: false,
    color: '#d6a645',
    allowedBuildings: ['starfort'],
  },
  empty: {
    name: 'Empty Space',
    core: 'empty_space',
    capturable: false,
    buildable: false,
    orbit: false,
    color: '#46606e',
  },
  // new terrains — each maps to a core `data.sectors` entry for its speed/HP bonus
  ion_storm: {
    name: 'Ion Storm',
    core: 'ion_storm',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#6fe3ff',
  },
  dense_nebula: {
    name: 'Dense Nebula',
    core: 'dense_nebula',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#a78bff',
  },
  solar_flare: {
    name: 'Solar Flare Zone',
    core: 'solar_flare_zone',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#ff9f3a',
  },
  graveyard: {
    name: 'Derelict Graveyard',
    core: 'derelict_graveyard',
    capturable: true,
    buildable: true,
    orbit: false,
    color: '#9fb0a8',
  },
  // debris field — a fast but UN-capturable corridor (kind `debris_field` in sectorKinds)
  debris_field: {
    name: 'Debris Field',
    core: 'deep_void',
    capturable: false,
    buildable: false,
    orbit: false,
    color: '#2f4a59',
  },
  // dead world — a destroyed planet (future hero ability); re-claimable, only the salvage rig builds here
  dead_world: {
    name: 'Dead World',
    core: 'deep_void',
    capturable: true,
    buildable: true,
    orbit: true,
    color: '#5a4a4a',
    allowedBuildings: ['metal_station'],
  },
};

// --- the map -----------------------------------------------------------------

/** One sector node. `sector` is its type key (see SECTOR_TYPES); `links` are the
 *  paths to neighbouring sectors; `type` is the planet-type (bonuses) for worlds. */
export interface MapNode {
  id: string;
  owner: string | null;
  x: number;
  y: number;
  sector: string;
  type?: string;
  links: string[];
  buildings?: Array<{ type: string; level?: number }>;
  garrison?: Array<[string, number]>;
}

type KeyNode = Omit<MapNode, 'links'>;

// A SQUARE, ORGANIC contested field: a jittered 7×7 lattice (equal cell spacing, no rigid
// grid look) wired to neighbours by a relative-neighbourhood graph. EXACTLY 12 are 'planet'
// kind — 4 of them START candidates (one per corner region, where players & AI spawn) + 8
// neutral worlds — and the other 37 are non-planet provinces, so the board totals ~970 base
// points (12×50 + 37×10); a solo win needs 450 (SCORE_LIMIT). All planets start NEUTRAL; newGame() seeds
// owners + homes at the chosen starts. The jitter is deterministic (seeded sine hash) →
// reproducible. Square aspect so it reads well in portrait (fills width, pans vertically).
const FIELD = { cols: 7, rows: 7, x0: 150, dx: 145, y0: 150, dy: 145, jitter: 0.4 };
const NON_PLANET_KINDS = [
  'asteroid',
  'nebula',
  'graveyard',
  'ion_storm',
  'dense_nebula',
  'solar_flare',
];
const NEUTRAL_PLANET_TYPES = [
  'oceanic',
  'volcanic',
  'fortress_world',
  'relic_world',
  'gas_giant',
  'irradiated',
  'ringworld',
  'crystalline',
];
// 4 start candidates — one per corner region (inset), spread wide so starts don't crowd.
const START_CELLS = ['1,1', '5,1', '1,5', '5,5'];
// 8 neutral 'planet' worlds, spread through the middle.
const NEUTRAL_PLANET_CELLS = ['3,3', '1,3', '5,3', '3,1', '3,5', '2,2', '4,4', '2,4'];

const cellId = (cell: string): string => {
  const [c, r] = cell.split(',');
  return `C${c}R${r}`;
};
/** Deterministic 0..1 hash for the organic jitter (no Math.random → reproducible map). */
function jhash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildField(): KeyNode[] {
  const starts = new Set(START_CELLS);
  const neutralP = new Set(NEUTRAL_PLANET_CELLS);
  const nodes: KeyNode[] = [];
  let ptIdx = 0; // cycles neutral planet types
  let npIdx = 0; // cycles non-planet terrains
  let i = 0; // jitter index
  for (let row = 0; row < FIELD.rows; row += 1) {
    for (let col = 0; col < FIELD.cols; col += 1) {
      const cell = `${col},${row}`;
      const x = Math.round(
        FIELD.x0 + col * FIELD.dx + (jhash(i * 2) - 0.5) * 2 * FIELD.jitter * FIELD.dx,
      );
      const y = Math.round(
        FIELD.y0 + row * FIELD.dy + (jhash(i * 2 + 1) - 0.5) * 2 * FIELD.jitter * FIELD.dy,
      );
      i += 1;
      const id = cellId(cell);
      if (starts.has(cell)) {
        nodes.push({ id, owner: null, x, y, sector: 'planet', type: 'terran' });
      } else if (neutralP.has(cell)) {
        nodes.push({
          id,
          owner: null,
          x,
          y,
          sector: 'planet',
          type: NEUTRAL_PLANET_TYPES[ptIdx++ % NEUTRAL_PLANET_TYPES.length],
        });
      } else {
        nodes.push({
          id,
          owner: null,
          x,
          y,
          sector: NON_PLANET_KINDS[npIdx++ % NON_PLANET_KINDS.length]!,
        });
      }
    }
  }
  return nodes;
}

const KEY: KeyNode[] = buildField();
/** The 4 worlds players spawn on — the start picker offers these. */
export const START_CANDIDATES: string[] = START_CELLS.map(cellId);

// Wire sectors up as a Relative Neighbourhood Graph: a sector links to another
// ONLY if no third sector lies "between" them (closer to both than they are to
// each other). That gives each sector paths to its immediate neighbours only —
// no long criss-crossing lanes — while the map stays one fully-connected graph
// (an RNG always contains the Euclidean minimum spanning tree). Links are
// symmetric. O(n³), trivial for a few dozen sectors.
function withNeighborLinks(nodes: KeyNode[]): MapNode[] {
  const dist = (a: KeyNode, b: KeyNode): number => Math.hypot(a.x - b.x, a.y - b.y);
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dab = dist(a, b);
      const between = nodes.some((c) => c !== a && c !== b && dist(a, c) < dab && dist(b, c) < dab);
      if (!between) {
        adj.get(a.id)!.add(b.id);
        adj.get(b.id)!.add(a.id);
      }
    }
  }
  return nodes.map((n) => ({ ...n, links: [...adj.get(n.id)!] }));
}

// Bytro-style province map: only real provinces (no "empty" void waypoints), wired
// to their neighbours by shared border (relative-neighbourhood graph). Movement is
// province-to-adjacent; the links ARE the visible path network.
export const MAP: MapNode[] = withNeighborLinks(KEY);

/** Clamp the spread of power-diagram (weighted-Voronoi) weights so no province cell is
 *  ever swallowed by a heavier neighbour. In a power diagram a site keeps a non-empty
 *  cell iff `w_j - w_i ≤ d_ij²` for every other site `j`; the binding case is the
 *  closest pair, so capping the total weight RANGE strictly below the minimum squared
 *  inter-seed distance keeps EVERY cell non-empty. Size ordering is preserved (a bigger
 *  world still claims a little more land) — just never enough to erase a close neighbour
 *  (which left that neighbour with no cell and no border). Mutates `w` in place; a no-op
 *  for <2 seeds or coincident points. */
export function clampPowerWeights(seeds: Array<{ x: number; y: number; w: number }>): void {
  const n = seeds.length;
  if (n < 2) return;
  let minD2 = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = seeds[i]!.x - seeds[j]!.x;
      const dy = seeds[i]!.y - seeds[j]!.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
    }
  }
  if (!Number.isFinite(minD2) || minD2 <= 0) return;
  let wmin = Infinity;
  let wmax = -Infinity;
  for (const s of seeds) {
    if (s.w < wmin) wmin = s.w;
    if (s.w > wmax) wmax = s.w;
  }
  const range = wmax - wmin;
  const cap = minD2 * 0.9; // strictly below the swallow threshold (d_ij² ≥ minD2 for all pairs)
  if (range <= cap || range <= 0) return;
  const k = cap / range;
  for (const s of seeds) s.w = wmin + (s.w - wmin) * k;
}

// Shared stance vocabulary — main.ts routes propose-vs-declare by the same ranks
// the core module enforces (one table, no drift).
export { STANCE_RANK } from '../../packages/shared-core/src/index';

function player(
  id: string,
  name: string,
  faction: string,
  resources: Record<string, number>,
  ai = false,
): Player {
  return { id, name, faction, status: 'active', resources, ...(ai ? { ai: true } : {}) };
}

function fleet(
  id: string,
  owner: string,
  location: string,
  units: Array<[string, number]>,
  landing: Array<[string, number]>,
): Fleet {
  return {
    id,
    owner,
    location,
    movement: null,
    units: units.map(([unit, count]) => ({ unit, count })),
    landing: landing.map(([unit, count]) => ({ unit, count })),
    traits: [],
  };
}

/** Move up to `count` of `unit` out of `src` (mutates src, pruning emptied
 *  stacks) and return the removed stacks. Outside combat a unit type is a single
 *  full-health stack, but this stays correct if combat has split it by HP. */
function takeFromStacks(src: UnitStack[], unit: string, count: number): UnitStack[] {
  let remaining = count;
  const taken: UnitStack[] = [];
  for (const st of src) {
    if (st.unit !== unit || remaining <= 0) continue;
    const move = Math.min(st.count, remaining);
    st.count -= move;
    remaining -= move;
    taken.push(st.hp === undefined ? { unit, count: move } : { unit, count: move, hp: st.hp });
  }
  return taken;
}

/** Fold one stack list into another, coalescing stacks that share the same unit
 *  type *and* HP pool (full-health stacks have `hp` undefined and combine). */
function mergeStacks(base: UnitStack[], add: UnitStack[]): UnitStack[] {
  const out = base.map((st) => ({ ...st }));
  for (const st of add) {
    const match = out.find((o) => o.unit === st.unit && o.hp === st.hp);
    if (match) match.count += st.count;
    else out.push({ ...st });
  }
  return out;
}

// --- taxes: inhabited worlds collect credits --------------------------------
// Armies cost credits in upkeep, but nothing minted them at scale — so a growing
// fleet starved the economy. Now every inhabited world of yours levies a flat
// civic tax; a Tax Office (one-time, no levels) boosts that world's whole credit
// take. Hooks `economy.production`, so the core economy stays generic.
export const TAX_PER_HOUR = 100; // base credits/h from the FIRST inhabited owned world
export const TAX_OFFICE_BONUS = 0.25; // Tax Office: +25% to that world's credit income
export const TAX_DIMINISH = 0.06; // civic tax per world tapers as an empire grows

/** An inhabited world — a normal colonisable planet/cloud with an orbital layer
 *  and the general build roster. Asteroid junctions (no orbit), dead worlds
 *  (salvage-only roster) and empty space are NOT inhabited and pay no tax. */
export function isInhabited(planet: Planet): boolean {
  return hasOrbit(data, planet) && allowedBuildings(data, planet) === undefined;
}

/** Civic credits/hour from ONE inhabited world when its owner holds `n` of them.
 *  Flat TAX_PER_HOUR for a lone world, diminishing as `n` climbs, so total civic
 *  income `n × civicTax(n)` still rises with territory but SUB-linearly — curbing
 *  the runaway snowball where every world paid a flat 100 forever (1→100, 5→~403,
 *  10→~649, 20→~934, 42→~1214 vs the old 100/500/1000/2000/4200). Tune TAX_DIMINISH. */
export function civicTax(n: number): number {
  return TAX_PER_HOUR / (1 + TAX_DIMINISH * Math.max(0, n - 1));
}

/** Count of inhabited worlds a player owns — the `n` fed to {@link civicTax}. */
export function inhabitedWorldCount(state: GameState, owner: string | null): number {
  if (owner === null) return 0;
  let n = 0;
  for (const p of Object.values(state.planets)) if (p.owner === owner && isInhabited(p)) n += 1;
  return n;
}

export const taxModule: GameModule = {
  id: 'tax',
  version: '0.1.0',
  setup(api) {
    // Runs in the `economy.production` pipeline AFTER planetType (see MODULES order),
    // so the civic tax isn't scaled by world richness, while the Tax Office multiplies
    // the world's whole credit take (refinery output + the tax). The per-world tax
    // diminishes with the owner's empire size (civicTax) so income scales sub-linearly.
    api.hook<ResourceBag>('economy.production', (bag, args, h) => {
      const planetId = (args as { planetId?: string }).planetId;
      const planet = planetId ? h.state.planets[planetId] : undefined;
      if (!planet || !isInhabited(planet)) return bag;
      const out: Record<string, number> = { ...bag };
      out.credits = (out.credits ?? 0) + civicTax(inhabitedWorldCount(h.state, planet.owner));
      if (planet.buildings.some((b) => b.type === 'tax_office')) {
        out.credits *= 1 + TAX_OFFICE_BONUS;
      }
      return out;
    });
  },
};

// --- fleet.launch / fleet.merge: form and consolidate mobile fleets ----------
// The core builds units into a planet's garrison; this small module lets a
// player scramble those into a new fleet (ships → units, ground troops →
// landing) so production feeds offense, and fuse two co-located fleets into one.
// A natural next addition to the core.
export const fleetLaunchModule: GameModule = {
  id: 'fleet-ops',
  version: '0.1.0',
  setup(api) {
    api.onAction('fleet.launch', (action, h) => {
      const payload = action.payload as { planetId?: string };
      if (typeof payload?.planetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const planet = h.state.planets[payload.planetId];
      if (!planet) {
        return h.reject('E_NO_PLANET');
      }
      if (planet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (planet.garrison.length === 0) {
        return h.reject('E_EMPTY_GARRISON');
      }
      // A fleet can't sit where one is already stationed-and-idle? Allow stacking.
      const units = planet.garrison.filter(
        (s) => !h.ctx.data.units[s.unit]?.traits.includes('ground'),
      );
      // Immobile emplacements (e.g. orbital AA, traits ['ground','immobile']) are
      // fixed installations: they can't be lifted onto a fleet — the same rule the
      // core army.load enforces with E_IMMOBILE. They are neither ships nor liftable
      // cargo, so they stay behind in the garrison (see the garrison reset below).
      const landing = planet.garrison.filter(
        (s) =>
          h.ctx.data.units[s.unit]?.traits.includes('ground') &&
          !h.ctx.data.units[s.unit]?.traits.includes('immobile'),
      );
      if (units.length === 0) {
        return h.reject('E_NO_SHIPS'); // need at least one ship to form a fleet
      }
      const seq = Object.keys(h.state.fleets).length;
      const id = `fleet:${action.playerId}:${h.ctx.now}:${seq}`;
      h.state.fleets[id] = {
        id,
        owner: action.playerId,
        location: planet.id,
        movement: null,
        units: units.map((s) => ({ unit: s.unit, count: s.count })),
        landing: landing.map((s) => ({ unit: s.unit, count: s.count })),
        traits: [],
        battleId: null,
      };
      // Keep immobile emplacements behind; only ships + liftable ground cargo left.
      planet.garrison = planet.garrison.filter((s) =>
        h.ctx.data.units[s.unit]?.traits.includes('immobile'),
      );
      h.emit('fleet.launched', { fleetId: id, planetId: planet.id, owner: action.playerId });
    });

    // Auto-rally: a freshly-built SHIP doesn't sit in the garrison waiting to be
    // launched — it flies straight to orbit and joins the world's RALLY fleet (the
    // construction output). Ships ordered in one queue thus pool into a single fleet.
    // The rally fleet is tagged 'rally'; pre-existing fleets the player already had on
    // orbit lack the tag, so a new build never silently merges into them. Ground units
    // (and immobile emplacements) stay in the garrison as before.
    api.on('unit.built', (event, h) => {
      const p = event.payload as {
        planetId?: string;
        unit?: string;
        count?: number;
        owner?: string;
      };
      if (
        typeof p?.planetId !== 'string' ||
        typeof p?.unit !== 'string' ||
        typeof p?.owner !== 'string'
      ) {
        return;
      }
      const def = h.ctx.data.units[p.unit];
      if (!def || def.traits.includes('ground')) return; // ground army stays planetside
      const planet = h.state.planets[p.planetId];
      if (!planet || planet.owner !== p.owner) return;
      const want = p.count ?? 0;
      const gi = planet.garrison.findIndex((st) => st.unit === p.unit);
      if (want <= 0 || gi < 0) return;
      const take = Math.min(want, planet.garrison[gi].count);
      if (take <= 0) return;
      // pull the just-built ships out of the garrison the core added them to
      planet.garrison[gi].count -= take;
      if (planet.garrison[gi].count <= 0) planet.garrison.splice(gi, 1);
      let rally = Object.values(h.state.fleets).find(
        (f) =>
          f.owner === p.owner &&
          f.location === planet.id &&
          !f.movement &&
          !f.battleId &&
          f.traits.includes('rally'),
      );
      if (!rally) {
        const seq = Object.keys(h.state.fleets).length;
        rally = {
          id: `fleet:${p.owner}:${h.ctx.now}:${seq}`,
          owner: p.owner,
          location: planet.id,
          movement: null,
          units: [],
          landing: [],
          traits: ['rally'],
          battleId: null,
        };
        h.state.fleets[rally.id] = rally;
      }
      const si = rally.units.findIndex((st) => st.unit === p.unit);
      if (si >= 0) rally.units[si].count += take;
      else rally.units.push({ unit: p.unit, count: take });
    });

    // Fuse `from` into `into` when both are docked, idle and in the same sector.
    // Bringing the fleets together (flying one to the other) is the caller's job;
    // by the time this action runs the two must already share a location.
    api.onAction('fleet.merge', (action, h) => {
      const payload = action.payload as { from?: string; into?: string };
      if (typeof payload?.from !== 'string' || typeof payload?.into !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (payload.from === payload.into) {
        return h.reject('E_SAME_FLEET');
      }
      const from = h.state.fleets[payload.from];
      const into = h.state.fleets[payload.into];
      if (!from || !into) {
        return h.reject('E_NO_FLEET');
      }
      if (from.owner !== action.playerId || into.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (from.battleId || into.battleId) {
        return h.reject('E_IN_BATTLE');
      }
      if (from.movement || into.movement || !from.location || from.location !== into.location) {
        return h.reject('E_NOT_COLOCATED');
      }
      into.units = mergeStacks(into.units, from.units);
      into.landing = mergeStacks(into.landing ?? [], from.landing ?? []);
      // Carried divisions ride `from` — re-point them to `into` BEFORE deleting `from`,
      // or the carrier-destroyed reaper (time.advanced) would mistake them for cargo lost
      // with a sunk ship and delete them. Merge is the one fleet-removal that isn't a death.
      for (const d of Object.values(divisionsOf(h.state))) {
        if (d.carriedBy === payload.from) d.carriedBy = into.id;
      }
      delete h.state.fleets[payload.from];
      h.emit('fleet.merged', {
        from: payload.from,
        into: payload.into,
        owner: action.playerId,
        at: into.location,
      });
    });

    // Peel a chosen set of ships off a docked, idle fleet into a fresh fleet that
    // spawns in the same sector (same orbit). The split must keep ≥1 ship behind
    // and move ≥1 out; carried ground troops stay with the original.
    api.onAction('fleet.split', (action, h) => {
      const payload = action.payload as {
        fleetId?: string;
        take?: Array<{ unit?: string; count?: number }>;
      };
      if (typeof payload?.fleetId !== 'string' || !Array.isArray(payload.take)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const fleet = h.state.fleets[payload.fleetId];
      if (!fleet) {
        return h.reject('E_NO_FLEET');
      }
      if (fleet.owner !== action.playerId) {
        return h.reject('E_FORBIDDEN');
      }
      if (fleet.battleId) {
        return h.reject('E_IN_BATTLE');
      }
      if (fleet.movement || !fleet.location) {
        return h.reject('E_IN_TRANSIT');
      }
      const want = new Map<string, number>();
      for (const t of payload.take) {
        if (typeof t?.unit !== 'string' || typeof t?.count !== 'number' || t.count <= 0) {
          return h.reject('E_BAD_PAYLOAD');
        }
        want.set(t.unit, (want.get(t.unit) ?? 0) + Math.floor(t.count));
      }
      const have = (unit: string) =>
        fleet.units.filter((st) => st.unit === unit).reduce((a, st) => a + st.count, 0);
      let takeTotal = 0;
      for (const [unit, n] of want) {
        if (n > have(unit)) return h.reject('E_NOT_ENOUGH');
        takeTotal += n;
      }
      const shipsTotal = fleet.units.reduce((a, st) => a + st.count, 0);
      if (takeTotal <= 0) {
        return h.reject('E_SPLIT_EMPTY');
      }
      if (takeTotal >= shipsTotal) {
        return h.reject('E_SPLIT_ALL'); // must leave at least one ship in the original
      }
      let taken: UnitStack[] = [];
      for (const [unit, n] of want) taken = taken.concat(takeFromStacks(fleet.units, unit, n));
      fleet.units = fleet.units.filter((st) => st.count > 0);
      const seq = Object.keys(h.state.fleets).length;
      const id = `fleet:${action.playerId}:${h.ctx.now}:${seq}`;
      h.state.fleets[id] = {
        id,
        owner: action.playerId,
        location: fleet.location,
        movement: null,
        units: taken,
        landing: [],
        traits: [],
        battleId: null,
        ...(fleet.orbit ? { orbit: fleet.orbit } : {}),
      };
      h.emit('fleet.split', {
        from: payload.fleetId,
        to: id,
        owner: action.playerId,
        at: fleet.location,
      });
    });

    api.onAction('fleet.engage', (action, h) => {
      const payload = action.payload as { fleetId?: string; targetId?: string };
      if (typeof payload?.fleetId !== 'string' || typeof payload?.targetId !== 'string') {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (payload.fleetId === payload.targetId) return h.reject('E_SAME_FLEET');
      const f = h.state.fleets[payload.fleetId];
      const target = h.state.fleets[payload.targetId];
      if (!f || !target) return h.reject('E_NO_FLEET');
      if (f.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      if (f.owner === target.owner) return h.reject('E_FORBIDDEN');
      if (f.battleId || target.battleId) return h.reject('E_IN_BATTLE');
      if (!f.location || f.movement || target.movement || f.location !== target.location) {
        return h.reject('E_NOT_COLOCATED');
      }
      const battleId = `battle:${h.state.battleSeq++}`;
      const battle: Battle = {
        id: battleId,
        location: f.location,
        phase: 'orbital',
        attacker: { ref: { kind: 'fleet', fleetId: f.id }, owner: f.owner },
        defender: { ref: { kind: 'fleet', fleetId: target.id }, owner: target.owner },
        round: 0,
      };
      h.state.battles[battleId] = battle;
      f.battleId = battleId;
      f.movement = null;
      target.battleId = battleId;
      target.movement = null;
      h.schedule(h.ctx.now + HOUR, 'combat.tick', { battleId });
      h.emit('battle.started', {
        battleId,
        location: f.location,
        phase: 'orbital',
        attacker: f.owner,
        defender: target.owner,
      });
    });
  },
};

// --- assembling the match ----------------------------------------------------

/** A seat in a match: who spawns where, and whether the AI drives it. Up to 4. */
export interface SeatConfig {
  id: string;
  name: string;
  faction: string;
  start: string; // a START_CANDIDATES world id
  ai: boolean;
}
export interface SetupConfig {
  seats: SeatConfig[];
  /** The player's 3 division templates, designed in the main menu and LOCKED for the
   *  session (mobilised in-match via `formation.mobilize`). Absent → DEFAULT_TEMPLATES. */
  templates?: FormationTemplate[];
  /** The player's hero roster (up to 3 loadouts), composed in the main menu. Absent →
   *  DEFAULT_HEROES. In-match instances / capital / respawn land in a later phase. */
  heroes?: HeroLoadout[];
  /** The player's ship blueprints — a module loadout per hull class (the "Верфь"
   *  designer). Frozen at session start (GDD §2). Absent → DEFAULT_SHIP_LOADOUTS. */
  ships?: ShipLoadout[];
}

// --- ground formations (HOI4-style division templates) -----------------------
// A "воинское объединение" is a TEMPLATE of 6 slots, each holding one formation unit
// (or empty). Mobilising it builds those units as a ground army; the division's stats
// are the SUM of its slots PLUS composition synergies. Templates are composed in the
// menu and frozen for the session, giving players a flexible, pre-committed doctrine.

/** The unit ids a template slot may hold — the formation roster (data.units above). */
export const FORMATION_UNITS = ['infantry', 'tank', 'bomber', 'aa'] as const;
export type FormationUnit = (typeof FORMATION_UNITS)[number];
/** Slots per template, and templates per player. */
export const FORMATION_SLOTS = 6;
export const FORMATION_TEMPLATE_COUNT = 3;

/** A division template: a name + exactly FORMATION_SLOTS slots (a unit id or null). */
export interface FormationTemplate {
  name: string;
  slots: (FormationUnit | null)[];
}

/** The three starter templates a player gets before customising them. */
export const DEFAULT_TEMPLATES: FormationTemplate[] = [
  { name: 'Линия', slots: ['infantry', 'infantry', 'infantry', 'infantry', 'tank', 'bomber'] },
  { name: 'Кулак', slots: ['tank', 'tank', 'tank', 'infantry', 'infantry', 'bomber'] },
  { name: 'Налёт', slots: ['bomber', 'bomber', 'tank', 'infantry', 'infantry', null] },
];

/** An active composition synergy (a doctrine bonus the template's mix unlocks). */
export interface FormationSynergy {
  key: string;
  name: string;
  desc: string;
}
/** Aggregate characteristics of a division template — what the designer previews and
 *  what mobilisation/combat read. attack/defense already include synergy multipliers. */
export interface FormationStats {
  count: number;
  byType: Record<FormationUnit, number>;
  attack: number;
  defense: number;
  hp: number;
  cost: Record<string, number>;
  synergies: FormationSynergy[];
}

/** Compute a template's aggregate stats = Σ(slot stats) × composition synergies
 *  (combined-arms / entrenched / armour / air-support). Pure + deterministic; used by
 *  the menu preview and (later) by mobilisation. */
export function formationStats(tpl: FormationTemplate): FormationStats {
  const byType: Record<FormationUnit, number> = { infantry: 0, tank: 0, bomber: 0, aa: 0 };
  let baseAtk = 0;
  let baseDef = 0;
  let hp = 0;
  const cost: Record<string, number> = {};
  for (const slot of tpl.slots) {
    if (!slot) continue;
    const def = data.units[slot];
    if (!def) continue;
    byType[slot] += 1;
    baseAtk += def.stats.attack ?? 0;
    baseDef += def.stats.defense ?? 0;
    hp += def.stats.hp ?? 0;
    for (const [res, amt] of Object.entries(def.cost ?? {})) cost[res] = (cost[res] ?? 0) + amt;
  }
  const count = byType.infantry + byType.tank + byType.bomber + byType.aa;
  // Composition synergies — additive multipliers on attack / defense.
  let atkMul = 1;
  let defMul = 1;
  const synergies: FormationSynergy[] = [];
  if (byType.infantry > 0 && byType.tank > 0 && byType.bomber > 0) {
    atkMul += 0.15;
    defMul += 0.15;
    synergies.push({
      key: 'combined',
      name: 'Комбинированные войска',
      desc: '+15% атака и оборона — есть все три рода войск',
    });
  }
  if (byType.infantry >= 4 && byType.tank === 0 && byType.bomber === 0) {
    defMul += 0.25;
    synergies.push({ key: 'entrench', name: 'Окопались', desc: '+25% оборона — чистая пехота' });
  }
  if (byType.tank >= 3) {
    atkMul += 0.2;
    synergies.push({
      key: 'armor',
      name: 'Танковый кулак',
      desc: '+20% атака — ≥3 танков (прорыв)',
    });
  }
  if (byType.bomber >= 1) {
    atkMul += 0.1;
    synergies.push({
      key: 'air',
      name: 'Авиаподдержка',
      desc: '+10% атака и удар по структурам — есть бомбардировщик',
    });
  }
  if (byType.aa >= 1) {
    defMul += 0.1;
    synergies.push({
      key: 'airdef',
      name: 'ПВО-зонтик',
      desc: '+10% оборона и защита от авиации — есть ПВО',
    });
  }
  return {
    count,
    byType,
    attack: Math.round(baseAtk * atkMul),
    defense: Math.round(baseDef * defMul),
    hp,
    cost,
    synergies,
  };
}

// --- bot favour (approval) scale ---------------------------------------------
// A bot's opinion of each other seat on a 0..100 meter, seeded neutral-friendly. It
// only falls when a player sours it (declares war on the bot, or a sustained war), and
// slowly heals while at peace. A bot NEVER starts a war for expansion (see aiOrders);
// it escalates by tier: normal → embargo (won't trade with you, wired once a session
// market exists) → and only at rock bottom does it declare war back. All tunable.
export const FAVOUR_BASE = 60; // starting favour toward every seat
export const FAVOUR_EMBARGO = 35; // below → the bot embargoes you on the market (future)
export const FAVOUR_WAR = 15; // below → the bot itself declares war (the extreme case)
export const FAVOUR_WAR_DECLARED_HIT = 30; // drop when a seat declares WAR on the bot
export const FAVOUR_SPY_CAUGHT_HIT = 20; // drop when the bot catches that seat's spy red-handed
export const FAVOUR_WAR_DECAY_PER_DAY = 5; // sustained war keeps eroding favour
export const FAVOUR_HEAL_PER_DAY = 6; // peace slowly mends it back toward FAVOUR_BASE

/** A bot's favour toward `player` (FAVOUR_BASE if untracked / not a bot). */
export function botFavour(state: GameState, bot: string, player: string): number {
  return (state as DivState).approval?.[bot]?.[player] ?? FAVOUR_BASE;
}
/** Does `bot` embargo `player` on the market (favour below the embargo line)? */
export function botEmbargoes(state: GameState, bot: string, player: string): boolean {
  return (
    (state as DivState).approval?.[bot] !== undefined &&
    botFavour(state, bot, player) < FAVOUR_EMBARGO
  );
}

/** Default solo skirmish: you (p1) vs one AI (p2), at two of the start candidates. */
export const DEFAULT_SETUP: SetupConfig = {
  seats: [
    { id: 'p1', name: 'Azure Compact', faction: 'blue', start: START_CANDIDATES[0]!, ai: false },
    { id: 'p2', name: 'Crimson Hegemony', faction: 'red', start: START_CANDIDATES[1]!, ai: true },
  ],
};

export function newGame(setup: SetupConfig = DEFAULT_SETUP): GameState {
  const base = createInitialState({
    seed: 'prototype-1',
    version: { data: '0.1.0', manifest: '1' },
  });
  // Every province starts NEUTRAL; the chosen seats below claim + fortify their homeworld.
  const planets: Record<string, Planet> = {};
  for (const n of MAP) {
    planets[n.id] = {
      id: n.id,
      owner: null,
      position: { x: n.x, y: n.y },
      links: n.links,
      terrain: SECTOR_TYPES[n.sector]?.core ?? 'empty_space',
      kind: n.sector, // planet / asteroid / nebula / … — drives capturable (sectorKinds)
      // relative territory weight — planets are the small sectors, fields/clouds bigger
      size: n.sector === 'nebula' ? 1.5 : n.sector === 'asteroid' ? 1.3 : 1,
      planetType: n.type,
      resources: {},
      buildings: [],
      garrison: [],
      traits: [],
    };
  }
  const players: Record<string, Player> = {};
  const fleets: Record<string, Fleet> = {};
  const heroes: Record<string, Hero> = {};
  for (const seat of setup.seats) {
    const home = planets[seat.start];
    if (!home) continue;
    home.owner = seat.id;
    home.buildings = [
      { type: 'mine', level: 1, hp: hpOfLevel('mine', 1) },
      { type: 'radar', level: 1, hp: hpOfLevel('radar', 1) },
      // Anti-ship defence is a building now: an orbital-AA emplacement over the homeworld.
      { type: 'orbital_aa', level: 1, hp: hpOfLevel('orbital_aa', 1) },
    ];
    // Ground defence is what holds a world against capture (an AA battery bleeds a fleet
    // but can't stop a landing — only ground troops do). Seed a starting infantry garrison
    // so the homeworld isn't a free walk-in; mobile ground beyond it comes via divisions.
    home.garrison = [{ unit: 'infantry', count: 3 }];
    players[seat.id] = player(
      seat.id,
      seat.name,
      seat.faction,
      { credits: 260, metal: 320, food: 120, energy: 90, microelectronics: 40 },
      seat.ai,
    );
    fleets[`${seat.id}-1`] = fleet(
      `${seat.id}-1`,
      seat.id,
      seat.start,
      [
        ['hero', 1], // the commander's projection — flagship of the home fleet
        ['cruiser', 2],
        ['scout', 1],
      ],
      [], // no marine landing troops — mobile ground is via the division system now
    );
    // The deployed hero is a projection of the commander, named by their nick: the MAIN
    // (grade-`main`) roster hero, flagship of the home fleet. It respawns at the capital
    // (`home`), which defaults to the homeworld and is re-designatable in-match.
    const roster = !seat.ai && setup.heroes ? setup.heroes : DEFAULT_HEROES;
    const mainHero = roster.find((x) => x.grade === 'main') ?? roster[0];
    const heroId = `hero:${seat.id}`;
    heroes[heroId] = {
      id: heroId,
      owner: seat.id,
      name: seat.name,
      location: seat.start,
      cooldowns: {},
      alive: true,
      grade: mainHero?.grade ?? 'main',
      abilities: mainHero ? [...mainHero.abilities] : [],
      home: seat.start,
      fleetId: `${seat.id}-1`,
    };
  }
  // Everyone starts at PEACE (not the core's war default): no marching through another
  // commander's space and no combat until war is declared (diplomacy.declare).
  const diplomacy: Record<string, DiplomaticStance> = {};
  const ids = setup.seats.map((seat) => seat.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) diplomacy[pairKey(ids[i]!, ids[j]!)] = 'peace';
  // Bots track a favour meter toward every other seat (seeded neutral-friendly). Only a
  // player's aggression lowers it; a bot never wars for expansion (see botDiplomacyModule).
  const approval: Record<string, Record<string, number>> = {};
  for (const seat of setup.seats) {
    if (!seat.ai) continue;
    approval[seat.id] = {};
    for (const other of ids) if (other !== seat.id) approval[seat.id]![other] = FAVOUR_BASE;
  }
  // The player's locked division templates ride into the match; the AI uses the defaults.
  const templates: Record<string, FormationTemplate[]> = {};
  const heroRoster: Record<string, HeroLoadout[]> = {};
  const shipLoadouts: Record<string, ShipLoadout[]> = {};
  const capital: Record<string, string> = {};
  for (const seat of setup.seats) {
    templates[seat.id] = !seat.ai && setup.templates ? setup.templates : DEFAULT_TEMPLATES;
    heroRoster[seat.id] = !seat.ai && setup.heroes ? setup.heroes : DEFAULT_HEROES;
    shipLoadouts[seat.id] = !seat.ai && setup.ships ? setup.ships : DEFAULT_SHIP_LOADOUTS;
    capital[seat.id] = seat.start; // capital defaults to the homeworld; re-designatable in-match
  }
  // `divisions` / `divisionSeq` / `templates` / `groundBattles` / `heroRoster` are
  // prototype-only state (preserved by deepClone); cast past GameState's shape.
  return {
    ...base,
    players,
    planets,
    fleets,
    heroes,
    diplomacy,
    approval,
    sessionMarket: [],
    sessionMarketSeq: 0,
    divisions: {},
    divisionSeq: 0,
    templates,
    groundBattles: {},
    heroRoster,
    shipLoadouts,
    capital,
  } as GameState;
}

/** Net per-hour income for a player: production from owned, un-bombarded worlds
 *  minus unit/garrison upkeep (daily ÷ 24). Drives the HUD's `+/h` deltas. */
export function netIncome(state: GameState, playerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const inhabited = inhabitedWorldCount(state, playerId); // for the diminishing civic tax
  for (const p of Object.values(state.planets)) {
    if (p.owner !== playerId || isBombarded(state, p.id)) continue;
    const mult = 1 + (p.planetType ? (data.planetTypes[p.planetType]?.productionBonus ?? 0) : 0);
    // Credits are settled per-planet so the civic tax + Tax Office boost mirror the
    // core's economy.production pipeline (taxModule); metal accrues straight to `out`.
    let credits = 0;
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      if (!def) continue;
      const produces = buildingLevel(def, b.level).produces;
      for (const res of Object.keys(produces)) {
        const v = (produces[res] ?? 0) * mult;
        if (res === 'credits') credits += v;
        else out[res] = (out[res] ?? 0) + v;
      }
    }
    if (isInhabited(p)) {
      credits += civicTax(inhabited);
      if (p.buildings.some((b) => b.type === 'tax_office')) credits *= 1 + TAX_OFFICE_BONUS;
    }
    if (credits !== 0) out.credits = (out.credits ?? 0) + credits;
  }
  const addUpkeep = (stacks: Array<{ unit: string; count: number }>) => {
    for (const st of stacks) {
      const def = data.units[st.unit];
      if (!def) continue;
      for (const res of Object.keys(def.upkeep))
        out[res] = (out[res] ?? 0) - ((def.upkeep[res] ?? 0) * st.count) / 24;
    }
  };
  for (const f of Object.values(state.fleets))
    if (f.owner === playerId) {
      addUpkeep(f.units);
      if (f.landing) addUpkeep(f.landing);
    }
  for (const p of Object.values(state.planets)) if (p.owner === playerId) addUpkeep(p.garrison);
  return out;
}

/** Max HP of a building level (mirrors the core's per-level data). */
export function hpOfLevel(type: string, level: number): number {
  const def = data.buildings[type];
  if (!def) return 0;
  if (level <= 1) return def.hp;
  return def.upgrades[level - 2]?.hp ?? def.hp;
}

// --- diplomacy (prototype) ---------------------------------------------------
// Stances live in `state.diplomacy` (core D1). `combat.isHostile` now reads them, so
// seeding `peace` (newGame) keeps two players from fighting until one declares war.
// This module exposes the declaration action; `declareWar` is the action builder.
export const diplomacyModule: GameModule = {
  id: 'diplomacy',
  version: '0.1.0',
  setup(api) {
    api.onAction('diplomacy.declare', (action, h) => {
      const p = action.payload as { target?: string; stance?: DiplomaticStance };
      if (typeof p?.target !== 'string' || p.target === action.playerId) {
        return h.reject('E_BAD_TARGET');
      }
      if (!h.state.players[p.target]) return h.reject('E_NO_PLAYER');
      const stance: DiplomaticStance = p.stance ?? 'war';
      // A coalition is between humans only — a bot is never a valid alliance party
      // (server-side rule; the menu greys the option out too).
      if (stance === 'alliance' && isBotPair(h.state, action.playerId, p.target)) {
        return h.reject('E_BOT_ALLIANCE');
      }
      setStance(h.state, action.playerId, p.target, stance);
      h.emit('diplomacy.changed', { a: action.playerId, b: p.target, stance });
    });
  },
};

// --- bot diplomacy: the favour meter reacts to a player's aggression ----------
// Bots are passive-friendly — they never start a war to expand (see aiOrders). This
// module lowers a bot's favour when a seat wrongs it and, only once the meter bottoms
// out, has the bot declare war back (venting to the embargo line so it won't re-war
// every tick). Peace slowly mends favour. The embargo tier (refuse to trade below
// FAVOUR_EMBARGO, reported by botEmbargoes) activates once a session market exists.
export const botDiplomacyModule: GameModule = {
  id: 'bot-diplomacy',
  version: '0.1.0',
  setup(api) {
    // A seat declaring WAR on a bot sours that bot's favour toward the declarer.
    api.on('diplomacy.changed', (event, h) => {
      const { a, b, stance } = event.payload as { a: string; b: string; stance: DiplomaticStance };
      if (stance !== 'war') return;
      const meter = (h.state as DivState).approval?.[b];
      if (!meter || meter[a] === undefined) return; // b isn't a tracked bot vs a
      meter[a] = Math.max(0, meter[a]! - FAVOUR_WAR_DECLARED_HIT);
    });
    // Counter-intel fallout (SPY-2): a bot that catches a spy red-handed (failed
    // attempt, identity burned — the event carries `spy`) sours toward the sender.
    // An anonymous leak (detected clean theft) blames nobody — no favour change.
    api.on('espionage.detected', (event, h) => {
      const { owner, spy } = event.payload as { owner: string; spy?: string };
      if (!spy) return;
      const meter = (h.state as DivState).approval?.[owner];
      if (!meter || meter[spy] === undefined) return; // the victim isn't a tracked bot
      meter[spy] = Math.max(0, meter[spy]! - FAVOUR_SPY_CAUGHT_HIT);
    });
    // Per span: sustained war erodes favour, peace mends it; a bottomed-out meter makes
    // the bot commit to war (once), then vents so it won't thrash war/peace every tick.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) return;
      const days = (span * timeScaleOf(h.ctx)) / DAY;
      const approval = (h.state as DivState).approval;
      if (!approval) return;
      for (const bot of Object.keys(approval)) {
        if (!h.state.players[bot]) continue; // eliminated seat
        const meter = approval[bot]!;
        for (const player of Object.keys(meter)) {
          const atWar = getStance(h.state, bot, player) === 'war';
          meter[player] = atWar
            ? Math.max(0, meter[player]! - FAVOUR_WAR_DECAY_PER_DAY * days)
            : Math.min(FAVOUR_BASE, meter[player]! + FAVOUR_HEAL_PER_DAY * days);
          if (meter[player]! < FAVOUR_WAR && !atWar) {
            setStance(h.state, bot, player, 'war');
            meter[player] = FAVOUR_EMBARGO; // vent: hostile now, but above the war line
            h.emit('diplomacy.changed', { a: bot, b: player, stance: 'war' });
          }
        }
      }
    });
  },
};

// --- session market: a two-sided resource order book -------------------------
// A public per-match book of lots. A SELL lot (ask) escrows goods and offers them
// for credits; a BUY lot (bid) escrows credits and offers them for goods. `market.take`
// fills a lot from the other side; `market.cancel` refunds the owner's escrow. Every
// trade is a pure transfer — credits and goods are conserved, nothing minted. A bot
// that embargoes you (soured favour, botEmbargoes) refuses to let you take its lots —
// this is the diplomacy embargo tier finally biting.
export const MARKET_GOODS = ['metal', 'food', 'energy', 'microelectronics']; // credits = currency
export type MarketSide = 'sell' | 'buy';
export interface MarketLot {
  id: string;
  side: MarketSide;
  owner: string;
  resource: string;
  amount: number; // units remaining on offer (escrowed)
  price: number; // credits per unit
}

/** The live order book (a prototype-only own-key field, preserved by deepClone). */
export function marketLots(state: GameState): MarketLot[] {
  const s = state as DivState;
  return (s.sessionMarket ??= []);
}
/** Add `n` of `res` to a player's treasury (mirrors payCost's subtract form). */
function creditTreasury(state: GameState, playerId: string, res: string, n: number): void {
  const t = state.players[playerId]?.resources;
  if (t) t[res] = (t[res] ?? 0) + n;
}

export const marketModule: GameModule = {
  id: 'market',
  version: '0.1.0',
  setup(api) {
    // Place a lot: a sell (ask) escrows goods; a buy (bid) escrows credits.
    api.onAction('market.list', (action, h) => {
      const p = action.payload as {
        side?: string;
        resource?: string;
        amount?: number;
        price?: number;
      };
      if (p?.side !== 'sell' && p?.side !== 'buy') return h.reject('E_BAD_PAYLOAD');
      if (typeof p.resource !== 'string' || !MARKET_GOODS.includes(p.resource))
        return h.reject('E_BAD_RESOURCE');
      const amount = Math.floor(p.amount ?? 0);
      const price = p.price ?? 0;
      if (!(amount > 0) || !(price >= 0)) return h.reject('E_BAD_PAYLOAD');
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      const escrow = p.side === 'sell' ? { [p.resource]: amount } : { credits: amount * price };
      if (!canAfford(player.resources, escrow)) return h.reject('E_NO_FUNDS');
      payCost(player.resources, escrow);
      const s = h.state as DivState;
      const id = `mk:${action.playerId}:${(s.sessionMarketSeq = (s.sessionMarketSeq ?? 0) + 1)}`;
      marketLots(h.state).push({
        id,
        side: p.side,
        owner: action.playerId,
        resource: p.resource,
        amount,
        price,
      });
      h.emit('market.listed', {
        id,
        side: p.side,
        owner: action.playerId,
        resource: p.resource,
        amount,
        price,
      });
    });

    // Fill (partially) a lot from the other side. Buying from a sell lot pays credits
    // for the escrowed goods; selling into a buy lot gives goods for the escrowed credits.
    api.onAction('market.take', (action, h) => {
      const p = action.payload as { id?: string; amount?: number };
      if (typeof p?.id !== 'string') return h.reject('E_BAD_PAYLOAD');
      const lots = marketLots(h.state);
      const lot = lots.find((l) => l.id === p.id);
      if (!lot) return h.reject('E_NO_LOT');
      if (lot.owner === action.playerId) return h.reject('E_OWN_LOT');
      if (botEmbargoes(h.state, lot.owner, action.playerId)) return h.reject('E_EMBARGO');
      const taker = h.state.players[action.playerId];
      if (!taker || !h.state.players[lot.owner]) return h.reject('E_NO_PLAYER');
      const qty = Math.min(lot.amount, Math.floor(p.amount ?? lot.amount));
      if (!(qty > 0)) return h.reject('E_BAD_PAYLOAD');
      const credits = qty * lot.price;
      if (lot.side === 'sell') {
        if (!canAfford(taker.resources, { credits })) return h.reject('E_NO_FUNDS');
        payCost(taker.resources, { credits }); // taker buys the goods
        creditTreasury(h.state, action.playerId, lot.resource, qty);
        creditTreasury(h.state, lot.owner, 'credits', credits);
      } else {
        if (!canAfford(taker.resources, { [lot.resource]: qty })) return h.reject('E_NO_FUNDS');
        payCost(taker.resources, { [lot.resource]: qty }); // taker sells the goods
        creditTreasury(h.state, action.playerId, 'credits', credits); // from the escrow
        creditTreasury(h.state, lot.owner, lot.resource, qty);
      }
      lot.amount -= qty;
      if (lot.amount <= 0) lots.splice(lots.indexOf(lot), 1);
      h.emit('market.traded', {
        id: lot.id,
        taker: action.playerId,
        owner: lot.owner,
        side: lot.side,
        resource: lot.resource,
        amount: qty,
        price: lot.price,
      });
    });

    // The owner reclaims a lot, refunding its remaining escrow.
    api.onAction('market.cancel', (action, h) => {
      const p = action.payload as { id?: string };
      if (typeof p?.id !== 'string') return h.reject('E_BAD_PAYLOAD');
      const lots = marketLots(h.state);
      const lot = lots.find((l) => l.id === p.id);
      if (!lot) return h.reject('E_NO_LOT');
      if (lot.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      if (lot.side === 'sell') creditTreasury(h.state, lot.owner, lot.resource, lot.amount);
      else creditTreasury(h.state, lot.owner, 'credits', lot.amount * lot.price);
      lots.splice(lots.indexOf(lot), 1);
      h.emit('market.cancelled', { id: lot.id, owner: lot.owner });
    });
  },
};

// --- ground divisions: mobilisation + daily restoration ----------------------
// A division is a cohesive ground formation built from a LOCKED template. It lives in
// `state.divisions` (a prototype-only field, preserved through deepClone), garrisons a
// world, and passively heals there. Combat (resolveGround) + transport land next.

/** A mobilised division in play. */
export interface Division {
  id: string;
  owner: string;
  name: string;
  template: number;
  /** Template counts per type — the regrow target (units rebuild toward this). */
  max: Partial<Record<FormationUnit, number>>;
  units: GroundStack[];
  /** Optional attached officer (OFFICERS key) — its bonuses apply in battle / toughness. */
  officer?: string;
  /** Planet id it garrisons (the world it sits on when not aboard a fleet). */
  location: string;
  /** Fleet id carrying it as cargo, or null/absent when garrisoning `location`.
   *  A carried division is "in the hold": it rides the fleet and does not fight. */
  carriedBy?: string | null;
}

/** Prototype state extended with the division registry, per-player locked templates,
 *  and the live ground-battle clock (planetId → unticked combat-time remainder, ms).
 *  These are non-`GameState` fields, but deepClone preserves them (own-key copy). */
type DivState = GameState & {
  divisions?: Record<string, Division>;
  divisionSeq?: number;
  templates?: Record<string, FormationTemplate[]>;
  groundBattles?: Record<string, number>;
  heroRoster?: Record<string, HeroLoadout[]>;
  shipLoadouts?: Record<string, ShipLoadout[]>;
  capital?: Record<string, string>;
  /** Bot favour toward each other seat: approval[bot][player] on a 0..100 meter. */
  approval?: Record<string, Record<string, number>>;
  /** Session market: a two-sided order book of open lots (sell/buy) + its id counter. */
  sessionMarket?: MarketLot[];
  sessionMarketSeq?: number;
  /** CC-server: per-fleet command-chain, now AUTHORITATIVE STATE (was a client-only plan)
   *  so the server drives it and it runs offline in multiplayer. fleetId → queued steps. */
  orders?: Record<string, QStep[]>;
};
export function divisionsOf(state: GameState): Record<string, Division> {
  const s = state as DivState;
  return (s.divisions ??= {});
}
/** The live ground-battle accumulator (planetId → combat-time remainder not yet
 *  ticked, ms). A world is in here exactly while a ground battle is underway. */
function groundBattlesOf(state: GameState): Record<string, number> {
  const s = state as DivState;
  return (s.groundBattles ??= {});
}
export function templatesOf(state: GameState, playerId: string): FormationTemplate[] {
  return (state as DivState).templates?.[playerId] ?? DEFAULT_TEMPLATES;
}
/** A player's hero roster (the loadouts composed in the menu), or the defaults. */
export function heroRosterOf(state: GameState, playerId: string): HeroLoadout[] {
  return (state as DivState).heroRoster?.[playerId] ?? DEFAULT_HEROES;
}
/** The capital map (playerId → planetId); lazily initialised. The capital is where a
 *  hero respawns and (Phase C) re-fits modules; designatable, defaults to the homeworld. */
function capitalsOf(state: GameState): Record<string, string> {
  const s = state as DivState;
  return (s.capital ??= {});
}
/** A player's current capital planet id, or undefined if unset. */
export function capitalOf(state: GameState, playerId: string): string | undefined {
  return (state as DivState).capital?.[playerId];
}

/** Base passive restoration: +1 HP per unit per day on a friendly planet (hospitals /
 *  hero / officer bonuses raise it — later). */
export const REGEN_PER_UNIT_PER_DAY = 1;

/** Per-unit max HP for a division's type, including any attached officer's toughness. */
function unitMaxHp(div: Division, type: FormationUnit): number {
  const base = GROUND_ROSTER[type]?.hp ?? 1;
  const bonus = div.officer ? (OFFICERS[div.officer]?.hp ?? 0) : 0;
  return base * (1 + bonus);
}

/** Heal + regrow a division toward its template `max` over `days` (per type, capped at
 *  full strength). A fully-dead TYPE regrows; the division as a whole is removed only
 *  when wiped in battle (handled there) — regen never resurrects a 0-unit division. */
export function regenDivision(div: Division, days: number): void {
  if (days <= 0) return;
  const byType: Record<string, GroundStack> = {};
  for (const s of div.units) byType[s.type] = s;
  const next: GroundStack[] = [];
  for (const type of Object.keys(div.max) as FormationUnit[]) {
    const maxCount = div.max[type] ?? 0;
    if (maxCount <= 0) continue;
    const hpEach = unitMaxHp(div, type);
    const maxHp = maxCount * hpEach;
    const cur = byType[type]?.hp ?? 0;
    const healed = Math.min(maxHp, cur + REGEN_PER_UNIT_PER_DAY * maxCount * days);
    const count = healed <= 0 ? 0 : Math.ceil(healed / hpEach);
    if (count > 0) next.push({ type, count, hp: healed, hpEach });
  }
  div.units = next;
}

// --- ground transport: divisions ride a fleet by cargo capacity --------------
// "По грузоподъёмности": a division's transport footprint is the summed `cargoSize`
// of its template, and a fleet carries as many divisions as fit in its ships' summed
// `cargoCapacity`. A carried division is "in the hold" — it rides the fleet and does
// not garrison or fight until unloaded onto a world.

/** A division's transport footprint = Σ template-unit `cargoSize` (stable across
 *  casualties — the hold is reserved for the whole formation). */
export function divisionCargo(div: Division): number {
  let total = 0;
  for (const type of Object.keys(div.max) as FormationUnit[]) {
    total += (div.max[type] ?? 0) * (data.units[type]?.stats.cargoSize ?? 0);
  }
  return total;
}

/** Hold left on a fleet = Σ ship `cargoCapacity` − Σ carried divisions' footprint
 *  − the legacy `landing` army aboard (both share the same hold, billed by cargoSize). */
export function fleetCargoFree(state: GameState, fleet: Fleet): number {
  const cap = sumUnitStat(fleet.units, data, 'cargoCapacity');
  const landingUsed = sumUnitStat(fleet.landing ?? [], data, 'cargoSize');
  let divUsed = 0;
  for (const d of Object.values(divisionsOf(state))) {
    if (d.carriedBy === fleet.id) divUsed += divisionCargo(d);
  }
  return cap - landingUsed - divUsed;
}

// --- ground battle: co-located hostile divisions trade matrix damage ---------
// "Потиково во времени": each owner's divisions on a contested world merge into one
// fighting side (so combat width 12 spans the whole force), the two sides trade
// `damageBuckets` each tick, casualties spread back per division by HP share, a wiped
// division is removed, and the attacker that clears the defenders CAPTURES the world.
// Resolved in discrete ticks as the clock advances — driven by `time.advanced` with a
// per-world remainder, so the tick sequence is the same however finely time is stepped.
// (Near/mid/far lines are a FLEET concept; ground routes damage by the type matrix.)

/** Hours of real time per ground combat tick (a ground assault plays out over hours). */
export const GROUND_TICK_HOURS = 3;
const GROUND_TICK_MS = GROUND_TICK_HOURS * HOUR;
/** Fail-secure cap on ticks resolved in one span (real battles end far sooner). */
const MAX_GROUND_TICKS_PER_SPAN = 1000;

const atWar = (state: GameState, a: string, b: string): boolean =>
  a !== b && getStance(state, a, b) === 'war';

/** The garrisoning (not in-transit) divisions at a world that still have units,
 *  lowest id first (deterministic order). */
function divisionsAt(state: GameState, planetId: string): Division[] {
  return Object.values(divisionsOf(state))
    .filter(
      (d) => d.carriedBy == null && d.location === planetId && d.units.some((u) => u.count > 0),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Merge a side's divisions into one stack list (summed counts per type). Only the
 *  per-type COUNT matters to `damageBuckets`; hp/hpEach here are unused placeholders. */
function mergeSide(divs: Division[]): GroundStack[] {
  const byType = {} as Record<FormationUnit, number>;
  for (const d of divs) for (const u of d.units) byType[u.type] = (byType[u.type] ?? 0) + u.count;
  const out: GroundStack[] = [];
  for (const type of Object.keys(byType) as FormationUnit[]) {
    if (byType[type] > 0) out.push({ type, count: byType[type], hp: byType[type], hpEach: 1 });
  }
  return out;
}

/** A merged side's effective officer = count-weighted mean of its divisions'
 *  attack/defence officer bonuses (per-division hp/atkVs are omitted in the merge). */
function mergeOfficer(divs: Division[]): Officer | undefined {
  let total = 0;
  let atk = 0;
  let def = 0;
  for (const d of divs) {
    const c = d.units.reduce((n, u) => n + u.count, 0);
    if (c <= 0) continue;
    total += c;
    const o = d.officer ? OFFICERS[d.officer] : undefined;
    if (o) {
      atk += (o.atk ?? 0) * c;
      def += (o.def ?? 0) * c;
    }
  }
  if (total <= 0 || (atk === 0 && def === 0)) return undefined;
  return { name: 'merged', atk: atk / total, def: def / total };
}

/** Spread a per-type damage bucket across a side's divisions, proportional to each
 *  stack's current HP; whole units die as the pool drops (per-division `hpEach`). */
function applyBucketsToDivs(divs: Division[], buckets: DamageTable): void {
  for (const type of Object.keys(buckets) as FormationUnit[]) {
    const dmg = buckets[type] ?? 0;
    if (dmg <= 0) continue;
    const stacks: GroundStack[] = [];
    for (const d of divs)
      for (const u of d.units) if (u.type === type && u.count > 0) stacks.push(u);
    const totalHp = stacks.reduce((n, u) => n + u.hp, 0);
    if (totalHp <= 0) continue;
    for (const u of stacks) {
      u.hp = Math.max(0, u.hp - dmg * (u.hp / totalHp));
      u.count = u.hp <= 0 ? 0 : Math.ceil(u.hp / u.hpEach);
    }
  }
  for (const d of divs) d.units = d.units.filter((u) => u.count > 0);
}

/** Drop fully-wiped divisions (last unit gone) from the registry. Survivors keep
 *  their HP; restoration regrows dead TYPES, never a fully-wiped division. */
function reapWipedDivisions(state: GameState): void {
  const divs = divisionsOf(state);
  for (const id of Object.keys(divs)) {
    if (!divs[id]!.units.some((u) => u.count > 0)) delete divs[id];
  }
}

/** Hand a world to the lowest-id attacker present (a non-`defenderOwner` owner),
 *  unless it isn't capturable or a hostile fleet garrison still holds it. The legacy
 *  ground/emplacement garrison is NOT engaged by division combat yet (a documented seam):
 *  a garrisoned world resists division capture until cleared via the fleet-assault path. */
function captureGround(h: HandlerContext, planetId: string, defenderOwner: string | null): void {
  const planet = h.state.planets[planetId];
  if (!planet || !isCapturable(data, planet)) return;
  if (planet.garrison.some((srv) => srv.count > 0)) return;
  // The taker is the lowest-id owner present that is actually AT WAR with the defender —
  // a co-located ally / non-belligerent must never steal the capture.
  const owners = [
    ...new Set(
      divisionsAt(h.state, planetId)
        .filter(
          (d) =>
            d.owner !== defenderOwner &&
            defenderOwner !== null &&
            atWar(h.state, d.owner, defenderOwner),
        )
        .map((d) => d.owner),
    ),
  ].sort();
  const taker = owners[0];
  if (taker === undefined) return;
  const from = planet.owner;
  planet.owner = taker;
  // Emit the SAME event the fleet path uses (`via: 'ground'`), so victory re-evaluates
  // and the UI logs + refreshes — a division-only event had no listener.
  h.emit('planet.captured', { planetId, owner: taker, from, via: 'ground' });
}

/** Whether a world currently hosts a ground battle: its owner's divisions facing a
 *  co-located at-war intruder's. (Undefended/neutral capture is a walk-in, not here.) */
function groundContested(state: GameState, planetId: string): boolean {
  const O = state.planets[planetId]?.owner ?? null;
  if (O === null) return false;
  const divs = divisionsAt(state, planetId);
  return (
    divs.some((d) => d.owner === O) && divs.some((d) => d.owner !== O && atWar(state, d.owner, O))
  );
}

/** Resolve ONE ground tick at a contested world. Returns true if a two-sided fight is
 *  still ongoing afterwards (keep ticking), false once it has resolved. */
function groundTickAt(h: HandlerContext, planetId: string): boolean {
  const O = h.state.planets[planetId]?.owner ?? null;
  if (O === null) return false;
  const divs = divisionsAt(h.state, planetId);
  const defenders = divs.filter((d) => d.owner === O);
  const hostiles = divs.filter((d) => d.owner !== O && atWar(h.state, d.owner, O));
  if (hostiles.length === 0) return false; // no hostiles → no battle
  // One attacker owner at a time: the lowest-id at-war owner engages the defender this
  // tick. Distinct owners are NOT fused into a single side — that would force mutual
  // enemies into an alliance and let them share the combat-width-12 budget. When this
  // attacker captures, the next tick re-evaluates with the NEW owner, so an FFA resolves
  // as a deterministic sequence of pairwise fights (driver re-checks groundContested).
  const foe = [...new Set(hostiles.map((d) => d.owner))].sort()[0]!;
  const attackers = hostiles.filter((d) => d.owner === foe);
  if (defenders.length === 0) {
    captureGround(h, planetId, O); // undefended by division → attacker seizes it
    return false;
  }
  // Both sides present: one simultaneous tick from the pre-tick snapshot.
  const atkOfficer = mergeOfficer(attackers);
  const defOfficer = mergeOfficer(defenders);
  const atkMerged = mergeSide(attackers);
  const defMerged = mergeSide(defenders);
  const toDefender = damageBuckets(GROUND_ROSTER, atkMerged, defMerged, 'atk', atkOfficer);
  const toAttacker = damageBuckets(GROUND_ROSTER, defMerged, atkMerged, 'def', defOfficer);
  applyBucketsToDivs(defenders, toDefender);
  applyBucketsToDivs(attackers, toAttacker);
  reapWipedDivisions(h.state);
  const after = divisionsAt(h.state, planetId);
  const defLeft = after.some((d) => d.owner === O);
  const foeLeft = after.some((d) => d.owner === foe);
  if (!defLeft && foeLeft) {
    captureGround(h, planetId, O); // defenders wiped → attacker captures
    return false;
  }
  return defLeft && foeLeft; // this pairwise fight continues only while both stand
}

/** Drive ground combat over a continuous span: accumulate combat time per world and
 *  resolve one whole tick per GROUND_TICK_MS elapsed. The accumulated time is spent
 *  ACROSS battle transitions — a capture that opens a follow-on fight (new owner faces
 *  the next attacker) keeps ticking within the same span — and only the sub-tick
 *  remainder is carried. So the tick sequence is identical however finely time is
 *  stepped (a single big span === many small spans), which a coarse offline catch-up
 *  and a per-frame live client both depend on (replay / multiplayer determinism). */
function runGroundCombat(h: HandlerContext, elapsed: number): void {
  const battles = groundBattlesOf(h.state);
  // Candidate worlds: any holding a garrisoning division, plus any mid-battle.
  const worlds = new Set<string>(Object.keys(battles));
  for (const d of Object.values(divisionsOf(h.state)))
    if (d.carriedBy == null) worlds.add(d.location);
  for (const planetId of [...worlds].sort()) {
    let acc = (battles[planetId] ?? 0) + elapsed;
    let guard = 0;
    // Tick while there's a whole tick of time AND a live contest; re-check the contest
    // each iteration so a mid-span capture's follow-on fight is resolved here, not
    // discarded (which would diverge from finer stepping).
    while (acc >= GROUND_TICK_MS && guard < MAX_GROUND_TICKS_PER_SPAN) {
      if (!groundContested(h.state, planetId)) break;
      groundTickAt(h, planetId);
      acc -= GROUND_TICK_MS;
      guard += 1;
    }
    // Carry the sub-tick remainder while a contest survives; otherwise the world is
    // settled — drop it (no contest left to spend leftover time on).
    if (groundContested(h.state, planetId)) battles[planetId] = acc % GROUND_TICK_MS;
    else delete battles[planetId];
  }
}

export const divisionModule: GameModule = {
  id: 'division',
  version: '0.1.0',
  setup(api) {
    // Mobilise a division by template on an owned world: pay the summed slot cost, the
    // formation garrisons the world at full strength. (Build time / transport — later.)
    api.onAction('division.mobilize', (action, h) => {
      const p = action.payload as { planetId?: string; template?: number };
      if (typeof p?.planetId !== 'string' || typeof p?.template !== 'number') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const planet = h.state.planets[p.planetId];
      if (!planet) return h.reject('E_NO_PLANET');
      if (planet.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      const tpl = templatesOf(h.state, action.playerId)[p.template];
      if (!tpl) return h.reject('E_NO_TEMPLATE');
      const stats = formationStats(tpl);
      if (stats.count <= 0) return h.reject('E_EMPTY_TEMPLATE');
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      if (!canAfford(player.resources, stats.cost)) return h.reject('E_NO_FUNDS');
      payCost(player.resources, stats.cost);
      const divs = divisionsOf(h.state);
      const ds = h.state as DivState;
      const seq = (ds.divisionSeq ?? 0) + 1;
      ds.divisionSeq = seq;
      const id = `div:${action.playerId}:${seq}`;
      divs[id] = {
        id,
        owner: action.playerId,
        name: tpl.name,
        template: p.template,
        max: { ...stats.byType },
        units: makeSide(GROUND_ROSTER, stats.byType),
        location: p.planetId,
      };
      h.emit('division.mobilized', {
        id,
        owner: action.playerId,
        planetId: p.planetId,
        template: p.template,
      });
    });

    /** Own-key division lookup owned by `playerId` (rejects a poisoned id / a foreign
     *  or missing division — fail-secure, mirroring the artillery `ownFleet` guard). */
    const ownDivision = (h: HandlerContext, id: unknown, playerId: string): Division => {
      if (
        typeof id !== 'string' ||
        !Object.prototype.hasOwnProperty.call(divisionsOf(h.state), id)
      ) {
        h.reject('E_NO_DIVISION');
      }
      const div = divisionsOf(h.state)[id as string]!;
      if (div.owner !== playerId) h.reject('E_FORBIDDEN');
      return div;
    };

    // Load a garrisoning division into a co-located, idle fleet — bounded by the
    // fleet's free hold ("по грузоподъёмности"). A carried division rides the fleet.
    api.onAction('division.load', (action, h) => {
      const p = action.payload as { divisionId?: string; fleetId?: string };
      if (typeof p?.fleetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const div = ownDivision(h, p.divisionId, action.playerId);
      if (div.carriedBy != null) return h.reject('E_ALREADY_LOADED');
      const fleet = requireOwnedIdleFleet(h, p.fleetId, action.playerId); // docked, not in battle
      if (fleet.location !== div.location) return h.reject('E_NOT_COLOCATED');
      if (divisionCargo(div) > fleetCargoFree(h.state, fleet)) return h.reject('E_NO_CARGO');
      div.carriedBy = fleet.id;
      h.emit('division.loaded', {
        id: div.id,
        fleetId: fleet.id,
        owner: action.playerId,
        at: div.location,
      });
    });

    // Unload a carried division onto the world its carrier is docked over. An
    // undefended, capturable hostile/neutral world is seized on the spot (walk-in
    // capture), mirroring fleet capture-on-arrival; otherwise the world's ground
    // battle (if any) is resolved by the continuous-time driver below.
    api.onAction('division.unload', (action, h) => {
      const div = ownDivision(
        h,
        (action.payload as { divisionId?: string })?.divisionId,
        action.playerId,
      );
      if (div.carriedBy == null) return h.reject('E_NOT_LOADED');
      const fleet = requireOwnedIdleFleet(h, div.carriedBy, action.playerId); // docked at a node
      const target = fleet.location;
      div.carriedBy = null;
      div.location = target;
      const planet = h.state.planets[target];
      if (
        planet &&
        planet.owner !== div.owner &&
        isCapturable(data, planet) &&
        (planet.owner === null || atWar(h.state, div.owner, planet.owner)) &&
        !planet.garrison.some((srv) => srv.count > 0) &&
        !divisionsAt(h.state, target).some((d) => d.owner !== div.owner)
      ) {
        const from = planet.owner;
        planet.owner = div.owner;
        // Same event the fleet capture path uses (`via: 'ground'`) → victory + UI react.
        h.emit('planet.captured', { planetId: target, owner: div.owner, from, via: 'ground' });
      }
      h.emit('division.unloaded', {
        id: div.id,
        fleetId: fleet.id,
        owner: action.playerId,
        at: target,
      });
    });

    // Attach / detach an officer (a hero-like leader granting tunable bonuses). The
    // officer's toughness re-scales the current units' HP so attaching it never costs
    // a unit. Pass `officer: null` to detach.
    api.onAction('division.officer', (action, h) => {
      const p = action.payload as { divisionId?: string; officer?: string | null };
      const div = ownDivision(h, p?.divisionId, action.playerId);
      const key = p?.officer ?? null;
      if (key !== null && !Object.prototype.hasOwnProperty.call(OFFICERS, key)) {
        return h.reject('E_NO_OFFICER');
      }
      div.officer = key ?? undefined;
      for (const u of div.units) {
        const newHpEach = unitMaxHp(div, u.type);
        if (newHpEach > 0 && u.hpEach > 0) u.hp *= newHpEach / u.hpEach; // re-toughen, keep count
        u.hpEach = newHpEach;
      }
      h.emit('division.officer', { id: div.id, officer: key, owner: action.playerId });
    });

    // Per-span ground upkeep: lose divisions with their destroyed carrier, resolve
    // tick-based ground battles, then restore survivors on friendly soil.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) return;
      const elapsed = span * timeScaleOf(h.ctx); // clamps a missing/non-positive scale to 1, like every sibling module
      // A division aboard a destroyed carrier is lost with the ship.
      const divs = divisionsOf(h.state);
      for (const id of Object.keys(divs)) {
        const d = divs[id]!;
        if (
          d.carriedBy != null &&
          !Object.prototype.hasOwnProperty.call(h.state.fleets, d.carriedBy)
        ) {
          h.emit('division.lost', { id, owner: d.owner });
          delete divs[id];
        }
      }
      // Tick-based ground combat on contested worlds (real time → discrete ticks).
      runGroundCombat(h, elapsed);
      // Daily restoration: +1 HP/unit/day for a garrisoning division on a friendly
      // planet (not in transit; a wiped division is gone, never resurrected).
      const days = elapsed / DAY;
      if (days <= 0) return;
      for (const div of Object.values(divisionsOf(h.state))) {
        if (div.carriedBy != null) continue; // in transit / in a hold — no restoration
        const planet = h.state.planets[div.location];
        if (!planet || planet.owner !== div.owner) continue; // own planet only
        if (!div.units.some((s) => s.count > 0)) continue; // wiped → gone, never resurrected
        regenDivision(div, days);
      }
    });
  },
};

// --- capital: a designatable home world (hero respawn + module re-fit anchor) -----
// "Назначаемая столица": each player's capital defaults to their homeworld and can be
// moved to any owned inhabited world (e.g. if the old one is lost). Phase B/C: heroes
// respawn here after the death cooldown, and modules are re-fitted here.
export const capitalModule: GameModule = {
  id: 'capital',
  version: '0.1.0',
  setup(api) {
    api.onAction('capital.designate', (action, h) => {
      const p = action.payload as { planetId?: string };
      if (typeof p?.planetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const planet = h.state.planets[p.planetId];
      if (!planet) return h.reject('E_NO_PLANET');
      if (planet.owner !== action.playerId) return h.reject('E_FORBIDDEN');
      if (!isInhabited(planet)) return h.reject('E_NOT_INHABITED'); // a capital must be a real world
      capitalsOf(h.state)[action.playerId] = p.planetId;
      // The capital is the hero respawn anchor: repoint this player's heroes' `home`.
      for (const hero of Object.values(h.state.heroes ?? {})) {
        if (hero.owner === action.playerId) hero.home = p.planetId;
      }
      h.emit('capital.designated', { owner: action.playerId, planetId: p.planetId });
    });
  },
};

/** Validate an order-chain step arriving as an action payload (fail-secure, A05/A08). */
function isQStep(x: unknown): x is QStep {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as { kind?: unknown; to?: unknown; hours?: unknown };
  switch (s.kind) {
    case 'move':
      return typeof s.to === 'string';
    case 'orbit':
    case 'assault':
    case 'load':
    case 'unload':
    case 'bombard':
    case 'repeat':
      return true;
    case 'wait':
      // Finite and bounded: Infinity would wedge the chain forever AND corrupt the
      // JSONB round-trip (JSON.stringify(Infinity) === null). CC-5.1 bounds.
      return (
        typeof s.hours === 'number' &&
        Number.isFinite(s.hours) &&
        s.hours >= 0 &&
        s.hours <= MAX_WAIT_HOURS
      );
    default:
      return false;
  }
}

// CC-server: the fleet order-chain (CC-1..CC-4) promoted from a CLIENT-ONLY plan to
// AUTHORITATIVE, durable state so the server drives it — the chain runs offline in
// multiplayer ("sleep and it plays"). This module only STORES the queue; a host driver
// (netserver's runServerQueues, mirroring runServerAI) pops the head step for an idle fleet
// and issues its actions through the same reducer. Fail-secure: any bad input → rejection,
// and the queue stays JSON-serializable (persisted through deepClone, like `divisions`).
export const orderQueueModule: GameModule = {
  id: 'order-queue',
  version: '0.1.0',
  setup(api) {
    // Resolve the payload's fleet to one this player owns, or an error code (fail-secure).
    const ownedFleet = (h: HandlerContext, playerId: string, fleetId: unknown): Fleet | string => {
      if (typeof fleetId !== 'string') return 'E_BAD_PAYLOAD';
      const f = h.state.fleets[fleetId];
      if (!f) return 'E_NO_FLEET';
      if (f.owner !== playerId) return 'E_FORBIDDEN';
      return f;
    };
    api.onAction('order.enqueue', (action, h) => {
      const p = action.payload as { fleetId?: unknown; step?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      if (!isQStep(p.step)) return h.reject('E_BAD_PAYLOAD');
      const orders = ((h.state as DivState).orders ??= {});
      const q = (orders[f.id] ??= []);
      if (q.length >= MAX_CHAIN_STEPS) return h.reject('E_QUEUE_FULL'); // bounded plans (CC-5.1)
      // Runtime stamps (wait countdown, driver verdict) are never client-supplied.
      const step = { ...p.step } as QStep & { until?: number };
      delete step.until;
      delete step.blocked;
      q.push(step);
    });
    api.onAction('order.clear', (action, h) => {
      const p = action.payload as { fleetId?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const orders = (h.state as DivState).orders;
      if (orders) delete orders[f.id];
    });
    api.onAction('order.pop', (action, h) => {
      const p = action.payload as { fleetId?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const orders = (h.state as DivState).orders;
      const q = orders?.[f.id];
      if (q && q.length) {
        popChainStep(q); // shared rule: shift, or rotate to the tail on a 🔁 chain
        if (q.length === 0) delete orders![f.id];
      }
    });
    api.onAction('order.remove', (action, h) => {
      // Edit one step of the plan (a mis-tap on step 3 of 6 must not cost the plan).
      const p = action.payload as { fleetId?: unknown; index?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const i = p.index;
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) return h.reject('E_BAD_PAYLOAD');
      const orders = (h.state as DivState).orders;
      const q = orders?.[f.id];
      if (!q || i >= q.length) return h.reject('E_NO_STEP');
      q.splice(i, 1);
      if (q.length === 0) delete orders![f.id];
    });
    api.onAction('order.block', (action, h) => {
      // The DRIVER's verdict on a failed head step: pause the chain with its reason
      // instead of silently popping (CC-4.1 minimum). The owner-addressed event lets
      // a connected client toast it; the panel shows it from state on next login.
      const p = action.payload as { fleetId?: unknown; code?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      if (typeof p.code !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(p.code)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const head = (h.state as DivState).orders?.[f.id]?.[0];
      if (!head) return h.reject('E_NO_STEP');
      head.blocked = p.code;
      h.emit('order.blocked', { fleetId: f.id, owner: f.owner, step: head.kind, code: p.code });
    });
    api.onAction('order.retry', (action, h) => {
      // Un-pause a blocked chain: clear the verdict so the driver tries the step again.
      const p = action.payload as { fleetId?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const head = (h.state as DivState).orders?.[f.id]?.[0];
      if (!head || head.blocked === undefined) return h.reject('E_NO_STEP');
      delete head.blocked;
    });
    api.onAction('order.hold', (action, h) => {
      // Stamp the head 'wait' step's resume time — set once, when it reaches the head, so
      // the delayed order counts down from that moment (mirrors the client's waitStatus).
      const p = action.payload as { fleetId?: unknown; until?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      if (typeof p.until !== 'number' || !Number.isFinite(p.until)) return h.reject('E_BAD_PAYLOAD');
      const head = (h.state as DivState).orders?.[f.id]?.[0];
      if (!head || head.kind !== 'wait') return h.reject('E_NO_WAIT');
      head.until = p.until;
      // Put the resume moment on the world timeline: the offline wakeup driver arms by
      // msUntilNextEvent(), so without this the chain would freeze mid-wait until some
      // unrelated event (or a login) happened to tick the room.
      h.schedule(Math.max(p.until, h.ctx.now + 1), 'order.wake', { fleetId: f.id });
    });
    // 'order.wake' exists only to appear on the schedule (see order.hold) — waking the
    // room is the whole job; the queue driver then sees the elapsed wait and pops it.
    api.on('order.wake', () => {});
    // Housekeeping: a destroyed fleet must not leave its chain in state (and in every
    // snapshot) forever. Deterministic sweep on the world clock.
    api.on('time.advanced', (_ev, h) => {
      const st = h.state as DivState;
      const orders = st.orders;
      if (!orders) return;
      for (const fid of Object.keys(orders)) {
        if (!h.state.fleets[fid] || orders[fid]!.length === 0) delete orders[fid];
      }
      if (Object.keys(orders).length === 0) delete st.orders;
    });
  },
};

export const MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  taxModule, // civic tax on inhabited worlds (hooks economy.production, after planetType)
  economyModule,
  movementModule,
  heroModule, // projection hero: fleet combat aura (+5%) + death/respawn
  // The combat family (split along the bus seams). Order matters (invariant #6):
  // orbital stamps orbit on fleet.arrived BEFORE combat engages, and runs its
  // AA/bombard span BEFORE artillery's standoff span — the old internal sequence.
  orbitalModule, // the single near-orbit: stationing, AA fire, bombardment
  combatModule, // melee battles: engage / tick / assault / retreat / capture
  artilleryModule, // standoff fire accrual + barrage orders
  interceptModule, // schedules lane-crossing meetings (resolved by combat)
  captureOnArrivalModule, // walk-in capture now a kernel rule (was client-side seizeSector)
  constructionModule,
  technologyModule, // session research: branch/day-gated techs → effect bonuses + content unlocks
  armyModule,
  victoryModule, // terminal match state from authoritative state (domination / elimination / score / timeout)
  fleetLaunchModule,
  diplomacyModule, // peace-by-default + declare-war action (combat reads state.diplomacy)
  espionageModule, // SPY-1 core module: espionage.spy → time-boxed intel windows (state.intel)
  botDiplomacyModule, // bots: friendly-by-default favour meter → embargo/war only when provoked
  marketModule, // session resource market: two-sided order book (sell/buy lots), embargo-gated
  divisionModule, // ground divisions: mobilise from a template + daily restoration
  capitalModule, // designatable capital (hero respawn / module re-fit anchor)
  orderQueueModule, // CC-server: authoritative per-fleet command-chain (server-driven, offline-safe)
];

export const kernel = createKernel(MODULES);

// Win at 450 of the board's ~970 base points (12 planets×50 + 37 provinces×10). Set
// below the ~60% domination line so a decisive-but-not-total lead — a fistful of planets
// plus built-up infrastructure — can win the SCORE race first, making the score/building
// system (scoreValue) meaningful instead of vestigial vs conquest. Tunable single source
// of truth, also read by the HUD score readout.
export const SCORE_LIMIT = 450;
export function ctx(now: number): Context {
  return { now, data, config: { timeScale: 1, victory: { scoreLimit: SCORE_LIMIT } } };
}

export interface StepOut {
  state: GameState;
  events: DomainEvent[];
  error?: string;
}

/** Advance the world to `now`, collecting events. */
export function advance(state: GameState, now: number): StepOut {
  if (now <= state.time) return { state, events: [] };
  const r = kernel.advanceTo(state, ctx(now));
  if (!r.ok) return { state, events: [], error: r.code };
  return { state: r.state, events: r.events };
}

/** Apply a player order at the current world time (advancing first if needed). */
export function order(state: GameState, action: Action, now: number): StepOut {
  const advanced = advance(state, now);
  const r = kernel.applyAction(advanced.state, action, ctx(Math.max(now, advanced.state.time)));
  if (!r.ok) return { state: advanced.state, events: advanced.events, error: r.code };
  return { state: r.state, events: [...advanced.events, ...r.events] };
}

// --- action builders ---------------------------------------------------------

let seqCounter = 0;
const act = (playerId: string, type: string, payload: unknown): Action => ({
  id: `ui:${playerId}:${seqCounter++}`,
  type,
  playerId,
  payload,
  issuedAt: 0,
});

export const moveFleet = (playerId: string, fleetId: string, to: string) =>
  act(playerId, 'fleet.move', { fleetId, to });
/** March to a continuous point ON a lane (Bytro-style): the army routes to the
 *  road and parks at fraction `t` along (`from`,`to`) instead of at a node. */
export const moveFleetEdge = (
  playerId: string,
  fleetId: string,
  edge: { from: string; to: string; t: number },
) => act(playerId, 'fleet.move', { fleetId, toEdge: edge });
export const stopFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.stop', { fleetId });
// A single orbit (GDD §7.4): the only value is 'near' — "enter orbit".
export const orbitFleet = (playerId: string, fleetId: string, orbit: 'near' = 'near') =>
  act(playerId, 'fleet.orbit', { fleetId, orbit });
export const assaultFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.assault', { fleetId });
export const retreatFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.retreat', { fleetId });
export const bombardFleet = (playerId: string, fleetId: string, on: boolean) =>
  act(playerId, 'fleet.bombard', { fleetId, on });
/** Focus an artillery fleet's standoff fire on one enemy fleet (targetId), or
 *  clear (targetId null) to auto-target the nearest hostile in range. */
export const barrageFleet = (playerId: string, fleetId: string, targetId: string | null) =>
  act(playerId, 'fleet.barrage', { fleetId, targetId });
/** Set an artillery fleet's rules of engagement (passive/return/standard/aggressive). */
export const barrageModeFleet = (playerId: string, fleetId: string, mode: string) =>
  act(playerId, 'fleet.barrageMode', { fleetId, mode });
export const loadArmy = (playerId: string, fleetId: string, unit: string, count = 1) =>
  act(playerId, 'army.load', { fleetId, unit, count });
export const unloadArmy = (playerId: string, fleetId: string, unit: string, count = 1) =>
  act(playerId, 'army.unload', { fleetId, unit, count });
export const launchFleet = (playerId: string, planetId: string) =>
  act(playerId, 'fleet.launch', { planetId });
export const mergeFleet = (playerId: string, from: string, into: string) =>
  act(playerId, 'fleet.merge', { from, into });
export const splitFleet = (
  playerId: string,
  fleetId: string,
  take: Array<{ unit: string; count: number }>,
) => act(playerId, 'fleet.split', { fleetId, take });
export const buildBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.construct', { planetId, building });
export const upgradeBuilding = (playerId: string, planetId: string, building: string) =>
  act(playerId, 'building.upgrade', { planetId, building });
export const buildUnit = (playerId: string, planetId: string, unit: string, count = 1) =>
  act(playerId, 'unit.build', { planetId, unit, count });
export const engageFleet = (playerId: string, fleetId: string, targetId: string) =>
  act(playerId, 'fleet.engage', { fleetId, targetId });
/** Begin researching a session technology (one active at a time — technologyModule). */
export const researchTech = (playerId: string, technology: string) =>
  act(playerId, 'technology.research', { technology });
/** Declare war on (or otherwise re-stance) another commander. */
export const declareWar = (playerId: string, target: string, stance: DiplomaticStance = 'war') =>
  act(playerId, 'diplomacy.declare', { target, stance });
/** Steal a time-boxed intel window on another commander (SPY-1 core module):
 *  `treasury` / `fleets` spy on the player; `planet` needs the world's id too. */
export const spyOn = (
  playerId: string,
  target: string,
  kind: 'treasury' | 'planet' | 'fleets',
  planetId?: string,
) => act(playerId, 'espionage.spy', { target, kind, ...(planetId ? { planetId } : {}) });

// --- CC-1: fleet order queue (command chains) -------------------------------
// A queued step is one intent a fleet runs when it next falls idle. The host driver
// (main.ts `driveQueues`) pops the head step per fleet each frame, so a chain like
// [move A, move B, assault] executes hands-off across real hours. The pure, testable
// pieces live here; the mutable queue + UI live in main.ts. Later bricks add timed and
// reactive (auto-assault / auto-launch on contact) steps on top of this shape.
export type QStep = (
  | { kind: 'move'; to: string } // route to a world, then hold for the next step
  | { kind: 'orbit' } // enter orbit over the fleet's current world
  | { kind: 'assault' } // land carried troops (enters orbit first when needed)
  | { kind: 'load' } // re-embark the liftable garrison here (pick your troops back up)
  | { kind: 'unload' } // drop the carried troops onto the world the fleet is docked over
  | { kind: 'bombard' } // start bombarding the world here (enters orbit first when needed)
  | { kind: 'wait'; hours: number; until?: number } // hold N game-hours, then continue (delayed order)
  | { kind: 'repeat' } // 🔁 loop marker: finished steps rotate to the tail — patrol until cleared
) & { blocked?: string }; // set by the DRIVER when the step's order was rejected: the chain
// pauses on the failed step with its E_* reason instead of silently skipping (CC-4.1 minimum)

/** Chain bounds (CC-5.1): steps per fleet and the longest single `wait` (game-hours). */
export const MAX_CHAIN_STEPS = 32;
export const MAX_WAIT_HOURS = 24 * 30;

/** A fleet may run its next queued step only when idle — not in transit, not locked in
 *  a battle. (A fleet parked on a lane counts as idle; its next move routes from there.) */
export function fleetIdle(fleet: Fleet): boolean {
  return !fleet.movement && !fleet.battleId;
}

/** The kernel action(s) a queued step issues for `fleet`. An assault enters orbit first
 *  when the fleet isn't already there (orbit is instant), mirroring the AI auto-capture
 *  pass. Pure — returns intents; the caller applies them. */
export function stepActions(me: string, fleetId: string, step: QStep, fleet: Fleet): Action[] {
  switch (step.kind) {
    case 'move':
      return [moveFleet(me, fleetId, step.to)];
    case 'orbit':
      return [orbitFleet(me, fleetId)];
    case 'assault':
      return fleet.orbit === 'near'
        ? [assaultFleet(me, fleetId)]
        : [orbitFleet(me, fleetId), assaultFleet(me, fleetId)];
    case 'load':
    case 'unload':
      // (Un)loading depends on the world's garrison / the fleet's hold, not just the
      // fleet, so the driver computes it via (un)loadHereActions(state, me, fleet).
      return [];
    case 'bombard':
      // Starting a bombardment needs near orbit, like an assault (orbit is instant).
      return fleet.orbit === 'near'
        ? [bombardFleet(me, fleetId, true)]
        : [orbitFleet(me, fleetId), bombardFleet(me, fleetId, true)];
    case 'wait':
      // A pure hold — issues no order; the driver counts it down via waitStatus.
      return [];
    case 'repeat':
      // The 🔁 loop marker issues nothing itself — the drivers rotate it (popChainStep).
      return [];
  }
}

/** Drop a chain's finished head IN PLACE — and when the chain carries a 🔁 repeat
 *  marker, rotate the head to the tail (cleansed of its runtime stamps) instead of
 *  discarding it, so `[A, B, 🔁]` patrols A→B→A→… until cleared. One shared rule for
 *  the authoritative `order.pop` and the single-player driver. */
export function popChainStep(steps: QStep[]): void {
  const head = steps.shift();
  if (!head) return;
  if (steps.some((st) => st.kind === 'repeat') || (head.kind === 'repeat' && steps.length > 0)) {
    const fresh = { ...head } as QStep & { until?: number };
    delete fresh.until; // a re-queued wait re-counts from when it's next reached
    delete fresh.blocked;
    steps.push(fresh);
  }
}

/**
 * Where a `wait` step stands: its absolute resume time (started lazily from `now` the
 * first time it's reached) and whether the hold has elapsed. Pure — the driver persists
 * the returned `until` back onto the step so the countdown survives across frames.
 */
export function waitStatus(
  step: { hours: number; until?: number },
  now: number,
  hourMs: number,
): { until: number; done: boolean } {
  const until = step.until ?? now + step.hours * hourMs;
  return { until, done: now >= until };
}

/** The squadron-trait ship stacks aboard a fleet — what a carrier launches as a strike
 *  wing (squadrons-roadmap SQ-1.1: launch-as-unit). Pure. */
export function squadronTake(fleet: Fleet): Array<{ unit: string; count: number }> {
  return fleet.units
    .filter((st) => st.count > 0 && (data.units[st.unit]?.traits.includes('squadron') ?? false))
    .map((st) => ({ unit: st.unit, count: st.count }));
}

// --- squadron fuel / rearm counter (squadrons-roadmap SQ-2.1) -----------------
// A launched wing has a limited sortie budget: each strike burns one `fuel`, and when
// it runs dry the wing drops onto a `rearmRounds` cooldown — "back on the carrier",
// unavailable — before it refuels and can fly again. A pure, deterministic counter that
// lives in state (like heroes.cooldowns), JSON-serializable. The patrol loop (SQ-4.1)
// drives it; here it's just the state machine + its guards.

/** A wing's sortie budget: `fuel` strikes left before rearm, `rearming` rounds left on
 *  the rearm cooldown (0 = flight-ready). */
export interface SortieState {
  fuel: number;
  rearming: number;
}

/** The wing's max sortie budget + rearm length, read from its squadron unit's stats
 *  (schema defaults 0). Reads the FIRST squadron-trait stack of the fleet. */
export function sortieSpec(fleet: Fleet): { maxFuel: number; rearmRounds: number } {
  const st = fleet.units.find(
    (s) => s.count > 0 && (data.units[s.unit]?.traits.includes('squadron') ?? false),
  );
  const u = st ? data.units[st.unit]?.stats : undefined;
  return {
    maxFuel: Math.max(0, Math.floor(u?.fuel ?? 0)),
    rearmRounds: Math.max(0, Math.floor(u?.rearmRounds ?? 0)),
  };
}

/** A fresh, fully-fuelled wing. */
export function freshSortie(maxFuel: number): SortieState {
  return { fuel: Math.max(0, Math.floor(maxFuel)), rearming: 0 };
}

/** Flight-ready = not mid-rearm and has fuel to burn. */
export function canSortie(s: SortieState): boolean {
  return s.rearming <= 0 && s.fuel > 0;
}

/** Burn one sortie. When the last of the fuel goes the wing drops onto a rearm cooldown
 *  of `rearmRounds` (unavailable until it counts back down). A spend while not
 *  flight-ready is a no-op — guard with canSortie first. */
export function spendSortie(s: SortieState, rearmRounds: number): SortieState {
  if (!canSortie(s)) return s;
  const fuel = s.fuel - 1;
  return fuel <= 0
    ? { fuel: 0, rearming: Math.max(1, Math.floor(rearmRounds)) }
    : { fuel, rearming: 0 };
}

/** Advance the rearm cooldown one round; when it elapses the wing refuels to max and is
 *  flight-ready again. A wing that isn't rearming is unchanged. */
export function tickRearm(s: SortieState, maxFuel: number): SortieState {
  if (s.rearming <= 0) return s;
  const rearming = s.rearming - 1;
  return rearming <= 0
    ? { fuel: Math.max(0, Math.floor(maxFuel)), rearming: 0 }
    : { fuel: s.fuel, rearming };
}

// --- squadron strike radius (squadrons-roadmap SQ-3.1) -----------------------
// A launched wing reaches only nodes inside `strikeRange` (Euclidean map units) of its
// launch / carrier node — the same distance model as radarRange. A carrier outside the
// target's radius can't strike it. Pure.

/** The wing's strike radius (map units) — the longest `strikeRange` among its live
 *  squadron ships. 0 = carries no strike wing. */
export function squadronStrikeRange(fleet: Fleet): number {
  let r = 0;
  for (const st of fleet.units) {
    if (st.count > 0 && (data.units[st.unit]?.traits.includes('squadron') ?? false)) {
      r = Math.max(r, data.units[st.unit]?.stats.strikeRange ?? 0);
    }
  }
  return r;
}

/** Is `target` within `range` (Euclidean map units) of `from`? Boundary inclusive — a
 *  target sitting exactly on the radius edge is reachable. */
export function withinRange(
  from: { x: number; y: number },
  target: { x: number; y: number },
  range: number,
): boolean {
  return Math.hypot(target.x - from.x, target.y - from.y) <= range;
}

/** Can the wing strike `targetPos` from its launch node at `fromPos`? Only a real strike
 *  wing (range > 0) whose target lies inside the radius (SQ-3.1). */
export function squadronReaches(
  fleet: Fleet,
  fromPos: { x: number; y: number },
  targetPos: { x: number; y: number },
): boolean {
  const r = squadronStrikeRange(fleet);
  return r > 0 && withinRange(fromPos, targetPos, r);
}

// --- squadron patrol (squadrons-roadmap SQ-4.1) ------------------------------
// A wing left on patrol auto-strikes an enemy that enters its radius, burning a sortie
// (SQ-2.1) each time; when it runs dry it rearms and then resumes — no live player in the
// moment, fully deterministic. The pure decision core lives here; the frame-loop driver
// (main.ts, mirrors autoEngage/driveQueues) issues the strike order, burns the sortie,
// and ticks the rearm on a game-hour cadence.

/** A standing patrol: guard `center` out to `radius` with the wing's sortie budget. */
export interface Patrol {
  center: { x: number; y: number };
  radius: number;
  sortie: SortieState;
}

/** The contact this patrol strikes this round: the lowest-id enemy inside the radius,
 *  and only while the wing is flight-ready (fuel left, not rearming). Stable tie-break by
 *  id — the same rule orbital AA / lane intercept use. Pure; null = hold fire. */
export function patrolTarget(
  patrol: Patrol,
  enemies: Array<{ id: string; pos: { x: number; y: number } }>,
): string | null {
  if (!canSortie(patrol.sortie)) return null;
  let best: string | null = null;
  for (const e of enemies) {
    if (withinRange(patrol.center, e.pos, patrol.radius) && (best === null || e.id < best)) {
      best = e.id;
    }
  }
  return best;
}

/** One reactive-scramble tick for a patrolling wing (CC-4 — "auto-sortie at an identified
 *  target in vision + range"): pick the in-range contact (SQ-4.1) and launch at it — engage
 *  if co-located, else fly to intercept its node — burning one fuel (SQ-2.1). `targets` are
 *  the pre-filtered hostile, identified contacts that are sitting on a node. Returns the
 *  order to issue (null = hold fire) plus the wing's new sortie state. Pure — the driver
 *  gathers the world (vision + diplomacy) and issues the order. */
export function scrambleOrder(
  me: string,
  fleet: Fleet,
  patrol: Patrol,
  targets: Array<{ id: string; location: string; pos: { x: number; y: number } }>,
  rearmRounds: number,
): { action: Action | null; sortie: SortieState } {
  const pick = patrolTarget(patrol, targets);
  if (pick === null) return { action: null, sortie: patrol.sortie };
  const foe = targets.find((t) => t.id === pick)!;
  const action =
    fleet.location === foe.location
      ? engageFleet(me, fleet.id, foe.id)
      : moveFleet(me, fleet.id, foe.location);
  return { action, sortie: spendSortie(patrol.sortie, rearmRounds) };
}

/**
 * Actions to re-embark the liftable garrison of the fleet's CURRENT world back into its
 * cargo — the "auto-load after capture" step. After a defended assault the storming
 * troops become the world's garrison (combat.ts capturePlanet), so this picks them up
 * again to carry onward, letting one army leapfrog a whole chain of worlds unattended.
 * Only lifts from a world you own; skips ships/immobile emplacements; respects cargo. Pure.
 */
export function loadHereActions(state: GameState, me: string, fleet: Fleet): Action[] {
  const at = fleet.location;
  if (at === null) return [];
  const planet = state.planets[at];
  if (!planet || planet.owner !== me) return []; // only your own world's troops are liftable
  let free = fleetCargoFree(state, fleet);
  const out: Action[] = [];
  for (const st of planet.garrison) {
    const u = data.units[st.unit];
    if (!u || st.count <= 0 || u.domain !== 'ground') continue; // ships/AA aren't cargo
    if (u.traits.includes('immobile')) continue; // fixed emplacements can't be lifted (E_IMMOBILE)
    const size = u.stats.cargoSize || 1;
    const fit = Math.min(st.count, Math.floor(free / size));
    if (fit <= 0) continue; // no room left
    out.push(loadArmy(me, fleet.id, st.unit, fit));
    free -= fit * size;
  }
  return out;
}

/** The unload orders for everything in `fleet`'s hold onto the world it's docked
 *  over — the symmetric partner of loadHereActions ("drop the troops off here").
 *  Mirrors the live `army.unload` preconditions: just a world under the fleet. Pure. */
export function unloadHereActions(state: GameState, me: string, fleet: Fleet): Action[] {
  if (fleet.location === null || !state.planets[fleet.location]) return [];
  const out: Action[] = [];
  for (const st of fleet.landing ?? []) {
    if (st.count > 0) out.push(unloadArmy(me, fleet.id, st.unit, st.count));
  }
  return out;
}

// --- CC-server: authoritative order-chain — actions + the server-side driver core -------

/** Append one step to a fleet's authoritative order chain (CC-server). */
export const orderEnqueue = (playerId: string, fleetId: string, step: QStep) =>
  act(playerId, 'order.enqueue', { fleetId, step });
/** Drop a fleet's whole order chain. */
export const orderClear = (playerId: string, fleetId: string) =>
  act(playerId, 'order.clear', { fleetId });
/** Drop the head step (the driver pops after issuing it / after a wait elapses). */
export const orderPop = (playerId: string, fleetId: string) =>
  act(playerId, 'order.pop', { fleetId });
/** Remove one step of the chain by index (plan editing — a mis-tap costs one tap). */
export const orderRemove = (playerId: string, fleetId: string, index: number) =>
  act(playerId, 'order.remove', { fleetId, index });
/** Pause the chain on its failed head step with the rejection's E_* reason (driver verdict). */
export const orderBlock = (playerId: string, fleetId: string, code: string) =>
  act(playerId, 'order.block', { fleetId, code });
/** Clear a blocked head step's verdict so the driver tries it again. */
export const orderRetry = (playerId: string, fleetId: string) =>
  act(playerId, 'order.retry', { fleetId });
/** Stamp the head 'wait' step's resume time (set once when the step reaches the head). */
export const orderHold = (playerId: string, fleetId: string, until: number) =>
  act(playerId, 'order.hold', { fleetId, until });

/** One tick of the SERVER-SIDE order-chain driver (CC-server): for every fleet whose
 *  authoritative chain is at the head and the fleet is IDLE, the actions to issue plus how
 *  to advance the queue. Pure — the host (netserver.runServerQueues) applies the actions
 *  and issues the pop / hold through the same authoritative room, so the chain runs even
 *  with nobody connected. Mirrors the client driveQueues() but reads `state.orders` and
 *  reuses the identical tested step helpers (stepActions / loadHereActions / waitStatus). */
export function serverQueueActions(
  state: GameState,
  now: number,
): Array<{ fleetId: string; owner: string; actions: Action[]; pop: boolean; holdUntil?: number; fail?: string }> {
  const orders = (state as DivState).orders ?? {};
  const out: Array<{ fleetId: string; owner: string; actions: Action[]; pop: boolean; holdUntil?: number; fail?: string }> = [];
  for (const [fid, steps] of Object.entries(orders)) {
    const f = state.fleets[fid];
    if (!f || steps.length === 0) continue; // stale entry — the module sweeps it on advance
    if (!fleetIdle(f)) continue; // in transit / battle → hold the chain
    const step = steps[0]!;
    if (step.blocked !== undefined) continue; // paused on a failed step — needs the player
    if (step.kind === 'repeat') {
      // Rotate the 🔁 marker to the tail so the next real step comes up; an orphan
      // marker (nothing left to repeat) just idles.
      if (steps.length > 1) out.push({ fleetId: fid, owner: f.owner, actions: [], pop: true });
      continue;
    }
    if (step.kind === 'wait') {
      const w = waitStatus(step, now, HOUR);
      if (step.until === undefined)
        out.push({ fleetId: fid, owner: f.owner, actions: [], pop: false, holdUntil: w.until });
      else if (w.done) out.push({ fleetId: fid, owner: f.owner, actions: [], pop: true });
      continue; // still counting down → do nothing this tick
    }
    const actions =
      step.kind === 'load'
        ? loadHereActions(state, f.owner, f)
        : step.kind === 'unload'
          ? unloadHereActions(state, f.owner, f)
          : stepActions(f.owner, fid, step, f);
    // A planned (un)load with nothing to move is a broken plan, not a no-op — the
    // garrison the player counted on is gone (or the hold is empty). Fail loudly.
    if ((step.kind === 'load' || step.kind === 'unload') && actions.length === 0) {
      out.push({ fleetId: fid, owner: f.owner, actions: [], pop: false, fail: 'E_NO_CARGO' });
      continue;
    }
    out.push({ fleetId: fid, owner: f.owner, actions, pop: true });
  }
  return out;
}
/** Place a market lot: `sell` escrows `amount` of `resource` for `price` credits/unit;
 *  `buy` escrows the credits and offers to buy that much of `resource`. */
export const marketList = (
  playerId: string,
  side: MarketSide,
  resource: string,
  amount: number,
  price: number,
) => act(playerId, 'market.list', { side, resource, amount, price });
/** Take (fill) up to `amount` from an open lot — buy from a sell lot / sell into a buy lot. */
export const marketTake = (playerId: string, id: string, amount?: number) =>
  act(playerId, 'market.take', amount === undefined ? { id } : { id, amount });
/** Reclaim your own lot, refunding its remaining escrow. */
export const marketCancel = (playerId: string, id: string) =>
  act(playerId, 'market.cancel', { id });
/** Mobilise division template `template` (0-based) on your world `planetId`. */
export const mobilizeDivision = (playerId: string, planetId: string, template: number) =>
  act(playerId, 'division.mobilize', { planetId, template });
/** Load a garrisoning division into a co-located, idle fleet (by free hold). */
export const loadDivision = (playerId: string, divisionId: string, fleetId: string) =>
  act(playerId, 'division.load', { divisionId, fleetId });
/** Unload a carried division onto the world its carrier is docked over. */
export const unloadDivision = (playerId: string, divisionId: string) =>
  act(playerId, 'division.unload', { divisionId });
/** Attach an officer (OFFICERS key) to a division, or detach with `officer = null`. */
export const setDivisionOfficer = (playerId: string, divisionId: string, officer: string | null) =>
  act(playerId, 'division.officer', { divisionId, officer });
/** Designate one of your inhabited worlds as your capital (hero respawn / re-fit anchor). */
export const designateCapital = (playerId: string, planetId: string) =>
  act(playerId, 'capital.designate', { planetId });

/** Can `mover`'s fleets enter/traverse a province owned by `owner`? Neutral, your own,
 *  and players you're at war / pact / alliance with are passable; a player you're at
 *  PEACE with is blocked (you'd have to declare war first). */
export function canTraverse(state: GameState, mover: string, owner: string | null): boolean {
  if (owner == null || owner === mover) return true;
  return getStance(state, mover, owner) !== 'peace';
}

// --- AI ----------------------------------------------------------------------

/** One decision tick's orders for an AI-driven seat, evaluated against `state`.
 *  Read-only: it builds and returns the actions; the caller applies them — the
 *  client to its local sim, the server through the authoritative room. Drives
 *  empty seats the same way in solo and multiplayer (a seat with no human). */
export function aiOrders(state: GameState, ai: string): Action[] {
  const out: Action[] = [];
  if (!state.players[ai]) return out; // seat not in play / eliminated
  const isShipUnit = (u: string): boolean => !data.units[u]?.traits.includes('ground');
  const capturable = (p: Planet): boolean => SECTOR_TYPES[p.kind ?? '']?.capturable ?? false;
  const d = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);
  // Send each idle AI fleet toward the nearest capturable world it can reach — only
  // neutral worlds or territory of someone it's at WAR with (peace = off-limits).
  for (const f of Object.values(state.fleets)) {
    if (f.owner !== ai || f.location == null || f.movement || f.battleId) continue;
    const here = state.planets[f.location];
    if (!here) continue;
    let best: Planet | null = null;
    let bestD = Infinity;
    for (const p of Object.values(state.planets)) {
      if (p.owner === ai || !capturable(p)) continue;
      if (!canTraverse(state, ai, p.owner)) continue; // a peace-locked target — leave it be
      const dd = d(here.position, p.position);
      if (dd < bestD) {
        bestD = dd;
        best = p;
      }
    }
    if (best) out.push(moveFleet(ai, f.id, best.id));
  }
  // NB: a passive bot never declares war just to keep expanding. Once neutral worlds run
  // out it simply builds (below) — "тихо копит армию". It only turns hostile when a player
  // sours its favour to rock bottom (botDiplomacyModule), then fights whoever it's at war
  // with via the same expansion loop above (war territory is traversable/capturable).
  // Build + launch from this AI's home base (its first developed owned world).
  const base =
    Object.values(state.planets).find((p) => p.owner === ai && p.buildings.length > 0) ??
    Object.values(state.planets).find((p) => p.owner === ai);
  const pl = state.players[ai];
  if (base && pl) {
    if ((pl.resources.metal ?? 0) > 220 && (pl.resources.credits ?? 0) > 120) {
      out.push(buildUnit(ai, base.id, 'cruiser', 1));
    }
    // (marine retired: the AI no longer cheap-builds a ground trooper. Its home keeps its
    //  seeded infantry garrison + orbital-AA building for defence; mobile ground via divisions.)
    const aiFleets = Object.values(state.fleets).filter((f) => f.owner === ai).length;
    const baseHasShip = base.garrison.some((st) => isShipUnit(st.unit));
    if (aiFleets < 2 && baseHasShip) out.push(launchFleet(ai, base.id));
  }
  // Trade on the session market: a passive bot liquidates the surplus goods it never
  // uses (food/energy/microelectronics) into the credits it always needs, and — when
  // flush — bids for the metal it burns fastest. One open lot per resource so it doesn't
  // spam. Embargo needs no check here: the book is anonymous and market.take rejects a
  // soured player from filling the bot's lots (botEmbargoes), so the bot simply won't
  // trade with anyone it has soured on.
  if (pl) {
    const lots = marketLots(state);
    const hasLot = (side: MarketSide, resource: string): boolean =>
      lots.some((l) => l.owner === ai && l.side === side && l.resource === resource);
    for (const good of ['food', 'energy', 'microelectronics']) {
      const have = pl.resources[good] ?? 0;
      if (have >= 40 && !hasLot('sell', good))
        out.push(marketList(ai, 'sell', good, Math.floor(have / 2), 2));
    }
    if (
      (pl.resources.metal ?? 0) < 80 &&
      (pl.resources.credits ?? 0) > 300 &&
      !hasLot('buy', 'metal')
    ) {
      out.push(marketList(ai, 'buy', 'metal', 30, 3));
    }
  }
  return out;
}
