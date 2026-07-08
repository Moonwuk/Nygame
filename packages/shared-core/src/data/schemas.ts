import { z } from 'zod';

/**
 * Validation schemas for the data-driven game content (docs/architecture.md
 * §2). The engine knows nothing about concrete units/factions/resources — it
 * only enforces these shapes and then operates over the data. New content =
 * new JSON entries, no code changes.
 *
 * All input from disk or from the wire is validated here before it ever
 * reaches the core (OWASP A05 — Injection; A08 — Integrity).
 */

/** A dynamic resource ledger, e.g. { "metal": 220, "credits": 80 }. */
export const ResourceBagSchema = z.record(z.string(), z.number());

/** Combat/movement stats. Extra numeric stats are allowed (data-driven). */
export const UnitStatsSchema = z
  .object({
    /** Damage dealt when attacking. */
    attack: z.number(),
    /** Damage dealt when defending (return fire of a standing fleet). */
    defense: z.number(),
    speed: z.number(),
    /** Hit points per ship — aggregate fleet HP = Σ count × hp (GDD §7.1). */
    hp: z.number().nonnegative().default(1),
    /** Ablative shield points per ship (shields-roadmap SH-0.1): damage hits the
     *  shield pool before the hull; a ship dies when its HULL reaches 0. 0 = no
     *  shield. (Out-of-combat regen is a later brick, SH-1.1.) */
    shield: z.number().nonnegative().default(0),
    /** Standoff firing radius in MAP UNITS — the Euclidean reach of an
     *  `artillery` unit's ranged attack (combat `runArtillery`). 0 = melee only,
     *  no ranged attack. The longest gun in a fleet sets the fleet's reach. */
    range: z.number().nonnegative().default(0),
    /** Ground-army transport capacity of a ship (0 = carries nothing; a
     *  dedicated dropship carries a lot). Bigger hulls carry more. */
    cargoCapacity: z.number().nonnegative().default(0),
    /** Transport space a ground unit occupies when carried (a tank > infantry). */
    cargoSize: z.number().nonnegative().default(1),
    /** Orbital-AA damage per hour a (ground) unit deals to a hostile fleet on the
     *  NEAR orbit while the planet is not under a ground assault. 0 = no AA. */
    aaDamage: z.number().nonnegative().default(0),
    /** Squadron reach (squadrons-roadmap SQ-3.1): the Euclidean distance in MAP
     *  UNITS a launched `squadron` may strike from its carrier. 0 = no reach. */
    strikeRange: z.number().nonnegative().default(0),
    /** Squadron sorties before it must rearm (SQ-2.1). 0 = not a squadron / no
     *  sortie limit. Decrements per sortie; at 0 the squadron goes to `rearmRounds`. */
    fuel: z.number().nonnegative().default(0),
    /** Combat rounds a spent squadron sits rearming on its carrier before it can
     *  sortie again (SQ-2.1). Deterministic cooldown, like a hero ability. */
    rearmRounds: z.number().nonnegative().default(0),
  })
  .catchall(z.number());

/** The three module-slot categories a hull exposes. Typed slots: a module fits
 *  only its own category. Kept small so slots compete — fitting is opportunity
 *  cost, not an open stack (ship-modules-roadmap.md §0). */
export const SHIP_SLOT_TYPES = ['weapon', 'defense', 'utility'] as const;
export const ShipSlotTypeSchema = z.enum(SHIP_SLOT_TYPES);
/** How many slots of each category a hull carries. Default 0 everywhere ⇒ the
 *  hull fits no modules (backward-compatible: existing units are unaffected). */
export const ShipSlotsSchema = z.object({
  weapon: z.number().int().nonnegative().default(0),
  defense: z.number().int().nonnegative().default(0),
  utility: z.number().int().nonnegative().default(0),
});

export const UnitDefSchema = z.object({
  faction: z.string(),
  stats: UnitStatsSchema,
  /** Where the unit operates: `space` units crew fleets and fight in orbit;
   *  `ground` units are the planetary army (garrison / transported as cargo /
   *  the landing force in a ground assault). Fleets carry ground units up to
   *  their ships' `cargoCapacity`. */
  domain: z.enum(['space', 'ground']).default('space'),
  /** Damage-receiving line (GDD §7.2). `artillery` trait overrides this. */
  line: z.enum(['front', 'mid', 'rear']).default('front'),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
  cost: ResourceBagSchema.default({}),
  /** Build time in hours to produce the unit at a planet (real-time,
   *  timeScale-scaled). Mirrors BuildingDef.buildTimeHours. */
  buildTimeHours: z.number().nonnegative().default(0),
  /** Daily upkeep paid to keep the unit (per day). */
  upkeep: ResourceBagSchema.default({}),
  /** Radar "signature": how detectable the unit is. A fleet's signature is the
   *  sum of count × signature; radar reveals a coarse size bucket, never the
   *  exact composition (fog-of-war — `visibleState`). */
  signature: z.number().nonnegative().default(1),
  /** Radar reach (Euclidean distance, map units) the unit projects as a radar-ship (0 = none). */
  radarRange: z.number().nonnegative().default(0),
  /** Typed module slots this hull exposes (ship-modules-roadmap.md). A player
   *  fills them BEFORE building; the built ship is locked (no refit). Omitted →
   *  all-zero → carries no modules (a partial object defaults the rest to 0). */
  slots: ShipSlotsSchema.default({ weapon: 0, defense: 0, utility: 0 }),
});

/** One stack in a faction's starting loadout (a unit id + how many). */
export const StartingStackSchema = z.object({
  unit: z.string(),
  count: z.number().int().positive(),
});

/** What a player of this faction begins a match with (consumed by the match-start
 *  assembly, brick B3). All fields default to empty so a faction can describe only
 *  what differs. */
export const FactionLoadoutSchema = z.object({
  /** Starting treasury. */
  resources: ResourceBagSchema.default({}),
  /** Ships in the starting fleet. */
  fleet: z.array(StartingStackSchema).default([]),
  /** Ground units in the homeworld garrison. */
  garrison: z.array(StartingStackSchema).default([]),
  /** Buildings already standing on the homeworld (ids → `data.buildings`). */
  homeBuildings: z.array(z.string()).default([]),
});

/** Passive faction bonuses — mirrors `TechnologyEffects` so the faction module
 *  (brick B2) can apply them through the same `economy.production` / `fleet.speed` /
 *  `combat.damage` hooks. Absent module → no effect (graceful degradation). */
export const FactionPassivesSchema = z.object({
  /** Multiplier on owned planetary production, e.g. 0.15 = +15%. */
  productionBonus: z.number().default(0),
  /** Multiplier on owned fleet movement speed. */
  fleetSpeedBonus: z.number().default(0),
  /** Multiplier on outgoing combat damage. */
  combatDamageBonus: z.number().default(0),
  /** Multiplier on the reach of every radar the player fields (buildings and
   *  ships). Read by the `visibleState` projection (A2), like the tech effect. */
  radarRangeBonus: z.number().default(0),
});

export const FactionDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  traits: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
  /** Unit ids this faction can field that others cannot (its signature roster). */
  uniqueUnits: z.array(z.string()).default([]),
  /** Match-start loadout (resources / fleet / garrison / homeworld buildings). */
  startingLoadout: FactionLoadoutSchema.default({
    resources: {},
    fleet: [],
    garrison: [],
    homeBuildings: [],
  }),
  /** Always-on faction bonuses, applied by the faction module via hooks. */
  passives: FactionPassivesSchema.default({
    productionBonus: 0,
    fleetSpeedBonus: 0,
    combatDamageBonus: 0,
    radarRangeBonus: 0,
  }),
});

/** Per-level stats of a building (level 2..N). Level 1 uses the base fields. */
export const BuildingLevelSchema = z.object({
  cost: ResourceBagSchema.default({}),
  buildTimeHours: z.number().nonnegative().default(0),
  produces: ResourceBagSchema.default({}),
  /** Daily running cost of the standing building (per day, like unit upkeep). When the
   *  owner can't pay a resource of it (treasury pinned at zero — arrears), buildings
   *  consuming THAT resource produce at half rate until the debt clears (economy.ts). */
  upkeep: ResourceBagSchema.default({}),
  /** Structural HP at this level. */
  hp: z.number().nonnegative().default(0),
  /** Ground-defense bonus this level grants the garrison (0.01 = +1%). */
  defenseBonus: z.number().default(0.01),
  /** Radar reach (Euclidean distance, map units) at this level — lets a radar array widen its
   *  detection radius as it is upgraded. */
  radarRange: z.number().nonnegative().default(0),
  /** Fraction of a garrison stack's max-HP pool restored per game hour (0.1 = 10%/h).
   *  Stacks heal continuously while the planet is owned; destroyed buildings don't heal. */
  healRate: z.number().nonnegative().default(0),
  /** Fraction of a docked friendly fleet's HULL restored per game hour (0.1 = 10%/h) —
   *  a shipyard / spaceport (shields-roadmap SH-2.1). 0 = this building can't mend hulls. */
  shipRepair: z.number().nonnegative().default(0),
  /** Anti-ship orbital-AA firepower this level fires per game hour at a hostile fleet on the
   *  near orbit (an emplacement building). Summed alongside garrison `aaDamage` in combat. */
  aaDamage: z.number().nonnegative().default(0),
});

export const BuildingDefSchema = z.object({
  name: z.string(),
  cost: ResourceBagSchema.default({}),
  buildTimeHours: z.number().nonnegative().default(0),
  produces: ResourceBagSchema.default({}),
  /** Daily running cost of the standing building (see BuildingLevelSchema.upkeep). */
  upkeep: ResourceBagSchema.default({}),
  /** Structural HP — bombarded from orbit and stormed on the ground (GDD §7.4);
   *  a destroyed building stops granting its defense bonus. */
  hp: z.number().nonnegative().default(0),
  /** Ground-defense bonus the building grants the garrison (0.01 = +1%); a
   *  fortress grants much more, and it grows with level. */
  defenseBonus: z.number().default(0.01),
  /** Overrides for levels 2..N (index 0 = level 2). maxLevel = 1 + length. */
  upgrades: z.array(BuildingLevelSchema).default([]),
  traits: z.array(z.string()).default([]),
  /** Victory-score worth of this building; the victory module multiplies it by
   *  the instance's level, so investing in upgrades raises (and losing the
   *  building lowers) the owner's score. */
  scoreValue: z.number().nonnegative().default(0),
  /** Radar reach (Euclidean distance, map units) the building projects from the world it sits on
   *  (0 = none). Drives signature detection in `visibleState`. */
  radarRange: z.number().nonnegative().default(0),
  /** Fraction of garrison max-HP restored per game hour (see BuildingLevelSchema). */
  healRate: z.number().nonnegative().default(0),
  /** Fraction of a docked friendly fleet's HULL restored per game hour — a
   *  shipyard / spaceport (shields-roadmap SH-2.1). 0 = can't mend hulls. */
  shipRepair: z.number().nonnegative().default(0),
  /** Anti-ship orbital-AA firepower per game hour (an emplacement building like an
   *  orbital-AA battery). Fires on hostile near-orbit fleets, summed with garrison AA. */
  aaDamage: z.number().nonnegative().default(0),
});

/**
 * A trigger -> effect rule: the universal vocabulary for traits, abilities and
 * dark events (docs/architecture.md §2.2). `params` is effect-specific and is
 * validated more tightly by the effect handler that consumes it.
 */
export const EffectRuleSchema = z.object({
  trigger: z.string(),
  effect: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  chance: z.number().min(0).max(1).default(1),
});

/**
 * A sector type — terrain of a map node (GDD §1: секторная структура). Carries
 * buffs/debuffs applied through hooks, never hard-coded in the core.
 */
export const SectorTypeDefSchema = z.object({
  name: z.string().optional(),
  /** Fleet speed change for a leg entering this sector, e.g. -0.25 = −25%. */
  speedBonus: z.number().default(0),
  /** Effective fleet HP change for battles in this sector, e.g. 0.1 = +10%. */
  hpBonus: z.number().default(0),
  /** Victory-score worth of controlling a node in this sector (terrain like an
   *  asteroid field is worth holding even without a habitable planet). */
  scoreValue: z.number().nonnegative().default(0),
});

/**
 * A planet type — the world's own nature (terran / barren / volcanic / oceanic /
 * gas giant …), distinct from the sector it sits in. Like a sector it carries
 * buffs/debuffs applied purely through hooks, never hard-coded in the core.
 */
export const PlanetTypeDefSchema = z.object({
  name: z.string().optional(),
  /** Multiplier on the world's production, e.g. 0.25 = +25% (rich), −0.25 = poor. */
  productionBonus: z.number().default(0),
  /** Per-resource production multipliers layered ON TOP of `productionBonus`, e.g.
   *  `{ metal: 0.3 }` = +30% metal only (a depleted dead world is metal-rich). Lets a
   *  type favour one resource without touching the others; applied by `planetTypeModule`. */
  productionByResource: z.record(z.string(), z.number()).default({}),
  /** Ground-defense edge for the owner's garrison: incoming assault damage is
   *  divided by (1 + this). Positive = defensible world, negative = exposed.
   *  Stacks with building defense. */
  defenseBonus: z.number().default(0),
  /** Victory-score worth of owning a world of this type (a developed terran
   *  world is worth more than a barren rock); added on top of the base. */
  scoreValue: z.number().nonnegative().default(0),
});

export const TechnologyUnlocksSchema = z.object({
  units: z.array(z.string()).default([]),
  buildings: z.array(z.string()).default([]),
  abilities: z.array(z.string()).default([]),
});

export const TechnologyEffectsSchema = z.object({
  /** Multiplier on owned planetary production, e.g. 0.1 = +10%. */
  productionBonus: z.number().default(0),
  /** Multiplier on owned fleet movement speed, e.g. 0.15 = +15%. */
  fleetSpeedBonus: z.number().default(0),
  /** Multiplier on outgoing combat damage, e.g. 0.1 = +10%. */
  combatDamageBonus: z.number().default(0),
  /** Multiplier on the reach of every radar the player fields (buildings and
   *  ships), e.g. 0.25 = +25%. Read by the `visibleState` projection (A2). */
  radarRangeBonus: z.number().default(0),
});

/** The five tech-tree branches (UI tabs), shared by technologies, scientists and the
 *  `has_scientist` gate. `command` is the automation / command-and-control branch (AI
 *  delegation "Steward", and later order chains and standing postures). */
const BranchSchema = z.enum(['ground', 'space', 'squadron', 'missile', 'command']);

/** Shared "at least N" threshold for a condition (default 1 = mere existence). This
 *  single `min` knob is the main data lever for tuning a gate without touching code. */
const conditionMin = z.number().int().positive().default(1);

/** One curated tech-unlock condition (a "ready-made block", not a constructor —
 *  §7.5): evaluated deterministically from state, each an "at least `min`" count.
 *  Balancing a tech = composing these in JSON (adjust `min`); a genuinely new KIND of
 *  gate = a new variant here + one evaluator case in the technology module. ALL of a
 *  tech's conditions must hold for it to unlock. */
export const TechnologyConditionSchema = z.discriminatedUnion('type', [
  /** Own at least `min` sectors (owned map nodes / planets). */
  z.object({ type: z.literal('own_sectors'), min: conditionMin }),
  /** Own at least `min` built copies of `building` across your worlds. */
  z.object({ type: z.literal('has_building'), building: z.string(), min: conditionMin }),
  /** Own at least `min` worlds of `planetType`. */
  z.object({ type: z.literal('controls_planet_type'), planetType: z.string(), min: conditionMin }),
  /** Field at least `min` of `unit` across fleets, their cargo, and garrisons. */
  z.object({ type: z.literal('has_unit'), unit: z.string(), min: conditionMin }),
  /** Have a chosen scientist (optionally of `branch`) at level ≥ `minLevel` — the
   *  seam for branch-focus and late-game capstone content. `minLevel` is a meta level;
   *  a capstone should anchor it to the account/scientist max once account-level lands
   *  (docs-only today), not a guessed magic number. */
  z.object({
    type: z.literal('has_scientist'),
    branch: BranchSchema.optional(),
    minLevel: z.number().int().positive().default(1),
  }),
]);
export type TechnologyCondition = z.infer<typeof TechnologyConditionSchema>;

export const TechnologyDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tier: z.number().int().positive().default(1),
  /** Tech-tree branch (UI tab). Defaults to 'space' so existing nodes that omit
   *  it stay valid (back-compat); squadron/missile branches may have no content yet. */
  branch: BranchSchema.default('space'),
  /** Session day from which the node becomes researchable (0 = from match start).
   *  A "day" is game-time, timeScale-scaled — mirrors how `researchTimeHours`
   *  compresses (enforced in the technology module). */
  dayGate: z.number().int().nonnegative().default(0),
  /** Extra unlock conditions beyond prerequisites/day-gate — a curated, data-driven
   *  catalog (§7.5). ALL must hold. Default: none. */
  conditions: z.array(TechnologyConditionSchema).default([]),
  cost: ResourceBagSchema.default({}),
  researchTimeHours: z.number().nonnegative().default(0),
  prerequisites: z.array(z.string()).default([]),
  unlocks: TechnologyUnlocksSchema.default({ units: [], buildings: [], abilities: [] }),
  effects: TechnologyEffectsSchema.default({
    productionBonus: 0,
    fleetSpeedBonus: 0,
    combatDamageBonus: 0,
    radarRangeBonus: 0,
  }),
});

/** How a province type draws on the map — resolved by kind id on the client, never
 *  stored on `Planet` (keeps `GameState` minimal). A missing field degrades to a
 *  neutral default, never a crash. */
export const SectorKindAppearanceSchema = z.object({
  /** Map accent fill / glyph tint (hex). */
  color: z.string().default('#46606e'),
  /** On-map callout. Falls back to the kind's `name`, then the kind id. */
  label: z.string().optional(),
  /** On-map marker family. */
  shape: z.enum(['city', 'junction', 'marker', 'station']).default('city'),
});

/** A sector **kind** = a **province type** (planet / asteroid / nebula / void_station
 *  / empty …): the single registry that decides whether a province can be owned, built
 *  on, what it can be built with, and how it looks on the map. Data-driven
 *  (map-roadmap.md M2.1) — add a province type by adding an entry, no code change.
 *  Absent / unknown kind degrades to the permissive defaults below. */
export const SectorKindDefSchema = z.object({
  name: z.string().optional(),
  /** Victory-score base for controlling a province of this kind (GDD §8.1). A
   *  habitable `planet` is the prize (50); every other province type — asteroid,
   *  nebula, a depleted dead world — is worth a flat 10. Data-driven so the whole
   *  scoring economy is balanced in content, not code. */
  scoreValue: z.number().nonnegative().default(10),
  /** Can this province be owned (captured)? Empty space cannot. */
  capturable: z.boolean().default(true),
  /** Can structures be raised here? */
  buildable: z.boolean().default(true),
  /** Does it have the orbital layer — can fleets station in orbit (cities, fortresses)? */
  orbit: z.boolean().default(true),
  /** Province-centric build roster: the building ids raisable on this province type.
   *  Absent/undefined = ANY building (the permissive default, so kind-less / roster-less
   *  worlds keep building as before). Explicit `[]` = no construction here (empty /
   *  debris). Enforced in the construction module (`E_WRONG_SECTOR`). */
  allowedBuildings: z.array(z.string()).optional(),
  /** Map appearance (color / label / shape); neutral default if absent. */
  appearance: SectorKindAppearanceSchema.default({ color: '#46606e', shape: 'city' }),
});

/** A research leader (scientist) — a per-player entity CHOSEN at match start and
 *  snapshotted immutably (NOT a unit, NOT a hero). `branch` is its focus; `slotBonus`
 *  is the "+slot" leader's extra research slots. Effects ride the `research.slots`
 *  hook and the `has_scientist` unlock gate. */
export const ScientistDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** The branch this leader focuses (gates `has_scientist { branch }` content). Omit
   *  for a branchless generalist (e.g. the +slot leader): with no branch it satisfies
   *  no branch-focus gate, which is what makes "+slot INSTEAD of a focus" a real
   *  opportunity cost. */
  branch: BranchSchema.optional(),
  /** Extra concurrent research slots this leader grants (the "+slot" leader). Flows
   *  through the `research.slots` hook, which the technology module clamps to the
   *  design max of 3 — so only 0 or 1 is meaningful under the base rule. Default 0. */
  slotBonus: z.number().int().nonnegative().default(0),
});

/** What a hull must satisfy for a module to be installable (all given fields must
 *  hold). Anchors a module to a class of ships (a cargo expander → only transports). */
export const ModuleAllowedSchema = z.object({
  domain: z.enum(['space', 'ground']).optional(),
  traits: z.array(z.string()).default([]),
  units: z.array(z.string()).default([]),
});
/** A module's effect. Two separate channels (kept apart on the balance axis):
 *  `stats` = flat additive stat deltas (×count); `enables` = action/ability flags
 *  the carrier unlocks. */
export const ModuleEffectsSchema = z.object({
  stats: z.record(z.string(), z.number()).default({}),
  enables: z.array(z.string()).default([]),
});
/** A ship module (loadout item). Chosen at BUILD time and locked onto the built
 *  stack — there is deliberately NO refit action (owner rule; supersedes the
 *  roadmap's port equip/unequip). `tag` splits the balance/monetisation axis:
 *  `horizontal` (logistics/utility) vs `vertical` (combat power). A paid/lootbox
 *  source must never carry a `vertical` module — enforced downstream and by the
 *  soulbound refine here. Extensible via data, like `UnitDef`. */
export const ModuleDefSchema = z
  .object({
    name: z.string(),
    slot: ShipSlotTypeSchema,
    tag: z.enum(['horizontal', 'vertical']),
    effects: ModuleEffectsSchema.default({ stats: {}, enables: [] }),
    cost: ResourceBagSchema.default({}),
    allowed: ModuleAllowedSchema.optional(),
    /** Bound to the owning player (anti-RMT). A `vertical` module must never be
     *  soulbound — a paid source can't sell combat power (refined below). */
    soulbound: z.boolean().optional(),
  })
  .refine((m) => !Object.keys(m.effects.stats).some((k) => /slot/i.test(k)), {
    message: 'a module may not modify slot capacity (anti self-expansion)',
  })
  .refine((m) => !(m.tag === 'vertical' && m.soulbound === true), {
    message: 'a vertical (combat) module may not be soulbound (anti pay-to-win)',
  });

/** A hero's skill-tree branch (docs/heroes.md): `transhuman` (implant-users) vs
 *  `psionic`. Deliberately distinct from the tech-tree `BranchSchema` — a hero belongs
 *  to a hero branch, not a research branch. Optional on an archetype (a branchless hero
 *  simply draws from no branch tree until skill trees land, HERO-7). */
export const HERO_BRANCHES = ['transhuman', 'psionic'] as const;
export const HeroBranchSchema = z.enum(HERO_BRANCHES);

/** One hero ability (a "module" in design terms) — a data-driven effect the `heroModule`
 *  dispatches on `type` (built-in handler, else capability `hero.effect.<type>`; HERO-4).
 *  `params` is effect-specific and validated more tightly by that handler, mirroring
 *  `EffectRuleSchema`. Balancing an ability = editing these numbers, not code. */
export const HeroAbilityDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Effect dispatch key (e.g. `temp_lane` / `annihilate` / `aura` / `reveal`). */
  type: z.string(),
  /** Cooldown in game-hours before it can fire again (deterministic `readyAt`). 0 = none. */
  cooldownHours: z.number().nonnegative().default(0),
  /** Targeting reach in MAP UNITS (Euclidean). 0 = self / untargeted; for the built-in
   *  targeted types (`temp_lane`/`annihilate`) the engine falls back to its legacy
   *  constant instead — an omitted range never means "unlimited reach" (fail-secure). */
  range: z.number().nonnegative().default(0),
  /** Treasury cost to activate (absent / empty = cooldown-only). Strictly nonnegative —
   *  a catalog line must not be able to MINT resources through `payCost` (A08). */
  cost: z.record(z.string(), z.number().nonnegative()).default({}),
  /** Effect-specific parameters, interpreted by the type's handler. */
  params: z.record(z.string(), z.unknown()).default({}),
});

/** The hook pipelines a hero passive may feed (HERO-5). A curated enum, not an open
 *  string — each hook needs an interpreter in the hero module (like the tech-condition
 *  catalog §7.5); a new hook = one enum entry + one evaluator case. */
export const HERO_PASSIVE_HOOKS = ['fleet.speed', 'combat.damage'] as const;
/** Where a passive applies: the hero's OWN ship's fleet, or every owner fleet within
 *  `params.radius` of the hero's node (the fleet-empowerment aura of docs/heroes.md). */
export const HERO_PASSIVE_SCOPES = ['heroFleet', 'ownFleetsNear'] as const;

/** A hero passive (docs/heroes.md §Данные) — an always-on, data-driven contribution to
 *  a hook while its hero is alive. Carried by a hero instance (`Hero.passives`, copied
 *  from the archetype's `startPassives` at seed). Balancing = editing these numbers. */
export const HeroPassiveDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  hook: z.enum(HERO_PASSIVE_HOOKS),
  scope: z.enum(HERO_PASSIVE_SCOPES),
  params: z
    .object({
      /** Multiplier contribution, e.g. 0.1 = +10% — applied as ×(1 + Σ bonuses). */
      bonus: z.number().default(0),
      /** Euclidean reach in MAP UNITS for `ownFleetsNear`. 0 ⇒ same node only. */
      radius: z.number().nonnegative().default(0),
    })
    .default({ bonus: 0, radius: 0 }),
});

/** What a skill node grants when unlocked (HERO-7). Deliberately only the two grants
 *  the engine already interprets — an ability slot-in (`Hero.abilities`, HERO-4) or a
 *  passive (`Hero.passives`, HERO-5). Stat / ability-param bonuses join when their
 *  engine seams exist (don't ship data promising what nothing implements). */
export const HeroSkillGrantsSchema = z.object({
  /** Ability id (→ `data.heroAbilities`) added to the hero's loadout. */
  ability: z.string().optional(),
  /** Passive id (→ `data.heroPassives`) switched on for the hero. */
  passive: z.string().optional(),
});

/** One node of the hero skill tree (docs/heroes.md — «дерево = бонусы к способностям»,
 *  ветки transhuman/psionic). Unlock order is gated by `requires` (parent nodes) and
 *  the hero's archetype branch; `cost` is an optional treasury price (default free —
 *  the points economy is an open design question). */
export const HeroSkillNodeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Branch this node belongs to; omit for a common node any hero may take. */
  branch: HeroBranchSchema.optional(),
  /** Parent node ids that must be unlocked first (the tree edges). */
  requires: z.array(z.string()).default([]),
  /** Treasury cost to unlock (nonnegative — a node must not mint resources). */
  cost: z.record(z.string(), z.number().nonnegative()).default({}),
  grants: HeroSkillGrantsSchema.default({}),
});

/** The ship a hero commands: either an existing unit archetype (`unit` → `data.units`) or
 *  inline stat overrides. A hero reuses the fleet for position/movement/combat, so its
 *  ship is described the same way a unit is (docs/heroes.md §Модель состояния). Both
 *  optional so an archetype can lean on a unit id, tweak it, or define stats outright. */
export const HeroShipSchema = z.object({
  unit: z.string().optional(),
  stats: UnitStatsSchema.partial().optional(),
});

/** A hero archetype (docs/heroes.md §Данные) — the persona a player fields, distinct from
 *  a `UnitDef` (it carries abilities/branch/slots and reuses a ship for its body). The
 *  data-first core model behind the prototype's roster; passives/fittings/skill-trees are
 *  later bricks (HERO-5/6/7), so `startPassives` is a plain id list here. */
export const HeroArchetypeDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  branch: HeroBranchSchema.optional(),
  /** The ship the hero commands (unit ref and/or inline stats). */
  ship: HeroShipSchema.default({}),
  /** Module slots the hero's ship exposes (fittings fill these — HERO-6). */
  slots: z.number().int().nonnegative().default(0),
  /** Ability ids granted at spawn (→ `data.heroAbilities`). */
  startAbilities: z.array(z.string()).default([]),
  /** Passive ids active from spawn (→ `data.heroPassives`, HERO-5). Ids only here. */
  startPassives: z.array(z.string()).default([]),
});

export const GameDataSchema = z.object({
  version: z.string(),
  resources: z.array(z.string()).min(1),
  units: z.record(z.string(), UnitDefSchema),
  factions: z.record(z.string(), FactionDefSchema),
  buildings: z.record(z.string(), BuildingDefSchema),
  events: z.record(z.string(), EffectRuleSchema),
  sectors: z.record(z.string(), SectorTypeDefSchema).default({}),
  sectorKinds: z.record(z.string(), SectorKindDefSchema).default({}),
  planetTypes: z.record(z.string(), PlanetTypeDefSchema).default({}),
  technologies: z.record(z.string(), TechnologyDefSchema).default({}),
  scientists: z.record(z.string(), ScientistDefSchema).default({}),
  modules: z.record(z.string(), ModuleDefSchema).default({}),
  heroes: z.record(z.string(), HeroArchetypeDefSchema).default({}),
  heroAbilities: z.record(z.string(), HeroAbilityDefSchema).default({}),
  heroPassives: z.record(z.string(), HeroPassiveDefSchema).default({}),
  heroSkillTrees: z.record(z.string(), HeroSkillNodeSchema).default({}),
});

export type ResourceBag = z.infer<typeof ResourceBagSchema>;
export type UnitStats = z.infer<typeof UnitStatsSchema>;
export type UnitDef = z.infer<typeof UnitDefSchema>;
export type ShipSlotType = z.infer<typeof ShipSlotTypeSchema>;
export type ShipSlots = z.infer<typeof ShipSlotsSchema>;
export type ModuleDef = z.infer<typeof ModuleDefSchema>;
export type ModuleEffects = z.infer<typeof ModuleEffectsSchema>;
export type FactionDef = z.infer<typeof FactionDefSchema>;
export type FactionLoadout = z.infer<typeof FactionLoadoutSchema>;
export type FactionPassives = z.infer<typeof FactionPassivesSchema>;
export type StartingStack = z.infer<typeof StartingStackSchema>;
export type BuildingDef = z.infer<typeof BuildingDefSchema>;
export type BuildingLevel = z.infer<typeof BuildingLevelSchema>;
export type EffectRule = z.infer<typeof EffectRuleSchema>;
export type SectorTypeDef = z.infer<typeof SectorTypeDefSchema>;
export type SectorKindDef = z.infer<typeof SectorKindDefSchema>;
export type SectorKindAppearance = z.infer<typeof SectorKindAppearanceSchema>;
export type PlanetTypeDef = z.infer<typeof PlanetTypeDefSchema>;
export type TechnologyUnlocks = z.infer<typeof TechnologyUnlocksSchema>;
export type TechnologyEffects = z.infer<typeof TechnologyEffectsSchema>;
export type TechnologyDef = z.infer<typeof TechnologyDefSchema>;
export type ScientistDef = z.infer<typeof ScientistDefSchema>;
export type HeroBranch = z.infer<typeof HeroBranchSchema>;
export type HeroAbilityDef = z.infer<typeof HeroAbilityDefSchema>;
export type HeroShip = z.infer<typeof HeroShipSchema>;
export type HeroArchetypeDef = z.infer<typeof HeroArchetypeDefSchema>;
export type HeroPassiveDef = z.infer<typeof HeroPassiveDefSchema>;
export type HeroSkillNode = z.infer<typeof HeroSkillNodeSchema>;
export type HeroSkillGrants = z.infer<typeof HeroSkillGrantsSchema>;
export type GameData = z.infer<typeof GameDataSchema>;

/** Stats of a building at a given level (1-based). Level 1 = the base fields;
 *  levels 2..N come from `upgrades`. Out-of-range levels fall back to level 1. */
export function buildingLevel(def: BuildingDef, level: number): BuildingLevel {
  if (level <= 1) {
    const { cost, buildTimeHours, produces, upkeep, hp, defenseBonus, radarRange, healRate, shipRepair, aaDamage } = def;
    return { cost, buildTimeHours, produces, upkeep, hp, defenseBonus, radarRange, healRate, shipRepair, aaDamage };
  }
  return def.upgrades[level - 2] ?? buildingLevel(def, 1);
}

/** Highest level this building can reach (level 1 plus its upgrades). */
export function buildingMaxLevel(def: BuildingDef): number {
  return 1 + def.upgrades.length;
}

/** Parses and validates a full game-data bundle, throwing on invalid input. */
export function parseGameData(raw: unknown): GameData {
  return GameDataSchema.parse(raw);
}

/** Non-throwing variant — returns a discriminated result. */
export function safeParseGameData(raw: unknown): z.ZodSafeParseResult<GameData> {
  return GameDataSchema.safeParse(raw);
}
