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
  isBuildable,
  isCapturable,
  isBombarded,
  economyModule,
  effectsModule,
  BROWNOUT,
  movementModule,
  factionModule,
  heroModule,
  heroEffectsModule,
  combatModule,
  orbitalModule,
  artilleryModule,
  interceptModule,
  captureOnArrivalModule,
  sectorModule,
  planetTypeModule,
  constructionModule,
  arsenalSyncModule,
  armyModule,
  victoryModule,
  technologyModule,
  espionageModule,
  stewardModule,
  diplomacyModule,
  stewardActive,
  STEWARD_POSTURES,
  STEWARD_LOSS_LIMIT,
  MAX_STEWARD_HOLD_POINTS,
  scanNodeThreats,
  previewBattle,
  hullPool,
  journeyDestination,
  planRoute,
  routeDistance,
  estimateTravelHours,
  getStance,
  clearOffers,
  setStance,
  pairKey,
  identifiedNodes,
  timeScaleOf,
  hoursToMs,
  effectiveStats,
  buildProgress,
  thresholdRamp,
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
  type StewardLogEntry,
  type Action,
  type Context,
  type DomainEvent,
  type Battle,
  type StewardPosture,
} from '../../packages/shared-core/src/index';
import { canAfford, payCost } from '../../packages/shared-core/src/util/treasury';
import { provinceScore } from '../../packages/shared-core/src/state/sectorKind';
import { sumUnitStat, findHealthyStack } from '../../packages/shared-core/src/util/stacks';
import {
  garrisonUnderAssault,
  requireOwnedIdleFleet,
} from '../../packages/shared-core/src/util/fleet';
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
import { DEFAULT_HEROES, type HeroGrade, type HeroLoadout } from './heroes';

/** Menu grade → core hero archetype: the four default roster heroes ARE the four
 *  catalog archetypes (Командир/Разрушитель/Авангард/Страж), so the grade doubles as
 *  the archetype key when the roster rides into the match as core hero instances. */
const ARCHETYPE_OF_GRADE: Record<HeroGrade, string> = {
  main: 'commander',
  legendary: 'ravager',
  rare: 'vanguard',
  common: 'warden',
};
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
    // --- meta-progression grants (прокачка командующего, prototype/src/meta.ts) ----
    // Hidden session techs granted as `completed` at newGame for unlocked meta nodes.
    // the meta_ prefix keeps them out of the research window (renderTech).
    meta_drill_speed: {
      name: 'Commander Drill: Logistics',
      description: 'Мета-прокачка: +5% к скорости флотов.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { fleetSpeedBonus: 0.05 },
    },
    meta_drill_combat: {
      name: 'Commander Drill: Gunnery',
      description: 'Мета-прокачка: +5% к урону.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { combatDamageBonus: 0.05 },
    },
    meta_drill_radar: {
      name: 'Commander Drill: Recon',
      description: 'Мета-прокачка: +15% к радиусу радаров.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { radarRangeBonus: 0.15 },
    },
    meta_drill_veteran: {
      name: 'Commander Drill: Veterancy',
      description: 'Мета-прокачка: ещё +5% к скорости и урону.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { fleetSpeedBonus: 0.05, combatDamageBonus: 0.05 },
    },
    meta_industry: {
      name: 'Commander Drill: Industry',
      description: 'Мета-прокачка: +5% к производству.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { productionBonus: 0.05 },
    },
    meta_industry_2: {
      name: 'Commander Drill: Magnate',
      description: 'Мета-прокачка: ещё +5% к производству.',
      branch: 'command',
      tier: 1,
      cost: {},
      researchTimeHours: 0,
      effects: { productionBonus: 0.05 },
    },
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
      cost: { credits: 260, metal: 220, microelectronics: 40 },
      researchTimeHours: 10,
      dayGate: 3,
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
      dayGate: 3,
      prerequisites: ['industrial_automation'],
    },
    microelectronics_fabrication: {
      name: 'Microelectronics Fabrication',
      description: 'Орбитальные фабрики: +5% к производству.',
      branch: 'space',
      tier: 2,
      cost: { credits: 220, metal: 180 },
      researchTimeHours: 10,
      dayGate: 2,
      prerequisites: ['industrial_automation'],
      effects: { productionBonus: 0.05 },
    },
    // --- эпохи (TT-3.1 контент): новые узлы всех пяти веток. Философия прототипа
    // сохранена — только аддитивные эффекты, доступный контент не запирается.
    // dayGate ЖЁСТКИЙ (ядро: E_TOO_EARLY); в UI подпись «День N» = dayGate+1 —
    // счёт статус-бара (день 1 — первый). Капстоуны веток гейтит учёный ветки
    // (has_scientist — качественный доступ, не % скорости).
    deep_survey: {
      name: 'Deep-Space Survey',
      description: 'Сети дальних сенсоров: +15% к радиусу радаров.',
      branch: 'space',
      tier: 2,
      cost: { credits: 200, metal: 140 },
      researchTimeHours: 8,
      dayGate: 2,
      prerequisites: ['industrial_automation'],
      effects: { radarRangeBonus: 0.15 },
    },
    void_armadas: {
      name: 'Void Armadas',
      description:
        'Доктрина больших соединений: +6% к урону и скорости флотов. Требует 5 своих секторов.',
      branch: 'space',
      tier: 3,
      cost: { credits: 420, metal: 300, microelectronics: 60 },
      researchTimeHours: 16,
      dayGate: 8,
      prerequisites: ['siege_doctrine'],
      conditions: [{ type: 'own_sectors', min: 5 }],
      effects: { combatDamageBonus: 0.06, fleetSpeedBonus: 0.06 },
    },
    combined_arms: {
      name: 'Combined Arms',
      description: 'Общевойсковой бой: слаженность пехоты и брони. +5% к урону.',
      branch: 'ground',
      tier: 1,
      cost: { credits: 140, metal: 100 },
      researchTimeHours: 5,
      effects: { combatDamageBonus: 0.05 },
    },
    garrison_networks: {
      name: 'Garrison Networks',
      description: 'Гарнизонные сети: тыл сам себя снабжает. +5% к производству.',
      branch: 'ground',
      tier: 2,
      cost: { credits: 240, metal: 200 },
      researchTimeHours: 10,
      dayGate: 5,
      prerequisites: ['combined_arms'],
      effects: { productionBonus: 0.05 },
    },
    planetary_bastions: {
      name: 'Planetary Bastions',
      description:
        'Планетарные бастионы: оборонная промышленность полного цикла. +8% к урону. Капстоун Маршала.',
      branch: 'ground',
      tier: 3,
      cost: { credits: 480, metal: 360, microelectronics: 40 },
      researchTimeHours: 18,
      dayGate: 12,
      prerequisites: ['fortified_infrastructure'],
      conditions: [{ type: 'has_scientist', branch: 'ground' }],
      effects: { combatDamageBonus: 0.08 },
    },
    flight_decks: {
      name: 'Flight Decks',
      description: 'Полётные палубы: быстрый цикл вылетов. +6% к скорости флотов.',
      branch: 'squadron',
      tier: 1,
      cost: { credits: 160, metal: 120 },
      researchTimeHours: 6,
      dayGate: 2,
      effects: { fleetSpeedBonus: 0.06 },
    },
    strike_vectors: {
      name: 'Strike Vectors',
      description: 'Ударные векторы: расчёт заходов эскадрилий. +8% к урону.',
      branch: 'squadron',
      tier: 2,
      cost: { credits: 280, metal: 220, microelectronics: 30 },
      researchTimeHours: 12,
      dayGate: 5,
      prerequisites: ['flight_decks'],
      effects: { combatDamageBonus: 0.08 },
    },
    ace_programs: {
      name: 'Ace Programs',
      description:
        'Программа асов: элитные экипажи. +6% к урону и скорости флотов. Капстоун Комэска.',
      branch: 'squadron',
      tier: 3,
      cost: { credits: 500, metal: 380, microelectronics: 60 },
      researchTimeHours: 20,
      dayGate: 12,
      prerequisites: ['strike_vectors'],
      conditions: [{ type: 'has_scientist', branch: 'squadron' }],
      effects: { combatDamageBonus: 0.06, fleetSpeedBonus: 0.06 },
    },
    guidance_arrays: {
      name: 'Guidance Arrays',
      description: 'Массивы наведения: телеметрия дальнего рубежа. +10% к радиусу радаров.',
      branch: 'missile',
      tier: 1,
      cost: { credits: 150, metal: 110 },
      researchTimeHours: 6,
      dayGate: 2,
      effects: { radarRangeBonus: 0.1 },
    },
    warhead_miniaturization: {
      name: 'Warhead Miniaturization',
      description: 'Миниатюризация БЧ: плотнее залп на тот же тоннаж. +6% к урону.',
      branch: 'missile',
      tier: 2,
      cost: { credits: 260, metal: 240, microelectronics: 30 },
      researchTimeHours: 12,
      dayGate: 5,
      prerequisites: ['guidance_arrays'],
      effects: { combatDamageBonus: 0.06 },
    },
    saturation_barrage: {
      name: 'Saturation Barrage',
      description: 'Насыщающий залп: перегрузка любой ПРО. +10% к урону. Капстоун Ракетчика.',
      branch: 'missile',
      tier: 3,
      cost: { credits: 520, metal: 400, microelectronics: 80 },
      researchTimeHours: 20,
      dayGate: 12,
      prerequisites: ['warhead_miniaturization'],
      conditions: [{ type: 'has_scientist', branch: 'missile' }],
      effects: { combatDamageBonus: 0.1 },
    },
    signal_corps: {
      name: 'Signal Corps',
      description: 'Войска связи: единая картина боя. +8% к радиусу радаров.',
      branch: 'command',
      tier: 1,
      cost: { credits: 130, metal: 90 },
      researchTimeHours: 4,
      effects: { radarRangeBonus: 0.08 },
    },
    logistics_command: {
      name: 'Logistics Command',
      description: 'Штаб логистики: конвои по расписанию. +5% к производству и скорости флотов.',
      branch: 'command',
      tier: 2,
      cost: { credits: 300, metal: 220 },
      researchTimeHours: 12,
      dayGate: 5,
      prerequisites: ['signal_corps'],
      effects: { productionBonus: 0.05, fleetSpeedBonus: 0.05 },
    },
    // «Хранитель» — the automation pillar. Strong, so it's gated behind choosing the
    // command scientist (Куратор) AND a mid-session day-gate (day 15). Unlocks the
    // `steward` ability, which `stewardModule` requires before `steward.delegate` works.
    ai_stewardship: {
      name: 'Steward Protocol',
      description:
        'Автоматизация командования: доверенному ИИ можно передать место, пока вы офлайн (спите) — он держит оборону и возвращает управление к сроку. Сильная — потому открывается выбором учёного-Куратора и лишь к середине сессии (день 16).',
      branch: 'command',
      tier: 3,
      cost: { credits: 400, metal: 260 },
      researchTimeHours: 14,
      dayGate: 15,
      conditions: [{ type: 'has_scientist', branch: 'command' }],
      unlocks: { abilities: ['steward'] },
    },
  },
  // Research leaders (scientistModule). Pick TWO at setup (before the start-point) — a
  // council: `has_scientist` passes if either matches, `+slot` bonuses sum. The
  // command-branch «Куратор» gates the Steward; «Полимат» trades a branch focus for +1 slot.
  scientists: {
    overseer: {
      name: 'Куратор',
      description:
        'Лидер ветки командования (C2): доктрины автоматизации и делегирования. Открывает «Протокол Хранитель» — передачу места ИИ на время сна.',
      branch: 'command',
    },
    void_admiral: {
      name: 'Космоадмирал',
      description: 'Лидер космической ветки: верфи, логистика, осадные доктрины.',
      branch: 'space',
    },
    ground_marshal: {
      name: 'Наземный маршал',
      description: 'Лидер наземной ветки: крепости и оборона фронтира.',
      branch: 'ground',
    },
    wing_commander: {
      name: 'Командир крыла',
      description: 'Лидер ветки эскадрилий: авианосные ударные крылья.',
      branch: 'squadron',
    },
    missile_chief: {
      name: 'Ракетный шеф',
      description: 'Лидер ракетной ветки: дальнобойные системы.',
      branch: 'missile',
    },
    polymath: {
      name: 'Полимат',
      description: 'Генералист без ветки: +1 слот исследования (2→3) вместо фокуса.',
      slotBonus: 1,
    },
  },
  units: {
    scout: {
      faction: 'blue',
      stats: { attack: 5, defense: 4, speed: 64, hp: 12, cargoCapacity: 1 },
      signature: 1, // quiet recon hull
      radarRange: 105, // projects fleet radar — read by both the core fog and the prototype view (плейтест 2026-07-18: −50%)
      cost: { metal: 20 },
      buildTimeHours: 1,
      upkeep: { credits: 1 },
      slots: { utility: 1 }, // a lone utility bay — a recon drone flexes its sensors
    },
    cruiser: {
      faction: 'blue',
      stats: { attack: 16, defense: 14, speed: 40, hp: 60, cargoCapacity: 5 },
      line: 'front',
      signature: 4, // big warship — broadcasts
      // ECON-7: modern warships need microelectronics — the hi-tech good gates a
      // real fleet, so you must run fabricators to keep building (Bytro model).
      cost: { metal: 60, credits: 20, microelectronics: 3 },
      buildTimeHours: 3,
      upkeep: { credits: 4 },
      slots: { weapon: 1, defense: 1, utility: 1 }, // the balanced warship: one of each bay
    },
    siege: {
      // Artillery: a backline platform that fires from range at one target —
      // a pure standoff (no return fire) within `range` map units (combat
      // runArtillery). Reaches ~one neighbouring world (~205 apart), no further.
      faction: 'blue',
      stats: { attack: 30, defense: 6, speed: 30, hp: 40, range: 240 },
      traits: ['artillery'],
      signature: 5, // huge siege platform — loudest
      cost: { metal: 90, credits: 40, microelectronics: 4 }, // ECON-7: guided munitions
      buildTimeHours: 5,
      upkeep: { credits: 6 },
      slots: { weapon: 1, utility: 1 }, // a gun bay + a utility bay — a glass cannon
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
      slots: { defense: 1, utility: 2 }, // no guns — it armours up and carries утилиту
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
      cost: { metal: 90, credits: 40, microelectronics: 10 },
      buildTimeHours: 2,
      upkeep: { credits: 4 },
      slots: { weapon: 1 }, // a single gun mount — upgun the paper-thin strike wing
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
      slots: { defense: 1, utility: 2 }, // a flat-top: armour + sensor/cargo bays
    },
    // (marine retired — mobile ground troops now come only from the division/formation
    //  system. Orbital AA is no longer a unit either: it's a defensive *building* now
    //  (see `orbital_aa` under buildings) — anti-ship, immobile, player-built.)
    // --- formation roster: the ground units that fill a division template's 6 slots
    // (formation.ts). Each has a distinct role. The division's aggregate attack/defense
    // ratings come from GROUND_ROSTER (the per-target matrix combat uses); only hp/cost/
    // upkeep are read from here (`stats.attack/defense/speed` on these four are legacy and
    // now unread — kept as reference). Composition doctrines are organisational labels,
    // not stat bonuses (BF-23).
    // Пехота — cheap, defensive front line; the backbone that holds ground.
    // Пехота в трёх вариантах (H4): ополчение — дешёвое мясо, тяжёлая пехота — щит
    // обороны, спецназ — элита с противотанковыми средствами (см. GROUND_ROSTER —
    // матрица «кто кого бьёт» живёт там; агрегатный рейтинг ⚔/🛡 = среднее её строк,
    // здесь же — hp, цена и содержание).
    militia: {
      faction: 'blue',
      stats: { attack: 4, defense: 8, speed: 44, hp: 14, cargoSize: 1 },
      domain: 'ground',
      traits: ['ground'],
      signature: 1,
      cost: { metal: 15 },
      buildTimeHours: 1,
      upkeep: { credits: 1, food: 1 },
    },
    heavy_infantry: {
      faction: 'blue',
      stats: { attack: 8, defense: 20, speed: 40, hp: 34, cargoSize: 2 },
      domain: 'ground',
      traits: ['ground'],
      signature: 1,
      cost: { metal: 55, credits: 15 },
      buildTimeHours: 2,
      upkeep: { credits: 2, food: 1 },
    },
    special_forces: {
      faction: 'blue',
      stats: { attack: 18, defense: 12, speed: 52, hp: 26, cargoSize: 1 },
      domain: 'ground',
      traits: ['ground'],
      signature: 1,
      cost: { metal: 60, credits: 45, microelectronics: 5 },
      buildTimeHours: 3,
      upkeep: { credits: 4, food: 1 },
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
      upkeep: { credits: 4, food: 2 },
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
  // Ship modules (mirror of data/modules.json) — the «Оснащение корабля» loadout
  // constructor fits these into a hull's typed slots (weapon/defense/utility). The
  // core `loadout.ts` engine (effectiveStats/canEquip/loadoutCost) validates and
  // prices them; `unit.build{modules}` stamps the chosen set onto the built stack.
  modules: {
    cargo_bay: {
      name: 'Грузовой отсек',
      slot: 'utility',
      tag: 'horizontal',
      effects: { stats: { cargoCapacity: 6 } },
      cost: { metal: 45 },
      allowed: { domain: 'space' },
    },
    radar_module: {
      name: 'Радар-модуль',
      slot: 'utility',
      tag: 'horizontal',
      effects: { stats: { radarRange: 180 } },
      cost: { metal: 55 },
      allowed: { domain: 'space' },
    },
    ion_engine: {
      name: 'Ионный двигатель',
      slot: 'utility',
      tag: 'vertical',
      effects: { stats: { speed: 2 } },
      cost: { metal: 40 },
      allowed: { domain: 'space' },
    },
    targeting_array: {
      name: 'Система наведения',
      slot: 'weapon',
      tag: 'vertical',
      effects: { stats: { attack: 4 } },
      cost: { metal: 60 },
      allowed: { domain: 'space' },
    },
    ablative_plating: {
      name: 'Броневые плиты',
      slot: 'defense',
      tag: 'vertical',
      effects: { stats: { hp: 12 } },
      cost: { metal: 50 },
      allowed: { domain: 'space' },
    },
    shield_booster: {
      name: 'Тяжёлый щит',
      slot: 'defense',
      tag: 'vertical',
      effects: { stats: { shield: 15 } },
      cost: { metal: 80 },
      allowed: { domain: 'space' },
    },
  },
  // --- фракции (H3): четыре лор-дома. Пока фракция — ЧИСТО пассивные бонусы к
  // экономике или юнитам (никаких уникальных юнитов/способностей) — их применяет
  // ядровый factionModule через те же хуки, что и технологии
  // (economy.production / fleet.speed / combat.damage). Человек выбирает дом на
  // setup-экране; ИИ-места разбирают оставшиеся.
  factions: {
    blue: {
      name: 'Azure Compact',
      description: 'Торгово-промышленный договор: вся планетарная экономика даёт +12%.',
      passives: { productionBonus: 0.12 },
    },
    red: {
      name: 'Crimson Hegemony',
      description: 'Милитаристская гегемония: весь исходящий урон флотов и армий +10%.',
      passives: { combatDamageBonus: 0.1 },
    },
    amber: {
      name: 'Amber Concord',
      description: 'Кочевой конкорд логистов: флоты идут по лейнам на +15% быстрее.',
      passives: { fleetSpeedBonus: 0.15 },
    },
    violet: {
      name: 'Violet Ascendancy',
      description: 'Универсалисты восхода: понемногу всюду — экономика +5% и урон +5%.',
      passives: { productionBonus: 0.05, combatDamageBonus: 0.05 },
    },
  },
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
      upkeep: { energy: 8 }, // refined credit production runs on grid power
      hp: 20,
      scoreValue: 3,
    },
    // --- the resource loop's missing three: food, energy, microelectronics ----------
    // Together with the mine they close all five session resources into one economy:
    // reactors feed the powered buildings (refinery/radar/AA/rig/fab), farms feed the
    // ground army (units' food upkeep), fabs turn power+food into the high-tech good.
    // Missing a resource doesn't kill a building — it BROWNOUTS its consumers to half
    // output until the bill is coverable again (economy.ts arrears).
    farm: {
      name: 'Hydroponics Farm',
      cost: { metal: 90 },
      buildTimeHours: 3,
      produces: { food: 10 },
      upkeep: { energy: 6 },
      hp: 18,
      scoreValue: 3,
      upgrades: [
        {
          cost: { metal: 160, credits: 40 },
          buildTimeHours: 4,
          produces: { food: 16 },
          upkeep: { energy: 10 },
          hp: 24,
        },
        {
          cost: { metal: 260, credits: 90 },
          buildTimeHours: 6,
          produces: { food: 24 },
          upkeep: { energy: 16 },
          hp: 30,
        },
      ],
    },
    power_plant: {
      name: 'Fusion Plant',
      cost: { metal: 110, credits: 30 },
      buildTimeHours: 4,
      produces: { energy: 14 },
      upkeep: { credits: 6 },
      hp: 20,
      scoreValue: 4,
      upgrades: [
        {
          cost: { metal: 240, credits: 100 },
          buildTimeHours: 6,
          produces: { energy: 26 },
          upkeep: { credits: 12 },
          hp: 28,
        },
        {
          cost: { metal: 400, credits: 190 },
          buildTimeHours: 8,
          produces: { energy: 42 },
          upkeep: { credits: 20 },
          hp: 36,
        },
      ],
    },
    // Bootstrap chain on purpose: the fab's UPGRADES cost the very good it produces —
    // the first one runs on imports (market) or patience, the rest compound.
    fabricator: {
      name: 'Microelectronics Fab',
      cost: { metal: 180, credits: 100 },
      buildTimeHours: 6,
      produces: { microelectronics: 5 },
      upkeep: { energy: 30, food: 8 },
      hp: 22,
      scoreValue: 6,
      upgrades: [
        {
          cost: { metal: 320, credits: 200, microelectronics: 30 },
          buildTimeHours: 8,
          produces: { microelectronics: 11 },
          upkeep: { energy: 55, food: 14 },
          hp: 32,
        },
        {
          cost: { metal: 520, credits: 340, microelectronics: 80 },
          buildTimeHours: 10,
          produces: { microelectronics: 19 },
          upkeep: { energy: 90, food: 22 },
          hp: 42,
        },
      ],
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
      upkeep: { energy: 8 },
      hp: 20,
      scoreValue: 5,
      upgrades: [
        {
          cost: { metal: 220, credits: 90 },
          buildTimeHours: 6,
          produces: { metal: 60 },
          upkeep: { energy: 14 },
          hp: 30,
        },
        {
          cost: { metal: 380, credits: 170 },
          buildTimeHours: 8,
          produces: { metal: 100 },
          upkeep: { energy: 22 },
          hp: 40,
        },
      ],
    },
    barracks: { name: 'Barracks', cost: { metal: 70 }, buildTimeHours: 3, hp: 25, scoreValue: 2 },
    // spaceport — the yard a space-domain hull needs to be laid down at all
    // (construction.ts `hasShipyard`/`enablesShipConstruction`); every homeworld
    // starts with one (see `newGame`) so turn-1 fleet-building always works.
    spaceport: {
      name: 'Spaceport',
      cost: { metal: 200, credits: 80 },
      buildTimeHours: 5,
      hp: 25,
      shipRepair: 0.05,
      enablesShipConstruction: true,
      scoreValue: 4,
    },
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
      // (auto-identified, 1 hop) and the next ring ~349, so only L3 (420) reaches past 349.
      radarRange: 240,
      upkeep: { energy: 6 },
      scoreValue: 2,
      upgrades: [
        {
          cost: { metal: 180, credits: 80 },
          buildTimeHours: 5,
          hp: 28,
          radarRange: 330,
          upkeep: { energy: 10 },
        },
        {
          cost: { metal: 300, credits: 140 },
          buildTimeHours: 7,
          hp: 38,
          radarRange: 420,
          upkeep: { energy: 16 },
        },
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
      upkeep: { energy: 6 },
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
    // ECON-7: каждый мир пассивно даёт 4 базовых ресурса (в час) с перекосом по типу
    // (Bytro-модель провинций). Микроэлектроники в baseOutput НЕТ — она только из
    // фабрикатора. productionBonus остаётся общим множителем богатства мира.
    terran: {
      name: 'Terran',
      baseOutput: { food: 5, credits: 6, energy: 3, metal: 4 },
      productionBonus: 0,
      defenseBonus: 0.1,
    },
    barren: {
      name: 'Barren',
      baseOutput: { metal: 7, credits: 3, energy: 2, food: 1 },
      productionBonus: -0.25,
      defenseBonus: 0,
    },
    oceanic: {
      name: 'Oceanic',
      baseOutput: { food: 8, credits: 5, energy: 3, metal: 3 },
      productionBonus: 0.15,
      defenseBonus: 0.05,
    },
    volcanic: {
      name: 'Volcanic',
      baseOutput: { metal: 11, energy: 5, credits: 4, food: 1 },
      productionBonus: 0.25,
      defenseBonus: -0.05,
    },
    gas_giant: {
      name: 'Gas Giant',
      baseOutput: { energy: 8, credits: 6, metal: 4, food: 1 },
      productionBonus: 0.35,
      defenseBonus: -0.15,
    },
    crystalline: {
      name: 'Crystalline',
      baseOutput: { metal: 13, energy: 5, credits: 6, food: 1 },
      productionBonus: 0.45,
      defenseBonus: -0.25,
    },
    fortress_world: {
      name: 'Fortress World',
      baseOutput: { metal: 4, credits: 5, energy: 3, food: 2 },
      productionBonus: -0.15,
      defenseBonus: 0.4,
    },
    relic_world: {
      name: 'Relic World',
      baseOutput: { credits: 12, energy: 4, metal: 4, food: 3 },
      productionBonus: 0.05,
      defenseBonus: 0,
    },
    irradiated: {
      name: 'Irradiated',
      baseOutput: { energy: 6, metal: 8, credits: 4, food: 1 },
      productionBonus: 0.2,
      defenseBonus: 0.15,
    },
    ringworld: {
      name: 'Ringworld',
      baseOutput: { food: 5, credits: 8, energy: 5, metal: 6 },
      productionBonus: 0.3,
      defenseBonus: 0.1,
    },
    dead_world: {
      name: 'Dead World',
      baseOutput: { metal: 10, credits: 1, energy: 1 },
      productionBonus: 0,
      productionByResource: { metal: 0.3 },
      defenseBonus: 0,
    },
  },
  // --- герои: 5 data-каталогов ядра (HERO-1..9), зеркало data/*.json --------------
  // Архетипы 1:1 совпадают с четырьмя ростер-героями меню (main→commander,
  // legendary→ravager, rare→vanguard, common→warden), а id способностей — с легаси-пулом
  // heroes.ts, так что меню-дизайнер продолжает работать поверх новой модели. Костов
  // хватает у прототипных валют (credits/metal/energy/microelectronics).
  heroes: {
    commander: {
      name: 'Командир',
      description:
        'Главный герой-флагман: командный трансгуманист, усиливает флот и открывает коридоры.',
      branch: 'transhuman',
      ship: { unit: 'hero' },
      slots: 4,
      startAbilities: ['corridor', 'rally', 'scan', 'bulwark', 'diplomatic_landing'],
      startPassives: ['rally_beacon'],
    },
    ravager: {
      name: 'Разрушитель',
      description: 'Псионик-разрушитель: аннигилирует миры и вскрывает туман.',
      branch: 'psionic',
      ship: { unit: 'hero' },
      slots: 3,
      startAbilities: ['annihilate', 'scan', 'recall', 'boarding_translocation'],
      startPassives: [],
    },
    vanguard: {
      name: 'Авангард',
      description: 'Трансгуманист-манёвренник: коридоры и боевой клич для передовых флотов.',
      branch: 'transhuman',
      ship: { unit: 'hero' },
      slots: 2,
      startAbilities: ['corridor', 'rally'],
      startPassives: ['vanguard_impulse'],
    },
    warden: {
      name: 'Страж',
      description: 'Псионик-защитник: держит рубеж бастионным щитом.',
      branch: 'psionic',
      ship: { unit: 'hero' },
      slots: 1,
      startAbilities: ['bulwark'],
      startPassives: [],
    },
  },
  // Способности: `temp_lane`/`annihilate` — встроенные эффекты heroModule (кастуются),
  // `spawn_*` — пассивные маркеры точек развёртывания (читает `hero.spawn`), остальные
  // типы (`aura`/`reveal`/`recall`) типизированы в данных, но эффекта в движке ещё нет —
  // `hero.ability` на них честно отвечает `E_NO_EFFECT` (UI показывает «скоро»).
  heroAbilities: {
    corridor: {
      name: 'Коридор',
      description:
        'Открывает временный публичный коридор-лейн до близкого мира; свои флоты идут по нему быстрее.',
      type: 'temp_lane',
      cooldownHours: 12,
      range: 600,
      params: {},
    },
    annihilate: {
      name: 'Аннигиляция',
      description:
        'Уничтожает планету в радиусе — она остаётся узлом, но становится мёртвым миром.',
      type: 'annihilate',
      cooldownHours: 48,
      range: 500,
      params: {},
    },
    rally: {
      name: 'Сбор',
      description: 'Боевой клич: временный бонус к боевой ауре для своих флотов рядом с героем.',
      type: 'aura',
      cooldownHours: 18,
      range: 0,
      params: { combatBonus: 0.1, durationHours: 2, radius: 300 },
    },
    scan: {
      name: 'Разведка',
      description: 'Раскрывает зону вокруг цели сквозь туман на время.',
      type: 'reveal',
      cooldownHours: 10,
      range: 400,
      params: { radius: 250, durationHours: 3 },
    },
    recall: {
      name: 'Отзыв',
      description: 'Мгновенно отзывает корабль-героя в столицу.',
      type: 'recall',
      cooldownHours: 24,
      range: 0,
      params: {},
    },
    bulwark: {
      name: 'Бастион',
      description: 'Временный щит: бонус к обороне своим флотам рядом с героем.',
      type: 'aura',
      cooldownHours: 20,
      range: 0,
      params: { defenseBonus: 0.15, durationHours: 2, radius: 300 },
    },
    boarding_translocation: {
      name: 'Абордажная транслокация',
      description:
        'Герой формируется прямо на борту одного из своих флотов — где бы тот ни был. Пассивный навык: расширяет точки развёртывания.',
      type: 'spawn_fleet',
      cooldownHours: 0,
      range: 0,
      params: {},
    },
    diplomatic_landing: {
      name: 'Дипломатическая высадка',
      description:
        'Союзные миры принимают героя как своего: корабль может подняться и на планете союзника. Пассивный навык: расширяет точки развёртывания.',
      type: 'spawn_allied',
      cooldownHours: 0,
      range: 0,
      params: {},
    },
  },
  heroPassives: {
    vanguard_impulse: {
      name: 'Импульс авангарда',
      description: 'Корабль героя ведёт свой флот на форсаже: +10% к скорости флота героя.',
      hook: 'fleet.speed',
      scope: 'heroFleet',
      params: { bonus: 0.1 },
    },
    rally_beacon: {
      name: 'Маяк сбора',
      description: 'Флоты рядом с героем бьются яростнее: +8% к урону своих флотов в радиусе 300.',
      hook: 'combat.damage',
      scope: 'ownFleetsNear',
      params: { bonus: 0.08, radius: 300 },
    },
  },
  heroSkillTrees: {
    neural_lace: {
      name: 'Нейрокружево',
      description: 'Имплант прямого канала «мозг—штурвал»: корабль героя разгоняется на +10%.',
      branch: 'transhuman',
      cost: { microelectronics: 20 },
      grants: { passive: 'vanguard_impulse' },
    },
    overclocked_helm: {
      name: 'Разогнанный шлем',
      description: 'Форсаж нейроинтерфейса открывает герою прокладку коридоров.',
      branch: 'transhuman',
      requires: ['neural_lace'],
      cost: { microelectronics: 45, credits: 100 },
      grants: { ability: 'corridor' },
    },
    void_attunement: {
      name: 'Сонастройка с Пустотой',
      description: 'Пси-резонанс героя воодушевляет флоты рядом: +8% к урону в радиусе 300.',
      branch: 'psionic',
      cost: { energy: 60 },
      grants: { passive: 'rally_beacon' },
    },
    psi_veil: {
      name: 'Пси-вуаль',
      description: 'Отточенное пси-зрение: герой учится вскрывать туман разведкой.',
      branch: 'psionic',
      requires: ['void_attunement'],
      cost: { energy: 90, credits: 100 },
      grants: { ability: 'scan' },
    },
  },
  heroFittings: {
    psi_amplifier: {
      name: 'Пси-усилитель',
      description: 'Резонансный контур раскрывает герою разведку сквозь туман.',
      grants: { ability: 'scan' },
      cost: { microelectronics: 30 },
    },
    aegis_matrix: {
      name: 'Матрица «Эгида»',
      description:
        'Полевой генератор воодушевляет флоты рядом с героем: +8% к урону в радиусе 300.',
      grants: { passive: 'rally_beacon' },
      cost: { metal: 60 },
    },
    ablative_plating: {
      name: 'Абляционная обшивка',
      description:
        'Дополнительные +40 к корпусу корабля героя. (Статы корабля заработают со швом эффективных статов, SHIP-3.)',
      statMods: { hp: 40 },
      cost: { metal: 30 },
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
/** The prototype's UI delta per sector kind: display name, `data.sectors` terrain
 *  mapping and map colour, plus an optionally STRICTER build roster than the core's
 *  (asteroid: the UI offers only the starfort even though the core kind is open). */
interface SectorTypeUi {
  name: string;
  core: string;
  color: string;
  allowedBuildings?: string[];
}
const SECTOR_TYPE_UI: Record<string, SectorTypeUi> = {
  planet: { name: 'Planet', core: 'empty_space', color: '#5fd0ff' },
  nebula: { name: 'Nebula', core: 'nebula', color: '#8f6dff' },
  asteroid: {
    name: 'Asteroid Field',
    core: 'asteroid_field',
    color: '#d6a645',
    allowedBuildings: ['starfort'],
  },
  empty: { name: 'Empty Space', core: 'empty_space', color: '#46606e' },
  // new terrains — each maps to a core `data.sectors` entry for its speed/HP bonus
  ion_storm: { name: 'Ion Storm', core: 'ion_storm', color: '#6fe3ff' },
  dense_nebula: { name: 'Dense Nebula', core: 'dense_nebula', color: '#a78bff' },
  solar_flare: { name: 'Solar Flare Zone', core: 'solar_flare_zone', color: '#ff9f3a' },
  graveyard: { name: 'Derelict Graveyard', core: 'derelict_graveyard', color: '#9fb0a8' },
  // debris field — a fast but UN-capturable corridor (kind `debris_field` in sectorKinds)
  debris_field: { name: 'Debris Field', core: 'deep_void', color: '#2f4a59' },
  // dead world — a destroyed planet; re-claimable, only the salvage rig builds here
  dead_world: { name: 'Dead World', core: 'deep_void', color: '#5a4a4a' },
};

/** SECTOR_TYPES = UI delta + gameplay flags DERIVED from `data.sectorKinds` via the
 *  core's own resolution (permissive default for kinds the data doesn't list) — one
 *  source of truth for capturable/buildable/orbit, so the prototype can't drift from
 *  what the kernel actually enforces. `allowedBuildings` stays the UI roster: the
 *  prototype may be stricter than the core (asteroid), else it mirrors the data
 *  (dead_world's salvage rig comes from `data.sectorKinds`). */
export const SECTOR_TYPES: Record<string, SectorType> = Object.fromEntries(
  Object.entries(SECTOR_TYPE_UI).map(([kind, ui]) => {
    const planet = { kind };
    const roster = ui.allowedBuildings ?? allowedBuildings(data, planet);
    const type: SectorType = {
      name: ui.name,
      core: ui.core,
      color: ui.color,
      capturable: isCapturable(data, planet),
      buildable: isBuildable(data, planet),
      orbit: hasOrbit(data, planet),
      ...(roster === undefined ? {} : { allowedBuildings: roster }),
    };
    return [kind, type];
  }),
);

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

// A SQUARE, ORGANIC contested field: a jittered 11×11 lattice (equal cell spacing, no rigid
// grid look) wired to neighbours by a relative-neighbourhood graph. EXACTLY 30 are 'planet'
// kind — 10 START candidates around the perimeter (where players & AI spawn) + 20 neutral
// worlds — and the other 91 are non-planet provinces, so the board totals ~2410 base points
// (30×50 + 91×10); a solo win needs 1100 (SCORE_LIMIT). All planets start NEUTRAL; newGame()
// seeds owners + homes at the chosen starts. The jitter is deterministic (seeded sine hash)
// → reproducible. Square aspect so it reads well in portrait (fills width, pans vertically).
//
// FAIRNESS (self-play M4 finding): the field is mirror-symmetric in BOTH axes — jitter,
// terrain kinds and planet types are computed for the canonical quadrant cell and
// mirrored out. The ten starts form three mirrored orbits (4 + 2 + 4), keeping opposite
// seats equivalent while fitting ten evenly-spaced homes on a square perimeter. The first
// asymmetric layout gave one corner ~6× the nearby province value (70 vs 410 points
// within 3 hops) and that start won 100% of seeded bot matches regardless of slot
// or faction. Competitive skirmish maps are symmetric for exactly this reason; the
// per-quadrant jitter keeps the organic look.
const FIELD = { cols: 11, rows: 11, x0: 150, dx: 145, y0: 150, dy: 145, jitter: 0.4 };
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
// 10 start candidates around the inset perimeter: three along the top/bottom and two
// along each side. Ordering follows the perimeter clockwise so automatic seat placement
// spreads through the board predictably.
const START_CELLS = ['2,1', '5,1', '8,1', '9,3', '9,7', '8,9', '5,9', '2,9', '1,7', '1,3'];
// 20 neutral 'planet' worlds in five four-cell axis-symmetric orbits. Combined with the
// ten starts this preserves the old density: three planet provinces per maximum seat.
const NEUTRAL_PLANET_CELLS = [
  '3,3',
  '7,3',
  '3,7',
  '7,7',
  '2,0',
  '8,0',
  '2,10',
  '8,10',
  '4,2',
  '6,2',
  '4,8',
  '6,8',
  '2,4',
  '8,4',
  '2,6',
  '8,6',
  '4,4',
  '6,4',
  '4,6',
  '6,6',
];

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
  const maxCol = FIELD.cols - 1;
  const maxRow = FIELD.rows - 1;
  const midCol = maxCol / 2;
  const midRow = maxRow / 2;
  // Canonical quadrant cell: fold (col,row) around the two centre axes. Jitter, terrain and
  // planet type are decided ONCE per canonical cell and mirrored to its orbit, which
  // is what makes opposite regions exactly equivalent (see the FIELD comment).
  const canon = (c: number, r: number): string =>
    `${Math.min(c, maxCol - c)},${Math.min(r, maxRow - r)}`;
  const jx = new Map<string, number>();
  const jy = new Map<string, number>();
  const kindOf = new Map<string, string>();
  const typeOf = new Map<string, string>();
  let ptIdx = 0; // cycles neutral planet types (per orbit)
  let npIdx = 0; // cycles non-planet terrains (per orbit)
  let i = 0; // jitter index (per canonical cell)
  for (let row = 0; row <= midRow; row += 1) {
    for (let col = 0; col <= midCol; col += 1) {
      const key = `${col},${row}`;
      jx.set(key, (jhash(i * 2) - 0.5) * 2 * FIELD.jitter * FIELD.dx);
      jy.set(key, (jhash(i * 2 + 1) - 0.5) * 2 * FIELD.jitter * FIELD.dy);
      i += 1;
      if (starts.has(key)) continue; // start orbit — always the terran home
      if (neutralP.has(key)) {
        typeOf.set(key, NEUTRAL_PLANET_TYPES[ptIdx++ % NEUTRAL_PLANET_TYPES.length]!);
      } else {
        kindOf.set(key, NON_PLANET_KINDS[npIdx++ % NON_PLANET_KINDS.length]!);
      }
    }
  }
  const nodes: KeyNode[] = [];
  for (let row = 0; row < FIELD.rows; row += 1) {
    for (let col = 0; col < FIELD.cols; col += 1) {
      const cell = `${col},${row}`;
      const key = canon(col, row);
      // Mirror the canonical jitter: flip its sign across each centre axis; a cell ON
      // a centre axis is its own mirror there, so that component stays unjittered.
      const sx = col < midCol ? 1 : col > midCol ? -1 : 0;
      const sy = row < midRow ? 1 : row > midRow ? -1 : 0;
      const x = Math.round(FIELD.x0 + col * FIELD.dx + sx * jx.get(key)!);
      const y = Math.round(FIELD.y0 + row * FIELD.dy + sy * jy.get(key)!);
      const id = cellId(cell);
      if (starts.has(cell)) {
        nodes.push({ id, owner: null, x, y, sector: 'planet', type: 'terran' });
      } else if (neutralP.has(cell)) {
        nodes.push({ id, owner: null, x, y, sector: 'planet', type: typeOf.get(key)! });
      } else {
        nodes.push({ id, owner: null, x, y, sector: kindOf.get(key)! });
      }
    }
  }
  return nodes;
}

const KEY: KeyNode[] = buildField();
/** The 10 worlds players spawn on — the start picker offers these. */
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

/** Canonical, order-independent loadout signature (mirrors shared-core `stacks.ts`):
 *  one instance per module id, sorted+joined. Two stacks share a merge identity only
 *  when this matches — a fitted stack never absorbs a bare one (SM-0.3). */
function loadoutKey(modules?: readonly string[]): string {
  return !modules || modules.length === 0 ? '' : [...modules].sort().join(',');
}

/** Move up to `count` of `unit` out of `src` (mutates src) and return the removed
 *  stacks. `hp`/`shieldHp` are POOLS for the whole stack (gameState.ts), so a split
 *  must APPORTION them pro-rata — copying the whole pool onto both halves duplicated
 *  hull that combat then minted into extra ships (BF-4). The loadout rides onto the
 *  taken stack so a routine split never strips paid modules (BF-5). */
function takeFromStacks(src: UnitStack[], unit: string, count: number): UnitStack[] {
  let remaining = count;
  const taken: UnitStack[] = [];
  for (const st of src) {
    if (st.unit !== unit || remaining <= 0) continue;
    const move = Math.min(st.count, remaining);
    remaining -= move;
    const frac = move / st.count; // share of the pools that leaves with the taken ships
    const t: UnitStack = { unit, count: move };
    if (st.hp !== undefined) {
      t.hp = st.hp * frac;
      st.hp -= t.hp; // source keeps the remainder — total pool conserved
    }
    if (st.shieldHp !== undefined) {
      t.shieldHp = st.shieldHp * frac;
      st.shieldHp -= t.shieldHp;
    }
    if (st.modules && st.modules.length > 0) t.modules = [...st.modules];
    st.count -= move;
    taken.push(t);
  }
  return taken;
}

/** Fold one stack list into another. Two stacks coalesce only when they share unit,
 *  loadout AND are both full-health (no `hp`/`shieldHp` pool) — the shared-core
 *  `findHealthyStack` rule. Merging on `hp` equality alone (the old code) fused two
 *  damaged stacks into ONE pool (halving hull) and smeared a fitted stack's modules
 *  over bare hulls, or destroyed them (BF-5); damaged/differently-fitted stacks now
 *  stay separate (combat handles multiple stacks of one unit fine). */
function mergeStacks(base: UnitStack[], add: UnitStack[]): UnitStack[] {
  const clone = (st: UnitStack): UnitStack => ({
    ...st,
    ...(st.modules ? { modules: [...st.modules] } : {}),
  });
  const out = base.map(clone);
  for (const st of add) {
    const healthy = st.hp === undefined && st.shieldHp === undefined;
    const match = healthy
      ? out.find(
          (o) =>
            o.unit === st.unit &&
            o.hp === undefined &&
            o.shieldHp === undefined &&
            loadoutKey(o.modules) === loadoutKey(st.modules),
        )
      : undefined;
    if (match) match.count += st.count;
    else out.push(clone(st));
  }
  return out;
}

// --- taxes: inhabited worlds collect credits --------------------------------
// Armies cost credits in upkeep, but nothing minted them at scale — so a growing
// fleet starved the economy. Now every inhabited world of yours levies a flat
// civic tax; a Tax Office (one-time, no levels) boosts that world's whole credit
// take. Hooks `economy.production`, so the core economy stays generic.
// ECON-7: civic tax slashed from 100 → 20. Worlds now make credits PASSIVELY via
// planetType.baseOutput (relic ~12/h, terran ~6/h …), so the flat capital tax is a
// modest bonus, not the firehose that flooded the treasury (playtest §4a: +2.8k/day).
export const TAX_PER_HOUR = 20; // base credits/h from the FIRST inhabited owned world
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

// --- ECON-1: голодная армия ---------------------------------------------------
// Food in the owner's `arrears` (the economy module's unpaid-bill marker) → their
// GROUND damage ×HUNGER_MULT. Ships run on credits, not rations — the orbital
// phase is untouched. Pure read of state the economy already settles spanwise, so
// determinism/replays are intact; the multiplier is a one-line balance knob.
export const HUNGER_MULT = 0.75;
export const hungerModule: GameModule = {
  id: 'hunger',
  version: '0.1.0',
  setup(api) {
    api.hook<number>('combat.damage', (damage, args, h) => {
      const a = args as { phase?: string; attacker?: string | null };
      if (a.phase !== 'ground' || typeof a.attacker !== 'string') return damage;
      const striker = h.state.players[a.attacker];
      return striker?.arrears?.includes('food') ? damage * HUNGER_MULT : damage;
    });
  },
};

// --- fleet.launch / fleet.merge: form and consolidate mobile fleets ----------
// The core builds units into a planet's garrison; this small module lets a
// player scramble those into a new fleet (ships → units, ground troops →
// landing) so production feeds offense, and fuse two co-located fleets into one.
// A natural next addition to the core.

/** Monotonic fleet-id counter (mirrors battleSeq/divisionSeq). The old
 *  `Object.keys(fleets).length` recycled freed numbers: a delete + re-mint in the
 *  same ms regenerated a LIVE id and silently overwrote that fleet (BF-25).
 *  Seeds from the current count so pre-counter saves keep minting unique ids. */
function nextFleetSeq(state: GameState): number {
  const s = state as DivState;
  const seq = (s.fleetSeq ?? Object.keys(state.fleets).length) + 1;
  s.fleetSeq = seq;
  return seq;
}

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
      // No mid-assault evacuation (BF-27): while a battle holds this garrison,
      // scrambling it onto ships would dodge the resolve — same lock as army.load.
      if (garrisonUnderAssault(h.state, planet.id)) {
        return h.reject('E_UNDER_ASSAULT');
      }
      // A fleet can't sit where one is already stationed-and-idle? Allow stacking.
      const units = planet.garrison.filter(
        (s) => !h.ctx.data.units[s.unit]?.traits.includes('ground'),
      );
      // Immobile emplacements (e.g. orbital AA, traits ['ground','immobile']) are
      // fixed installations: they can't be lifted onto a fleet — the same rule the
      // core army.load enforces with E_IMMOBILE. They are neither ships nor liftable
      // cargo, so they stay behind in the garrison (see the garrison reset below).
      const liftable = planet.garrison.filter(
        (s) =>
          h.ctx.data.units[s.unit]?.traits.includes('ground') &&
          !h.ctx.data.units[s.unit]?.traits.includes('immobile'),
      );
      if (units.length === 0) {
        return h.reject('E_NO_SHIPS'); // need at least one ship to form a fleet
      }
      // Cargo cap (BF-28): the new fleet lifts ground troops only up to its ships'
      // summed cargoCapacity — the same bound army.load enforces — in garrison
      // order; whatever doesn't fit stays planetside.
      let free = sumUnitStat(units, h.ctx.data, 'cargoCapacity');
      const landing: UnitStack[] = [];
      const stayBehind: UnitStack[] = [];
      for (const s of liftable) {
        const size = h.ctx.data.units[s.unit]?.stats.cargoSize ?? 1;
        const take = size > 0 ? Math.min(s.count, Math.floor(free / size)) : s.count;
        if (take > 0) {
          landing.push({ unit: s.unit, count: take });
          free -= take * size;
        }
        if (take < s.count) stayBehind.push({ unit: s.unit, count: s.count - take });
      }
      const seq = nextFleetSeq(h.state);
      const id = `fleet:${action.playerId}:${h.ctx.now}:${seq}`;
      h.state.fleets[id] = {
        id,
        owner: action.playerId,
        location: planet.id,
        movement: null,
        units: units.map((s) => ({ unit: s.unit, count: s.count })),
        landing,
        traits: [],
        battleId: null,
      };
      // Keep immobile emplacements + the over-cap troops behind; ships and the
      // lifted cargo are aboard now.
      planet.garrison = planet.garrison
        .filter((s) => h.ctx.data.units[s.unit]?.traits.includes('immobile'))
        .concat(stayBehind);
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
        modules?: unknown;
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
      // The build's paid loadout rides along (BF-29): pull the EXACT fitted stack
      // out of the garrison (loadout-keyed, like fleet.split) and re-stamp the
      // modules on the rally stack — auto-rally must not strip «Оснащение».
      const mods = Array.isArray(p.modules)
        ? p.modules.filter((m): m is string => typeof m === 'string')
        : undefined;
      const key = loadoutKey(mods);
      const gi = planet.garrison.findIndex(
        (st) => st.unit === p.unit && loadoutKey(st.modules) === key,
      );
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
        const seq = nextFleetSeq(h.state);
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
      const si = rally.units.findIndex(
        (st) => st.unit === p.unit && loadoutKey(st.modules) === key,
      );
      if (si >= 0) rally.units[si].count += take;
      else {
        rally.units.push({
          unit: p.unit,
          count: take,
          ...(mods && mods.length > 0 ? { modules: [...mods] } : {}),
        });
      }
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
      // Heroes are bound by fleetId the same way (BF-3): the hero UNIT rides into the
      // merged fleet, so the hero ENTITY must follow — a stale fleetId left the hero
      // orphaned, and hero.spawn could then mint a duplicate free flagship.
      for (const hr of Object.values(h.state.heroes ?? {})) {
        if (hr.fleetId === payload.from) hr.fleetId = into.id;
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
        // The hero flagship can't be peeled off by a split (BF-3): the hero ENTITY is
        // bound to the source fleet by fleetId, and moving its UNIT without the entity
        // would orphan the binding (wrong-fleet aura, wrong-hero death attribution).
        if (h.ctx.data.units[t.unit]?.traits.includes('hero')) {
          return h.reject('E_HERO_UNIT');
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
      const seq = nextFleetSeq(h.state);
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
      // Combat needs a DECLARED war (BF-охота MAJOR): engage was the one attack path
      // without a stance gate — a hand-crafted client action could open fire on a
      // player at peace/pact/alliance, bypassing diplomacy entirely in multiplayer.
      if (getStance(h.state, f.owner, target.owner) !== 'war') return h.reject('E_NOT_HOSTILE');
      if (!f.units.some((s) => s.count > 0) || !target.units.some((s) => s.count > 0)) {
        return h.reject('E_NO_FLEET'); // ghosts can't fight — no empty-side battles
      }
      if (f.battleId || target.battleId) return h.reject('E_IN_BATTLE');
      if (!f.location || f.movement || target.movement || f.location !== target.location) {
        return h.reject('E_NOT_COLOCATED');
      }
      const battleId = `battle:${h.state.battleSeq++}`;
      // Round cadence mirrors the core combat module: one round per GAME hour
      // (÷timeScale on the wall clock), with nextRoundAt stamped for the HUD timer.
      const roundAt = h.ctx.now + hoursToMs(h.ctx, 1);
      const battle: Battle = {
        id: battleId,
        location: f.location,
        phase: 'orbital',
        attacker: { ref: { kind: 'fleet', fleetId: f.id }, owner: f.owner },
        defender: { ref: { kind: 'fleet', fleetId: target.id }, owner: target.owner },
        round: 0,
        nextRoundAt: roundAt,
      };
      h.state.battles[battleId] = battle;
      f.battleId = battleId;
      f.movement = null;
      target.battleId = battleId;
      target.movement = null;
      h.schedule(roundAt, 'combat.tick', { battleId });
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

/** A seat in a match: who spawns where, and whether the AI drives it. Up to 10. */
export interface SeatConfig {
  id: string;
  name: string;
  faction: string;
  start: string; // a START_CANDIDATES world id
  ai: boolean;
  /** Team side for a team battle (e.g. 'A' / 'B'). Seats sharing a team start ALLIED;
   *  across teams they start at WAR. Absent on every seat ⇒ free-for-all (all pairs
   *  seeded at peace, the classic skirmish). Mirrors the core map's slot `team`. */
  team?: string;
}
export interface SetupConfig {
  seats: SeatConfig[];
  /** RNG seed of the match. Absent → the historical fixed 'prototype-1'. Self-play
   *  (M4) varies it per run — with the fixed seed an identical setup plays out
   *  identically every time (the determinism the core guarantees). */
  seed?: string;
  /** The human player's chosen research-leader council — up to 2 scientist ids from
   *  `data.scientists`, picked BEFORE the start-point at setup (a start consecration,
   *  GDD §5.2). Absent → the command leader «overseer» by default. */
  scientists?: string[];
  /** The player's 3 division templates, designed in the main menu and LOCKED for the
   *  session (mobilised in-match via `formation.mobilize`). Absent → DEFAULT_TEMPLATES. */
  templates?: FormationTemplate[];
  /** The player's hero roster (up to 3 loadouts), composed in the main menu. Absent →
   *  DEFAULT_HEROES. In-match instances / capital / respawn land in a later phase. */
  heroes?: HeroLoadout[];
  /** The player's ship blueprints — a module loadout per hull class (the "Верфь"
   *  designer). Frozen at session start (GDD §2). Absent → DEFAULT_SHIP_LOADOUTS. */
  ships?: ShipLoadout[];
  /** Meta-progression grant for the HUMAN seat (prototype/src/meta.ts metaGrant),
   *  snapshotted at match start like scientists/templates: hidden techs land as
   *  `completed`, the council starts higher, the treasury opens fatter. Earned by
   *  play only — never sold (main-menu.md §5). Absent = a fresh commander. */
  meta?: { tech: string[]; scientistLevel: number; resourceMult: number };
}

// --- ground formations (HOI4-style division templates) -----------------------
// A "воинское объединение" is a TEMPLATE of 6 slots, each holding one formation unit
// (or empty). Mobilising it builds those units as a ground army; the division's aggregate
// attack/defense rating is Σ over slots of the unit's mean per-target damage in GROUND_ROSTER
// (the same table combat uses) — composition doctrines are organisational LABELS only and
// add nothing to the numbers (BF-23). Templates are composed in the menu and frozen for
// the session, giving players a flexible, pre-committed doctrine.

/** The unit ids a template slot may hold — the formation roster (data.units above). */
export const FORMATION_UNITS = ['militia', 'heavy_infantry', 'special_forces', 'tank'] as const;
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
  {
    name: 'Линия',
    slots: ['heavy_infantry', 'heavy_infantry', 'militia', 'militia', 'tank', 'tank'],
  },
  {
    name: 'Кулак',
    slots: ['tank', 'tank', 'tank', 'special_forces', 'heavy_infantry', 'heavy_infantry'],
  },
  {
    name: 'Рейд',
    slots: ['special_forces', 'special_forces', 'special_forces', 'militia', 'militia', null],
  },
];

/** Именные офицерские дивизии (H4): ГОТОВЫЕ шаблоны с встроенным офицером — состав
 *  закреплён, редактировать нельзя (конструктор их только показывает). Мобилизация
 *  сразу прикрепляет офицера. */
export interface OfficerTemplate extends FormationTemplate {
  officer: string; // OFFICERS key
}
export const OFFICER_TEMPLATES: OfficerTemplate[] = [
  {
    name: 'Гвардия прорыва',
    officer: 'assault',
    slots: ['tank', 'tank', 'special_forces', 'special_forces', 'heavy_infantry', 'heavy_infantry'],
  },
  {
    name: 'Железный рубеж',
    officer: 'defender',
    slots: [
      'heavy_infantry',
      'heavy_infantry',
      'heavy_infantry',
      'heavy_infantry',
      'militia',
      'militia',
    ],
  },
  {
    name: 'Колонна снабжения',
    officer: 'quartermaster',
    slots: ['militia', 'militia', 'militia', 'heavy_infantry', 'heavy_infantry', 'tank'],
  },
];

/** A composition doctrine the template's mix unlocks — an organisational LABEL
 *  (combined-arms, entrenched, …), NOT a combat bonus: it carries no multiplier and
 *  combat never reads it (BF-23). Purely descriptive flavour for the designer. */
export interface FormationSynergy {
  key: string;
  name: string;
  desc: string;
}
/** Aggregate characteristics of a division template — the designer's combat readout.
 *  attack/defense are a compact rating: Σ over slots of each unit's MEAN per-target damage
 *  in the SAME ground roster combat resolves from (groundcombat.ts) — an expected weight vs
 *  an even enemy mix, so the preview tracks real combat instead of an unrelated paper stat.
 *  `synergies` are organisational doctrine labels only — no combat multiplier (BF-23). */
export interface FormationStats {
  count: number;
  byType: Record<FormationUnit, number>;
  attack: number;
  defense: number;
  hp: number;
  cost: Record<string, number>;
  synergies: FormationSynergy[];
}

/** Compute a template's aggregate combat rating + the doctrine LABELS its composition
 *  unlocks (combined-arms / entrenched / armour / raid / human-wave). attack/defense are
 *  Σ over slots of the unit's MEAN per-target damage in the ground roster — the SAME table
 *  combat resolves from — so the preview is grounded in real combat, not an unrelated paper
 *  stat (BF-23 tail). Doctrines are labels only, no multiplier. Pure + deterministic. */
export function formationStats(tpl: FormationTemplate): FormationStats {
  const byType: Record<FormationUnit, number> = {
    militia: 0,
    heavy_infantry: 0,
    special_forces: 0,
    tank: 0,
  };
  // A unit's single-number weight = the mean of its per-target damage row in GROUND_ROSTER
  // (expected damage vs an even enemy mix); `atk` when attacking, `def` on return fire.
  const rosterMean = (row: DamageTable): number =>
    FORMATION_UNITS.reduce((s, t) => s + (row[t] ?? 0), 0) / FORMATION_UNITS.length;
  let baseAtk = 0;
  let baseDef = 0;
  let hp = 0;
  const cost: Record<string, number> = {};
  for (const slot of tpl.slots) {
    if (!slot) continue;
    const def = data.units[slot];
    if (!def) continue;
    byType[slot] += 1;
    const prof = GROUND_ROSTER[slot];
    baseAtk += prof ? rosterMean(prof.atk) : 0;
    baseDef += prof ? rosterMean(prof.def) : 0;
    hp += def.stats.hp ?? 0;
    for (const [res, amt] of Object.entries(def.cost ?? {})) cost[res] = (cost[res] ?? 0) + amt;
  }
  const infantry = byType.militia + byType.heavy_infantry + byType.special_forces;
  const count = infantry + byType.tank;
  // Composition doctrines — organisational LABELS the mix unlocks (combined arms, an
  // entrenched heavy line, an armoured fist, a spec-ops raid, the cheap human wave).
  // Descriptive ONLY: combat resolves per-target from the ground roster + officer, so a
  // doctrine grants no attack/defence multiplier — the preview must not advertise one (BF-23).
  const synergies: FormationSynergy[] = [];
  if (infantry > 0 && byType.tank > 0) {
    synergies.push({
      key: 'combined',
      name: 'Комбинированные войска',
      desc: 'Пехота и танки в одном строю',
    });
  }
  if (byType.heavy_infantry >= 3) {
    synergies.push({ key: 'entrench', name: 'Окопались', desc: '≥3 тяжёлой пехоты держат рубеж' });
  }
  if (byType.tank >= 3) {
    synergies.push({
      key: 'armor',
      name: 'Танковый кулак',
      desc: '≥3 танков — ударный клин',
    });
  }
  if (byType.special_forces >= 2 && byType.militia === 0) {
    synergies.push({
      key: 'raid',
      name: 'Рейдовая доктрина',
      desc: '≥2 спецназа без ополчения',
    });
  }
  if (byType.militia >= 4) {
    synergies.push({ key: 'wave', name: 'Людская волна', desc: '≥4 ополчения — берут числом' });
  }
  return {
    count,
    byType,
    attack: Math.round(baseAtk),
    defense: Math.round(baseDef),
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
// = FAVOUR_WAR: a bot too calm to start a war won't refuse to end one. One war
// declaration (60→30) leaves a ~3-day window to sue for peace before war decay
// (5/day) drops the meter below the line — then the bot fights to the end.
export const FAVOUR_PEACE_ACCEPT = 15;
export const FAVOUR_PACT_ACCEPT = 55; // an offered PACT needs real goodwill
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

export type NetworkMatchMode = 'ffa' | '2v2' | '5v5';

const NETWORK_HOUSES = [
  { name: 'Azure Compact', faction: 'blue' },
  { name: 'Crimson Hegemony', faction: 'red' },
  { name: 'Amber Concord', faction: 'amber' },
  { name: 'Violet Ascendancy', faction: 'violet' },
] as const;

export function parseNetworkMatchMode(value: string | undefined): NetworkMatchMode {
  if (value === undefined) return 'ffa';
  if (value === '2v2' || value === '5v5') return value;
  throw new Error(`TEAMS must be 2v2 or 5v5, got: ${value}`);
}

/** Claimable human chairs for the prototype host. Empty chairs are driven by server AI. */
export function networkSeats(mode: NetworkMatchMode = 'ffa'): SeatConfig[] {
  const startIndexes = mode === '2v2' ? [9, 8, 3, 4] : START_CANDIDATES.map((_, i) => i);
  return startIndexes.map((startIndex, i) => {
    const house = NETWORK_HOUSES[i % NETWORK_HOUSES.length]!;
    const cycle = Math.floor(i / NETWORK_HOUSES.length) + 1;
    const suffix = cycle === 1 ? '' : cycle === 2 ? ' II' : ' III';
    return {
      id: `p${i + 1}`,
      name: `${house.name}${suffix}`,
      faction: house.faction,
      start: START_CANDIDATES[startIndex]!,
      ai: false,
      ...(mode === '2v2' ? { team: i < 2 ? 'A' : 'B' } : {}),
      ...(mode === '5v5' ? { team: i < 5 ? 'A' : 'B' } : {}),
    };
  });
}

export function newGame(setup: SetupConfig = DEFAULT_SETUP): GameState {
  const base = createInitialState({
    seed: setup.seed ?? 'prototype-1',
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
      // A starting yard — space-domain hulls need a standing shipyard/spaceport to
      // build at all (enablesShipConstruction); without one, turn-1 fleet-building
      // would be impossible.
      { type: 'spaceport', level: 1, hp: hpOfLevel('spaceport', 1) },
    ];
    // Ground defence is what holds a world against capture (an AA battery bleeds a fleet
    // but can't stop a landing — only ground troops do). Seed a starting infantry garrison
    // so the homeworld isn't a free walk-in; mobile ground beyond it comes via divisions.
    home.garrison = [
      { unit: 'militia', count: 2 },
      { unit: 'heavy_infantry', count: 1 },
    ];
    players[seat.id] = player(
      seat.id,
      seat.name,
      seat.faction,
      { credits: 260, metal: 320, food: 120, energy: 90, microelectronics: 40 },
      seat.ai,
    );
    // Human seats get the research-leader council chosen at setup (before the start-point
    // pick — a start consecration). Default to the command leader «Куратор» so the Steward
    // line stays reachable when unset; the has_scientist + day-15 gates still apply.
    if (!seat.ai) {
      const ids = setup.scientists?.length ? setup.scientists.slice(0, 2) : ['overseer'];
      // Meta-progression raises the whole council's level (snapshot at match start).
      const lvl = 1 + Math.max(0, setup.meta?.scientistLevel ?? 0);
      players[seat.id]!.scientists = ids.map((id) => ({ id, level: lvl }));
      // …opens the treasury fatter…
      const mult = 1 + Math.max(0, setup.meta?.resourceMult ?? 0);
      if (mult > 1) {
        const bag = players[seat.id]!.resources;
        for (const r of Object.keys(bag)) bag[r] = Math.round((bag[r] ?? 0) * mult);
      }
      // …and lands the unlocked hidden techs as completed (bonuses ride the normal
      // technology hooks from the first second — the C3 pre-match seam, reused).
      const grant = (setup.meta?.tech ?? []).filter((id) => data.technologies[id]);
      if (grant.length) players[seat.id]!.technologies = { completed: [...new Set(grant)] };
    }
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
    // The roster rides in as CORE hero instances (the HERO-9 model): each menu hero
    // maps onto its archetype (grade → archetype flavour, 1:1 by design). The MAIN one
    // deploys as flagship of the home fleet (named by the commander's nick); the rest
    // seed UNDEPLOYED, mirroring `buildFromMap` — `hero.spawn` raises their ships
    // in-match (active cap 3). All respawn at the capital (`home`, re-designatable).
    const roster = !seat.ai && setup.heroes ? setup.heroes : DEFAULT_HEROES;
    const mainIdx = Math.max(
      0,
      roster.findIndex((x) => x.grade === 'main'),
    );
    roster.forEach((loadout, i) => {
      const archetype = ARCHETYPE_OF_GRADE[loadout.grade] ?? 'commander';
      const def = data.heroes[archetype];
      // Ability loadout = the menu picks (catalog-known ids) + the archetype's
      // spawn-marker perks (not menu-pickable — they ride with the archetype).
      const picks = loadout.abilities.filter(
        (id): id is string => !!id && !!data.heroAbilities[id],
      );
      const markers = (def?.startAbilities ?? []).filter((id) =>
        data.heroAbilities[id]?.type.startsWith('spawn_'),
      );
      const main = i === mainIdx;
      const heroId = `hero:${seat.id}:${i + 1}`;
      heroes[heroId] = {
        id: heroId,
        owner: seat.id,
        name: main ? seat.name : loadout.name,
        location: seat.start,
        cooldowns: {},
        grade: loadout.grade,
        archetype,
        abilities: [...new Set([...picks, ...markers])],
        passives: [...(def?.startPassives ?? [])],
        home: seat.start,
        ...(main ? { alive: true, fleetId: `${seat.id}-1` } : {}),
      };
    });
  }
  // Free-for-all seeds every pair at PEACE (not the core's war default): no marching
  // through another commander's space and no combat until war is declared. A TEAM
  // battle instead seeds by side — same team ALLIED (win together, no friendly fire),
  // across teams at WAR (fight from the first hour). A team alliance is seeded state,
  // so it bypasses the `E_BOT_ALLIANCE` declare-gate — an AI teammate is a real ally
  // (the SES-1 victory clique reads the stance, so the coalition forms).
  const teamed = setup.seats.some((seat) => seat.team !== undefined);
  const teamOf = new Map(setup.seats.map((seat) => [seat.id, seat.team]));
  const diplomacy: Record<string, DiplomaticStance> = {};
  const ids = setup.seats.map((seat) => seat.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const ta = teamOf.get(ids[i]!);
      const tb = teamOf.get(ids[j]!);
      const stance: DiplomaticStance = !teamed
        ? 'peace'
        : ta !== undefined && ta === tb
          ? 'alliance'
          : 'war';
      diplomacy[pairKey(ids[i]!, ids[j]!)] = stance;
    }
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

/** ECON-6: почасовой экономический срез для пайплайна наблюдений хоста — казна /
 *  чистый приток / arrears per player на мировом времени `state.time`. Чистая
 *  функция состояния: кривые пишет JSONL хоста, headline-счётчики — агрегатор. */
export function economySnapshot(state: GameState): {
  kind: 'economy';
  atTime: number;
  players: Record<
    string,
    { resources: Record<string, number>; netPerHour: Record<string, number>; arrears: string[] }
  >;
} {
  const players: Record<
    string,
    { resources: Record<string, number>; netPerHour: Record<string, number>; arrears: string[] }
  > = {};
  for (const [pid, pl] of Object.entries(state.players)) {
    players[pid] = {
      resources: { ...pl.resources },
      netPerHour: netIncome(state, pid),
      arrears: [...(pl.arrears ?? [])],
    };
  }
  return { kind: 'economy', atTime: state.time, players };
}

/** Net per-hour income for a player: production from owned, un-bombarded worlds
 *  (brownout-dimmed like the core) minus unit/garrison AND building upkeep
 *  (daily ÷ 24). Drives the HUD's `+/h` deltas. */
export function netIncome(state: GameState, playerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const arrears = state.players[playerId]?.arrears ?? [];
  const inhabited = inhabitedWorldCount(state, playerId); // for the diminishing civic tax
  // BF-35: mirror the faction + tech `economy.production` hooks (factionModule /
  // technologyModule) — the HUD `+/h` used to apply only the planetType bonus, so a
  // production-boosted player (e.g. a +12% faction) saw a low readout from minute one.
  const me = state.players[playerId];
  const factionBonus = me?.faction
    ? (data.factions[me.faction]?.passives?.productionBonus ?? 0)
    : 0;
  let techBonus = 0;
  for (const id of me?.technologies?.completed ?? [])
    techBonus += data.technologies[id]?.effects?.productionBonus ?? 0;
  const bonusMult = (1 + factionBonus) * (1 + techBonus);
  for (const p of Object.values(state.planets)) {
    if (p.owner !== playerId || isBombarded(state, p.id)) continue;
    const mult =
      (1 + (p.planetType ? (data.planetTypes[p.planetType]?.productionBonus ?? 0) : 0)) * bonusMult;
    // Credits are settled per-planet so the civic tax + Tax Office boost mirror the
    // core's economy.production pipeline (taxModule); metal accrues straight to `out`.
    let credits = 0;
    // ECON-7: passive per-type base output, mirrored from the core's planetTypeModule
    // (scaled by the world's richness incl. productionByResource; base credits routed
    // through the tax accumulator so a Tax Office boosts them too).
    const ptDef = p.planetType ? data.planetTypes[p.planetType] : undefined;
    const ptByRes = ptDef?.productionByResource ?? {};
    for (const res of Object.keys(ptDef?.baseOutput ?? {})) {
      const v = (ptDef!.baseOutput[res] ?? 0) * mult * (1 + (ptByRes[res] ?? 0));
      if (res === 'credits') credits += v;
      else out[res] = (out[res] ?? 0) + v;
    }
    for (const b of p.buildings) {
      const def = data.buildings[b.type];
      if (!def) continue;
      const level = buildingLevel(def, b.level);
      // Mirror the core's brownout: a building starved of an arrears resource shows
      // its dimmed output, so the top-bar flow matches what actually accrues.
      const starved =
        arrears.length > 0 &&
        Object.keys(level.upkeep).some((r) => (level.upkeep[r] ?? 0) > 0 && arrears.includes(r));
      const bMult = mult * (starved ? BROWNOUT : 1);
      for (const res of Object.keys(level.produces)) {
        const v = (level.produces[res] ?? 0) * bMult;
        if (res === 'credits') credits += v;
        else out[res] = (out[res] ?? 0) + v;
      }
      // …and its running cost (daily → hourly), same drain the settlement applies.
      for (const res of Object.keys(level.upkeep))
        out[res] = (out[res] ?? 0) - (level.upkeep[res] ?? 0) / 24;
    }
    // Constructions in progress (≥50% built) chip in a partial/delta share too —
    // mirrors economy.ts's `pendingProduction` ramp rule. Point-evaluated (not
    // integrated) since this is a live HUD rate, not an accrual over a span; no
    // upkeep is charged on an unfinished building either, so no brownout applies here.
    for (const event of state.scheduled) {
      if (event.type !== 'construction.complete') continue;
      const cp = event.payload as {
        kind?: 'building' | 'unit' | 'upgrade';
        planetId?: string;
        building?: string;
        level?: number;
      };
      if (cp.planetId !== p.id) continue;
      if (cp.kind === 'building' && typeof cp.building === 'string') {
        const def = data.buildings[cp.building];
        if (!def) continue;
        const level1 = buildingLevel(def, 1);
        const ramp = thresholdRamp(
          buildProgress(state.time, event.at, level1.buildTimeHours * HOUR),
        );
        if (ramp <= 0) continue;
        for (const res of Object.keys(level1.produces)) {
          const v = (level1.produces[res] ?? 0) * ramp * mult;
          if (res === 'credits') credits += v;
          else out[res] = (out[res] ?? 0) + v;
        }
      } else if (
        cp.kind === 'upgrade' &&
        typeof cp.building === 'string' &&
        typeof cp.level === 'number'
      ) {
        const def = data.buildings[cp.building];
        const instance = p.buildings.find((b) => b.type === cp.building);
        if (!def || !instance) continue;
        const current = buildingLevel(def, instance.level);
        const target = buildingLevel(def, cp.level);
        const ramp = thresholdRamp(
          buildProgress(state.time, event.at, target.buildTimeHours * HOUR),
        );
        if (ramp <= 0) continue;
        const resources = new Set([
          ...Object.keys(current.produces),
          ...Object.keys(target.produces),
        ]);
        for (const res of resources) {
          const delta = ((target.produces[res] ?? 0) - (current.produces[res] ?? 0)) * ramp * mult;
          if (delta === 0) continue;
          if (res === 'credits') credits += delta;
          else out[res] = (out[res] ?? 0) + delta;
        }
      }
    }
    // A PAUSED site keeps its frozen share too — pausing halts further construction,
    // not the share of the building already standing (mirrors economy.ts's
    // `pausedProduction`: same threshold rule, held flat at `site.progress`).
    for (const site of p.pausedConstruction ?? []) {
      const ramp = thresholdRamp(site.progress);
      if (ramp <= 0) continue;
      if (site.kind === 'building' && typeof site.building === 'string') {
        const def = data.buildings[site.building];
        if (!def) continue;
        const level1 = buildingLevel(def, 1);
        for (const res of Object.keys(level1.produces)) {
          const v = (level1.produces[res] ?? 0) * ramp * mult;
          if (res === 'credits') credits += v;
          else out[res] = (out[res] ?? 0) + v;
        }
      } else if (
        site.kind === 'upgrade' &&
        typeof site.building === 'string' &&
        typeof site.level === 'number'
      ) {
        const def = data.buildings[site.building];
        const instance = p.buildings.find((b) => b.type === site.building);
        if (!def || !instance) continue;
        const current = buildingLevel(def, instance.level);
        const target = buildingLevel(def, site.level);
        const resources = new Set([
          ...Object.keys(current.produces),
          ...Object.keys(target.produces),
        ]);
        for (const res of resources) {
          const delta = ((target.produces[res] ?? 0) - (current.produces[res] ?? 0)) * ramp * mult;
          if (delta === 0) continue;
          if (res === 'credits') credits += delta;
          else out[res] = (out[res] ?? 0) + delta;
        }
      }
    }
    if (isInhabited(p)) {
      credits += civicTax(inhabited) * bonusMult; // civic tax is post-tax income → also boosted (BF-35)
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

// --- diplomacy ---------------------------------------------------------------
// D4: the prototype now runs the CORE `diplomacyModule` (imported above) — one
// implementation of `diplomacy.declare` for the whole repo (D2 escalation, D3
// consent offers, E_BOT_ALLIANCE, offer sweep on `player.eliminated`, plus the
// `diplomacy` capability combat consults). Stances still live in `state.diplomacy`
// (D1) and newGame seeds `peace`, so nothing changes at the table. Code deltas vs
// the retired prototype module: same-stance → `E_SAME_STANCE` (was `E_ALREADY`),
// malformed target → `E_BAD_PAYLOAD` (was `E_BAD_TARGET`), and `stance` is required
// (the `declareWar` builder still defaults it to 'war').

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
    // A bot ANSWERS negotiations by the favour meter: an offered peace/pact from a
    // seat it doesn't resent is accepted on the spot (the bot files the matching
    // declaration — the same consent path a human would take); a soured bot turns
    // it down and the offer is wiped so the seat can retry once favour recovers —
    // only humans may leave an offer pending. Alliances stay human-only
    // (E_BOT_ALLIANCE upstream).
    api.on('diplomacy.offered', (event, h) => {
      const { from, to, stance } = event.payload as {
        from: string;
        to: string;
        stance: DiplomaticStance;
      };
      const meter = (h.state as DivState).approval?.[to];
      if (!meter || meter[from] === undefined) return; // `to` isn't a tracked bot vs `from`
      const need =
        stance === 'peace' ? FAVOUR_PEACE_ACCEPT : stance === 'pact' ? FAVOUR_PACT_ACCEPT : null;
      if (need !== null && botFavour(h.state, to, from) >= need) {
        clearOffers(h.state, to, from);
        setStance(h.state, to, from, stance);
        h.emit('diplomacy.changed', { a: to, b: from, stance });
        return;
      }
      clearOffers(h.state, from, to);
      h.emit('diplomacy.declined', { from, to, stance });
    });
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
    // An eliminated seat leaves the favour ledger entirely: its own meter dies with
    // it, and no surviving bot keeps tracking (or later declaring on) a corpse —
    // the same sweep diplomacy does for standing offers (BF-33).
    api.on('player.eliminated', (event, h) => {
      const playerId = (event.payload as { playerId?: string })?.playerId;
      const approval = (h.state as DivState).approval;
      if (typeof playerId !== 'string' || !approval) return;
      delete approval[playerId];
      for (const meter of Object.values(approval)) delete meter[playerId];
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
        // Elimination marks the seat 'defeated' (the record STAYS) — a dead bot
        // must not keep venting favour or declare war from the grave (BF-33).
        if (h.state.players[bot]?.status !== 'active') continue;
        const meter = approval[bot]!;
        for (const player of Object.keys(meter)) {
          if (h.state.players[player]?.status !== 'active') continue; // no grudges vs the dead
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
// ECON-4: рыночная комиссия — доля суммы сделки СГОРАЕТ (не переходит никому):
// первый настоящий сток кредитов в торговле + анти-спам книги. Платит получатель
// кредитов, симметрично для обеих сторон книги; эскроу-возврат при отмене без
// комиссии.
export const MARKET_FEE = 0.05;
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
      // typeof first: a numeric STRING passes `>`/`>=` through coercion and would
      // otherwise reach the treasury math on the ungated path.
      if (typeof p.amount !== 'number' || typeof p.price !== 'number') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const amount = Math.floor(p.amount);
      const price = p.price;
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
      // ECON-4: получатель кредитов получает net, комиссия сгорает.
      const net = credits * (1 - MARKET_FEE);
      if (lot.side === 'sell') {
        if (!canAfford(taker.resources, { credits })) return h.reject('E_NO_FUNDS');
        payCost(taker.resources, { credits }); // taker buys the goods
        creditTreasury(h.state, action.playerId, lot.resource, qty);
        creditTreasury(h.state, lot.owner, 'credits', net);
      } else {
        if (!canAfford(taker.resources, { [lot.resource]: qty })) return h.reject('E_NO_FUNDS');
        payCost(taker.resources, { [lot.resource]: qty }); // taker sells the goods
        creditTreasury(h.state, action.playerId, 'credits', net); // from the escrow
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
        fee: credits - net,
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
  /** Monotonic fleet-id counter (BF-25) — never recycles a freed number. */
  fleetSeq?: number;
  /** Sortie state of wings whose patrol is currently OFF (BF-26): fuel/rearm
   *  survive the scramble toggle, so OFF→ON never refuels a dry wing for free. */
  wingSorties?: Record<string, SortieState>;
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
  /** CC-2 standing order, AUTHORITATIVE (was a client-only Set): fleets that auto-storm
   *  the enemy world they arrive at. Driven server-side (serverAutoAssaultActions). */
  autoAssault?: Record<string, true>;
  /** CC-4 standing patrols, AUTHORITATIVE (was a client-only Map): fleetId → patrol
   *  (center/radius/sortie + the next rearm-round due time). Driven server-side
   *  (serverPatrolActions), so «дежурный вылет» works in NET and offline. */
  patrols?: Record<string, Patrol & { rearmAt?: number }>;
  /** CC-1 order chains, AUTHORITATIVE: fleetId → queued steps the fleet runs one by
   *  one whenever it is free (Задержка = wait, Точка+ = several move steps, «прийти и
   *  открыть огонь» = move+barrage). The key is `orders` on purpose: `visibleState`
   *  already strips it for other viewers (future intent, like `scheduled`). Driven
   *  server-side (serverChainActions) and by the solo frame loop. */
  orders?: Record<string, FleetChain>;
  /** BOOST-1 форс-марш («Ускорить»): fleets trading hull for speed — ×1.5 to
   *  `fleet.speed` at the cost of 5% max-HP wear per hour IN TRANSIT. One march:
   *  the flag drops on arrival. Stripped for other viewers (visibility.ts). */
  forcedMarch?: Record<string, true>;
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
      const fromOfficer = (action.payload as { officer?: unknown }).officer === true;
      const tpl = fromOfficer
        ? OFFICER_TEMPLATES[p.template]
        : templatesOf(h.state, action.playerId)[p.template];
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
      // Именной шаблон приходит со своим офицером — «готовый шаблон, менять нельзя».
      // Its HP bonus is baked into hpEach at birth, so the division is born AT its
      // regen-max (unitMaxHp reads the same officer), not below it.
      const officer = fromOfficer ? (tpl as OfficerTemplate).officer : undefined;
      divs[id] = {
        id,
        owner: action.playerId,
        name: tpl.name,
        template: p.template,
        max: { ...stats.byType },
        units: makeSide(GROUND_ROSTER, stats.byType, officer ? OFFICERS[officer] : undefined),
        location: p.planetId,
        ...(officer ? { officer } : {}),
      };
      h.emit('division.mobilized', {
        id,
        owner: action.playerId,
        planetId: p.planetId,
        template: p.template,
      });
    });

    // Assemble a division template in-match — set slot `slot` of the player's template
    // `template` to a formation unit (or null). Templates are no longer frozen at setup:
    // "сбор шаблона из разных юнитов" happens at mobilisation. Materialises the player's
    // templates from the defaults on first edit (per-player, deep-copied, JSON-safe).
    api.onAction('division.template', (action, h) => {
      const p = action.payload as { template?: number; slot?: number; unit?: string | null };
      if (typeof p?.template !== 'number' || typeof p?.slot !== 'number')
        return h.reject('E_BAD_PAYLOAD');
      if (p.slot < 0 || p.slot >= FORMATION_SLOTS) return h.reject('E_BAD_PAYLOAD');
      const unit = p.unit ?? null;
      if (unit !== null && !(FORMATION_UNITS as readonly string[]).includes(unit)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      const ds = h.state as DivState;
      const all = (ds.templates ??= {});
      const mine = (all[action.playerId] ??= DEFAULT_TEMPLATES.map((t) => ({
        name: t.name,
        slots: [...t.slots],
      })));
      const tpl = mine[p.template];
      if (!tpl) return h.reject('E_NO_TEMPLATE');
      tpl.slots[p.slot] = unit as FormationUnit | null;
      h.emit('division.retemplated', { template: p.template, slot: p.slot, unit });
    });

    // Rename a CUSTOM template (Stellaris-style designer). Officer premades are not
    // player templates, so they are unreachable here — their name is locked by data.
    api.onAction('division.rename', (action, h) => {
      const p = action.payload as { template?: number; name?: unknown };
      if (typeof p?.template !== 'number' || typeof p?.name !== 'string')
        return h.reject('E_BAD_PAYLOAD');
      const name = p.name.trim().slice(0, 24);
      if (!name) return h.reject('E_BAD_PAYLOAD');
      const ds = h.state as DivState;
      const all = (ds.templates ??= {});
      const mine = (all[action.playerId] ??= DEFAULT_TEMPLATES.map((t) => ({
        name: t.name,
        slots: [...t.slots],
      })));
      const tpl = mine[p.template];
      if (!tpl) return h.reject('E_NO_TEMPLATE');
      tpl.name = name;
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

    // NOTE: there is deliberately NO runtime officer attach/detach action. Officers
    // arrive ONLY with their locked premade (`division.mobilize {officer: true}`) —
    // a raw `division.officer` action used to attach any officer to any division for
    // free, bypassing the premade lock (bughunt BF-19).

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
        // No field repair under fire: regen while a ground battle rages would also
        // make the outcome depend on how finely the span is stepped (BF-22).
        if (groundContested(h.state, div.location)) continue;
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

// --- CC-server: standing orders (CC-2 auto-storm / CC-4 дежурный вылет) -------------
// Promoted from client-only Set/Map to AUTHORITATIVE state so the server drives them —
// they run in NET and while the owner is offline. The module only STORES the standing
// order; the host driver (netserver.runServerStanding) reads the pure decision cores
// below and issues the orders through the same authoritative room. Single-player keeps
// its local frame-loop drivers.
export const standingOrdersModule: GameModule = {
  id: 'standing-orders',
  version: '0.1.0',
  setup(api) {
    const ownedFleet = (h: HandlerContext, playerId: string, fleetId: unknown): Fleet | string => {
      if (typeof fleetId !== 'string') return 'E_BAD_PAYLOAD';
      const f = h.state.fleets[fleetId];
      if (!f) return 'E_NO_FLEET';
      if (f.owner !== playerId) return 'E_FORBIDDEN';
      return f;
    };
    api.onAction('order.auto', (action, h) => {
      // CC-2: toggle the auto-storm stance on an owned fleet. Pure flag — the driver
      // decides WHEN it fires (parked over a capturable enemy world, orbit clear).
      const p = action.payload as { fleetId?: unknown; on?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      if (typeof p.on !== 'boolean') return h.reject('E_BAD_PAYLOAD');
      const st = h.state as DivState;
      if (p.on) (st.autoAssault ??= {})[f.id] = true;
      else if (st.autoAssault) {
        delete st.autoAssault[f.id];
        if (Object.keys(st.autoAssault).length === 0) delete st.autoAssault;
      }
    });
    api.onAction('order.scramble', (action, h) => {
      // CC-4: stand (or stand down) a reactive patrol on an owned squadron fleet. The
      // SERVER computes the patrol — center from the fleet's node, radius from its wing,
      // a fresh sortie budget — nothing about it is client-supplied.
      const p = action.payload as { fleetId?: unknown; on?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      if (typeof p.on !== 'boolean') return h.reject('E_BAD_PAYLOAD');
      const st = h.state as DivState;
      if (!p.on) {
        if (st.patrols?.[f.id]) {
          // The wing's fuel/rearm survive the toggle (BF-26): stash the sortie so
          // OFF→ON resumes where it left off instead of handing back a full tank.
          (st.wingSorties ??= {})[f.id] = st.patrols[f.id]!.sortie;
          delete st.patrols[f.id];
          if (Object.keys(st.patrols).length === 0) delete st.patrols;
        }
        return;
      }
      if (!fleetHasSquadron(f)) return h.reject('E_NO_SHIPS');
      const pos = f.location !== null ? h.state.planets[f.location]?.position : undefined;
      if (!pos || !fleetIdle(f)) return h.reject('E_CONDITIONS_UNMET'); // patrols stand from a parked node
      const spec = sortieSpec(f);
      const stashed = st.wingSorties?.[f.id];
      (st.patrols ??= {})[f.id] = {
        center: { x: pos.x, y: pos.y },
        radius: squadronStrikeRange(f),
        // Resume the stashed sortie (clamped to the CURRENT wing's spec — the
        // composition may have changed); only a never-flown wing starts fresh.
        sortie: stashed
          ? {
              fuel: Math.min(stashed.fuel, spec.maxFuel),
              rearming: Math.min(stashed.rearming, spec.rearmRounds),
            }
          : freshSortie(spec.maxFuel),
        rearmAt: h.ctx.now + HOUR, // rearm cadence: one round per game-hour from now
      };
      if (st.wingSorties) {
        delete st.wingSorties[f.id];
        if (Object.keys(st.wingSorties).length === 0) delete st.wingSorties;
      }
    });
    api.onAction('patrol.stamp', (action, h) => {
      // The DRIVER's runtime stamp (burned fuel / ticked rearm / next cadence mark) —
      // same trust shape as order.hold. Bounds-checked against the wing's own spec so
      // a forged stamp can't mint fuel or park a patrol in an impossible state.
      const p = action.payload as { fleetId?: unknown; sortie?: unknown; rearmAt?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const patrol = (h.state as DivState).patrols?.[f.id];
      if (!patrol) return h.reject('E_NO_TARGET');
      const s = p.sortie as { fuel?: unknown; rearming?: unknown } | undefined;
      const spec = sortieSpec(f);
      if (
        typeof s?.fuel !== 'number' ||
        !Number.isInteger(s.fuel) ||
        s.fuel < 0 ||
        s.fuel > spec.maxFuel ||
        typeof s.rearming !== 'number' ||
        !Number.isInteger(s.rearming) ||
        s.rearming < 0 ||
        s.rearming > spec.rearmRounds
      ) {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (
        p.rearmAt !== undefined &&
        (typeof p.rearmAt !== 'number' || !Number.isFinite(p.rearmAt) || p.rearmAt < 0)
      ) {
        return h.reject('E_BAD_PAYLOAD');
      }
      patrol.sortie = { fuel: s.fuel, rearming: s.rearming };
      if (p.rearmAt !== undefined) patrol.rearmAt = p.rearmAt;
    });
    api.onAction('order.chain', (action, h) => {
      // CC-1: replace the fleet's WHOLE order chain atomically ([] = cancel). The
      // client only ever sets the plan; advancing it is the driver's job (chain.stamp).
      const p = action.payload as { fleetId?: unknown; steps?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const steps = validateChainSteps(p?.steps, h.state);
      if (steps === null) return h.reject('E_BAD_PAYLOAD');
      const st = h.state as DivState;
      if (steps.length === 0) {
        if (st.orders) {
          delete st.orders[f.id];
          if (Object.keys(st.orders).length === 0) delete st.orders;
        }
        return;
      }
      (st.orders ??= {})[f.id] = { steps }; // a fresh plan drops any armed wait
    });
    api.onAction('chain.stamp', (action, h) => {
      // The DRIVER's runtime stamp (consumed head / armed wait deadline) — same trust
      // shape as patrol.stamp: bounds-checked, so a forged stamp can't plant garbage.
      const p = action.payload as { fleetId?: unknown; steps?: unknown; waitUntil?: unknown };
      const f = ownedFleet(h, action.playerId, p?.fleetId);
      if (typeof f === 'string') return h.reject(f);
      const st = h.state as DivState;
      if (!st.orders?.[f.id]) return h.reject('E_NO_TARGET'); // nothing to advance
      const steps = validateChainSteps(p?.steps, h.state);
      if (steps === null) return h.reject('E_BAD_PAYLOAD');
      const w = p?.waitUntil;
      if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w < 0)) {
        return h.reject('E_BAD_PAYLOAD');
      }
      if (steps.length === 0) {
        delete st.orders[f.id];
        if (Object.keys(st.orders).length === 0) delete st.orders;
        return;
      }
      st.orders[f.id] = w === undefined ? { steps } : { steps, waitUntil: w };
    });
    // Housekeeping: standing orders of dead fleets must not live in state (and every
    // snapshot) forever. Same deterministic sweep as the order chains'.
    api.on('time.advanced', (_ev, h) => {
      const st = h.state as DivState;
      for (const key of ['autoAssault', 'patrols', 'wingSorties', 'orders'] as const) {
        const map = st[key];
        if (!map) continue;
        for (const fid of Object.keys(map)) if (!h.state.fleets[fid]) delete map[fid];
        if (Object.keys(map).length === 0) delete st[key];
      }
    });
  },
};

// --- BOOST-1: форс-марш («Ускорить») -----------------------------------------
// +50% to fleet speed at the cost of 5% max-HP wear per hour IN TRANSIT — the
// Bytro-style forced march. The wear cripples but never kills: the pool floors
// one hull above loss, so a march can't erase a fleet by itself. One march only:
// the flag drops on arrival (re-arm for the next leg deliberately).
export const FORCED_MARCH_MULT = 1.5;
export const FORCED_MARCH_WEAR = 0.05; // share of max HP per game-hour
export const forcedMarchModule: GameModule = {
  id: 'forced-march',
  version: '0.1.0',
  setup(api) {
    api.onAction('fleet.forcemarch', (action, h) => {
      const p = action.payload as { fleetId?: unknown; on?: unknown };
      if (typeof p?.fleetId !== 'string' || typeof p?.on !== 'boolean') {
        return h.reject('E_BAD_PAYLOAD');
      }
      const f = h.state.fleets[p.fleetId];
      // Absent OR not-yours → one opaque code (A06 — no fleet-existence probing).
      if (!f || f.owner !== action.playerId) return h.reject('E_NO_FLEET');
      const st = h.state as DivState;
      if (p.on) {
        (st.forcedMarch ??= {})[f.id] = true;
      } else if (st.forcedMarch) {
        delete st.forcedMarch[f.id];
        if (Object.keys(st.forcedMarch).length === 0) delete st.forcedMarch;
      }
    });
    // The speed pipeline contribution — same contract as retreat-haste / faction
    // passives: multiply and pass on (order commutes, invariant #6 intact).
    api.hook<number>('fleet.speed', (speed, args, h) => {
      const fleetId = (args as { fleetId?: string }).fleetId;
      return fleetId && (h.state as DivState).forcedMarch?.[fleetId]
        ? speed * FORCED_MARCH_MULT
        : speed;
    });
    // Wear accrues over continuous time while the fleet is actually marching.
    api.on('time.advanced', (event, h) => {
      const { from, to } = event.payload as { from: number; to: number };
      const span = to - from;
      if (span <= 0) return;
      const st = h.state as DivState;
      if (!st.forcedMarch) return;
      const hours = (span / HOUR) * timeScaleOf(h.ctx);
      for (const fid of Object.keys(st.forcedMarch)) {
        const f = h.state.fleets[fid];
        if (!f) {
          delete st.forcedMarch[fid]; // dead fleet — sweep the flag with it
          continue;
        }
        if (!f.movement) continue; // parked = no wear (the march is the cost)
        for (const stack of f.units) {
          if (stack.count <= 0) continue;
          const def = h.ctx.data.units[stack.unit];
          if (!def) continue;
          const per = effectiveStats(def, stack, h.ctx.data).hp ?? 0;
          if (per <= 0) continue;
          const full = stack.count * per;
          const pool = Math.min(stack.hp ?? full, full);
          const minPool = (stack.count - 1) * per + 1; // last hull stays alive
          stack.hp = Math.max(Math.min(minPool, pool), pool - full * FORCED_MARCH_WEAR * hours);
        }
      }
      if (Object.keys(st.forcedMarch).length === 0) delete st.forcedMarch;
    });
    // One march per arm: reaching the destination drops the flag.
    api.on('fleet.arrived', (event, h) => {
      const fid = (event.payload as { fleetId?: string })?.fleetId;
      const st = h.state as DivState;
      if (typeof fid === 'string' && st.forcedMarch?.[fid]) {
        delete st.forcedMarch[fid];
        if (Object.keys(st.forcedMarch).length === 0) delete st.forcedMarch;
      }
    });
  },
};

// --- платное мгновенное восстановление («золотой ремонт») ---------------------
// Донатная кнопка Bytro-стиля, ненавязчивая: маленький чип в карточке флота.
// Кредиты играют роль премиум-валюты до монетизации (как шпионаж 150c). Мгновенный
// топ-ап КОРПУСА всех стеков (корабли + десант) где угодно — кроме боя; щит регенит
// бесплатно сам, медленный портовый ремонт (shipRepair) и план ECON-3 (metal в
// доке) остаются как были.
export const INSTANT_REPAIR_CREDITS_PER_HP = 1;

/** Недостающий корпус флота (корабли + десант), по эффективному hp с фитингами. */
export function missingHull(f: Fleet, data: GameData): number {
  let missing = 0;
  for (const stack of [...f.units, ...(f.landing ?? [])]) {
    if (stack.count <= 0 || stack.hp === undefined) continue;
    const def = data.units[stack.unit];
    if (!def) continue;
    const per = effectiveStats(def, stack, data).hp ?? 0;
    const full = stack.count * per;
    missing += Math.max(0, full - Math.min(stack.hp, full));
  }
  return missing;
}

/** Цена мгновенного ремонта в кредитах (0 — чинить нечего) — одна формула на
 *  сервер и кнопку клиента, чтобы ценник в UI не расходился с гейтом. */
export function instantRepairCost(f: Fleet, data: GameData): number {
  return Math.ceil(missingHull(f, data) * INSTANT_REPAIR_CREDITS_PER_HP);
}

export const instantRepairModule: GameModule = {
  id: 'instant-repair',
  version: '0.1.0',
  setup(api) {
    api.onAction('fleet.instantRepair', (action, h) => {
      const p = action.payload as { fleetId?: unknown };
      if (typeof p?.fleetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const f = h.state.fleets[p.fleetId];
      // Absent OR not-yours → one opaque code (A06 — no fleet-existence probing).
      if (!f || f.owner !== action.playerId) return h.reject('E_NO_FLEET');
      if (f.battleId) return h.reject('E_IN_BATTLE');
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      const hull = missingHull(f, h.ctx.data);
      if (hull <= 0) return h.reject('E_NOTHING_TO_REPAIR');
      const credits = Math.ceil(hull * INSTANT_REPAIR_CREDITS_PER_HP);
      if (!canAfford(player.resources, { credits })) return h.reject('E_NO_FUNDS');
      payCost(player.resources, { credits });
      for (const stack of [...f.units, ...(f.landing ?? [])]) delete stack.hp;
      h.emit('fleet.instantRepaired', { fleetId: f.id, owner: f.owner, credits, hull });
    });
  },
};

// --- ECON-3: экспресс-ремонт за металл ----------------------------------------
// Сток металла в духе Bytro: экспресс-ремонт за METAL у своего дока — дешёвая
// альтернатива платному мгновенному ремонту (за кредиты) и быстрая — бесплатному
// портовому (shipRepair 5–10%/ч остаётся). Металл тратится на латание корпуса,
// а не копится мёртвым грузом.
export const REPAIR_HP_PER_METAL = 2;

/** Цена экспресс-ремонта в metal (0 — чинить нечего) — одна формула на сервер и
 *  кнопку клиента. */
export function dockRepairCost(f: Fleet, data: GameData): number {
  return Math.ceil(missingHull(f, data) / REPAIR_HP_PER_METAL);
}

/** Есть ли у флота свой док: стоит (не летит) над СВОИМ миром с живым зданием,
 *  дающим `shipRepair > 0` (spaceport/shipyard). Та же проверка — в кнопке UI. */
export function fleetAtOwnDock(f: Fleet, state: GameState, data: GameData): boolean {
  if (f.movement || !f.location) return false;
  const planet = state.planets[f.location];
  if (!planet || planet.owner !== f.owner) return false;
  return planet.buildings.some((b) => {
    if (b.hp <= 0) return false;
    const def = data.buildings[b.type];
    return !!def && buildingLevel(def, b.level).shipRepair > 0;
  });
}

export const econScrewsModule: GameModule = {
  id: 'econ-screws',
  version: '0.1.0',
  setup(api) {
    // Экспресс-ремонт: мгновенный топ-ап корпуса за metal у своего дока.
    api.onAction('fleet.repair', (action, h) => {
      const p = action.payload as { fleetId?: unknown };
      if (typeof p?.fleetId !== 'string') return h.reject('E_BAD_PAYLOAD');
      const f = h.state.fleets[p.fleetId];
      // Absent OR not-yours → one opaque code (A06 — no fleet-existence probing).
      if (!f || f.owner !== action.playerId) return h.reject('E_NO_FLEET');
      if (f.battleId) return h.reject('E_IN_BATTLE');
      if (!fleetAtOwnDock(f, h.state, h.ctx.data)) return h.reject('E_NO_DOCK');
      const player = h.state.players[action.playerId];
      if (!player) return h.reject('E_NO_PLAYER');
      const hull = missingHull(f, h.ctx.data);
      if (hull <= 0) return h.reject('E_NOTHING_TO_REPAIR');
      const metal = Math.ceil(hull / REPAIR_HP_PER_METAL);
      if (!canAfford(player.resources, { metal })) return h.reject('E_NO_FUNDS');
      payCost(player.resources, { metal });
      for (const stack of [...f.units, ...(f.landing ?? [])]) delete stack.hp;
      h.emit('fleet.repaired', { fleetId: f.id, owner: f.owner, metal, hull });
    });
  },
};

export const MODULES: GameModule[] = [
  sectorModule,
  planetTypeModule,
  taxModule, // civic tax on inhabited worlds (hooks economy.production, after planetType)
  factionModule, // H3: чисто пассивные бонусы дома (production / fleet.speed / combat.damage)
  hungerModule, // ECON-1: food в arrears → наземный урон ×0.75 (корабли едят кредиты)
  economyModule,
  movementModule,
  heroModule, // projection hero: fleet combat aura (+5%) + death/respawn
  heroEffectsModule, // first hero.effect.<type> capability provider: recall (warp ship home)
  // The combat family (split along the bus seams). Order matters (invariant #6):
  // orbital stamps orbit on fleet.arrived BEFORE combat engages, and runs its
  // AA/bombard span BEFORE artillery's standoff span — the old internal sequence.
  orbitalModule, // the single near-orbit: stationing, AA fire, bombardment
  combatModule, // melee battles: engage / tick / assault / retreat / capture
  artilleryModule, // standoff fire accrual + barrage orders
  interceptModule, // schedules lane-crossing meetings (resolved by combat)
  captureOnArrivalModule, // walk-in capture now a kernel rule (was client-side seizeSector)
  constructionModule,
  arsenalSyncModule, // LARS-1: server-driver refresh of live build-catalog ownership (bypasses gate)
  technologyModule, // session research: branch/day-gated techs → effect bonuses + content unlocks
  stewardModule, // «Хранитель»: delegate the seat to the AI while you sleep (gated by the Steward tech)
  armyModule,
  victoryModule, // terminal match state from authoritative state (domination / elimination / score / timeout)
  fleetLaunchModule,
  diplomacyModule, // CORE D2+D3 (D4): escalation/consent offers; combat reads state.diplomacy
  espionageModule, // SPY-1 core module: espionage.spy → time-boxed intel windows (state.intel)
  botDiplomacyModule, // bots: friendly-by-default favour meter → embargo/war only when provoked
  marketModule, // session resource market: two-sided order book (sell/buy lots), embargo-gated
  divisionModule, // ground divisions: mobilise from a template + daily restoration
  capitalModule, // designatable capital (hero respawn / module re-fit anchor)
  standingOrdersModule, // CC-2/CC-4 standing orders (auto-storm / дежурный вылет), server-driven
  forcedMarchModule, // BOOST-1 форс-марш: +50% скорости за 5% max-HP износа в час хода
  instantRepairModule, // платный мгновенный ремонт корпуса (кредиты как премиум-валюта)
  econScrewsModule, // ECON-3: экспресс-ремонт корпуса за metal у своего дока
  effectsModule, // EFX-1: интерпретатор data.events (trigger→effect); инертен, пока events: {} пуст
];

export const kernel = createKernel(MODULES);

// Win at 1100 of the board's ~2410 base points (30 planets×50 + 91 provinces×10). Set
// below the ~60% domination line so a decisive-but-not-total lead — a fistful of planets
// plus built-up infrastructure — can win the SCORE race first, making the score/building
// system (scoreValue) meaningful instead of vestigial vs conquest. Tunable single source
// of truth, also read by the HUD score readout.
export const SCORE_LIMIT = 1100;
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
  // Chain partial catch-ups (mirrors matchRoom.computeAdvance): a long-idle world
  // may exceed MAX_ADVANCE_STEPS per call; stopping short would leave due events in
  // the queue and `order()` would then hit the kernel's E_TIME_GAP guard. A chunk
  // that makes NO progress (same-instant runaway) breaks out — the frame loop
  // retries next tick rather than spinning here.
  let cur = state;
  const events: StepOut['events'] = [];
  for (let i = 0; i < 10; i++) {
    const r = kernel.advanceTo(cur, ctx(now));
    if (!r.ok) return { state: cur, events, error: r.code };
    const progressed = r.state.time > cur.time;
    cur = r.state;
    events.push(...r.events);
    if (!r.partial || !progressed) break;
  }
  return { state: cur, events };
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
/** Build a hull with a chosen module loadout (the «Оснащение корабля» constructor).
 *  The modules ride in the `unit.build` payload; the core stamps them onto the built
 *  stack (validated + priced by `loadout.ts`), locked for good — no refit. */
export const buildShip = (
  playerId: string,
  planetId: string,
  unit: string,
  count: number,
  modules: string[],
) => act(playerId, 'unit.build', { planetId, unit, count, modules });
/** Cancel an ACTIVE (already paid) building/upgrade/unit order: refunds the unbuilt
 *  share of its cost and parks it as a resumable paused site — `seq` is the order's
 *  `construction.complete` scheduled-event seq (already read off `s.scheduled`, e.g.
 *  by `activeConstruction()`). */
export const cancelConstruction = (playerId: string, planetId: string, seq: number) =>
  act(playerId, 'construction.cancel', { planetId, seq });
/** Resume a paused site: pays exactly what was refunded, continues from the same
 *  progress. `id` is the `PausedConstructionSite.id` (= the original order's `seq`). */
export const resumeConstruction = (playerId: string, planetId: string, id: number) =>
  act(playerId, 'construction.resume', { planetId, id });
export const engageFleet = (playerId: string, fleetId: string, targetId: string) =>
  act(playerId, 'fleet.engage', { fleetId, targetId });
/** Begin researching a session technology (one active at a time — technologyModule). */
export const researchTech = (playerId: string, technology: string) =>
  act(playerId, 'technology.research', { technology });
/** «Хранитель»: hand this seat to the AI until game-time `until`, running `posture` —
 *  'defend' («Оборона», the safe default) or 'active_defend' («Активная оборона»,
 *  ST-3.3: + forecast-gated counterstrike and squadron fire-watch on own soil).
 *  Rejected (E_STEWARD_LOCKED) until the Steward tech is researched. */
export const delegateSteward = (
  playerId: string,
  until: number,
  posture: StewardPosture = 'defend',
) => act(playerId, 'steward.delegate', { posture, until });
/** Take the seat back early (a safe no-op if nothing was delegated). */
export const recallSteward = (playerId: string) => act(playerId, 'steward.recall', {});
/** Mark (or unmark) an OWN world as a hold point (ST-2.1) — a standing order the
 *  Steward honors under any posture: never auto-evacuated, reinforced under threat. */
export const setHoldPoint = (playerId: string, planetId: string, on: boolean) =>
  act(playerId, 'steward.holdpoint', { planetId, on });
// Re-export the Steward reads so the netserver + UI import them from the `./game` façade.
export { stewardActive, STEWARD_POSTURES, MAX_STEWARD_HOLD_POINTS };
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
/** A fleet may run its next queued step only when idle — not in transit, not locked in
 *  a battle. (A fleet parked on a lane counts as idle; its next move routes from there.) */
export function fleetIdle(fleet: Fleet): boolean {
  return !fleet.movement && !fleet.battleId;
}

/** One CC-1 chain step. `move` — fly to a world; `wait` — hold N game-hours
 *  (Задержка); `assault` — storm the world under the fleet (entering orbit first if
 *  needed); `barrage` — focus artillery standoff fire (null = nearest hostile).
 *  A step runs when the fleet is FREE, so «прийти и открыть огонь» = [move, barrage]
 *  and a waypoint route (Точка+) is just several move steps. */
export type ChainStep =
  | { kind: 'move'; to: string }
  | { kind: 'wait'; hours: number }
  | { kind: 'assault' }
  | { kind: 'barrage'; target: string | null }
  // A FIRE WINDOW: focus artillery standoff fire (null = auto-target) for `hours`
  // game-hours, then cease and move on. Artillery damage is continuous
  // (`power × hours`, artillery.ts) — hours ARE the honest count of «ударов».
  | { kind: 'strike'; target: string | null; hours: number };
/** A fleet's queued chain: the remaining steps + the deadline of the ARMED head
 *  `wait` step (stamped by the driver; absent while the head is not a ticking wait). */
export interface FleetChain {
  steps: ChainStep[];
  waitUntil?: number;
}
export const MAX_CHAIN_STEPS = 8;
/** One Задержка is capped at 14 game-days — enough for any real plan, too short to
 *  park garbage in state forever. */
export const MAX_CHAIN_WAIT_HOURS = 24 * 14;

/** Rebuild chain steps from a raw payload: only known kinds, only known worlds, no
 *  smuggled extra keys into state (A08). null = garbage → E_BAD_PAYLOAD. */
export function validateChainSteps(raw: unknown, state: GameState): ChainStep[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CHAIN_STEPS) return null;
  const out: ChainStep[] = [];
  for (const item of raw) {
    const step = item as { kind?: unknown; to?: unknown; hours?: unknown; target?: unknown } | null;
    if (!step || typeof step !== 'object') return null;
    if (step.kind === 'move') {
      if (typeof step.to !== 'string' || !state.planets[step.to]) return null;
      out.push({ kind: 'move', to: step.to });
    } else if (step.kind === 'wait') {
      const h = step.hours;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_CHAIN_WAIT_HOURS) {
        return null;
      }
      out.push({ kind: 'wait', hours: h });
    } else if (step.kind === 'assault') {
      out.push({ kind: 'assault' });
    } else if (step.kind === 'barrage') {
      if (step.target !== null && step.target !== undefined && typeof step.target !== 'string') {
        return null;
      }
      out.push({ kind: 'barrage', target: typeof step.target === 'string' ? step.target : null });
    } else if (step.kind === 'strike') {
      if (step.target !== null && step.target !== undefined && typeof step.target !== 'string') {
        return null;
      }
      const h = step.hours;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_CHAIN_WAIT_HOURS) {
        return null;
      }
      out.push({
        kind: 'strike',
        target: typeof step.target === 'string' ? step.target : null,
        hours: h,
      });
    } else {
      return null;
    }
  }
  return out;
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

/** Does this fleet carry a launchable strike wing (squadron-trait ships)? */
export function fleetHasSquadron(f: Fleet | undefined): boolean {
  return (
    !!f &&
    f.units.some((u) => u.count > 0 && (data.units[u.unit]?.traits.includes('squadron') ?? false))
  );
}

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

/** One tick of the SERVER-SIDE auto-storm driver (CC-2): every fleet flagged in
 *  `state.autoAssault` that sits over someone else's capturable world with the orbit
 *  clear gets its storm orders. Mirrors the client autoEngage() conditions exactly.
 *  Pure — the host applies the actions; a rejection is simply skipped (a standing
 *  stance has no chain to block). */
export function serverAutoAssaultActions(
  state: GameState,
): Array<{ fleetId: string; owner: string; actions: Action[] }> {
  const flagged = (state as DivState).autoAssault ?? {};
  const out: Array<{ fleetId: string; owner: string; actions: Action[] }> = [];
  for (const fid of Object.keys(flagged)) {
    const f = state.fleets[fid];
    if (!f || f.location === null || !fleetIdle(f)) continue;
    const here = state.planets[f.location];
    if (!here || !isCapturable(data, here) || here.owner === f.owner) continue;
    // Auto-storm only worlds we are AT WAR with (bug-hunt MINOR): the core rejects a
    // peaceful assault anyway (E_FORBIDDEN), but the driver re-issued the doomed pair
    // on every wake — rejected-action churn, and the fleet.orbit half DID apply.
    if (here.owner !== null && getStance(state, f.owner, here.owner) !== 'war') continue;
    const enemyHere = Object.values(state.fleets).some(
      (g) => g.owner !== f.owner && g.location === f.location && g.units.some((u) => u.count > 0),
    );
    if (enemyHere) continue; // let the orbital battle settle first
    // An assault needs near orbit first (orbit is instant), mirroring the AI capture pass.
    const actions =
      f.orbit === 'near'
        ? [assaultFleet(f.owner, fid)]
        : [orbitFleet(f.owner, fid), assaultFleet(f.owner, fid)];
    out.push({ fleetId: fid, owner: f.owner, actions });
  }
  return out;
}

/** One tick of the CC-1 chain driver: for every chained fleet that is FREE (not in
 *  transit, not in battle), resolve the head step into the orders to issue plus the
 *  `chain.stamp` patch ([] steps = chain done → cleared). Consume-on-issue: a step
 *  whose order the core then rejects is SKIPPED, not retried forever (the CC-2
 *  rejected-churn lesson). Sorted fleet ids ⇒ deterministic across hosts (JSONB does
 *  not preserve object key order). Pure — hosts apply the patch, then the actions. */
export function serverChainActions(
  state: GameState,
  now: number,
): Array<{
  fleetId: string;
  owner: string;
  actions: Action[];
  patch?: { steps: ChainStep[]; waitUntil?: number };
}> {
  const chains = (state as DivState).orders ?? {};
  const out: Array<{
    fleetId: string;
    owner: string;
    actions: Action[];
    patch?: { steps: ChainStep[]; waitUntil?: number };
  }> = [];
  for (const fid of Object.keys(chains).sort()) {
    const chain = chains[fid]!;
    const f = state.fleets[fid];
    if (!f) continue; // dead fleet — the module's own housekeeping sweep clears it
    if (!fleetIdle(f)) continue; // busy: the chain resumes once the fleet is free
    const head = chain.steps[0];
    if (!head) {
      out.push({ fleetId: fid, owner: f.owner, actions: [], patch: { steps: [] } });
      continue;
    }
    const rest = chain.steps.slice(1);
    if (head.kind === 'wait') {
      // Two-phase hold: arm the deadline once, then consume when the clock passes it.
      if (chain.waitUntil === undefined) {
        out.push({
          fleetId: fid,
          owner: f.owner,
          actions: [],
          patch: { steps: chain.steps, waitUntil: now + head.hours * HOUR },
        });
      } else if (now >= chain.waitUntil) {
        out.push({ fleetId: fid, owner: f.owner, actions: [], patch: { steps: rest } });
      }
    } else if (head.kind === 'move') {
      out.push({
        fleetId: fid,
        owner: f.owner,
        // Already there → nothing to issue (the core would reject E_SAME_LOCATION).
        actions: f.location === head.to ? [] : [moveFleet(f.owner, fid, head.to)],
        patch: { steps: rest },
      });
    } else if (head.kind === 'assault') {
      out.push({
        fleetId: fid,
        owner: f.owner,
        actions:
          f.orbit === 'near'
            ? [assaultFleet(f.owner, fid)]
            : [orbitFleet(f.owner, fid), assaultFleet(f.owner, fid)],
        patch: { steps: rest },
      });
    } else if (head.kind === 'strike') {
      // Fire window, two-phase like `wait`: open — focus the guns and arm the
      // deadline; close — cease fire (clear focus) and move on. A fleet with no
      // artillery just idles through the window (the focus order rejects, the
      // window still runs — deterministic either way).
      if (chain.waitUntil === undefined) {
        out.push({
          fleetId: fid,
          owner: f.owner,
          actions: [barrageFleet(f.owner, fid, head.target)],
          patch: { steps: chain.steps, waitUntil: now + head.hours * HOUR },
        });
      } else if (now >= chain.waitUntil) {
        out.push({
          fleetId: fid,
          owner: f.owner,
          actions: [barrageFleet(f.owner, fid, null)],
          patch: { steps: rest },
        });
      }
    } else {
      out.push({
        fleetId: fid,
        owner: f.owner,
        actions: [barrageFleet(f.owner, fid, head.target)],
        patch: { steps: rest },
      });
    }
  }
  return out;
}

/** One tick of the SERVER-SIDE patrol driver (CC-4): tick each standing patrol's rearm
 *  on its game-hour cadence, then — if the wing is parked and flight-ready — scramble at
 *  the lowest-id identified, at-war contact inside the radius (the same pure scrambleOrder
 *  the solo driver uses; vision comes from the owner's identify coverage, so the server
 *  never lets a patrol see through the fog its owner has). Pure — the host applies the
 *  strike `actions` and persists `patch` via patrol.stamp; `drop` retires a patrol whose
 *  fleet lost its wing. */
export function serverPatrolActions(
  state: GameState,
  now: number,
): Array<{
  fleetId: string;
  owner: string;
  actions: Action[];
  patch?: { sortie: SortieState; rearmAt?: number };
  drop?: boolean;
}> {
  const patrols = (state as DivState).patrols ?? {};
  const out: Array<{
    fleetId: string;
    owner: string;
    actions: Action[];
    patch?: { sortie: SortieState; rearmAt?: number };
    drop?: boolean;
  }> = [];
  const identify = new Map<string, Set<string>>(); // owner → identified nodes (hoisted per owner)
  // Sorted fleet-id iteration (like serverChainActions above): JSONB does not preserve
  // object key order, so unsorted iteration would make the strike-issue order — and thus
  // which of two co-located wings wins a race for the same target — host/hibernation
  // dependent. Sorting pins one order across hosts and wake cycles (invariant #6).
  for (const fid of Object.keys(patrols).sort()) {
    const p = patrols[fid]!;
    const f = state.fleets[fid];
    if (!f || !fleetHasSquadron(f)) {
      out.push({ fleetId: fid, owner: f?.owner ?? '', actions: [], drop: true });
      continue;
    }
    const spec = sortieSpec(f);
    // Rearm cadence: one round per game-hour past `rearmAt` (absolute stamps — no
    // wall-clock drift, works however rarely the offline room wakes).
    let sortie = p.sortie;
    let rearmAt = p.rearmAt ?? now + HOUR;
    while (now >= rearmAt) {
      sortie = tickRearm(sortie, spec.maxFuel);
      rearmAt += HOUR;
    }
    let actions: Action[] = [];
    if (fleetIdle(f)) {
      let seen = identify.get(f.owner);
      if (!seen) {
        seen = identifiedNodes(state, f.owner, data);
        identify.set(f.owner, seen);
      }
      const targets: Array<{ id: string; location: string; pos: { x: number; y: number } }> = [];
      for (const g of Object.values(state.fleets)) {
        if (g.owner === f.owner || !g.location || g.movement || !g.units.some((u) => u.count > 0))
          continue;
        if (g.battleId) continue; // already locked in a battle — engage would reject, yet the sortie fuel is spent (BF-30)
        if (getStance(state, f.owner, g.owner) !== 'war') continue; // declared enemies only — never auto-war
        if (!seen.has(g.location)) continue; // identified contacts only — fog-honest
        const pos = state.planets[g.location]?.position;
        if (pos) targets.push({ id: g.id, location: g.location, pos });
      }
      const res = scrambleOrder(f.owner, f, { ...p, sortie }, targets, spec.rearmRounds);
      sortie = res.sortie;
      if (res.action) actions = [res.action];
    }
    const changed =
      sortie.fuel !== p.sortie.fuel ||
      sortie.rearming !== p.sortie.rearming ||
      rearmAt !== p.rearmAt;
    out.push({
      fleetId: fid,
      owner: f.owner,
      actions,
      patch: changed ? { sortie, rearmAt } : undefined,
    });
  }
  return out;
}

/** Toggle the CC-2 auto-storm stance on an owned fleet (authoritative standing order). */
export const orderAuto = (playerId: string, fleetId: string, on: boolean) =>
  act(playerId, 'order.auto', { fleetId, on });
/** Stand (or stand down) a CC-4 reactive patrol on an owned squadron fleet — the server
 *  computes the patrol itself (center / radius / fresh sortie). */
export const orderScramble = (playerId: string, fleetId: string, on: boolean) =>
  act(playerId, 'order.scramble', { fleetId, on });
/** The patrol driver's runtime stamp: burned fuel / ticked rearm / next cadence mark. */
export const patrolStamp = (
  playerId: string,
  fleetId: string,
  sortie: SortieState,
  rearmAt?: number,
) =>
  act(
    playerId,
    'patrol.stamp',
    rearmAt === undefined ? { fleetId, sortie } : { fleetId, sortie, rearmAt },
  );
/** CC-1: set (or [] = cancel) an owned fleet's whole order chain atomically. */
export const orderChain = (playerId: string, fleetId: string, steps: ChainStep[]) =>
  act(playerId, 'order.chain', { fleetId, steps });
/** BOOST-1: toggle форс-марш on an owned fleet (+50% speed, hull wear in transit). */
export const forceMarchFleet = (playerId: string, fleetId: string, on: boolean) =>
  act(playerId, 'fleet.forcemarch', { fleetId, on });
/** Платный мгновенный ремонт корпуса всего флота (цена — `instantRepairCost`). */
export const instantRepairFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.instantRepair', { fleetId });
/** ECON-3а: экспресс-ремонт за metal у своего дока (цена — `dockRepairCost`). */
export const repairFleet = (playerId: string, fleetId: string) =>
  act(playerId, 'fleet.repair', { fleetId });
/** The chain driver's runtime stamp: consumed head / armed wait deadline. */
export const chainStamp = (
  playerId: string,
  fleetId: string,
  steps: ChainStep[],
  waitUntil?: number,
) =>
  act(
    playerId,
    'chain.stamp',
    waitUntil === undefined ? { fleetId, steps } : { fleetId, steps, waitUntil },
  );

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
/** Mobilise division template `template` (0-based) on your world `planetId`.
 *  `officer` = build from the named OFFICER_TEMPLATES roster instead (locked premades). */
export const mobilizeDivision = (
  playerId: string,
  planetId: string,
  template: number,
  officer = false,
) =>
  act(
    playerId,
    'division.mobilize',
    officer ? { planetId, template, officer: true } : { planetId, template },
  );
/** Rename your CUSTOM division template (designer menu). */
export const renameDivisionTemplate = (playerId: string, template: number, name: string) =>
  act(playerId, 'division.rename', { template, name });
/** Assemble a template: set slot `slot` of your template `template` to `unit` (null = clear). */
export const setDivisionTemplate = (
  playerId: string,
  template: number,
  slot: number,
  unit: string | null,
) => act(playerId, 'division.template', { template, slot, unit });
/** Load a garrisoning division into a co-located, idle fleet (by free hold). */
export const loadDivision = (playerId: string, divisionId: string, fleetId: string) =>
  act(playerId, 'division.load', { divisionId, fleetId });
/** Unload a carried division onto the world its carrier is docked over. */
export const unloadDivision = (playerId: string, divisionId: string) =>
  act(playerId, 'division.unload', { divisionId });
/** Designate one of your inhabited worlds as your capital (hero respawn / re-fit anchor). */
export const designateCapital = (playerId: string, planetId: string) =>
  act(playerId, 'capital.designate', { planetId });

// --- hero engine (core heroModule, HERO-3..9): the data-driven hero actions ---
/** Cast a hero ability (HERO-4 dispatcher); `target` — planet id for ranged casts. */
export const castHeroAbility = (
  playerId: string,
  heroId: string,
  abilityId: string,
  target?: string,
) =>
  act(playerId, 'hero.ability', { heroId, abilityId, ...(target !== undefined ? { target } : {}) });
/** Raise an undeployed hero's ship at an owned world (or own fleet / allied world
 *  when the hero carries the matching spawn-marker ability). */
export const spawnHero = (playerId: string, heroId: string, at: string) =>
  act(playerId, 'hero.spawn', { heroId, at });
/** Unlock a hero skill-tree node (branch/requires/cost gate the order). */
export const unlockHeroSkill = (playerId: string, heroId: string, node: string) =>
  act(playerId, 'hero.skill.unlock', { heroId, node });
/** Install a ship fitting into one of the hero archetype's slots (no refit). */
export const fitHero = (playerId: string, heroId: string, fitting: string) =>
  act(playerId, 'hero.fit', { heroId, fitting });

/** Can `mover`'s fleets enter/traverse a province owned by `owner`? Neutral, your own,
 *  and players you're at war / pact / alliance with are passable; a player you're at
 *  PEACE with is blocked (you'd have to declare war first). */
export function canTraverse(state: GameState, mover: string, owner: string | null): boolean {
  if (owner == null || owner === mover) return true;
  return getStance(state, mover, owner) !== 'peace';
}

// --- AI ----------------------------------------------------------------------

/** A garrison unit the evacuation can actually lift: the same gate `army.load`
 *  enforces (ground cargo only, fixed emplacements stay). */
const liftable = (unit: string): boolean => {
  const def = data.units[unit];
  return !!def && def.domain === 'ground' && !def.traits.includes('immobile');
};

/** Anti-shuttle cooldown (ST-3.4), game-hours: after the Steward evacuates X→Y,
 *  the REVERSE trip Y→X is off the haven list for this long — an enemy poking
 *  two nodes alternately must not make the wing челночить between them forever
 *  (each leg it defends nothing and a lane camper can catch it in the open).
 *  With no other haven the wing STANDS instead — a fight beats eternal transit. */
const EVAC_RETURN_COOLDOWN_H = 12;

/**
 * One guard-duty tick of the Steward for a delegated seat (posture «Оборона»,
 * ST-3.2 / steward-roadmap §ST-3): for every owned world a VISIBLE hostile
 * bears on, forecast the stand (`previewBattle`: every bearing force strikes,
 * the node's whole defense — docked fleets + garrison — answers). Forecast own
 * losses at/over `STEWARD_LOSS_LIMIT` mean the fight is a bad trade, so the
 * wing is pulled out to the nearest SAFE own world: self-moving fleets fly out
 * (lifting what garrison fits their holds on the way), and for the rest the
 * nearest idle transport with a free hold is summoned — only if it can arrive
 * with a tick to spare BEFORE the threat lands, because `army.load` locks the
 * moment the assault starts (`E_UNDER_ASSAULT`). Evacuation is loss-avoidance:
 * the autopilot saves what it cannot profitably defend, it never fights better
 * than the player would. Pure builder like `aiOrders`: returns actions only.
 * The forecast is the base model (no `combat.damage` hooks) over one combined
 * engagement — a retreat heuristic, not an oracle (ONB-6 semantics).
 */
export function stewardGuardOrders(
  state: GameState,
  ai: string,
  posture: StewardPosture = 'defend',
): Action[] {
  const out: Action[] = [];
  const c = ctx(state.time);
  // SITREP (ST-2.4): every decision below is journaled and stamped as ONE
  // trailing `steward.report` — the morning report the sleeping owner reads.
  const report: StewardLogEntry[] = [];
  const frac = (x: number): number => Math.round(x * 1000) / 1000;
  // Repeat-prone facts (hold/stranded re-derive every 2h tick) are stamped once
  // per EPISODE: skipped while the node's latest journal line already says the
  // same thing. The journal lives in state, so the check survives the stateless
  // re-tick; any different entry for the node reopens the episode.
  const lastLogged = (node: string): string | undefined => {
    const log = state.players[ai]?.stewardLog;
    if (!log) return undefined;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.node === node) return log[i]!.kind;
    }
    return undefined;
  };
  const noteOnce = (entry: StewardLogEntry): void => {
    if (entry.node !== undefined && lastLogged(entry.node) === entry.kind) return;
    report.push(entry);
  };
  const identified = identifiedNodes(state, ai, data);
  const mine = Object.values(state.planets).filter((p) => p.owner === ai);
  // Threat scans are per-node; cache them — the haven search re-reads them.
  const threatCache = new Map<string, ReturnType<typeof scanNodeThreats>>();
  const threatsOf = (node: string): ReturnType<typeof scanNodeThreats> => {
    let t = threatCache.get(node);
    if (t === undefined) {
      t = scanNodeThreats(state, node, ai, c, identified);
      threatCache.set(node, t);
    }
    return t;
  };
  // Hold points (ST-2.1): player-designated standing anchors — never evacuated,
  // reinforced instead; their docked wings are not poached for other errands.
  const holdPoints = new Set(state.players[ai]?.stewardHoldPoints ?? []);
  // A fleet gets ONE task per tick (evacuate or ferry) — never two nodes' errands.
  const tasked = new Set<string>();
  const idleOwn = (f: Fleet): boolean =>
    f.owner === ai && f.location != null && !f.movement && !f.battleId && !tasked.has(f.id);
  // fleetCargoFree, not a local re-count: the hold is shared with carried DIVISIONS
  // too — a transport already ferrying a formation must not be over-filled.
  const freeHold = (f: Fleet): number => fleetCargoFree(state, f);

  for (const p of mine) {
    const threats = threatsOf(p.id);
    if (threats.length === 0) continue;
    const docked = Object.values(state.fleets).filter((f) => idleOwn(f) && f.location === p.id);
    const defenders: UnitStack[] = [...docked.flatMap((f) => f.units), ...p.garrison];
    if (!defenders.some((s) => s.count > 0)) continue; // nothing here to save
    const attackers: UnitStack[] = threats.flatMap((t) => {
      const f = state.fleets[t.fleetId];
      return f ? [...f.units, ...(f.landing ?? [])] : [];
    });
    const stand = previewBattle(attackers, defenders, data);
    // A stand the forecast says we WIN is held regardless of its price: fleeing a
    // won fight gifts the world to a cheap feint (three scouts «push» a cruiser
    // off an empty rock and walk in). The loss limit judges only losing/pyrrhic
    // stands — the wing bails when it would be wiped or ground down for nothing.
    const holds =
      stand.outcome === 'defender' || stand.defender.damageFraction < STEWARD_LOSS_LIMIT;
    if (holds) {
      // Counterstrike (ST-3.3, «Активная оборона» only): war-stance intruders
      // PARKED at our node that auto-engage didn't already lock (war declared
      // after they docked; a resolved battle's leftovers). The combat module
      // AUTO-re-engages a battle's victor into the NEXT parked hostile, so the
      // gate must price the WHOLE ladder, not the first rung: the wing has to
      // clear EVERY parked intruder, chained in scan order, with CUMULATIVE
      // hull losses under the limit — else a cheap first fight would drag the
      // damaged wing into one its forecast declined («держим, но не
      // кровоточим»). One engager, one order — the victor chain does the rest;
      // the fight happens where the wing stands: own territory only.
      const holdEntry: StewardLogEntry = {
        at: state.time,
        kind: 'hold',
        node: p.id,
        fraction: frac(stand.defender.damageFraction),
      };
      if (posture !== 'active_defend') {
        noteOnce(holdEntry);
        continue;
      }
      const ladder: Fleet[] = [];
      for (const t of threats) {
        if (t.kind !== 'present') continue;
        const tf = state.fleets[t.fleetId];
        if (tf && !tf.battleId) ladder.push(tf);
      }
      if (ladder.length === 0) {
        noteOnce(holdEntry);
        continue;
      }
      const byStrength = [...docked].sort(
        (a, b) =>
          hullPool(b.units, data) - hullPool(a.units, data) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      let engaged = false;
      for (const f of byStrength) {
        if (tasked.has(f.id)) continue;
        let wing = f.units;
        let clears = true;
        for (const tf of ladder) {
          const rung = previewBattle(wing, tf.units, data);
          if (rung.outcome !== 'attacker') {
            clears = false;
            break;
          }
          wing = rung.attacker.survivors; // carry the hull damage into the next rung
        }
        const before = hullPool(f.units, data);
        if (!clears || before <= 0) continue;
        const ladderFraction = 1 - hullPool(wing, data) / before;
        if (ladderFraction >= STEWARD_LOSS_LIMIT) continue;
        out.push(engageFleet(ai, f.id, ladder[0]!.id));
        tasked.add(f.id);
        engaged = true;
        report.push({
          at: state.time,
          kind: 'strike',
          node: p.id,
          fleetId: f.id,
          count: ladder.length,
          fraction: frac(ladderFraction),
        });
        break;
      }
      if (!engaged) noteOnce(holdEntry);
      continue;
    }
    const earliest = threats[0]!.eta;
    // Hold point (ST-2.1): a player-designated anchor is NEVER auto-evacuated —
    // the standing order outranks the loss forecast. The Steward instead tries
    // to FLIP the forecast: summon ONE idle wing that (a) arrives with a tick
    // (2h) to spare before the earliest threat lands and (b) turns the combined
    // stand into a hold. Piecemeal feeding is refused — help that arrives late
    // or still loses would only widen the defeat; the wing then stands as
    // ordered, and the journal's bad fraction tells the owner the price.
    if (holdPoints.has(p.id)) {
      // Help already flying in (last tick's relief or the owner's own order) —
      // nothing to add; the episode is already journaled.
      const inboundHelp = Object.values(state.fleets).some(
        (f) => f.owner === ai && f.movement != null && journeyDestination(f.movement) === p.id,
      );
      if (!inboundHelp) {
        let relief: Fleet | null = null;
        let reliefEta = Infinity;
        let reliefFraction = 0;
        for (const f of Object.values(state.fleets)) {
          if (!idleOwn(f) || f.location === p.id) continue;
          if (!f.units.some((s) => s.count > 0)) continue;
          // Same no-poach rule as the ferry: a wing on another threatened node
          // (or another anchor) is needed where it stands.
          if (threatsOf(f.location!).length > 0 || holdPoints.has(f.location!)) continue;
          const hours = estimateTravelHours(state, data, f.location!, p.id, f);
          if (hours === null) continue;
          const arrives = state.time + hoursToMs(c, hours);
          if (arrives + hoursToMs(c, 2) > earliest) continue; // too late to matter
          const together = previewBattle(attackers, [...defenders, ...f.units], data);
          const flips =
            together.outcome === 'defender' ||
            together.defender.damageFraction < STEWARD_LOSS_LIMIT;
          if (!flips) continue;
          if (arrives < reliefEta) {
            reliefEta = arrives;
            relief = f;
            reliefFraction = together.defender.damageFraction;
          }
        }
        if (relief) {
          out.push(moveFleet(ai, relief.id, p.id));
          tasked.add(relief.id);
          report.push({
            at: state.time,
            kind: 'reinforce',
            node: p.id,
            fleetId: relief.id,
            fraction: frac(reliefFraction),
          });
        } else {
          noteOnce({
            at: state.time,
            kind: 'hold',
            node: p.id,
            fraction: frac(stand.defender.damageFraction),
          });
        }
      }
      continue; // a hold point never falls through to evacuation
    }
    // Bad trade — evacuate to the nearest reachable own world nothing bears on.
    // Anti-shuttle hysteresis (ST-3.4): a candidate we RECENTLY fled FROM into
    // this very node is the shuttle's return leg — journaled evacuations
    // (state-resident, so the check survives the stateless re-tick) block it
    // for EVAC_RETURN_COOLDOWN_H game-hours.
    const returnBlocked = (candidate: string): boolean => {
      const log = state.players[ai]?.stewardLog;
      if (!log) return false;
      const horizon = hoursToMs(c, EVAC_RETURN_COOLDOWN_H);
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i]!;
        if (e.kind !== 'evac' || e.node !== candidate || e.to !== p.id) continue;
        if (state.time - e.at < horizon) return true;
      }
      return false;
    };
    let haven: string | null = null;
    let havenDist = Infinity;
    for (const q of mine) {
      if (q.id === p.id || threatsOf(q.id).length > 0 || returnBlocked(q.id)) continue;
      const route = planRoute(state, p.id, q.id);
      if (!route) continue;
      const dist = routeDistance(state, p.id, route);
      if (dist < havenDist) {
        havenDist = dist;
        haven = q.id;
      }
    }
    if (haven === null) {
      // Nowhere safer — a FORCED stand; the bad fraction in the entry tells the
      // owner why the wing stayed put.
      noteOnce({
        at: state.time,
        kind: 'hold',
        node: p.id,
        fraction: frac(stand.defender.damageFraction),
      });
      continue;
    }
    const assaulted = garrisonUnderAssault(state, p.id);
    // What the garrison still holds after the loads planned below (state is
    // read-only). Counted EXACTLY as `army.load` will resolve it — via
    // findHealthyStack: only a full-health, default-loadout stack embarks.
    // Battle-worn troops cannot be lifted (they hold the line; hospitals mend
    // them) — planning them would bounce off E_NO_ARMY and, worse, mark the
    // garrison as handled so no ferry would come for anyone.
    const left = new Map<string, number>();
    for (const s of p.garrison) {
      if (s.count <= 0 || !liftable(s.unit) || left.has(s.unit)) continue;
      const healthy = findHealthyStack(p.garrison, s.unit);
      if (healthy) left.set(s.unit, healthy.count);
    }
    // Docked fleets fly out — lifting what garrison fits their holds first
    // (load and move stack in one tick: actions apply in order while docked).
    for (const f of docked) {
      if (!assaulted) {
        let free = freeHold(f);
        for (const [unit, have] of left) {
          if (free <= 0 || have <= 0) continue;
          const size = data.units[unit]?.stats.cargoSize ?? 0;
          const n = size > 0 ? Math.min(have, Math.floor(free / size)) : have;
          if (n <= 0) continue;
          out.push(loadArmy(ai, f.id, unit, n));
          left.set(unit, have - n);
          free -= n * size;
        }
      }
      // A standing patrol flies out with its carrier: stand it down first (the
      // sortie is stashed, BF-26) so no stale patrol record points at this node.
      if ((state as DivState).patrols?.[f.id]) out.push(orderScramble(ai, f.id, false));
      out.push(moveFleet(ai, f.id, haven));
      tasked.add(f.id);
    }
    if (docked.length > 0) {
      report.push({
        at: state.time,
        kind: 'evac',
        node: p.id,
        to: haven,
        count: docked.length,
        fraction: frac(stand.defender.damageFraction),
      });
    }
    // Garrison still stranded → summon the nearest idle transport with a free
    // hold, but only when it beats the threat with one AI tick (2h) to spare —
    // a transport that would arrive into the assault is not sent at all.
    const stranded = [...left.values()].some((n) => n > 0);
    const inboundAlready = Object.values(state.fleets).some(
      (f) => f.owner === ai && f.movement != null && journeyDestination(f.movement) === p.id,
    );
    if (stranded && !inboundAlready && !assaulted) {
      let ferry: Fleet | null = null;
      let ferryEta = Infinity;
      for (const f of Object.values(state.fleets)) {
        if (!idleOwn(f) || f.location === p.id || freeHold(f) <= 0) continue;
        // Never poach a transport off ANOTHER threatened node (its own evac
        // branch tasks it) or off a hold point (the anchor keeps its wing).
        if (threatsOf(f.location!).length > 0 || holdPoints.has(f.location!)) continue;
        const hours = estimateTravelHours(state, data, f.location!, p.id, f);
        if (hours === null) continue;
        const arrives = state.time + hoursToMs(c, hours);
        if (arrives + hoursToMs(c, 2) > earliest) continue; // too late to load — don't feed it in
        if (arrives < ferryEta) {
          ferryEta = arrives;
          ferry = f;
        }
      }
      if (ferry) {
        out.push(moveFleet(ai, ferry.id, p.id));
        tasked.add(ferry.id);
        report.push({ at: state.time, kind: 'ferry', node: p.id, fleetId: ferry.id });
      } else {
        // Liftable troops remain, no help is coming this tick — the owner should
        // wake up to «гарнизон не спасти», not to silence. Once per episode.
        noteOnce({
          at: state.time,
          kind: 'stranded',
          node: p.id,
          fraction: frac(stand.defender.damageFraction),
        });
      }
    }
  }
  // Fire-watch (ST-3.3, «Активная оборона» only): stand a CC-4 reactive patrol on
  // every wing docked at an OWN world that isn't patrolling yet — the дежурный
  // вылет then answers raiders inside its radius on its own cadence (including
  // the mid-lane standoff campers `fleet.engage` can't reach). Never on foreign
  // soil; a wing the evac branch just tasked is not re-ordered.
  if (posture === 'active_defend') {
    const patrols = (state as DivState).patrols;
    for (const f of Object.values(state.fleets)) {
      if (!idleOwn(f) || !fleetHasSquadron(f) || patrols?.[f.id]) continue;
      if (state.planets[f.location!]?.owner !== ai) continue;
      out.push(orderScramble(ai, f.id, true));
      report.push({ at: state.time, kind: 'watch', node: f.location!, fleetId: f.id });
    }
  }
  // The SITREP stamp rides LAST: it narrates the orders above. Applied through
  // the same kernel path (steward.report — server-driver-only, gate refuses it
  // from the wire), so the journal lands in state and survives the night.
  if (report.length > 0) out.push(act(ai, 'steward.report', { entries: report }));
  return out;
}

/** The two server-side AIs that can play a seat, kept explicitly DISTINCT
 *  (SES-2.2). `steward` — «Хранитель»: the player's OWN autopilot, a defensive
 *  posture they turned on to cover their sleep; it runs on their chosen posture
 *  even while they are connected-but-idle, and its live delegation OUTRANKS the
 *  abandon grace. `substitute` — «заместитель»: the full expansion bot that takes
 *  over an ABANDONED chair, only after the player has been gone past the
 *  real-time grace window, and it is reclaimed the instant they return. `none` —
 *  no AI drives the seat this tick (a present player commands it, or an absent
 *  one is still inside their reconnect grace). */
export type SeatAiKind = 'steward' | 'substitute' | 'none';

/** What drives a seat this tick + the posture to hand `aiOrders`. */
export interface SeatAiDecision {
  kind: SeatAiKind;
  posture: StewardPosture | 'expand' | null; // null ⇔ kind === 'none'
}

/** Decide which server AI (if any) plays ONE seat this tick — SES-2.2. Pure:
 *  reads only the three facts the host tracks, no time source of its own.
 *  `hasHuman` — a live peer holds the chair; `posture` — the seat's active
 *  Steward delegation (`stewardActive`), null if none; `graceExpired` — the
 *  player has been absent PAST the real-time abandon window (wall-clock, the host
 *  compares `Date.now()`; always true for a chair that never opened a window).
 *  The precedence encodes the owner's intent: a delegation they set beats the
 *  automatic takeover, and a present human beats the idle bot. */
export function seatAiDecision(
  hasHuman: boolean,
  posture: StewardPosture | null,
  graceExpired: boolean,
): SeatAiDecision {
  // A live Steward delegation is the player's OWN autopilot: it plays regardless
  // of connection and never waits on the abandon grace (they asked for it).
  if (posture) return { kind: 'steward', posture };
  // No delegation → a present human commands their own chair.
  if (hasHuman) return { kind: 'none', posture: null };
  // Empty chair: wait out the grace (a drop / restart blip / a few days away)
  // before the substitute bot seizes it — reclaimed the moment they return.
  if (!graceExpired) return { kind: 'none', posture: null };
  return { kind: 'substitute', posture: 'expand' };
}

/** One decision tick's orders for an AI-driven seat, evaluated against `state`.
 *  Read-only: it builds and returns the actions; the caller applies them — the
 *  client to its local sim, the server through the authoritative room. Drives
 *  empty seats the same way in solo and multiplayer (a seat with no human). */
export function aiOrders(
  state: GameState,
  ai: string,
  posture: StewardPosture | 'expand' = 'expand',
): Action[] {
  const out: Action[] = [];
  if (!state.players[ai]) return out; // seat not in play / eliminated
  // The defensive family: both Steward postures HOLD (no expansion, no war
  // declarations); «Активная оборона» merely adds the counterstrike/fire-watch
  // inside the guard-duty tick below.
  const defensive = posture === 'defend' || posture === 'active_defend';
  // Steward guard duty (ST-3.2/3.3): a delegated defensive seat watches its worlds,
  // evacuates a wing the forecast says it would lose ≥ STEWARD_LOSS_LIMIT of, and —
  // under «Активная оборона» — counterstrikes what it beats cheaply on own soil.
  if (defensive) out.push(...stewardGuardOrders(state, ai, posture as StewardPosture));
  const isShipUnit = (u: string): boolean => !data.units[u]?.traits.includes('ground');
  const capturable = (p: Planet): boolean => SECTOR_TYPES[p.kind ?? '']?.capturable ?? false;
  const d = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);
  // Send each idle AI fleet toward the nearest capturable world it can reach — only
  // neutral worlds or territory of someone it's at WAR with (peace = off-limits).
  // Steward «Оборона» (a delegated human seat, posture 'defend') HOLDS: it skips this
  // offensive sweep entirely and only builds / reinforces / trades below — repelling an
  // attacker is automatic in combat. "Autopilot keeps you alive; active play wins."
  // Named `warFooting` (not `atWar`) so the module-level pair helper stays visible.
  const warFooting = Object.keys(state.players).some(
    (pid) =>
      pid !== ai && state.players[pid]?.status === 'active' && getStance(state, ai, pid) === 'war',
  );
  // The home base (build/launch anchor, and the rally point ships pool at during war).
  const base =
    Object.values(state.planets).find((p) => p.owner === ai && p.buildings.length > 0) ??
    Object.values(state.planets).find((p) => p.owner === ai);
  const shipCount = (f: Fleet): number =>
    f.units.reduce((n, s) => n + (isShipUnit(s.unit) ? s.count : 0), 0);
  const expandFleets: Fleet[] = defensive ? [] : Object.values(state.fleets);
  // Consolidate BEFORE moving (self-play M4): two idle fleets sharing a location fuse
  // into one — without this, battle remnants and rally leftovers accumulate into a
  // hundreds-strong swarm of one-ship fleets that grinds the whole sim (and feeds
  // enemy AA one hull at a time). The merged fleet sorties on the next tick.
  const skipMove = new Set<string>();
  {
    const byLoc = new Map<string, Fleet[]>();
    for (const f of expandFleets) {
      if (f.owner !== ai || f.location == null || f.movement || f.battleId) continue;
      const group = byLoc.get(f.location);
      if (group) group.push(f);
      else byLoc.set(f.location, [f]);
    }
    for (const group of byLoc.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => shipCount(b) - shipCount(a));
      for (let k = 1; k < group.length; k++) {
        out.push(mergeFleet(ai, group[k]!.id, group[0]!.id));
        skipMove.add(group[k]!.id);
      }
      skipMove.add(group[0]!.id); // it grows this tick, sorties the next
    }
  }
  for (const f of expandFleets) {
    if (f.owner !== ai || f.location == null || f.movement || f.battleId) continue;
    if (skipMove.has(f.id)) continue;
    // Strike groups, not dribbles (self-play M4): auto-rally pools each new ship into
    // the IDLE rally fleet at its build world — but only while one is parked there.
    // Sending every single-ship fleet out at once therefore orphaned the rally point,
    // spawned a fresh one-ship fleet per build (hundreds of fleets, the sim ground to
    // a halt) and fed hulls into enemy AA one at a time. At war, ships HOLD at the
    // home rally point until a strike group has formed; peacetime keeps the old
    // race-to-claim behaviour (speed is everything, there is nothing to fight).
    if (warFooting && f.location === base?.id) {
      if (shipCount(f) < 3) continue;
      // Lift a landing party before the sortie: only ground troops can take a
      // garrisoned world (two-phase capture), so a strike group without a landing
      // can raid provinces but never resolve the war. Load, then move — same tick.
      const militia = base.garrison.find((s) => s.unit === 'militia' && s.count > 0);
      const hasLanding = (f.landing ?? []).some((s) => s.count > 0);
      if (!hasLanding && militia) {
        out.push(loadArmy(ai, f.id, 'militia', Math.min(2, militia.count)));
      }
    }
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
  // War when the race is being LOST (self-play M4 finding): a passive bot loses the
  // score race to whoever expands faster — every bot-vs-bot match ended as a 2-day
  // race with zero battles, and the military (and combat factions) never played. So
  // a bot falling a planet's worth (≥ 50) behind the score leader — or merely behind
  // once no capturable neutral is left — declares war on that leader; the expansion
  // loop above then targets war territory (traversable/capturable) and contested
  // provinces swing back. A bot that IS ahead stays quiet — it wins by holding.
  // Declared only from a clean 'peace' stance: pacts/alliances are never betrayed,
  // and favour-driven war (botDiplomacyModule) keeps working on top unchanged.
  if (!defensive) {
    const scoreOf = (who: string): number =>
      Object.values(state.planets).reduce(
        (s, p) => (p.owner === who ? s + provinceScore(data, p) : s),
        0,
      );
    const mine = scoreOf(ai);
    let leader: string | null = null;
    let leaderScore = -1;
    for (const pid of Object.keys(state.players)) {
      if (pid === ai || state.players[pid]?.status !== 'active') continue;
      const sc = scoreOf(pid);
      if (sc > leaderScore) {
        leaderScore = sc;
        leader = pid;
      }
    }
    const neutralLeft = Object.values(state.planets).some((p) => p.owner === null && capturable(p));
    const losingRace = leaderScore - mine >= 50 || (!neutralLeft && leaderScore >= mine);
    if (leader && losingRace && getStance(state, ai, leader) === 'peace') {
      out.push(declareWar(ai, leader));
    }
  }
  // Build + launch from this AI's home base (its first developed owned world).
  const pl = state.players[ai];
  if (base && pl) {
    // Keep the lights on first: a bot whose energy/food NET flow is negative (or already
    // in arrears) raises a plant/farm before anything else — brownouts halve its economy.
    const flow = netIncome(state, ai);
    const has = (b: string): boolean =>
      Object.values(state.planets).some(
        (p) => p.owner === ai && p.buildings.some((x) => x.type === b),
      );
    for (const [need, b] of [
      ['energy', 'power_plant'],
      ['food', 'farm'],
    ] as const) {
      if ((flow[need] ?? 0) >= 0 && !(pl.arrears ?? []).includes(need)) continue;
      if (has(b)) continue;
      const cost = data.buildings[b]?.cost ?? {};
      if (Object.keys(cost).every((r) => (pl.resources[r] ?? 0) >= (cost[r] ?? 0) + 60)) {
        out.push(buildBuilding(ai, base.id, b));
      }
    }
    // Economy chain (self-play M4: mine/refinery/tax office were DEAD content for the
    // bot — it bought all its metal on the market): raise the first missing credit
    // engine at the home base (refinery → tax office), and put a metal mine on each
    // captured PRIZE world — one link at a time, only when comfortably affordable,
    // and never over the same build already queued (no reject spam).
    const pendingBuild = (planetId: string, b: string): boolean =>
      state.scheduled.some((e) => {
        if (e.type !== 'construction.complete') return false;
        const q = e.payload as { kind?: string; planetId?: string; building?: string };
        return q.kind === 'building' && q.planetId === planetId && q.building === b;
      });
    const affordable = (b: string): boolean => {
      const cost = data.buildings[b]?.cost ?? {};
      return Object.keys(cost).every((r) => (pl.resources[r] ?? 0) >= (cost[r] ?? 0) + 60);
    };
    // ECON-7: fabricator joins the chain — microelectronics gates warships now
    // (cruiser/siege cost micro), so a bot without a fab eventually can't build a
    // fleet. Built once the credit/tax engine is up; keeps micro produced AND spent.
    for (const b of ['refinery', 'tax_office', 'fabricator'] as const) {
      if (has(b)) continue;
      if (affordable(b) && !pendingBuild(base.id, b)) out.push(buildBuilding(ai, base.id, b));
      break; // one link at a time — wait out the current one either way
    }
    for (const p of Object.values(state.planets)) {
      if (p.owner !== ai || p.kind !== 'planet' || p.id === base.id) continue;
      if (p.buildings.some((x) => x.type === 'mine') || pendingBuild(p.id, 'mine')) continue;
      if (!affordable('mine')) break;
      out.push(buildBuilding(ai, p.id, 'mine'));
      break; // spread the economy one world per tick
    }
    // Ship production is CAPPED by the fleet count (self-play M4: endless building
    // fed an ever-growing swarm — hundreds of fleets by mid-match). Enough fleets
    // out ⇒ the metal flows to economy/garrisons instead.
    const aiFleets = Object.values(state.fleets).filter((f) => f.owner === ai).length;
    if (
      aiFleets < (warFooting ? 8 : 4) &&
      (pl.resources.metal ?? 0) > 220 &&
      (pl.resources.credits ?? 0) > 120 &&
      (pl.resources.microelectronics ?? 0) >= 3 // ECON-7: warships need the hi-tech good
    ) {
      out.push(buildUnit(ai, base.id, 'cruiser', 1));
    }
    // Wartime posture (self-play M4: wars were free walk-in raids — the leader had no
    // garrisons, so whoever attacked always came back and won): at war the bot
    // (a) garrisons its undefended PRIZE worlds with militia — a garrisoned planet
    // can't be walk-in captured, it takes a ground assault; the 10-point provinces
    // stay an open raid zone by design; (b) adds fast scouts to the build mix
    // (capture runners for that raid zone); (c) fields more fleets — and a launched
    // fleet lifts home-built militia aboard as landing troops (fleet.launch), which
    // is exactly what lets it assault a garrisoned world back.
    if (warFooting) {
      let garrisonOrders = 0;
      for (const p of Object.values(state.planets)) {
        if (garrisonOrders >= 2 || (pl.resources.metal ?? 0) < 90) break;
        if (p.owner !== ai || p.kind !== 'planet') continue;
        if (p.garrison.some((s) => s.count > 0)) continue;
        out.push(buildUnit(ai, p.id, 'militia', 2));
        garrisonOrders += 1;
      }
      // A landing stock at home: strike groups lift militia on sortie (above), so
      // the base keeps a few spare beyond its seeded defenders.
      const baseMilitia = base.garrison
        .filter((s) => s.unit === 'militia')
        .reduce((n, s) => n + s.count, 0);
      if (baseMilitia < 4 && (pl.resources.metal ?? 0) > 120) {
        out.push(buildUnit(ai, base.id, 'militia', 2));
      }
      if (aiFleets < 8 && (pl.resources.metal ?? 0) > 140) {
        out.push(buildUnit(ai, base.id, 'scout', 1));
      }
    }
    // (marine retired: the AI no longer cheap-builds a ground trooper. Its home keeps its
    //  seeded infantry garrison + orbital-AA building for defence; mobile ground via divisions.)
    const baseHasShip = base.garrison.some((st) => isShipUnit(st.unit));
    if (aiFleets < (warFooting ? 4 : 2) && baseHasShip) out.push(launchFleet(ai, base.id));
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
      const reserve = good === 'microelectronics' ? 40 : 120; // the working stock it keeps
      if (have >= reserve + 40 && !hasLot('sell', good))
        out.push(marketList(ai, 'sell', good, Math.floor((have - reserve) / 2), 2));
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
